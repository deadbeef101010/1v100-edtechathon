import { mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { io as createClient, type Socket as ClientSocket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTeacherToken } from "../src/auth.js";
import { CommandCoordinator } from "../src/command-coordinator.js";
import { openDatabase, type AppDatabase } from "../src/db.js";
import { answererRoom, oneRoom, projectApplicationPacket, snapshotView } from "../src/emitter.js";
import { GameEventStore } from "../src/game-event-store.js";
import {
  OneV100Engine,
  selectNextOne,
  type RulesetLifecycleEvent,
  type RulesetPlayer,
} from "../src/engine/one-v-100-engine.js";
import { ONE_V_100_DEFAULT_SETTINGS } from "../src/engine/ruleset-settings.js";
import { uuidV7 } from "../src/ids.js";
import { SqliteRulesetRepository } from "../src/ruleset-store.js";
import { attachSocketGateway } from "../src/socket-gateway.js";
import { createAppServer } from "../src/server.js";
import { createClassroomSession } from "../src/sessions.js";
import { mintTeacherKey } from "../src/teachers.js";

let directory: string;
let database: AppDatabase;
const clients: ClientSocket[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "one-v-100-lifecycle-"));
  database = openDatabase(join(directory, "game.db"));
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  database.close();
  await rm(directory, { recursive: true, force: true });
});

function addPlayer(sessionId: string, nickname: string, joinedAtMs: number, points = 0): string {
  const playerId = uuidV7(joinedAtMs);
  database.prepare(
    `INSERT INTO session_players
      (player_id, session_id, nickname, nickname_norm, token_hash, token_expires_at_ms,
       role, points, joined_at_ms, last_seen_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, 'mob', ?, ?, ?)`,
  ).run(playerId, sessionId, nickname, nickname.toLowerCase(), Buffer.from(playerId), joinedAtMs + 100_000, points, joinedAtMs, joinedAtMs);
  return playerId;
}

function ack<T>(socket: ClientSocket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function expectNoCorrectness(value: unknown): void {
  const forbidden = new Set(["correct_choice", "correctChoice", "correct", "was_correct", "wasCorrect", "one_correct", "oneCorrect"]);
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach(visit);
      return;
    }
    if (typeof candidate !== "object" || candidate === null) return;
    for (const [key, entry] of Object.entries(candidate as Record<string, unknown>)) {
      expect(forbidden.has(key), `unexpected pre-reveal field ${key}`).toBe(false);
      visit(entry);
    }
  };
  visit(value);
}

function fixture(): Readonly<{ teacherId: string; sessionId: string; first: string; second: string }> {
  const teacher = mintTeacherKey(database, "Ms Rivera");
  const session = createClassroomSession(database, teacher.teacherId, "lifecycle-test-secret-32-characters");
  database.prepare("UPDATE sessions SET settings_json = ? WHERE session_id = ?")
    .run(JSON.stringify(ONE_V_100_DEFAULT_SETTINGS), session.sessionId);
  const first = addPlayer(session.sessionId, "Ari", 1_000, 5);
  const second = addPlayer(session.sessionId, "Bo", 2_000, 20);
  return Object.freeze({ teacherId: teacher.teacherId, sessionId: session.sessionId, first, second });
}

