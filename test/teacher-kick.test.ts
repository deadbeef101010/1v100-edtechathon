import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { io as createClient, type Socket as ClientSocket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTeacherToken } from "../src/auth.js";
import { openDatabase, type AppDatabase } from "../src/db.js";
import { GameEventStore } from "../src/game-event-store.js";
import { ONE_V_100_DEFAULT_SETTINGS } from "../src/engine/ruleset-settings.js";
import { createAppServer } from "../src/server.js";
import { attachSocketGateway } from "../src/socket-gateway.js";
import { createClassroomSession, type CreatedClassroomSession } from "../src/sessions.js";
import { mintTeacherKey, type MintedTeacherKey } from "../src/teachers.js";

const SECRET = "teacher-kick-secret-at-least-32-characters";
let directory: string;
let database: AppDatabase;
let classroom: CreatedClassroomSession;
let teacher: MintedTeacherKey;
let server: ReturnType<typeof createAppServer>;
let gateway: ReturnType<typeof attachSocketGateway>;
let url: string;
const clients: ClientSocket[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "game-kick-"));
  database = openDatabase(join(directory, "game.db"));
  teacher = mintTeacherKey(database, "Kick Teacher");
  classroom = createClassroomSession(database, teacher.teacherId, SECRET);
  server = createAppServer();
  gateway = attachSocketGateway(server, { database, tokenSecret: SECRET });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected TCP listener");
  }
  url = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  for (const socket of clients.splice(0)) {
    socket.disconnect();
  }
  await gateway.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  database.close();
  await rm(directory, { recursive: true, force: true });
});

function client(auth?: Record<string, string>): ClientSocket {
  const socket = createClient(url, {
    forceNew: true,
    reconnection: false,
    ...(auth === undefined ? {} : { auth }),
  });
  clients.push(socket);
  return socket;
}

function ack<T>(socket: ClientSocket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

describe("teacher kick", () => {
  it("revokes the token, notifies and disconnects sockets, removes roster entry, and logs", async () => {
    const student = client();
    const joined = await ack<{ player_id: string; token: string }>(student, "join_session", {
      code: classroom.code,
      nickname: "Maya",
    });
    const teacherSocket = client({
      teacher_token: createTeacherToken(teacher.teacherId, SECRET),
    });
    await ack(teacherSocket, "teacher_attach", { session_id: classroom.sessionId });
    const kicked = new Promise<unknown>((resolve) => student.once("kicked", resolve));
    const disconnected = new Promise<void>((resolve) => student.once("disconnect", () => resolve()));
    const roster = new Promise<unknown[]>((resolve) => teacherSocket.once("roster_update", resolve));

    expect(
      await ack(teacherSocket, "kick_player", {
        request_id: "kick-1",
        player_id: joined.player_id,
      }),
    ).toMatchObject({ ok: true });
    expect(await kicked).toMatchObject({ code: "KICKED" });
    await expect(Promise.race([
      disconnected,
      new Promise((_, reject) => setTimeout(() => reject(new Error("disconnect timeout")), 1_000)),
    ])).resolves.toBeUndefined();
    expect(await roster).toEqual([]);

    expect(await ack(client(), "resume", { token: joined.token })).toEqual({
      ok: false,
      code: "KICKED",
    });
    expect(
      new GameEventStore(database)
        .readSession(classroom.sessionId)
        .some((event) => event.eventType === "player_kicked" && event.actorId === teacher.teacherId),
    ).toBe(true);
  });

  it("forces a durable pause when the current One is kicked", async () => {
    database.prepare("UPDATE sessions SET settings_json = ? WHERE session_id = ?")
      .run(JSON.stringify(ONE_V_100_DEFAULT_SETTINGS), classroom.sessionId);
    const oneSocket = client();
    const one = await ack<{ player_id: string }>(oneSocket, "join_session", { code: classroom.code, nickname: "One" });
    const mobSocket = client();
    await ack(mobSocket, "join_session", { code: classroom.code, nickname: "Mob" });
    const teacherSocket = client({ teacher_token: createTeacherToken(teacher.teacherId, SECRET) });
    await ack(teacherSocket, "teacher_attach", { session_id: classroom.sessionId });
    await ack(teacherSocket, "teacher_start_session", { request_id: "kick-start", first_one_player_id: one.player_id });
    const phaseA = new Promise<Record<string, unknown>>((resolve) => mobSocket.once("phase_a_start", resolve));
    await ack(teacherSocket, "teacher_advance", { request_id: "kick-open" });
    const question = await phaseA;
    await ack(mobSocket, "answer_submit", {
      request_id: "kick-answer",
      attempt_id: question.attempt_id,
      question_id: question.question_id,
      choice: 0,
    });
    // Teacher-gated exposure: advance moves the locked attempt into Phase B.
    expect(await ack(teacherSocket, "teacher_advance", { request_id: "kick-expose" })).toMatchObject({ ok: true });
    const paused = new Promise<Record<string, unknown>>((resolve) => teacherSocket.once("pause_state", resolve));

    expect(await ack(teacherSocket, "kick_player", { request_id: "kick-one", player_id: one.player_id }))
      .toMatchObject({ ok: true });
    expect(await paused).toMatchObject({ paused: true, reason: "one_kicked" });
    const game = database.prepare("SELECT snapshot_json FROM games WHERE session_id = ? ORDER BY ordinal DESC LIMIT 1")
      .get(classroom.sessionId) as { snapshot_json: string };
    expect(JSON.parse(game.snapshot_json)).toMatchObject({ phase: "PAUSED", paused_from: "PHASE_B" });
    const events = new GameEventStore(database).readSession(classroom.sessionId);
    const kickedIndex = events.findIndex((event) => event.eventType === "player_kicked");
    expect(events[kickedIndex + 1]).toMatchObject({ eventType: "pause_state" });

    expect(await ack(teacherSocket, "kick_player", { request_id: "kick-one", player_id: one.player_id }))
      .toMatchObject({ ok: true });
    const replayedGame = database.prepare("SELECT snapshot_json FROM games WHERE session_id = ? ORDER BY ordinal DESC LIMIT 1")
      .get(classroom.sessionId) as { snapshot_json: string };
    expect(JSON.parse(replayedGame.snapshot_json)).toMatchObject({ phase: "PAUSED", paused_reason: "one_kicked" });

    const ended = new Promise<Record<string, unknown>>((resolve) => teacherSocket.once("game_end", resolve));
    expect(await ack(teacherSocket, "teacher_force_reveal", {
      request_id: "kick-force-reveal",
      one_choice: 1,
    })).toMatchObject({ ok: true });
    const gameEnd = await ended;
    const payout = (gameEnd.payouts as Array<{ player_id: string; points: number }> | undefined)
      ?.find((entry) => entry.player_id === one.player_id);
    expect(payout).toBeDefined();
    const persisted = database.prepare("SELECT points FROM session_players WHERE player_id = ?")
      .get(one.player_id) as { points: number };
    expect(persisted.points).toBe(10 + payout!.points);
  });
});