function addQuestion(sessionId: string, position: number, choices = ["A", "B", "C"]): string {
  const questionSet = database.prepare("SELECT question_set_id FROM sessions WHERE session_id = ?")
    .get(sessionId) as { question_set_id: string };
  const questionId = uuidV7(20_000 + position);
  database.prepare(
    `INSERT INTO questions
      (question_id, question_set_id, position, prompt, choices_json, correct_choice, phase_a_seconds)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
  ).run(questionId, questionSet.question_set_id, position, `Question ${position}`, JSON.stringify(choices), choices.length - 1);
  return questionId;
}

function startRoundEngine(
  data: ReturnType<typeof fixture>,
  events: RulesetLifecycleEvent[] = [],
  connected = new Set([data.first, data.second]),
): OneV100Engine {
  const engine = new OneV100Engine({
    sessionId: data.sessionId,
    coordinator: new CommandCoordinator(database),
    repository: new SqliteRulesetRepository(database),
    wallNow: () => 10_000,
    monotonicNow: () => 5_000,
    connectedPlayerIds: () => connected,
    publish: (event) => events.push(event),
  });
  engine.startSession({ teacherId: data.teacherId, requestId: "round-start", firstOnePlayerId: data.first });
  return engine;
}

function startEngineWithDeck(
  data: ReturnType<typeof fixture>,
  questionCount: number,
  events: RulesetLifecycleEvent[] = [],
  connected = new Set([data.first, data.second]),
): OneV100Engine {
  database.prepare("UPDATE sessions SET settings_json = ? WHERE session_id = ?").run(JSON.stringify({
    ...ONE_V_100_DEFAULT_SETTINGS,
    questions_per_game: questionCount,
    session_question_budget: Math.max(ONE_V_100_DEFAULT_SETTINGS.session_question_budget, questionCount),
  }), data.sessionId);
  return startRoundEngine(data, events, connected);
}

function enableMomentum(data: ReturnType<typeof fixture>, questionCount: number): void {
  database.prepare("UPDATE sessions SET settings_json = ? WHERE session_id = ?").run(JSON.stringify({
    ...ONE_V_100_DEFAULT_SETTINGS,
    momentum_enabled: true,
    questions_per_game: questionCount,
    session_question_budget: Math.max(ONE_V_100_DEFAULT_SETTINGS.session_question_budget, questionCount),
  }), data.sessionId);
}

function exposeIfLocked(engine: OneV100Engine): void {
  if (engine.phase === "PHASE_A_LOCKED") {
    expect(engine.startPhaseB()).toMatchObject({ ok: true });
  }
}

function playCorrectMomentumQuestion(
  engine: OneV100Engine,
  data: ReturnType<typeof fixture>,
  request: string,
): void {
  expect(engine.startPhaseA({ teacherId: data.teacherId, requestId: `${request}-open` })).toMatchObject({ ok: true });
  const active = engine.game!.snapshot.active!;
  expect(engine.answerPhaseA({
    playerId: data.second,
    requestId: `${request}-mob`,
    attemptId: active.attempt_id,
    questionId: active.question_id,
    choice: active.correct_choice,
  })).toMatchObject({ ok: true });
  exposeIfLocked(engine);
  exposeIfLocked(engine);
  expect(engine.answerOne({
    playerId: data.first,
    requestId: `${request}-one`,
    attemptId: active.attempt_id,
    questionId: active.question_id,
    choice: active.correct_choice,
  })).toMatchObject({ ok: true });
}

describe("1v100 game lifecycle", () => {
  it("persists game 1, chair history, roles, and the game_start contract", () => {
    const data = fixture();
    const events: RulesetLifecycleEvent[] = [];
    const engine = new OneV100Engine({
      sessionId: data.sessionId,
      coordinator: new CommandCoordinator(database),
      repository: new SqliteRulesetRepository(database),
      wallNow: () => 10_000,
      publish: (event) => events.push(event),
    });

    const result = engine.startSession({ teacherId: data.teacherId, requestId: "start-1", firstOnePlayerId: data.first });
    const players = database.prepare(
      "SELECT player_id, role, has_been_one FROM session_players WHERE session_id = ? ORDER BY joined_at_ms",
    ).all(data.sessionId);

    expect(result.ok).toBe(true);
    expect(players).toEqual([
      { player_id: data.first, role: "one", has_been_one: 1 },
      { player_id: data.second, role: "mob", has_been_one: 0 },
    ]);
    expect(events[0]?.payload).toMatchObject({
      ordinal: 1,
      one: { id: data.first, nickname: "Ari" },
      mob_count: 1,
      deck_size: 1,
      base_strikes: 2,
      momentum_enabled: false,
    });
  });

  it("restores chair history and pending boundary selection after restart", () => {
    const data = fixture();
    const repository = new SqliteRulesetRepository(database);
    const first = new OneV100Engine({
      sessionId: data.sessionId,
      coordinator: new CommandCoordinator(database),
      repository,
      wallNow: () => 10_000,
      publish: vi.fn(),
    });
    first.startSession({ teacherId: data.teacherId, requestId: "start", firstOnePlayerId: data.first });
    first.endGame({ actorId: "system", requestId: "end", reason: "deck_survived" });
    first.selectNextOne({ teacherId: data.teacherId, requestId: "select", playerId: data.second });

    const restored = new OneV100Engine({
      sessionId: data.sessionId,
      coordinator: new CommandCoordinator(database),
      repository,
      wallNow: () => 11_000,
      publish: vi.fn(),
    });
    const result = restored.nextGame({ teacherId: data.teacherId, requestId: "next" });
    const game = database.prepare(
      "SELECT ordinal, one_player_id FROM games WHERE session_id = ? ORDER BY ordinal DESC LIMIT 1",
    ).get(data.sessionId);

    expect(result.ok).toBe(true);
    expect(game).toEqual({ ordinal: 2, one_player_id: data.second });
  });

  it("selects highest score, then earliest join, then player id", () => {
    const players: RulesetPlayer[] = [
      { id: "b", nickname: "B", role: "mob", points: 20, streak: 0, hasBeenOne: false, joinedAtMs: 1 },
      { id: "a", nickname: "A", role: "mob", points: 20, streak: 0, hasBeenOne: false, joinedAtMs: 1 },
      { id: "c", nickname: "C", role: "mob", points: 50, streak: 0, hasBeenOne: true, joinedAtMs: 0 },
    ];
    expect(selectNextOne(players)?.id).toBe("a");
  });

  it("delivers game_start only after the One has moved to the One room", async () => {
    const secret = "lifecycle-gateway-secret-32-characters";
    const teacher = mintTeacherKey(database, "Gateway Teacher");
    const session = createClassroomSession(database, teacher.teacherId, secret);
    database.prepare("UPDATE sessions SET settings_json = ? WHERE session_id = ?")
      .run(JSON.stringify(ONE_V_100_DEFAULT_SETTINGS), session.sessionId);
    const server = createAppServer();
    const gateway = attachSocketGateway(server, { database, tokenSecret: secret });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP listener");
    const url = `http://127.0.0.1:${address.port}`;
    const client = (auth?: Record<string, string>): ClientSocket => {
      const socket = createClient(url, { forceNew: true, reconnection: false, ...(auth === undefined ? {} : { auth }) });
      clients.push(socket);
      return socket;
    };

    try {
      const firstSocket = client();
      const first = await ack<{ player_id: string; token: string }>(firstSocket, "join_session", {
        code: session.code,
        nickname: "Ari",
      });
      const mobSocket = client();
      await ack(mobSocket, "join_session", { code: session.code, nickname: "Bo" });
      const teacherSocket = client({ teacher_token: createTeacherToken(teacher.teacherId, secret) });
      await ack(teacherSocket, "teacher_attach", { session_id: session.sessionId });
      const frames: unknown[] = [];
      firstSocket.on("game_start", (frame) => frames.push(frame));
      const gameStart = new Promise<unknown>((resolve) => firstSocket.once("game_start", resolve));

      const started = await ack<Record<string, unknown>>(teacherSocket, "teacher_start_session", {
        request_id: "gateway-start",
        first_one_player_id: first.player_id,
      });
      await gameStart;
      const serverSocket = gateway.sockets.sockets.get(firstSocket.id ?? "");

      expect(started).toMatchObject({ ok: true, gameId: expect.any(String) });
      expect(frames).toEqual([expect.objectContaining({
        game_id: expect.any(String),
        ordinal: 1,
        one: { id: first.player_id, nickname: "Ari" },
        mob_count: 1,
        deck_size: 1,
        base_strikes: 2,
        momentum_enabled: false,
      })]);
      expect(serverSocket?.rooms).toContain(oneRoom(session.sessionId));
      expect(serverSocket?.rooms).not.toContain(answererRoom(session.sessionId));
    } finally {
      for (const clientSocket of clients.splice(0)) clientSocket.disconnect();
      await gateway.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("hydrates a cold projector with the completed game and leaderboard", async () => {
    const secret = "leaderboard-snapshot-secret-32-chars";
    const teacher = mintTeacherKey(database, "Leaderboard Teacher");
    const session = createClassroomSession(database, teacher.teacherId, secret);
    database.prepare("UPDATE sessions SET settings_json = ? WHERE session_id = ?")
      .run(JSON.stringify(ONE_V_100_DEFAULT_SETTINGS), session.sessionId);
    const oneId = addPlayer(session.sessionId, "Ari", 1_000, 5);
    addPlayer(session.sessionId, "Bo", 2_000, 20);
    const engine = new OneV100Engine({
      sessionId: session.sessionId,
      coordinator: new CommandCoordinator(database),
      repository: new SqliteRulesetRepository(database),
      wallNow: () => 10_000,
      publish: vi.fn(),
    });
    engine.startSession({ teacherId: teacher.teacherId, requestId: "snapshot-start", firstOnePlayerId: oneId });
    engine.endGame({
      actorId: "system",
      requestId: "snapshot-end",
      reason: "deck_survived",
      payouts: [{ player_id: oneId, points: 25 }],
      bankedByOne: 25,
    });

    const server = createAppServer();
    const gateway = attachSocketGateway(server, { database, tokenSecret: secret });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP listener");
    const projector = createClient(`http://127.0.0.1:${address.port}`, { forceNew: true, reconnection: false });
    clients.push(projector);
    try {
      const attached = await ack<Record<string, unknown>>(projector, "projector_attach", {
        projector_token: session.projectorToken,
      });
      expect(attached).toMatchObject({
        snapshot: {
          server_seq: expect.any(Number),
          session: { mode: "one_v_100" },
          game: {
            ordinal: 1,
            one: { player_id: oneId, nickname: "Ari" },
            mob_count: 1,
            phase: "LEADERBOARD",
            last_result: {
              reason: "deck_survived",
              payouts: [{ player_id: oneId, points: 25 }],
              banked_by_one: 25,
            },
          },
          leaderboard: expect.arrayContaining([
            expect.objectContaining({ player_id: oneId, nickname: "Ari", has_been_one: true }),
          ]),
        },
      });
      expect(attached).not.toHaveProperty("snapshot.self");
    } finally {
      projector.disconnect();
      await gateway.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("sends Phase A question fields only to answerers on raw sockets", async () => {
    const secret = `phase-a-${"visibility-test-".repeat(2)}`;
    const teacher = mintTeacherKey(database, "Visibility Teacher");
    const session = createClassroomSession(database, teacher.teacherId, secret);
    database.prepare("UPDATE sessions SET settings_json = ? WHERE session_id = ?")
      .run(JSON.stringify(ONE_V_100_DEFAULT_SETTINGS), session.sessionId);
    const server = createAppServer();
    const gateway = attachSocketGateway(server, { database, tokenSecret: secret });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP listener");
    const url = `http://127.0.0.1:${address.port}`;
    const client = (auth?: Record<string, string>): ClientSocket => {
      const socket = createClient(url, { forceNew: true, reconnection: false, ...(auth === undefined ? {} : { auth }) });
      clients.push(socket);
      return socket;
    };

    try {
      const oneSocket = client();
      const one = await ack<{ player_id: string; token: string }>(oneSocket, "join_session", { code: session.code, nickname: "Ari" });
      const mobSocket = client();
      const mob = await ack<{ player_id: string; token: string }>(mobSocket, "join_session", { code: session.code, nickname: "Bo" });
      const projectorSocket = client();
      await ack(projectorSocket, "projector_attach", { projector_token: session.projectorToken });
      const teacherSocket = client({ teacher_token: createTeacherToken(teacher.teacherId, secret) });
      await ack(teacherSocket, "teacher_attach", { session_id: session.sessionId });
      await ack(teacherSocket, "teacher_start_session", {
        request_id: "visibility-start",
        first_one_player_id: one.player_id,
      });
      const mobFrame = new Promise<Record<string, unknown>>((resolve) => mobSocket.once("phase_a_start", resolve));
      const oneFrame = new Promise<Record<string, unknown>>((resolve) => oneSocket.once("phase_a_status", resolve));
      const projectorFrame = new Promise<Record<string, unknown>>((resolve) => projectorSocket.once("phase_a_status", resolve));

      const result = await ack<Record<string, unknown>>(teacherSocket, "teacher_advance", {
        request_id: "visibility-advance",
      });
      const [mobPacket, onePacket, projectorPacket] = await Promise.all([mobFrame, oneFrame, projectorFrame]);

      expect(result).toMatchObject({ ok: true });
      expect(mobPacket).toMatchObject({ prompt: expect.any(String), choices: expect.any(Array) });
      for (const packet of [onePacket, projectorPacket]) {
        expect(packet).toMatchObject({ locked_count: 0, eligible_count: 1 });
        expect(packet).not.toHaveProperty("question_id");
        expect(packet).not.toHaveProperty("prompt");
        expect(packet).not.toHaveProperty("choices");
        expect(packet).not.toHaveProperty("correct_choice");
        expect(packet).not.toHaveProperty("was_correct");
        expectNoCorrectness(packet);
      }
      expectNoCorrectness(mobPacket);

      const attachedProjector = client();
      const projectorAttach = await ack<Record<string, unknown>>(attachedProjector, "projector_attach", {
        projector_token: session.projectorToken,
      });
      expect(projectorAttach).toMatchObject({ ok: true, snapshot: { phase: "PHASE_A" } });
      expect(projectorAttach).not.toHaveProperty("snapshot.question");
      expect(projectorAttach).not.toHaveProperty("snapshot.game.question");
      expectNoCorrectness(projectorAttach);

      const attachedTeacher = client({ teacher_token: createTeacherToken(teacher.teacherId, secret) });
      const teacherAttach = await ack<Record<string, unknown>>(attachedTeacher, "teacher_attach", { session_id: session.sessionId });
      expect(teacherAttach).toMatchObject({ ok: true, snapshot: { phase: "PHASE_A" } });
      expectNoCorrectness(teacherAttach);

      mobSocket.disconnect();
      const resumedMobSocket = client();
      const resumedMob = await ack<Record<string, unknown>>(resumedMobSocket, "resume", {
        token: mob.token,
        request_id: "resume-answerer-phase-a",
      });
      expect(resumedMob).toMatchObject({
        snapshot: {
          server_seq: expect.any(Number),
          game: {
            phase: "PHASE_A",
            question: {
              question_id: mobPacket.question_id,
              prompt: mobPacket.prompt,
              choices: mobPacket.choices,
              deadline_ms: expect.any(Number),
            },
          },
          leaderboard: expect.any(Array),
          self: {
            player_id: mob.player_id,
            role: "mob",
            points: expect.any(Number),
            streak: expect.any(Number),
            answered: false,
            is_speaker: false,
          },
        },
      });

      const lateSocket = client();
      const lateJoin = await ack<Record<string, unknown>>(lateSocket, "join_session", { code: session.code, nickname: "Cy" });
      expect(lateJoin).toMatchObject({ role: "crowd", late_join: true, snapshot: { phase: "PHASE_A" } });
      expect(lateJoin).not.toHaveProperty("snapshot.question");
      expect(lateJoin).not.toHaveProperty("snapshot.game.question");
      expect(lateJoin).toHaveProperty("snapshot.self.answered", false);
      expect(lateJoin).toHaveProperty("snapshot.leaderboard", expect.any(Array));
      expectNoCorrectness(lateJoin);

      expect(await ack<Record<string, unknown>>(lateSocket, "answer_submit", {
        request_id: "late-join-answer",
        attempt_id: mobPacket.attempt_id,
        question_id: mobPacket.question_id,
        choice: 0,
      })).toMatchObject({ ok: false, code: "FORBIDDEN", message: expect.any(String) });

      oneSocket.disconnect();
      const resumedOneSocket = client();
      const resumed = await ack<Record<string, unknown>>(resumedOneSocket, "resume", {
        token: one.token,
        request_id: "resume-one-phase-a",
      });
      expect(resumed).toMatchObject({ ok: true, role: "one", snapshot: { phase: "PHASE_A" } });
      expect(resumed).not.toHaveProperty("snapshot.question");
      expect(resumed).not.toHaveProperty("snapshot.game.question");
      expectNoCorrectness(resumed);
      const resumedServerSocket = gateway.sockets.sockets.get(resumedOneSocket.id ?? "");
      expect(resumedServerSocket?.rooms).toContain(oneRoom(session.sessionId));
      expect(resumedServerSocket?.rooms).not.toContain(answererRoom(session.sessionId));

      const roleChange = await ack<Record<string, unknown>>(teacherSocket, "assign_role", {
        request_id: "role-during-phase-a",
        player_id: one.player_id,
        role: "mob",
      });
      expect(roleChange).toMatchObject({ ok: false, code: "WRONG_PHASE" });

      expect(await ack<Record<string, unknown>>(resumedMobSocket, "one_answer", {
        request_id: "mob-cannot-one-answer",
        attempt_id: mobPacket.attempt_id,
        question_id: mobPacket.question_id,
        choice: 0,
      })).toMatchObject({ ok: false, code: "FORBIDDEN", message: expect.any(String) });

      const genericFrames: unknown[] = [];
      resumedOneSocket.on("question_open", (frame) => genericFrames.push(frame));
      projectorSocket.on("question_open", (frame) => genericFrames.push(frame));
      const generic = await ack<Record<string, unknown>>(teacherSocket, "teacher_open_question", {
        request_id: "generic-during-ruleset",
      });
      expect(generic).toMatchObject({ ok: false, code: "WRONG_PHASE", message: expect.any(String) });

      const lockCounts = [resumedOneSocket, resumedMobSocket, projectorSocket, teacherSocket].map((socket) =>
        new Promise<Record<string, unknown>>((resolve) => socket.once("lock_counts", resolve)));
      const phaseB = [resumedOneSocket, resumedMobSocket, projectorSocket, teacherSocket].map((socket) =>
        new Promise<Record<string, unknown>>((resolve) => socket.once("phase_b_start", resolve)));
      const answer = await ack<Record<string, unknown>>(resumedMobSocket, "answer_submit", {
        request_id: "raw-answer-ack",
        attempt_id: mobPacket.attempt_id,
        question_id: mobPacket.question_id,
        choice: 0,
      });
      expect(answer).toMatchObject({
        ok: true,
        question_id: mobPacket.question_id,
        locked: true,
        received_at_ms: expect.any(Number),
      });
      for (const packet of await Promise.all(lockCounts)) {
        expect(packet).toMatchObject({ locked_count: 1, eligible_count: 1 });
        expectNoCorrectness(packet);
      }
      // Teacher-gated exposure: the question reaches The One only on advance.
      expect(await ack<Record<string, unknown>>(teacherSocket, "teacher_advance", {
        request_id: "visibility-expose",
      })).toMatchObject({ ok: true });
      const phaseBPackets = await Promise.all(phaseB);
      for (const packet of phaseBPackets) {
        expect(packet).toMatchObject({ question_id: mobPacket.question_id, prompt: expect.any(String), choices: expect.any(Array) });
        expectNoCorrectness(packet);
      }

      // The disconnecting One cannot receive its own pause; all remaining audiences must.
      const pausedFrames = [resumedMobSocket, projectorSocket, teacherSocket].map((socket) =>
        new Promise<Record<string, unknown>>((resolve) => socket.once("pause_state", resolve)));
      resumedOneSocket.disconnect();
      const pausedPackets = await Promise.all(pausedFrames);
      for (const packet of pausedPackets) {
        expect(packet).toMatchObject({ paused: true, reason: "one_disconnected" });
        expectNoCorrectness(packet);
      }
      expect(new Set(pausedPackets.map((packet) => packet.server_seq)).size).toBe(1);
      expect(new SqliteRulesetRepository(database).latestGame(session.sessionId)?.snapshot.phase).toBe("PAUSED");

      const phaseBOneSocket = client();
      const resumedAudiences = [phaseBOneSocket, resumedMobSocket, projectorSocket, teacherSocket];
      const unpausedFrames = resumedAudiences.map((socket) =>
        new Promise<Record<string, unknown>>((resolve) => socket.once("pause_state", resolve)));
      const reexposedFrames = resumedAudiences.map((socket) =>
        new Promise<Record<string, unknown>>((resolve) => socket.once("phase_b_start", resolve)));
      const phaseBResume = await ack<Record<string, unknown>>(phaseBOneSocket, "resume", {
        token: one.token,
        request_id: "resume-one-phase-b",
      });
      const [unpausedPackets, reexposedPackets] = await Promise.all([
        Promise.all(unpausedFrames),
        Promise.all(reexposedFrames),
      ]);
      expect(phaseBResume).toMatchObject({
        ok: true,
        player_id: one.player_id,
        role: "one",
        snapshot: {
          phase: "PHASE_B",
          attempt_id: mobPacket.attempt_id,
          question_exposed: true,
          paused: null,
          game: {
            phase: "PHASE_B",
            helps_available: { poll: true, ask: true, trust: true },
            question: {
              question_id: mobPacket.question_id,
              prompt: mobPacket.prompt,
              choices: mobPacket.choices,
            },
          },
          leaderboard: expect.any(Array),
          self: {
            player_id: one.player_id,
            role: "one",
            answered: false,
            is_speaker: false,
          },
        },
      });
      expectNoCorrectness(phaseBResume);
      for (const packet of unpausedPackets) {
        expect(packet).toMatchObject({ paused: false, reason: "one_reconnected" });
        expectNoCorrectness(packet);
      }
      expect(new Set(unpausedPackets.map((packet) => packet.server_seq)).size).toBe(1);
      for (const packet of reexposedPackets) {
        expect(packet).toMatchObject({
          attempt_id: mobPacket.attempt_id,
          question_id: mobPacket.question_id,
          prompt: mobPacket.prompt,
          choices: mobPacket.choices,
          started_at_ms: expect.any(Number),
        });
        expectNoCorrectness(packet);
      }
      expect(new Set(reexposedPackets.map((packet) => packet.server_seq)).size).toBe(1);
      expect(Number(reexposedPackets[0]?.server_seq)).toBeGreaterThan(Number(unpausedPackets[0]?.server_seq));
      const phaseBServerSocket = gateway.sockets.sockets.get(phaseBOneSocket.id ?? "");
      expect(phaseBServerSocket?.rooms).toContain(oneRoom(session.sessionId));
      expect(phaseBServerSocket?.rooms).not.toContain(answererRoom(session.sessionId));

      const oneAnswer = await ack<Record<string, unknown>>(phaseBOneSocket, "one_answer", {
        request_id: "raw-one-answer",
        attempt_id: mobPacket.attempt_id,
        question_id: mobPacket.question_id,
        choice: 1,
      });
      expect(oneAnswer).toMatchObject({ ok: true, locked: true, question_id: mobPacket.question_id });
      expect(oneAnswer).toHaveProperty("received_at_ms", expect.any(Number));
      for (const packet of [mobPacket, onePacket, projectorPacket, answer, oneAnswer]) expectNoCorrectness(packet);
      expect(await ack<Record<string, unknown>>(phaseBOneSocket, "one_answer", {
        request_id: "late-one-answer",
        question_id: String(mobPacket.question_id),
        choice: 1,
      })).toMatchObject({ ok: false, code: "WRONG_PHASE", message: "Wait for the next question" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(genericFrames).toEqual([]);
    } finally {
      for (const clientSocket of clients.splice(0)) clientSocket.disconnect();
      await gateway.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10_000);

  it("resets every role and streak atomically at the next-game boundary", () => {
    const data = fixture();
    const third = addPlayer(data.sessionId, "Cy", 3_000, 10);
    const repository = new SqliteRulesetRepository(database);
    const engine = new OneV100Engine({
      sessionId: data.sessionId,
      coordinator: new CommandCoordinator(database),
      repository,
      wallNow: () => 10_000,
      publish: vi.fn(),
    });
    engine.startSession({ teacherId: data.teacherId, requestId: "start-reset", firstOnePlayerId: data.first });
    database.prepare("UPDATE session_players SET role = 'crowd', streak = 4 WHERE player_id = ?").run(third);
    database.prepare("UPDATE session_players SET streak = 3 WHERE player_id = ?").run(data.second);
    engine.endGame({ actorId: "system", requestId: "end-reset", reason: "deck_survived" });

    const result = engine.nextGame({ teacherId: data.teacherId, requestId: "next-reset" });
    const players = database.prepare(
      "SELECT player_id, role, points, streak FROM session_players WHERE session_id = ? ORDER BY joined_at_ms",
    ).all(data.sessionId);

    expect(result.ok).toBe(true);
    expect(players).toEqual([
      { player_id: data.first, role: "mob", points: 5, streak: 0 },
      { player_id: data.second, role: "one", points: 20, streak: 0 },
      { player_id: third, role: "mob", points: 10, streak: 0 },
    ]);
  });

  it("runs Phase A through automatic Phase B to a deck-survived reveal", () => {
    const data = fixture();
    const events: RulesetLifecycleEvent[] = [];
    const engine = startRoundEngine(data, events);

    const opened = engine.startPhaseA({ teacherId: data.teacherId, requestId: "advance-question" });
    const active = engine.game?.snapshot.active;
    expect(opened.ok).toBe(true);
    expect(active).toMatchObject({ index: 1, eligible_player_ids: [data.second] });

    const answered = engine.answerPhaseA({
      playerId: data.second,
      requestId: "mob-answer",
      attemptId: active?.attempt_id ?? "",
      questionId: active?.question_id ?? "",
      choice: 1,
    });
    exposeIfLocked(engine);
    expect(answered.ok).toBe(true);
    expect(engine.phase).toBe("PHASE_B");

    exposeIfLocked(engine);
    const oneAnswer = engine.answerOne({
      playerId: data.first,
      requestId: "one-answer",
      attemptId: active?.attempt_id ?? "",
      questionId: active?.question_id ?? "",
      choice: 1,
    });
    expect(oneAnswer.ok).toBe(true);
    expect(engine.phase).toBe("LEADERBOARD");
    expect(engine.game).toMatchObject({ status: "ended", endReason: "deck_survived" });
    expect(events.find((event) => event.type === "game_end")?.payload).toMatchObject({
      reason: "deck_survived",
      payouts: [{ player_id: data.second, points: 15 }],
    });
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "phase_a_start",
      "phase_a_status",
      "phase_a_locked",
      "phase_b_start",
      "reveal",
      "game_end",
      "leaderboard",
    ]));
    expect(database.prepare(
      "SELECT event_type FROM game_events WHERE session_id = ? ORDER BY server_seq DESC LIMIT 1",
    ).get(data.sessionId)).toEqual({ event_type: "leaderboard" });
  });

  it("demotes the final Mob and pays The One's mob-emptied jackpot", () => {
    const data = fixture();
    const events: RulesetLifecycleEvent[] = [];
    const engine = startRoundEngine(data, events);
    engine.startPhaseA({ teacherId: data.teacherId, requestId: "mob-empty-open" });
    const active = engine.game?.snapshot.active;

    expect(engine.answerPhaseA({
      playerId: data.second,
      requestId: "mob-empty-mob",
      attemptId: active?.attempt_id ?? "",
      questionId: active?.question_id ?? "",
      choice: 0,
    })).toMatchObject({ ok: true });
    exposeIfLocked(engine);
    exposeIfLocked(engine);
    expect(engine.answerOne({
      playerId: data.first,
      requestId: "mob-empty-one",
      attemptId: active?.attempt_id ?? "",
      questionId: active?.question_id ?? "",
      choice: 1,
    })).toMatchObject({ ok: true });

    expect(engine.phase).toBe("LEADERBOARD");
    expect(engine.game).toMatchObject({ status: "ended", endReason: "mob_emptied", bank: 20 });
    expect(events.find((event) => event.type === "reveal")).toMatchObject({
      payload: {
        demoted: [data.second],
        bank_delta: 20,
        bank: 20,
        score_deltas: expect.arrayContaining([
          { player_id: data.first, points: 30, reason: "jackpot" },
        ]),
      },
      roleChanges: [{ playerId: data.second, role: "crowd" }],
    });
    expect(events.find((event) => event.type === "game_end")?.payload).toMatchObject({
      reason: "mob_emptied",
      payouts: [{ player_id: data.first, points: 30 }],
      bank: 20,
      banked_by_one: 30,
    });
    expect(database.prepare(
      "SELECT role FROM session_players WHERE session_id = ? AND player_id = ?",
    ).get(data.sessionId, data.second)).toEqual({ role: "crowd" });
  });

  it("rolls back the final Phase A answer when the lock cannot be committed", () => {
    const data = fixture();
    const engine = startRoundEngine(data);
    engine.startPhaseA({ teacherId: data.teacherId, requestId: "atomic-open" });
    const active = engine.game?.snapshot.active;
    database.exec(`CREATE TRIGGER reject_lock BEFORE INSERT ON game_events
      WHEN NEW.event_type = 'phase_a_locked' BEGIN SELECT RAISE(ABORT, 'reject lock'); END`);

    const answer = () => engine.answerPhaseA({
      playerId: data.second,
      requestId: "atomic-mob-answer",
      attemptId: active?.attempt_id ?? "",
      questionId: active?.question_id ?? "",
      choice: 0,
    });
    expect(answer).toThrow(/reject lock/);
    expect(engine.phase).toBe("PHASE_A");
    expect(new SqliteRulesetRepository(database).latestGame(data.sessionId)?.snapshot.active?.answers).toEqual([]);

    database.exec("DROP TRIGGER reject_lock");
    expect(answer()).toMatchObject({ ok: true });
    expect(engine.phase).toBe("PHASE_A_LOCKED");

    // Exposure is its own atomic step: a failed phase_b_start leaves the game
    // safely locked, and a retry exposes it.
    database.exec(`CREATE TRIGGER reject_phase_b BEFORE INSERT ON game_events
      WHEN NEW.event_type = 'phase_b_start' BEGIN SELECT RAISE(ABORT, 'reject phase b'); END`);
    expect(() => engine.startPhaseB()).toThrow(/reject phase b/);
    expect(engine.phase).toBe("PHASE_A_LOCKED");
    database.exec("DROP TRIGGER reject_phase_b");
    expect(engine.startPhaseB()).toMatchObject({ ok: true });
    expect(engine.phase).toBe("PHASE_B");
  });

  it("rolls back the One answer when reveal cannot be committed", () => {
    const data = fixture();
    const engine = startRoundEngine(data);
    engine.startPhaseA({ teacherId: data.teacherId, requestId: "reveal-atomic-open" });
    const active = engine.game?.snapshot.active;
    engine.answerPhaseA({
      playerId: data.second,
      requestId: "reveal-atomic-mob",
      attemptId: active?.attempt_id ?? "",
      questionId: active?.question_id ?? "",
      choice: 0,
    });
    exposeIfLocked(engine);
    database.exec(`CREATE TRIGGER reject_reveal BEFORE INSERT ON game_events
      WHEN NEW.event_type = 'reveal' BEGIN SELECT RAISE(ABORT, 'reject reveal'); END`);
    const answer = () => engine.answerOne({
      playerId: data.first,
      requestId: "reveal-atomic-one",
      attemptId: active?.attempt_id ?? "",
      questionId: active?.question_id ?? "",
      choice: 1,
    });

    expect(answer).toThrow(/reject reveal/);
    expect(engine.phase).toBe("PHASE_B");
    expect(new SqliteRulesetRepository(database).latestGame(data.sessionId)?.snapshot.active?.one_answer).toBeNull();
    database.exec("DROP TRIGGER reject_reveal");
    expect(answer()).toMatchObject({ ok: true });
    expect(engine.phase).toBe("LEADERBOARD");
  });

  it("ends the session in the same transaction as a budget-terminal reveal", () => {
    const data = fixture();
    database.prepare("UPDATE sessions SET settings_json = ? WHERE session_id = ?").run(JSON.stringify({
      ...ONE_V_100_DEFAULT_SETTINGS,
      session_question_budget: 1,
    }), data.sessionId);
    const engine = startRoundEngine(data);
    engine.startPhaseA({ teacherId: data.teacherId, requestId: "budget-open" });
    const active = engine.game?.snapshot.active;
    engine.answerPhaseA({
      playerId: data.second,
      requestId: "budget-mob",
      attemptId: active?.attempt_id ?? "",
      questionId: active?.question_id ?? "",
      choice: 0,
    });
    exposeIfLocked(engine);
    exposeIfLocked(engine);
    expect(engine.answerOne({
      playerId: data.first,
      requestId: "budget-one",
      attemptId: active?.attempt_id ?? "",
      questionId: active?.question_id ?? "",
      choice: 1,
    })).toMatchObject({ ok: true });

    expect(engine.phase).toBe("SESSION_ENDED");
    expect(database.prepare("SELECT status FROM sessions WHERE session_id = ?").get(data.sessionId)).toEqual({ status: "ended" });
    expect(database.prepare(
      "SELECT event_type FROM game_events WHERE session_id = ? ORDER BY server_seq DESC LIMIT 4",
    ).all(data.sessionId).map((row) => (row as { event_type: string }).event_type).reverse()).toEqual([
      "reveal", "game_end", "leaderboard", "session_end",
    ]);
  });

  it("returns transient WRONG_PHASE when teacher advances during an active phase", () => {
    const data = fixture();
    const engine = startRoundEngine(data);
    engine.startPhaseA({ teacherId: data.teacherId, requestId: "valid-advance" });

    const result = engine.startPhaseA({ teacherId: data.teacherId, requestId: "invalid-advance" });

    expect(result).toMatchObject({ ok: false, code: "WRONG_PHASE" });
    const stored = database.prepare(
      `SELECT request_id, payload_json FROM game_events
       WHERE session_id = ? AND event_type = 'command_rejected' ORDER BY server_seq DESC LIMIT 1`,
    ).get(data.sessionId) as { request_id: string | null; payload_json: string };
    expect(stored.request_id).toBeNull();
    expect(JSON.parse(stored.payload_json)).toMatchObject({ disposition: "transient", code: "WRONG_PHASE" });
  });

  it("applies phase timing settings at the next question boundary", () => {
    const data = fixture();
    const third = addPlayer(data.sessionId, "Cy", 3_000, 10);
    addQuestion(data.sessionId, 2);
    addQuestion(data.sessionId, 3);
    const events: RulesetLifecycleEvent[] = [];
    const engine = startEngineWithDeck(data, 2, events);
    engine.startPhaseA({ teacherId: data.teacherId, requestId: "settings-q1" });
    const first = engine.game?.snapshot.active;
    expect((first?.deadline_ms ?? 0) - (first?.started_at_ms ?? 0)).toBe(20_000);

    const settingsResult = engine.updateSettings({
      teacherId: data.teacherId,
      requestId: "settings-update",
      patch: { phase_a_seconds: 10, base_strikes: 3, momentum_enabled: true },
    });
    expect(settingsResult).toMatchObject({ ok: true, settings_revision: 2, phase_a_seconds: 10 });
    expect(engine.updateSettings({
      teacherId: data.teacherId,
      requestId: "settings-update",
      patch: { phase_a_seconds: 10, base_strikes: 3, momentum_enabled: true },
    })).toEqual(settingsResult);
    expect((engine.game?.snapshot.active?.deadline_ms ?? 0) - (engine.game?.snapshot.active?.started_at_ms ?? 0))
      .toBe(20_000);
    expect(new GameEventStore(database).readSession(data.sessionId).filter((event) =>
      event.eventType === "settings_updated"
    )).toHaveLength(1);
    engine.answerPhaseA({
      playerId: data.second,
      requestId: "settings-mob",
      attemptId: first?.attempt_id ?? "",
      questionId: first?.question_id ?? "",
      choice: 1,
    });
    exposeIfLocked(engine);
    exposeIfLocked(engine);
    engine.answerOne({
      playerId: data.first,
      requestId: "settings-one",
      attemptId: first?.attempt_id ?? "",
      questionId: first?.question_id ?? "",
      choice: 1,
    });
    expect(events.filter((event) => event.type.startsWith("meter_"))).toEqual([]);

    expect(engine.phase).toBe("BETWEEN_QUESTIONS");
    engine.startPhaseA({ teacherId: data.teacherId, requestId: "settings-q2" });
    const second = engine.game?.snapshot.active;
    expect((second?.deadline_ms ?? 0) - (second?.started_at_ms ?? 0)).toBe(10_000);
    expect(engine.game?.snapshot.settings_revision).toBe(2);
    expect(engine.game?.snapshot.settings.base_strikes).toBe(2);
    expect(engine.game?.snapshot.settings.momentum_enabled).toBe(true);
    expect(database.prepare("SELECT settings_revision FROM sessions WHERE session_id = ?").get(data.sessionId))
      .toEqual({ settings_revision: 2 });
    engine.answerPhaseA({
      playerId: data.second,
      requestId: "settings-q2-mob",
      attemptId: second?.attempt_id ?? "",
      questionId: second?.question_id ?? "",
      choice: 2,
    });
    exposeIfLocked(engine);
    exposeIfLocked(engine);
    engine.answerOne({
      playerId: data.first,
      requestId: "settings-q2-one",
      attemptId: second?.attempt_id ?? "",
      questionId: second?.question_id ?? "",
      choice: 2,
    });
    expect(events.filter((event) => event.type === "meter_progress")).toHaveLength(1);
    expect(events.find((event) => event.type === "meter_progress")?.payload).toMatchObject({
      progress: 1,
      credited: true,
      reason: "fast_correct",
    });
    expect(engine.phase).toBe("LEADERBOARD");
    engine.selectNextOne({ teacherId: data.teacherId, requestId: "settings-select", playerId: third });
    engine.nextGame({ teacherId: data.teacherId, requestId: "settings-next-game" });
    expect(engine.game).toMatchObject({ onePlayerId: third, strikesRemaining: 3 });
    expect(engine.game?.snapshot.settings.base_strikes).toBe(3);
  });

  it("emits no meter events or extra strike while momentum is disabled by default", () => {
    const data = fixture();
    for (let position = 2; position <= 5; position += 1) addQuestion(data.sessionId, position);
    const events: RulesetLifecycleEvent[] = [];
    const engine = startEngineWithDeck(data, 5, events);

    for (let question = 1; question <= 5; question += 1) {
      playCorrectMomentumQuestion(engine, data, `disabled-${question}`);
    }

    expect(events.filter((event) => event.type === "meter_progress" || event.type === "meter_filled")).toEqual([]);
    expect(engine.game).toMatchObject({ strikesRemaining: 2, snapshot: { momentum: { progress: 0, awarded_once: false } } });

    const reveals = events.filter((event) => event.type === "reveal");
    expect(reveals.length).toBeGreaterThan(0);
    for (const reveal of reveals) {
      expect(reveal.payload).toMatchObject({ fast_window_ms: null });
    }
    const storedReveals = database.prepare(
      "SELECT payload_json FROM game_events WHERE session_id = ? AND event_type = ?",
    ).all(data.sessionId, "reveal") as readonly { payload_json: string }[];
    expect(storedReveals.length).toBeGreaterThan(0);
    for (const stored of storedReveals) {
      expect(Object.keys(JSON.parse(stored.payload_json))).not.toContain("momentum_window");
    }
    expect(Object.keys(engine.liveSnapshot("teacher") ?? {})).not.toContain("momentum");
  });

  it("awards exactly one extra strike at four fast correct answers while progress continues", () => {
    const data = fixture();
    for (let position = 2; position <= 6; position += 1) addQuestion(data.sessionId, position);
    enableMomentum(data, 6);
    const events: RulesetLifecycleEvent[] = [];
    const engine = startRoundEngine(data, events);

    for (let question = 1; question <= 5; question += 1) {
      playCorrectMomentumQuestion(engine, data, `enabled-${question}`);
    }

    const progress = events.filter((event) => event.type === "meter_progress");
    const filled = events.filter((event) => event.type === "meter_filled");
    expect(progress).toHaveLength(5);
    expect(progress.at(-1)?.payload).toMatchObject({ progress: 5, threshold: 4, credited: true });
    expect(filled).toHaveLength(1);
    expect(filled[0]?.payload).toEqual({ progress: 4, threshold: 4, strikes_remaining: 3, awarded_once: true });
    expect(engine.game).toMatchObject({ strikesRemaining: 3, snapshot: { momentum: { progress: 5, awarded_once: true } } });
  });

  it.each([
    ["wrong", "one_wrong"],
    ["slow", "too_slow"],
    ["help", "help_used"],
  ] as const)("does not credit a %s answer", (kind, reason) => {
    const data = fixture();
    addQuestion(data.sessionId, 2);
    enableMomentum(data, 2);
    const events: RulesetLifecycleEvent[] = [];
    let monotonic = 5_000;
    const engine = new OneV100Engine({
      sessionId: data.sessionId,
      coordinator: new CommandCoordinator(database),
      repository: new SqliteRulesetRepository(database),
      wallNow: () => 10_000,
      monotonicNow: () => monotonic,
      connectedPlayerIds: () => new Set([data.first, data.second]),
      publish: (event) => events.push(event),
    });
    engine.startSession({ teacherId: data.teacherId, requestId: `${kind}-start`, firstOnePlayerId: data.first });
    engine.startPhaseA({ teacherId: data.teacherId, requestId: `${kind}-open` });
    const active = engine.game!.snapshot.active!;
    engine.answerPhaseA({
      playerId: data.second,
      requestId: `${kind}-mob`,
      attemptId: active.attempt_id,
      questionId: active.question_id,
      choice: active.correct_choice,
    });
    exposeIfLocked(engine);
    if (kind === "slow") monotonic += 20_001;
    if (kind === "help") {
      expect(engine.helpPoll({ playerId: data.first, requestId: "help-poll", choice: active.correct_choice }))
        .toMatchObject({ ok: true });
    }
    exposeIfLocked(engine);
    engine.answerOne({
      playerId: data.first,
      requestId: `${kind}-one`,
      attemptId: active.attempt_id,
      questionId: active.question_id,
      choice: kind === "wrong" ? (active.correct_choice + 1) % active.choices.length : active.correct_choice,
    });

    expect(events.find((event) => event.type === "meter_progress")?.payload).toEqual({
      progress: 0,
      threshold: 4,
      credited: false,
      reason,
    });
    expect(events.some((event) => event.type === "meter_filled")).toBe(false);
    expect(engine.game?.snapshot.momentum).toEqual({ progress: 0, awarded_once: false });
  });

  it("restores earned progress and the once-per-game award from durable game state", () => {
    const data = fixture();
    for (let position = 2; position <= 5; position += 1) addQuestion(data.sessionId, position);
    enableMomentum(data, 5);
    const first = startRoundEngine(data);
    for (let question = 1; question <= 4; question += 1) {
      playCorrectMomentumQuestion(first, data, `restart-${question}`);
    }

    const columns = database.prepare(
      "SELECT momentum_progress, momentum_awarded FROM games WHERE game_id = ?",
    ).get(first.game?.gameId);
    expect(columns).toEqual({ momentum_progress: 4, momentum_awarded: 1 });

    const restoredEvents: RulesetLifecycleEvent[] = [];
    const restored = new OneV100Engine({
      sessionId: data.sessionId,
      coordinator: new CommandCoordinator(database),
      repository: new SqliteRulesetRepository(database),
      wallNow: () => 11_000,
      monotonicNow: () => 6_000,
      connectedPlayerIds: () => new Set([data.first, data.second]),
      publish: (event) => restoredEvents.push(event),
    });
    expect(restored.game).toMatchObject({
      strikesRemaining: 3,
      snapshot: { momentum: { progress: 4, awarded_once: true } },
    });
    expect(restored.liveSnapshot(data.first)).toMatchObject({
      momentum: { enabled: true, progress: 4, threshold: 4, awarded_once: true },
      game: { momentum: { enabled: true, progress: 4, threshold: 4, awarded_once: true } },
    });
    expect(snapshotView(restored.liveSnapshot(data.first), { audience: "one" })).toMatchObject({
      momentum: { progress: 4, awarded_once: true },
      game: { momentum: { progress: 4, awarded_once: true } },
    });
    expect(snapshotView(restored.liveSnapshot(), { audience: "teacher" })).toMatchObject({
      momentum: { progress: 4, awarded_once: true },
      game: { momentum: { progress: 4, awarded_once: true } },
    });
    playCorrectMomentumQuestion(restored, data, "restart-continued");
    expect(restored.game).toMatchObject({
      strikesRemaining: 3,
      snapshot: { momentum: { progress: 5, awarded_once: true } },
    });
    expect(restoredEvents.filter((event) => event.type === "meter_filled")).toEqual([]);
    expect(restoredEvents.find((event) => event.type === "meter_progress")?.payload).toMatchObject({ progress: 5 });
  });

  it("recovers locked and answered legacy attempts without stranding the game", () => {
    const data = fixture();
    const engine = startRoundEngine(data);
    engine.startPhaseA({ teacherId: data.teacherId, requestId: "legacy-open" });
    const game = engine.game;
    const active = game?.snapshot.active;
    if (game === null || game === undefined || active === null || active === undefined) throw new Error("Expected attempt");
    const locked = { ...game.snapshot, phase: "PHASE_A_LOCKED" as const };
    database.prepare("UPDATE games SET snapshot_json = ?, phase_b_exposed_at_ms = NULL WHERE game_id = ?")
      .run(JSON.stringify(locked), game.gameId);

    const recoveredLocked = new OneV100Engine({
      sessionId: data.sessionId,
      coordinator: new CommandCoordinator(database),
      repository: new SqliteRulesetRepository(database),
      wallNow: () => 11_000,
      connectedPlayerIds: () => new Set([data.first, data.second]),
      publish: vi.fn(),
    });
    // Teacher-gated exposure: a locked attempt is a stable state, not a
    // stranded one — recovery holds it and the teacher's advance exposes it.
    expect(recoveredLocked.recover()).toBeUndefined();
    expect(recoveredLocked.phase).toBe("PHASE_A_LOCKED");
    expect(recoveredLocked.startPhaseB()).toMatchObject({ ok: true });
    expect(recoveredLocked.phase).toBe("PHASE_B");

    const answered = {
      ...recoveredLocked.game!.snapshot,
      active: { ...recoveredLocked.game!.snapshot.active!, one_answer: 1, one_duration_ms: 500 },
    };
    database.prepare("UPDATE games SET snapshot_json = ? WHERE game_id = ?")
      .run(JSON.stringify(answered), game.gameId);
    const recoveredAnswered = new OneV100Engine({
      sessionId: data.sessionId,
      coordinator: new CommandCoordinator(database),
      repository: new SqliteRulesetRepository(database),
      wallNow: () => 12_000,
      connectedPlayerIds: () => new Set([data.first, data.second]),
      publish: vi.fn(),
    });
    expect(recoveredAnswered.recover()).toMatchObject({ ok: true });
    expect(recoveredAnswered.phase).toBe("LEADERBOARD");
    expect(database.prepare("SELECT COUNT(*) AS count FROM game_events WHERE game_id = ? AND event_type = 'reveal'")
      .get(game.gameId)).toEqual({ count: 1 });
  });

  it("supports repeated persisted disconnect and resume cycles for The One", () => {
    const data = fixture();
    const connected = new Set([data.first, data.second]);
    let now = 10_000;
    const engine = new OneV100Engine({
      sessionId: data.sessionId,
      coordinator: new CommandCoordinator(database),
      repository: new SqliteRulesetRepository(database),
      wallNow: () => now,
      connectedPlayerIds: () => connected,
      publish: vi.fn(),
    });
    engine.startSession({ teacherId: data.teacherId, requestId: "cycle-start", firstOnePlayerId: data.first });
    engine.startPhaseA({ teacherId: data.teacherId, requestId: "cycle-open" });
    const active = engine.game?.snapshot.active;
    engine.answerPhaseA({
      playerId: data.second,
      requestId: "cycle-mob",
      attemptId: active?.attempt_id ?? "",
      questionId: active?.question_id ?? "",
      choice: 0,
    });
    exposeIfLocked(engine);
    for (let cycle = 0; cycle < 2; cycle += 1) {
      connected.delete(data.first);
      expect(engine.pauseOneDisconnected(data.first)).toMatchObject({ ok: true });
      expect(engine.phase).toBe("PAUSED");
      now += 1_000;
      connected.add(data.first);
      expect(engine.resumeOne(data.first)).toMatchObject({ ok: true });
      expect(engine.phase).toBe("PHASE_B");
      now += 1_000;
    }
  });

  it("sums active Phase B time across pause and resume", () => {
    const data = fixture();
    const connected = new Set([data.first, data.second]);
    const events: RulesetLifecycleEvent[] = [];
    let wallNow = 10_000;
    let monotonicNow = 5_000;
    const engine = new OneV100Engine({
      sessionId: data.sessionId,
      coordinator: new CommandCoordinator(database),
      repository: new SqliteRulesetRepository(database),
      wallNow: () => wallNow,
      monotonicNow: () => monotonicNow,
      connectedPlayerIds: () => connected,
      publish: (event) => events.push(event),
    });
    engine.startSession({ teacherId: data.teacherId, requestId: "duration-start", firstOnePlayerId: data.first });
    engine.startPhaseA({ teacherId: data.teacherId, requestId: "duration-open" });
    const active = engine.game?.snapshot.active;
    engine.answerPhaseA({
      playerId: data.second,
      requestId: "duration-mob",
      attemptId: active?.attempt_id ?? "",
      questionId: active?.question_id ?? "",
      choice: 0,
    });
    exposeIfLocked(engine);

    wallNow += 3_000;
    monotonicNow += 3_000;
    connected.delete(data.first);
    expect(engine.pauseOneDisconnected(data.first)).toMatchObject({ ok: true });
    expect(new SqliteRulesetRepository(database).latestGame(data.sessionId)?.snapshot.active?.one_duration_ms)
      .toBe(3_000);

    wallNow += 20_000;
    monotonicNow += 20_000;
    connected.add(data.first);
    expect(engine.resumeOne(data.first)).toMatchObject({ ok: true });
    wallNow += 2_000;
    monotonicNow += 2_000;
    exposeIfLocked(engine);
    expect(engine.answerOne({
      playerId: data.first,
      requestId: "duration-one",
      attemptId: active?.attempt_id ?? "",
      questionId: active?.question_id ?? "",
      choice: 1,
    })).toMatchObject({ ok: true });

    expect(events.find((event) => event.type === "reveal")?.payload.one_duration_ms).toBe(5_000);
    const locked = database.prepare(
      "SELECT payload_json FROM game_events WHERE session_id = ? AND event_type = 'one_answer_locked'",
    ).get(data.sessionId) as { payload_json: string };
    expect(JSON.parse(locked.payload_json)).toMatchObject({ one_duration_ms: 5_000 });
  });

  it("recovers pre-restart active Phase B time before resuming", () => {
    const data = fixture();
    const connected = new Set([data.first, data.second]);
    let wallNow = 10_000;
    let monotonicNow = 5_000;
    const first = new OneV100Engine({
      sessionId: data.sessionId,
      coordinator: new CommandCoordinator(database),
      repository: new SqliteRulesetRepository(database),
      wallNow: () => wallNow,
      monotonicNow: () => monotonicNow,
      connectedPlayerIds: () => connected,
      publish: vi.fn(),
    });
    first.startSession({ teacherId: data.teacherId, requestId: "restart-duration-start", firstOnePlayerId: data.first });
    first.startPhaseA({ teacherId: data.teacherId, requestId: "restart-duration-open" });
    const active = first.game?.snapshot.active;
    first.answerPhaseA({
      playerId: data.second,
      requestId: "restart-duration-mob",
      attemptId: active?.attempt_id ?? "",
      questionId: active?.question_id ?? "",
      choice: 0,
    });
    expect(first.startPhaseB()).toMatchObject({ ok: true });

    wallNow += 4_000;
    connected.delete(data.first);
    monotonicNow = 50;
    const events: RulesetLifecycleEvent[] = [];
    const restored = new OneV100Engine({
      sessionId: data.sessionId,
      coordinator: new CommandCoordinator(database),
      repository: new SqliteRulesetRepository(database),
      wallNow: () => wallNow,
      monotonicNow: () => monotonicNow,
      connectedPlayerIds: () => connected,
      publish: (event) => events.push(event),
    });
    expect(restored.recover()).toMatchObject({ ok: true });
    expect(restored.phase).toBe("PAUSED");
    expect(new SqliteRulesetRepository(database).latestGame(data.sessionId)?.snapshot.active?.one_duration_ms)
      .toBe(4_000);

    wallNow += 15_000;
    monotonicNow += 15_000;
    connected.add(data.first);
    expect(restored.resumeOne(data.first)).toMatchObject({ ok: true });
    wallNow += 1_500;
    monotonicNow += 1_500;
    exposeIfLocked(restored);
    expect(restored.answerOne({
      playerId: data.first,
      requestId: "restart-duration-one",
      attemptId: active?.attempt_id ?? "",
      questionId: active?.question_id ?? "",
      choice: 1,
    })).toMatchObject({ ok: true });
    expect(events.find((event) => event.type === "reveal")?.payload.one_duration_ms).toBe(5_500);
  });

  it("does not let a Mob reconnect poison The One's paused resume", () => {
    const data = fixture();
    const connected = new Set([data.first, data.second]);
    const engine = new OneV100Engine({
      sessionId: data.sessionId,
      coordinator: new CommandCoordinator(database),
      repository: new SqliteRulesetRepository(database),
      wallNow: () => 10_000,
      connectedPlayerIds: () => connected,
      publish: vi.fn(),
    });
    engine.startSession({ teacherId: data.teacherId, requestId: "poison-start", firstOnePlayerId: data.first });
    engine.startPhaseA({ teacherId: data.teacherId, requestId: "poison-open" });
    const active = engine.game?.snapshot.active;
    engine.answerPhaseA({ playerId: data.second, requestId: "poison-mob", attemptId: active?.attempt_id ?? "", questionId: active?.question_id ?? "", choice: 0 });
    exposeIfLocked(engine);
    connected.delete(data.first);
    engine.pauseOneDisconnected(data.first);

    expect(engine.resumeOne(data.second)).toMatchObject({ ok: false, code: "WRONG_PHASE" });
    connected.add(data.first);
    expect(engine.resumeOne(data.first)).toMatchObject({ ok: true });
    expect(engine.phase).toBe("PHASE_B");
  });

  it("persists and publishes pause_state when The One is absent at the Phase B boundary", () => {
    const data = fixture();
    const connected = new Set([data.first, data.second]);
    const events: RulesetLifecycleEvent[] = [];
    const engine = startRoundEngine(data, events, connected);
    engine.startPhaseA({ teacherId: data.teacherId, requestId: "boundary-open" });
    const active = engine.game?.snapshot.active;
    connected.delete(data.first);
    expect(engine.answerPhaseA({
      playerId: data.second,
      requestId: "boundary-answer",
      attemptId: active?.attempt_id ?? "",
      questionId: active?.question_id ?? "",
      choice: 0,
    })).toMatchObject({ ok: true });
    exposeIfLocked(engine);

    expect(engine.phase).toBe("PAUSED");
    expect(engine.game?.snapshot.active?.phase_b_started_at_ms).toBeNull();
    expect(events.at(-1)).toMatchObject({
      type: "pause_state",
      payload: { paused: true, reason: "one_disconnected" },
    });
    expect(database.prepare("SELECT phase_b_exposed_at_ms FROM games WHERE game_id = ?").get(engine.game?.gameId))
      .toEqual({ phase_b_exposed_at_ms: null });
    const oneSnapshot = snapshotView(engine.liveSnapshot(data.first), { audience: "one" });
    expect(oneSnapshot).not.toHaveProperty("question");
  });

  it("attributes game starts and sequences lifecycle batches causally", () => {
    const data = fixture();
    const third = addPlayer(data.sessionId, "Cy", 3_000, 10);
    const events: RulesetLifecycleEvent[] = [];
    const engine = startRoundEngine(data, events);
    const firstGameId = engine.game?.gameId;
    const firstStart = database.prepare(
      "SELECT game_id FROM game_events WHERE session_id = ? AND event_type = 'game_start' ORDER BY server_seq LIMIT 1",
    ).get(data.sessionId);
    expect(firstStart).toEqual({ game_id: firstGameId });

    engine.endGame({ actorId: "system", requestId: "sequence-end", reason: "deck_survived" });
    engine.selectNextOne({ teacherId: data.teacherId, requestId: "sequence-select", playerId: third });
    const before = events.length;
    engine.nextGame({ teacherId: data.teacherId, requestId: "sequence-next" });
    const batch = events.slice(before);
    expect(batch.map((event) => event.type)).toEqual(["next_game", "game_start"]);
    expect(batch[0]!.serverSeq).toBeLessThan(batch[1]!.serverSeq);
    const nextGameId = engine.game?.gameId;
    expect(database.prepare(
      "SELECT event_type, game_id FROM game_events WHERE request_id = ? OR (game_id = ? AND event_type = 'game_start') ORDER BY server_seq",
    ).all("sequence-next", nextGameId)).toEqual([
      { event_type: "next_game", game_id: nextGameId },
      { event_type: "game_start", game_id: nextGameId },
    ]);
  });

  it("gives strike, reveal, game end, leaderboard, and session end distinct sequences", () => {
    const data = fixture();
    database.prepare("UPDATE sessions SET settings_json = ? WHERE session_id = ?").run(JSON.stringify({
      ...ONE_V_100_DEFAULT_SETTINGS,
      base_strikes: 1,
      session_question_budget: 1,
    }), data.sessionId);
    const events: RulesetLifecycleEvent[] = [];
    const engine = startRoundEngine(data, events);
    engine.startPhaseA({ teacherId: data.teacherId, requestId: "terminal-open" });
    const active = engine.game?.snapshot.active;
    engine.answerPhaseA({ playerId: data.second, requestId: "terminal-mob", attemptId: active?.attempt_id ?? "", questionId: active?.question_id ?? "", choice: 1 });
    exposeIfLocked(engine);
    exposeIfLocked(engine);
    engine.answerOne({ playerId: data.first, requestId: "terminal-one", attemptId: active?.attempt_id ?? "", questionId: active?.question_id ?? "", choice: 0 });
    const terminal = events.filter((event) => ["strike", "reveal", "game_end", "leaderboard", "session_end"].includes(event.type));
    expect(terminal.map((event) => event.type)).toEqual(["strike", "reveal", "game_end", "leaderboard", "session_end"]);
    expect(terminal.map((event) => event.serverSeq)).toEqual([...terminal.map((event) => event.serverSeq)].sort((a, b) => a - b));
    expect(new Set(terminal.map((event) => event.serverSeq)).size).toBe(terminal.length);
    expect(terminal.find((event) => event.type === "leaderboard")?.payload).toMatchObject({
      rows: expect.arrayContaining([expect.objectContaining({ has_been_one: expect.any(Boolean) })]),
    });
  });

  it("validates answer indexes against three- and four-choice attempts", () => {
    const data = fixture();
    const questionSet = database.prepare("SELECT question_set_id FROM sessions WHERE session_id = ?")
      .get(data.sessionId) as { question_set_id: string };
    database.prepare("UPDATE questions SET choices_json = ?, correct_choice = 2 WHERE question_set_id = ? AND position = 1")
      .run(JSON.stringify(["A", "B", "C"]), questionSet.question_set_id);
    addQuestion(data.sessionId, 2, ["A", "B", "C", "D"]);
    const engine = startRoundEngine(data);
    engine.startPhaseA({ teacherId: data.teacherId, requestId: "choices-q1" });
    const first = engine.game?.snapshot.active;
    expect(engine.answerPhaseA({ playerId: data.second, requestId: "choices-bad", attemptId: first?.attempt_id ?? "", questionId: first?.question_id ?? "", choice: 3 }))
      .toMatchObject({ ok: false, code: "INVALID_CHOICE" });
    exposeIfLocked(engine);
    engine.answerPhaseA({ playerId: data.second, requestId: "choices-q1-answer", attemptId: first?.attempt_id ?? "", questionId: first?.question_id ?? "", choice: 2 });
    exposeIfLocked(engine);
    exposeIfLocked(engine);
    engine.answerOne({ playerId: data.first, requestId: "choices-q1-one", attemptId: first?.attempt_id ?? "", questionId: first?.question_id ?? "", choice: 2 });
    engine.startPhaseA({ teacherId: data.teacherId, requestId: "choices-q2" });
    const second = engine.game?.snapshot.active;
    expect(second?.choices).toHaveLength(4);
    expect(engine.answerPhaseA({ playerId: data.second, requestId: "choices-four", attemptId: second?.attempt_id ?? "", questionId: second?.question_id ?? "", choice: 3 }))
      .toMatchObject({ ok: true });
    exposeIfLocked(engine);
  });

  it("restores a persisted Phase B attempt after restart", () => {
    const data = fixture();
    const first = startRoundEngine(data);
    first.startPhaseA({ teacherId: data.teacherId, requestId: "restore-open" });
    const active = first.game?.snapshot.active;
    first.answerPhaseA({
      playerId: data.second,
      requestId: "restore-mob-answer",
      attemptId: active?.attempt_id ?? "",
      questionId: active?.question_id ?? "",
      choice: 0,
    });
    expect(first.startPhaseB()).toMatchObject({ ok: true });

    const restored = new OneV100Engine({
      sessionId: data.sessionId,
      coordinator: new CommandCoordinator(database),
      repository: new SqliteRulesetRepository(database),
      wallNow: () => 11_000,
      monotonicNow: () => 6_000,
      connectedPlayerIds: () => new Set([data.first, data.second]),
      publish: vi.fn(),
    });

    expect(restored.phase).toBe("PHASE_B");
    expect(restored.game?.snapshot.active).toMatchObject({
      attempt_id: active?.attempt_id,
      answers: [{ player_id: data.second, choice: 0 }],
    });
    expect(restored.liveSnapshot(data.first)).toHaveProperty("question.prompt");
  });

  it("uses the durable exposure marker instead of restoring hidden Phase A", () => {
    const data = fixture();
    const first = startRoundEngine(data);
    first.startPhaseA({ teacherId: data.teacherId, requestId: "marker-open" });
    const phaseA = first.game?.snapshot;
    const active = phaseA?.active;
    first.answerPhaseA({
      playerId: data.second,
      requestId: "marker-mob",
      attemptId: active?.attempt_id ?? "",
      questionId: active?.question_id ?? "",
      choice: 0,
    });
    expect(first.startPhaseB()).toMatchObject({ ok: true });
    database.prepare("UPDATE games SET snapshot_json = ? WHERE game_id = ?")
      .run(JSON.stringify(phaseA), first.game?.gameId);

    const restored = new OneV100Engine({
      sessionId: data.sessionId,
      coordinator: new CommandCoordinator(database),
      repository: new SqliteRulesetRepository(database),
      wallNow: () => 11_000,
      connectedPlayerIds: () => new Set([data.first, data.second]),
      publish: vi.fn(),
    });
    expect(restored.phase).toBe("PHASE_B");
    expect(restored.liveSnapshot(data.first)).toHaveProperty("question.prompt");
  });

  it("keeps Phase A question fields out of One snapshots", () => {
    const data = fixture();
    const engine = startRoundEngine(data);
    engine.startPhaseA({ teacherId: data.teacherId, requestId: "snapshot-open" });

    const oneSnapshot = snapshotView(engine.liveSnapshot(data.first), { audience: "one" });
    const projected = JSON.stringify(oneSnapshot);

    expect(projected).toContain('"phase":"PHASE_A"');
    expect(projected).not.toContain('"correct_choice"');
    expect(projected).not.toContain('"was_correct"');
  });

  it("restores future and overdue Phase A deadlines on gateway boot", async () => {
    vi.useFakeTimers();
    const data = fixture();
    let now = 10_000;
    const engine = new OneV100Engine({
      sessionId: data.sessionId,
      coordinator: new CommandCoordinator(database),
      repository: new SqliteRulesetRepository(database),
      wallNow: () => now,
      connectedPlayerIds: () => new Set([data.first, data.second]),
      publish: vi.fn(),
    });
    engine.startSession({ teacherId: data.teacherId, requestId: "timer-start", firstOnePlayerId: data.first });
    engine.startPhaseA({ teacherId: data.teacherId, requestId: "timer-open" });
    const server = createAppServer();
    const gateway = attachSocketGateway(server, {
      database,
      tokenSecret: "timer-recovery-secret-32-characters",
      wallNow: () => now,
      monotonicNow: () => now,
    });
    try {
      expect(new SqliteRulesetRepository(database).latestGame(data.sessionId)?.snapshot.phase).toBe("PHASE_A");
      now = 30_000;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(new SqliteRulesetRepository(database).latestGame(data.sessionId)?.snapshot.phase).toBe("PHASE_A_LOCKED");
      expect(database.prepare("SELECT event_type FROM game_events WHERE session_id = ? ORDER BY server_seq DESC LIMIT 1")
        .all(data.sessionId).map((row) => (row as { event_type: string }).event_type)).toEqual([
        "phase_a_locked",
      ]);
    } finally {
      await gateway.close();
      vi.useRealTimers();
    }

    const overdue = fixture();
    const overdueEngine = new OneV100Engine({
      sessionId: overdue.sessionId,
      coordinator: new CommandCoordinator(database),
      repository: new SqliteRulesetRepository(database),
      wallNow: () => 10_000,
      connectedPlayerIds: () => new Set([overdue.first, overdue.second]),
      publish: vi.fn(),
    });
    overdueEngine.startSession({ teacherId: overdue.teacherId, requestId: "overdue-start", firstOnePlayerId: overdue.first });
    overdueEngine.startPhaseA({ teacherId: overdue.teacherId, requestId: "overdue-open" });
    const overdueServer = createAppServer();
    const overdueGateway = attachSocketGateway(overdueServer, {
      database,
      tokenSecret: "overdue-recovery-secret-32-characters",
      wallNow: () => 30_001,
      monotonicNow: () => 30_001,
    });
    try {
      expect(new SqliteRulesetRepository(database).latestGame(overdue.sessionId)?.snapshot.phase).toBe("PHASE_A_LOCKED");
    } finally {
      await overdueGateway.close();
    }
  });

  it("runs Poll and persists per-question and per-game help guards", () => {
    const data = fixture();
    const third = addPlayer(data.sessionId, "Cy", 3_000);
    const events: RulesetLifecycleEvent[] = [];
    const engine = startRoundEngine(data, events, new Set([data.first, data.second, third]));
    engine.startPhaseA({ teacherId: data.teacherId, requestId: "poll-open" });
    const active = engine.game!.snapshot.active!;
    engine.answerPhaseA({ playerId: data.second, requestId: "poll-bo", attemptId: active.attempt_id, questionId: active.question_id, choice: 1 });
    exposeIfLocked(engine);
    engine.answerPhaseA({ playerId: third, requestId: "poll-cy", attemptId: active.attempt_id, questionId: active.question_id, choice: 2 });
    exposeIfLocked(engine);

    expect(engine.helpPoll({ playerId: data.first, requestId: "poll-help", choice: 2 })).toMatchObject({ ok: true });
    expect(events.at(-1)).toMatchObject({ type: "help_poll_result", payload: { choice: 2, count: 1, total_answers: 2 } });
    expect(engine.helpAsk({ playerId: data.first, requestId: "same-question-help" })).toMatchObject({ ok: false, code: "HELP_ALREADY_USED" });

    const restored = new OneV100Engine({
      sessionId: data.sessionId,
      coordinator: new CommandCoordinator(database),
      repository: new SqliteRulesetRepository(database),
      wallNow: () => 11_000,
      connectedPlayerIds: () => new Set([data.first, data.second, third]),
      publish: vi.fn(),
    });
    expect(restored.liveSnapshot(data.first)).toMatchObject({
      helps_available: { poll: false, ask: true, trust: true },
      helps_used: { poll: true, ask: false, trust: false },
    });
    expect(restored.helpPoll({ playerId: data.first, requestId: "poll-again", choice: 2 }))
      .toMatchObject({ ok: false, code: "HELP_USED" });
  });

  it("selects Ask speakers from connected answerers, awards +5, and never exposes correctness", () => {
    const data = fixture();
    const third = addPlayer(data.sessionId, "Cy", 3_000);
    const events: RulesetLifecycleEvent[] = [];
    const connected = new Set([data.first, data.second, third]);
    const engine = startRoundEngine(data, events, connected);
    engine.startPhaseA({ teacherId: data.teacherId, requestId: "ask-open" });
    const active = engine.game!.snapshot.active!;
    engine.answerPhaseA({ playerId: data.second, requestId: "ask-bo", attemptId: active.attempt_id, questionId: active.question_id, choice: active.correct_choice });
    exposeIfLocked(engine);
    const wrongChoice = (active.correct_choice + 1) % active.choices.length;
    engine.answerPhaseA({ playerId: third, requestId: "ask-cy", attemptId: active.attempt_id, questionId: active.question_id, choice: wrongChoice });
    exposeIfLocked(engine);
    connected.delete(third);
    expect(engine.helpAsk({ playerId: data.first, requestId: "ask-empty" })).toMatchObject({ ok: false, code: "ASK_UNAVAILABLE" });
    expect(engine.liveSnapshot(data.first)).toMatchObject({ helps_available: { ask: true } });

    connected.add(third);
    expect(engine.helpAsk({ playerId: data.first, requestId: "ask-help" })).toMatchObject({ ok: true });
    const result = events.at(-1)!;
    expect(result).toMatchObject({ type: "help_ask_result", payload: { bonus_each: 5, speakers: expect.arrayContaining([
      expect.objectContaining({ player_id: data.second, nickname: "Bo", choice: active.correct_choice }),
      expect.objectContaining({ player_id: third, nickname: "Cy", choice: wrongChoice }),
    ]) } });
    const points = database.prepare("SELECT player_id, points FROM session_players WHERE player_id IN (?, ?) ORDER BY player_id")
      .all(data.second, third) as Array<{ player_id: string; points: number }>;
    expect(points.map((row) => row.points).sort((left, right) => left - right)).toEqual([5, 25]);
    for (const audience of ["teacher", "projector", "one", "answerers", "players"] as const) {
      expectNoCorrectness(projectApplicationPacket("help_ask_result", audience, result.payload));
    }
    expectNoCorrectness(snapshotView(engine.liveSnapshot(data.first), { audience: "one" }));
    exposeIfLocked(engine);
    expect(engine.answerOne({
      playerId: data.first,
      requestId: "ask-one-answer",
      attemptId: active.attempt_id,
      questionId: active.question_id,
      choice: active.correct_choice,
    })).toMatchObject({ ok: true });
    expect(events.find((event) => event.type === "reveal")?.payload.score_deltas).toEqual(expect.arrayContaining([
      { player_id: data.second, points: 12, reason: "correct_answer" },
    ]));
    expect(database.prepare("SELECT points FROM session_players WHERE player_id = ?").get(data.second))
      .toEqual({ points: 52 });
  });

  it("reports consumed helps on the following question and after restart", () => {
    const data = fixture();
    addQuestion(data.sessionId, 2);
    const events: RulesetLifecycleEvent[] = [];
    const engine = startEngineWithDeck(data, 2, events);
    engine.startPhaseA({ teacherId: data.teacherId, requestId: "available-q1" });
    const first = engine.game!.snapshot.active!;
    engine.answerPhaseA({ playerId: data.second, requestId: "available-mob1", attemptId: first.attempt_id, questionId: first.question_id, choice: 2 });
    exposeIfLocked(engine);
    engine.helpPoll({ playerId: data.first, requestId: "available-poll", choice: 2 });
    exposeIfLocked(engine);
    engine.answerOne({ playerId: data.first, requestId: "available-one1", attemptId: first.attempt_id, questionId: first.question_id, choice: 0 });
    engine.startPhaseA({ teacherId: data.teacherId, requestId: "available-q2" });
    const second = engine.game!.snapshot.active!;
    engine.answerPhaseA({ playerId: data.second, requestId: "available-mob2", attemptId: second.attempt_id, questionId: second.question_id, choice: 0 });
    exposeIfLocked(engine);

    expect(events.filter((event) => event.type === "phase_b_start").at(-1)?.payload).toMatchObject({
      helps_available: { poll: false, ask: true, trust: true },
    });
    const restored = new OneV100Engine({
      sessionId: data.sessionId,
      coordinator: new CommandCoordinator(database),
      repository: new SqliteRulesetRepository(database),
      wallNow: () => 11_000,
      connectedPlayerIds: () => new Set([data.first, data.second]),
      publish: vi.fn(),
    });
    expect(restored.liveSnapshot(data.first)).toMatchObject({ helps_available: { poll: false, ask: true, trust: true } });
  });

  it("uses deterministic Trust ties and flows through the normal reveal transaction", () => {
    const data = fixture();
    const third = addPlayer(data.sessionId, "Cy", 3_000);
    const events: RulesetLifecycleEvent[] = [];
    const engine = startEngineWithDeck(data, 2, events, new Set([data.first, data.second, third]));
    engine.startPhaseA({ teacherId: data.teacherId, requestId: "trust-open" });
    const active = engine.game!.snapshot.active!;
    const tiedChoices = [0, active.choices.length - 1];
    engine.answerPhaseA({ playerId: data.second, requestId: "trust-bo", attemptId: active.attempt_id, questionId: active.question_id, choice: tiedChoices[0]! });
    exposeIfLocked(engine);
    engine.answerPhaseA({ playerId: third, requestId: "trust-cy", attemptId: active.attempt_id, questionId: active.question_id, choice: tiedChoices[1]! });
    exposeIfLocked(engine);
    const gameId = engine.game!.gameId;
    const expected = tiedChoices[Number(BigInt(`0x${createHash("sha256").update(gameId + active.question_id).digest("hex")}`) % 2n)]!;
    const counts = active.choices.map((_, choice) => tiedChoices.includes(choice) ? 1 : 0);

    expect(engine.helpTrust({ playerId: data.first, requestId: "trust-help" })).toMatchObject({ ok: true });
    expect(events.find((event) => event.type === "help_trust_result")).toMatchObject({
      payload: { plurality_choice: expected, counts, tie_candidates: tiedChoices, locked: true },
    });
    const stored = database.prepare("SELECT payload_json FROM game_events WHERE game_id = ? AND event_type = 'help_trust_used'")
      .get(gameId) as { payload_json: string };
    expect(JSON.parse(stored.payload_json)).toMatchObject({ plurality_choice: expected, tie_candidates: tiedChoices });
    expect(events.some((event) => event.type === "reveal")).toBe(true);
  });

  it("force reveals without a choice as wrong through normal scoring", () => {
    const data = fixture();
    addQuestion(data.sessionId, 2);
    const events: RulesetLifecycleEvent[] = [];
    const engine = startEngineWithDeck(data, 2, events);
    engine.startPhaseA({ teacherId: data.teacherId, requestId: "force-open" });
    const active = engine.game!.snapshot.active!;
    engine.answerPhaseA({ playerId: data.second, requestId: "force-mob", attemptId: active.attempt_id, questionId: active.question_id, choice: 2 });
    exposeIfLocked(engine);

    expect(engine.forceReveal({ teacherId: data.teacherId, requestId: "force-reveal" })).toMatchObject({ ok: true });
    expect(events.find((event) => event.type === "reveal")).toMatchObject({ payload: { one_correct: false, forced: true } });
    expect(engine.game?.strikesRemaining).toBe(1);
    expect(database.prepare("SELECT payload_json FROM game_events WHERE request_id = ?").get("force-reveal"))
      .toEqual({ payload_json: expect.stringContaining('"forced":true') });
  });

  it("freezes and restores the Phase A deadline for teacher pause", () => {
    const data = fixture();
    let wallNow = 10_000;
    let monotonicNow = 1_000;
    const events: RulesetLifecycleEvent[] = [];
    const engine = new OneV100Engine({
      sessionId: data.sessionId,
      coordinator: new CommandCoordinator(database),
      repository: new SqliteRulesetRepository(database),
      wallNow: () => wallNow,
      monotonicNow: () => monotonicNow,
      connectedPlayerIds: () => new Set([data.first, data.second]),
      publish: (event) => events.push(event),
    });
    engine.startSession({ teacherId: data.teacherId, requestId: "pause-start", firstOnePlayerId: data.first });
    engine.startPhaseA({ teacherId: data.teacherId, requestId: "pause-open" });
    wallNow = 16_000;
    monotonicNow = 7_000;
    expect(engine.teacherPause({ teacherId: data.teacherId, requestId: "teacher-pause", reason: "discussion" })).toMatchObject({ ok: true });
    expect(events.at(-1)).toMatchObject({ type: "pause_state", payload: { paused: true, reason: "teacher", remaining_ms: 14_000 } });
    wallNow = 50_000;
    monotonicNow = 51_000;
    expect(engine.teacherResume({ teacherId: data.teacherId, requestId: "teacher-resume" })).toMatchObject({ ok: true });
    expect(engine.game?.snapshot.active?.deadline_ms).toBe(64_000);
    expect(events.at(-1)).toMatchObject({
      type: "pause_state",
      payload: { paused: false, reason: "teacher_resumed", deadline_ms: 64_000 },
    });
    expect(engine.phase).toBe("PHASE_A");

    wallNow = 52_000;
    monotonicNow = 53_000;
    const active = engine.game!.snapshot.active!;
    expect(engine.answerPhaseA({
      playerId: data.second,
      requestId: "answer-after-pause",
      attemptId: active.attempt_id,
      questionId: active.question_id,
      choice: 0,
    })).toMatchObject({ ok: true });
    exposeIfLocked(engine);
    expect(engine.game?.snapshot.active?.answers).toContainEqual(expect.objectContaining({
      player_id: data.second,
      receive_duration_ms: 8_000,
    }));
  });

  it("keeps Phase B paused until The One reconnects even when the teacher resumes", () => {
    const data = fixture();
    const connected = new Set([data.first, data.second]);
    const engine = startRoundEngine(data, [], connected);
    engine.startPhaseA({ teacherId: data.teacherId, requestId: "disconnect-open" });
    const active = engine.game!.snapshot.active!;
    engine.answerPhaseA({ playerId: data.second, requestId: "disconnect-mob", attemptId: active.attempt_id, questionId: active.question_id, choice: 0 });
    exposeIfLocked(engine);
    expect(engine.phase).toBe("PHASE_B");
    expect(engine.teacherPause({ teacherId: data.teacherId, requestId: "disconnect-teacher-pause" })).toMatchObject({ ok: true });

    connected.delete(data.first);
    expect(engine.pauseOneDisconnected(data.first)).toMatchObject({ ok: true });
    expect(engine.game?.snapshot.pause_reasons).toMatchObject({ teacher: "teacher", one_disconnected: true });
    expect(engine.teacherResume({ teacherId: data.teacherId, requestId: "disconnect-teacher-resume" })).toMatchObject({
      ok: false,
      code: "ONE_UNAVAILABLE",
    });
    expect(engine.phase).toBe("PAUSED");

    connected.add(data.first);
    expect(engine.resumeOne(data.first)).toMatchObject({ ok: true });
    expect(engine.phase).toBe("PAUSED");
    expect(engine.game?.snapshot.pause_reasons).toMatchObject({ teacher: "teacher", one_disconnected: false });
    expect(engine.teacherResume({ teacherId: data.teacherId, requestId: "disconnect-final-resume" })).toMatchObject({ ok: true });
    expect(engine.phase).toBe("PHASE_B");
  });
});
