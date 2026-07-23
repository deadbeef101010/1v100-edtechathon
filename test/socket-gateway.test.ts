import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { io as createClient, type Socket as ClientSocket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTeacherToken } from "../src/auth.js";
import { openDatabase, type AppDatabase } from "../src/db.js";
import { projectApplicationPacket } from "../src/emitter.js";
import { GameEventStore } from "../src/game-event-store.js";
import { ONE_V_100_DEFAULT_SETTINGS } from "../src/engine/ruleset-settings.js";
import { QuestionRound } from "../src/question-round.js";
import { MetaAdminService } from "../src/meta-admin.js";
import {
  attachSocketGateway,
  answererRoom,
  oneRoom,
  playerRoom,
  projectorRoom,
  studentRoom,
  teacherRoom,
} from "../src/socket-gateway.js";
import { createAppServer } from "../src/server.js";
import { createClassroomSession, type CreatedClassroomSession } from "../src/sessions.js";
import { mintTeacherKey, type MintedTeacherKey } from "../src/teachers.js";
import { ServerLogger } from "../src/log.js";

const TOKEN_SECRET = "socket-token-secret-32-characters-minimum";

let directory: string;
let database: AppDatabase;
let classroom: CreatedClassroomSession;
let teacher: MintedTeacherKey;
let url: string;
const clients: ClientSocket[] = [];
let server: ReturnType<typeof createAppServer>;
let gateway: ReturnType<typeof attachSocketGateway>;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "game-1v100-socket-"));
  database = openDatabase(join(directory, "game.db"));
  teacher = mintTeacherKey(database, "Ms Rivera");
  classroom = createClassroomSession(database, teacher.teacherId, TOKEN_SECRET);
  server = createAppServer();
  gateway = attachSocketGateway(server, { database, tokenSecret: TOKEN_SECRET });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP listener");
  }
  url = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.disconnect();
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
    transports: ["polling", "websocket"],
    ...(auth === undefined ? {} : { auth }),
  });
  clients.push(socket);
  return socket;
}

function cookieClient(cookie: string): ClientSocket {
  const socket = createClient(url, {
    forceNew: true,
    reconnection: false,
    transports: ["polling", "websocket"],
    extraHeaders: { cookie },
  });
  clients.push(socket);
  return socket;
}

function emitWithAck<T>(socket: ClientSocket, event: string, payload: unknown): Promise<T> {
  return new Promise<T>((resolve) => socket.emit(event, payload, resolve));
}

function emitWithAckTimeout<T>(
  socket: ClientSocket,
  event: string,
  payload: unknown,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    socket.timeout(500).emit(event, payload, (error: Error | null, response: T) => {
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(response);
    });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await once(child, "exit");
}

describe("Socket.IO classroom gateway", () => {
  it("survives malformed command arguments without partial writes", async () => {
    const childDirectory = await mkdtemp(join(tmpdir(), "game-1v100-socket-process-"));
    const childDatabasePath = join(childDirectory, "game.db");
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "test/fixtures/socket-process-server.ts",
        childDatabasePath,
        TOKEN_SECRET,
      ],
      {
        cwd: new URL("..", import.meta.url),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    try {
      const [line] = (await once(child.stdout, "data")) as [Buffer];
      const processServer = JSON.parse(line.toString("utf8")) as {
        url: string;
        code: string;
      };
      const processClient = createClient(processServer.url, {
        forceNew: true,
        reconnection: false,
        transports: ["websocket"],
      });
      await new Promise<void>((resolve) => processClient.once("connect", resolve));
      const commands = ["join_session", "projector_attach", "resume", "teacher_attach"];
      const oversized = "x".repeat(8 * 1_024);

      const oversizedPayloads: Record<string, object> = {
        join_session: { code: processServer.code, nickname: oversized },
        projector_attach: { projector_token: oversized },
        resume: { player_token: oversized },
        teacher_attach: { session_id: oversized },
      };

      for (const command of commands) {
        processClient.emit(command);
        for (const payload of [null, [], "wrong", 7, oversizedPayloads[command]]) {
          const ack = await emitWithAckTimeout<unknown>(processClient, command, payload);
          expect(ack).toEqual({ error: "protocol_error" });
        }
      }
      const invalidIdentifier = "-".repeat(36);
      const nonce = "A".repeat(22);
      const signature = "B".repeat(43);
      for (const [command, payload] of [
        [
          "resume",
          { player_token: `p1.${invalidIdentifier}.1234567890123.${nonce}.${signature}` },
        ],
        [
          "projector_attach",
          {
            projector_token: `prj1.${invalidIdentifier}.1234567890123.${nonce}.${signature}`,
          },
        ],
      ] as const) {
        const ack = await emitWithAckTimeout<unknown>(processClient, command, payload);
        expect(ack).toEqual({ error: "protocol_error" });
      }
      processClient.emit("join_session", {
        code: processServer.code,
        nickname: "No Ack Player",
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      const health = await fetch(`${processServer.url}/health`);
      expect(health.status).toBe(200);
      expect(child.exitCode, stderr).toBeNull();
      processClient.disconnect();
    } finally {
      await stopChild(child);
    }

    const childDatabase = openDatabase(childDatabasePath);
    const playerCount = childDatabase
      .prepare("SELECT COUNT(*) AS count FROM session_players")
      .get() as { count: number };
    childDatabase.close();
    await rm(childDirectory, { recursive: true, force: true });
    expect(playerCount.count).toBe(0);
  }, 10_000);

  it("contains unexpected database failures at socket and HTTP boundaries", async () => {
    const childDirectory = await mkdtemp(join(tmpdir(), "game-1v100-boundary-process-"));
    const childDatabasePath = join(childDirectory, "game.db");
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "test/fixtures/socket-process-server.ts",
        childDatabasePath,
        TOKEN_SECRET,
      ],
      {
        cwd: new URL("..", import.meta.url),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    try {
      const [line] = (await once(child.stdout, "data")) as [Buffer];
      const processServer = JSON.parse(line.toString("utf8")) as {
        url: string;
        code: string;
        teacherToken: string;
      };
      const processClient = createClient(processServer.url, {
        forceNew: true,
        reconnection: false,
        transports: ["websocket"],
      });
      await new Promise<void>((resolve) => processClient.once("connect", resolve));
      child.stdin?.write("close_database\n");
      await once(child.stdout, "data");

      const socketAck = await emitWithAckTimeout<unknown>(processClient, "join_session", {
        code: processServer.code,
        nickname: "Database Failure",
      });
      expect(socketAck).toEqual({ error: "protocol_error" });
      expect((await fetch(`${processServer.url}/health`)).status).toBe(200);

      const response = await fetch(`${processServer.url}/api/sessions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${processServer.teacherToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ request_id: "closed-database-create" }),
      });
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: "internal_error" });
      expect((await fetch(`${processServer.url}/health`)).status).toBe(200);
      expect(child.exitCode, stderr).toBeNull();
      processClient.disconnect();
    } finally {
      await stopChild(child);
      await rm(childDirectory, { recursive: true, force: true });
    }
  }, 10_000);

  it.each(["revoked", "expired"] as const)(
    "rejects a %s teacher token at realtime authorization",
    async (invalidState) => {
      const teacherToken = createTeacherToken(teacher.teacherId, TOKEN_SECRET);
      if (invalidState === "revoked") {
        database
          .prepare("UPDATE teachers SET status = 'revoked', revoked_at_ms = ? WHERE teacher_id = ?")
          .run(Date.now(), teacher.teacherId);
      } else {
        database
          .prepare("UPDATE teachers SET expires_at_ms = ? WHERE teacher_id = ?")
          .run(Date.now() - 1, teacher.teacherId);
      }
      const teacherSocket = client({ teacher_token: teacherToken });

      const attach = await emitWithAck<{ ok: boolean; code?: string }>(
        teacherSocket,
        "teacher_attach",
        { session_id: classroom.sessionId },
      );
      const privilegedSockets = await gateway.in(teacherRoom(classroom.sessionId)).fetchSockets();

      expect(attach).toEqual({ ok: false, code: "TEACHER_UNAUTHORIZED" });
      expect(privilegedSockets).toHaveLength(0);
    },
  );

  it("attaches an active unexpired teacher to their own realtime room", async () => {
    const teacherSocket = client({
      teacher_token: createTeacherToken(teacher.teacherId, TOKEN_SECRET),
    });

    const attach = await emitWithAck<{ ok: boolean }>(teacherSocket, "teacher_attach", {
      session_id: classroom.sessionId,
    });
    const privilegedSockets = await gateway.in(teacherRoom(classroom.sessionId)).fetchSockets();

    expect(attach.ok).toBe(true);
    expect(privilegedSockets).toHaveLength(1);
    expect(privilegedSockets[0]?.rooms).not.toContain(studentRoom(classroom.sessionId));
    expect(privilegedSockets[0]?.rooms).not.toContain(answererRoom(classroom.sessionId));
    expect(privilegedSockets[0]?.rooms).not.toContain(oneRoom(classroom.sessionId));
  });

  it("attaches a teacher using the teacher_session cookie", async () => {
    const teacherToken = createTeacherToken(teacher.teacherId, TOKEN_SECRET);
    const teacherSocket = cookieClient(`teacher_session=${teacherToken}`);

    const attach = await emitWithAckTimeout<{ ok: boolean; session_id: string }>(
      teacherSocket,
      "teacher_attach",
      { session_id: classroom.sessionId },
    );

    expect(attach).toMatchObject({ ok: true, session_id: classroom.sessionId });
  });

  it("acknowledges both teacher credential rotation commands", async () => {
    const teacherSocket = client({
      teacher_token: createTeacherToken(teacher.teacherId, TOKEN_SECRET),
    });
    await emitWithAckTimeout(teacherSocket, "teacher_attach", { session_id: classroom.sessionId });

    const code = await emitWithAckTimeout<{ ok: boolean; code: string }>(
      teacherSocket,
      "teacher_rotate_session_code",
      { request_id: "rotate-code-regression" },
    );
    const projector = await emitWithAckTimeout<{ ok: boolean; projector_token: string }>(
      teacherSocket,
      "teacher_rotate_projector_credential",
      { request_id: "rotate-projector-regression" },
    );

    expect(code).toMatchObject({ ok: true, code: expect.stringMatching(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/) });
    expect(projector).toMatchObject({ ok: true, projector_token: expect.any(String) });
  });

  it("immediately disconnects a revoked teacher before further room broadcasts", async () => {
    const teacherSocket = client({
      teacher_token: createTeacherToken(teacher.teacherId, TOKEN_SECRET),
    });
    const attach = await emitWithAck<{ ok: boolean }>(teacherSocket, "teacher_attach", {
      session_id: classroom.sessionId,
    });
    let received = false;
    teacherSocket.on("teacher_only_test", () => {
      received = true;
    });
    const disconnected = new Promise<void>((resolve) => {
      teacherSocket.once("disconnect", () => resolve());
    });
    const revoked = new MetaAdminService(database, "").revokeTeacher(
      teacher.teacherId,
      "revoke-live-teacher",
    );
    await disconnected;
    const privilegedSockets = await gateway.in(teacherRoom(classroom.sessionId)).fetchSockets();
    gateway.to(teacherRoom(classroom.sessionId)).emit("teacher_only_test");

    expect(attach.ok).toBe(true);
    expect(revoked).toEqual({ ok: true });
    expect(teacherSocket.connected).toBe(false);
    expect(privilegedSockets).toHaveLength(0);
    expect(received).toBe(false);
  });

  it("immediately disconnects a teacher when their key is reissued", async () => {
    const teacherSocket = client({
      teacher_token: createTeacherToken(teacher.teacherId, TOKEN_SECRET),
    });
    const attach = await emitWithAck<{ ok: boolean }>(teacherSocket, "teacher_attach", {
      session_id: classroom.sessionId,
    });
    const disconnected = new Promise<void>((resolve) => {
      teacherSocket.once("disconnect", () => resolve());
    });

    const reissued = new MetaAdminService(database, "").reissueTeacher(
      teacher.teacherId,
      "reissue-live-teacher",
    );
    await disconnected;

    expect(attach.ok).toBe(true);
    expect(reissued.ok).toBe(true);
    expect(teacherSocket.connected).toBe(false);
    expect(await gateway.in(teacherRoom(classroom.sessionId)).fetchSockets()).toHaveLength(0);
  });

  it("bounds unauthenticated attach failure logs with pre-auth rate limiting", async () => {
    const isolatedServer = createAppServer();
    const logger = new ServerLogger({ write: () => undefined });
    const isolatedGateway = attachSocketGateway(isolatedServer, {
      database,
      tokenSecret: TOKEN_SECRET,
      logger,
      preAuthRateLimitPerSecond: 1,
      capacity: 40,
      monotonicNow: () => 1_000,
    });
    isolatedServer.listen(0, "127.0.0.1");
    await once(isolatedServer, "listening");
    const address = isolatedServer.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP listener");
    const unauthenticated = createClient(`http://127.0.0.1:${address.port}`, {
      forceNew: true,
      reconnection: false,
    });
    clients.push(unauthenticated);
    const first = await emitWithAck<Record<string, unknown>>(unauthenticated, "teacher_attach", {
      session_id: classroom.sessionId,
    });
    const limited = await emitWithAck<Record<string, unknown>>(unauthenticated, "teacher_attach", {
      session_id: classroom.sessionId,
    });
    for (let index = 0; index < 20; index += 1) {
      await emitWithAck(unauthenticated, "teacher_attach", { session_id: classroom.sessionId });
    }

    expect(first).toMatchObject({ ok: false, code: "TEACHER_UNAUTHORIZED" });
    expect(limited).toMatchObject({ ok: false, code: "RATE_LIMITED" });
    expect(logger.entries().filter((entry) => entry.event === "rate_limit_hit")).toHaveLength(1);
    expect(logger.entries().filter((entry) => entry.event === "auth_failure")).toHaveLength(1);
    unauthenticated.disconnect();
    await isolatedGateway.close();
    await new Promise<void>((resolve) => isolatedServer.close(() => resolve()));
  });

  it("does not retain or emit per-socket logs for unauthenticated connection churn", async () => {
    const isolatedServer = createAppServer();
    const lines: string[] = [];
    const logger = new ServerLogger({ capacity: 2, write: (line) => lines.push(line) });
    logger.info("retained_sentinel");
    const isolatedGateway = attachSocketGateway(isolatedServer, {
      database,
      tokenSecret: TOKEN_SECRET,
      logger,
    });
    isolatedServer.listen(0, "127.0.0.1");
    await once(isolatedServer, "listening");
    const address = isolatedServer.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP listener");
    const isolatedUrl = `http://127.0.0.1:${address.port}`;

    for (let index = 0; index < 8; index += 1) {
      const disconnected = new Promise<void>((resolve) => {
        isolatedGateway.once("connection", (serverSocket) => {
          serverSocket.once("disconnect", () => resolve());
        });
      });
      const unauthenticated = createClient(isolatedUrl, {
        forceNew: true,
        reconnection: false,
        transports: ["websocket"],
      });
      await new Promise<void>((resolve) => unauthenticated.once("connect", resolve));
      unauthenticated.disconnect();
      await disconnected;
    }

    expect(logger.entries().map((entry) => entry.event)).toEqual([
      "retained_sentinel",
      "socket_connected",
    ]);
    expect(lines).toHaveLength(2);
    await isolatedGateway.close();
    await new Promise<void>((resolve) => isolatedServer.close(() => resolve()));
  });

  it("prevents a student socket from accumulating projector or teacher capabilities", async () => {
    const socket = client({
      teacher_token: createTeacherToken(teacher.teacherId, TOKEN_SECRET),
    });
    const joined = await emitWithAck<{ player_id: string }>(socket, "join_session", {
      code: classroom.code,
      nickname: "Single Principal",
    });

    const projectorAttach = await emitWithAck<{ ok: boolean; code?: string }>(
      socket,
      "projector_attach",
      { projector_token: classroom.projectorToken },
    );
    const teacherAttach = await emitWithAck<{ ok: boolean; code?: string }>(
      socket,
      "teacher_attach",
      { session_id: classroom.sessionId },
    );
    const serverSocket = gateway.sockets.sockets.get(socket.id ?? "");

    expect(projectorAttach).toEqual({ ok: false, code: "PRINCIPAL_CONFLICT" });
    expect(teacherAttach).toEqual({ ok: false, code: "PRINCIPAL_CONFLICT" });
    expect(serverSocket?.rooms).toContain(studentRoom(classroom.sessionId));
    expect(serverSocket?.rooms).toContain(playerRoom(classroom.sessionId, joined.player_id));
    expect(serverSocket?.rooms).not.toContain(projectorRoom(classroom.sessionId));
    expect(serverSocket?.rooms).not.toContain(teacherRoom(classroom.sessionId));
  });

  it.each(["teacher_advance", "teacher_pause", "teacher_resume", "teacher_force_reveal"])(
    "rejects student use of %s with FORBIDDEN",
    async (event) => {
      const socket = client();
      await emitWithAck(socket, "join_session", {
        code: classroom.code,
        nickname: `Forbidden ${event}`,
      });

      expect(
        await emitWithAck(socket, event, { request_id: "request-1", attempt_id: "attempt-1" }),
      ).toEqual({
        ok: false,
        request_id: "request-1",
        code: "FORBIDDEN",
        server_time_ms: expect.any(Number),
        deadline_ms: null,
      });
    },
  );

  it("routes an attached teacher force-reveal control to the session round", async () => {
    const round = new QuestionRound({
      sessionId: classroom.sessionId,
      store: new GameEventStore(database),
      database,
      monotonicNow: () => 100,
      wallNow: () => 100,
      emit: () => undefined,
    });
    round.openQuestion({
      actorId: teacher.teacherId,
      requestId: "open",
      attemptId: "attempt-1",
      question: { id: "q", prompt: "Q", choices: ["A", "B", "C"], correctChoice: 0 },
      durationMs: 1_000,
      eligiblePlayerIds: [],
    });
    const isolatedServer = createAppServer();
    const isolatedGateway = attachSocketGateway(isolatedServer, {
      database,
      tokenSecret: TOKEN_SECRET,
      rounds: new Map([[classroom.sessionId, round]]),
    });
    isolatedServer.listen(0, "127.0.0.1");
    await once(isolatedServer, "listening");
    const address = isolatedServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected a TCP listener");
    }
    const teacherSocket = client({
      teacher_token: createTeacherToken(teacher.teacherId, TOKEN_SECRET),
    });
    teacherSocket.disconnect();
    const isolatedClient = createClient(`http://127.0.0.1:${address.port}`, {
      forceNew: true,
      reconnection: false,
      auth: { teacher_token: createTeacherToken(teacher.teacherId, TOKEN_SECRET) },
    });
    clients.push(isolatedClient);
    await emitWithAck(isolatedClient, "teacher_attach", { session_id: classroom.sessionId });

    const response = await emitWithAck(isolatedClient, "teacher_force_reveal", {
      request_id: "force",
      attempt_id: "attempt-1",
    });

    expect(response).toMatchObject({ ok: true });
    expect(round.phase).toBe("REVEALED");
    isolatedClient.disconnect();
    await isolatedGateway.close();
    await new Promise<void>((resolve) => isolatedServer.close(() => resolve()));
  });

  it("replays a stored teacher advance success after restart and phase change", async () => {
    const round = new QuestionRound({
      sessionId: classroom.sessionId,
      store: new GameEventStore(database),
      database,
      monotonicNow: () => 100,
      wallNow: () => 100,
      emit: () => undefined,
    });
    round.openQuestion({
      actorId: teacher.teacherId,
      requestId: "restart-open",
      attemptId: "restart-attempt",
      question: { id: "restart-q", prompt: "Q", choices: ["A", "B", "C"], correctChoice: 0 },
      durationMs: 1_000,
      eligiblePlayerIds: [],
    });
    round.forceReveal({
      actorId: teacher.teacherId,
      requestId: "restart-reveal",
      attemptId: "restart-attempt",
    });
    const first = round.advance({
      actorId: teacher.teacherId,
      requestId: "restart-advance",
      attemptId: "restart-attempt",
    });
    expect(first).toMatchObject({ ok: true });

    const isolatedServer = createAppServer();
    const isolatedGateway = attachSocketGateway(isolatedServer, {
      database,
      tokenSecret: TOKEN_SECRET,
      rounds: new Map(),
    });
    isolatedServer.listen(0, "127.0.0.1");
    await once(isolatedServer, "listening");
    const address = isolatedServer.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP listener");
    const teacherSocket = createClient(`http://127.0.0.1:${address.port}`, {
      forceNew: true,
      reconnection: false,
      auth: { teacher_token: createTeacherToken(teacher.teacherId, TOKEN_SECRET) },
    });
    clients.push(teacherSocket);
    await emitWithAck(teacherSocket, "teacher_attach", { session_id: classroom.sessionId });
    const replay = await emitWithAck<Record<string, unknown>>(teacherSocket, "teacher_advance", {
      request_id: "restart-advance",
      attempt_id: "restart-attempt",
    });

    expect(replay).toMatchObject({ ok: true, request_id: "restart-advance" });
    expect(replay.serverSeq).toBe(first.ok ? first.serverSeq : undefined);
    expect(await emitWithAck(teacherSocket, "teacher_advance", {
      request_id: "restart-advance",
      attempt_id: "different-attempt",
    })).toMatchObject({
      ok: false,
      request_id: "restart-advance",
      code: "REQUEST_MISMATCH",
    });
    teacherSocket.disconnect();
    await isolatedGateway.close();
    await new Promise<void>((resolve) => isolatedServer.close(() => resolve()));
  });

  it("restores an active question from the event log when the gateway starts", async () => {
    const source = new QuestionRound({
      sessionId: classroom.sessionId,
      store: new GameEventStore(database),
      database,
      monotonicNow: () => 100,
      wallNow: () => Date.now(),
      emit: () => undefined,
    });
    source.openQuestion({
      actorId: teacher.teacherId,
      requestId: "restore-open",
      attemptId: "restore-attempt",
      question: { id: "restore-q", prompt: "Restore?", choices: ["A", "B", "C"], correctChoice: 2 },
      durationMs: 20_000,
      eligiblePlayerIds: ["restore-player", "other-player"],
    });
    const restoredRounds = new Map<string, QuestionRound>();
    const isolatedServer = createAppServer();
    const isolatedGateway = attachSocketGateway(isolatedServer, {
      database,
      tokenSecret: TOKEN_SECRET,
      rounds: restoredRounds,
    });
    isolatedServer.listen(0, "127.0.0.1");
    await once(isolatedServer, "listening");
    const address = isolatedServer.address();
    if (address === null || typeof address === "string") {
      throw new Error("Expected a TCP listener");
    }
    const isolatedUrl = `http://127.0.0.1:${address.port}`;
    const restoredTeacher = createClient(isolatedUrl, {
      forceNew: true,
      reconnection: false,
      auth: { teacher_token: createTeacherToken(teacher.teacherId, TOKEN_SECRET) },
    });
    const restoredProjector = createClient(isolatedUrl, { forceNew: true, reconnection: false });
    clients.push(restoredTeacher, restoredProjector);

    expect(restoredRounds.get(classroom.sessionId)?.liveSnapshot("restore-player")).toMatchObject({
      phase: "QUESTION_OPEN",
      attempt_id: "restore-attempt",
      question: { question_id: "restore-q" },
      own_answer: null,
    });
    const teacherAttach = await emitWithAck<{ snapshot: Record<string, unknown> }>(
      restoredTeacher,
      "teacher_attach",
      { session_id: classroom.sessionId },
    );
    const projectorAttach = await emitWithAck<{ snapshot: Record<string, unknown> }>(
      restoredProjector,
      "projector_attach",
      { projector_token: classroom.projectorToken },
    );
    const expectedSnapshot = {
      phase: "QUESTION_OPEN",
      attempt_id: "restore-attempt",
      question: {
        question_id: "restore-q",
        prompt: "Restore?",
        choices: ["A", "B", "C"],
      },
      own_answer: null,
      locked_count: 0,
      eligible_count: 2,
      server_time_ms: expect.any(Number),
      deadline_ms: expect.any(Number),
    };
    expect(teacherAttach.snapshot).toEqual(expectedSnapshot);
    expect(projectorAttach.snapshot).toEqual(expectedSnapshot);
    expect(teacherAttach.snapshot).not.toHaveProperty("question.correctChoice");
    expect(projectorAttach.snapshot).not.toHaveProperty("question.correctChoice");
    expect(projectorAttach.snapshot).toEqual(
      projectApplicationPacket("state_snapshot", "projector", expectedSnapshot),
    );
    const projectorSockets = await isolatedGateway.in(projectorRoom(classroom.sessionId)).fetchSockets();
    expect(projectorSockets[0]?.rooms).not.toContain(studentRoom(classroom.sessionId));
    expect(projectorSockets[0]?.rooms).not.toContain(answererRoom(classroom.sessionId));
    expect(projectorSockets[0]?.rooms).not.toContain(oneRoom(classroom.sessionId));
    restoredTeacher.disconnect();
    restoredProjector.disconnect();
    await isolatedGateway.close();
    await new Promise<void>((resolve) => isolatedServer.close(() => resolve()));
  });

  it("uses a server timer to coordinate deadline locking", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const timedRound = new QuestionRound({
      sessionId: classroom.sessionId,
      store: new GameEventStore(database),
      database,
      monotonicNow: Date.now,
      wallNow: Date.now,
      emit: () => undefined,
    });
    const isolatedServer = createAppServer();
    const isolatedGateway = attachSocketGateway(isolatedServer, {
      database,
      tokenSecret: TOKEN_SECRET,
      rounds: new Map([[classroom.sessionId, timedRound]]),
      monotonicNow: Date.now,
      wallNow: Date.now,
    });
    try {
      timedRound.openQuestion({
        actorId: teacher.teacherId,
        requestId: "timer-open",
        attemptId: "timer-attempt",
        question: { id: "timer-q", prompt: "Timer?", choices: ["A", "B", "C"], correctChoice: 0 },
        durationMs: 100,
        eligiblePlayerIds: ["missing-player"],
      });
      await vi.advanceTimersByTimeAsync(100);

      expect(timedRound.phase).toBe("LOCKED");
      expect(new GameEventStore(database).readSession(classroom.sessionId)).toEqual(
        expect.arrayContaining([expect.objectContaining({ eventType: "phase_a_locked" })]),
      );
    } finally {
      await isolatedGateway.close();
      vi.useRealTimers();
    }
  });

  it("rejects gameplay commands after the session ends", async () => {
    const student = client();
    const joined = await emitWithAck<{ player_id: string; token: string }>(student, "join_session", {
      code: classroom.code,
      nickname: "End Guard",
    });
    const teacherSocket = client({
      teacher_token: createTeacherToken(teacher.teacherId, TOKEN_SECRET),
    });
    await emitWithAck(teacherSocket, "teacher_attach", { session_id: classroom.sessionId });
    await emitWithAck(teacherSocket, "teacher_end_session", { request_id: "end-now" });

    expect(await emitWithAck(student, "answer_submit", {
      request_id: "answer-after-end",
      question_id: "q",
      choice: 0,
    })).toMatchObject({ ok: false, code: "SESSION_ENDED", deadline_ms: null });
    expect(await emitWithAck(teacherSocket, "teacher_open_question", {
      request_id: "open-after-end",
    })).toMatchObject({ ok: false, code: "SESSION_ENDED", deadline_ms: null });
    expect(await emitWithAck(teacherSocket, "teacher_pause", {
      request_id: "pause-after-end",
      attempt_id: "attempt",
    })).toMatchObject({ ok: false, code: "SESSION_ENDED", deadline_ms: null });
    const reconnect = client();
    const resume = () => emitWithAck(reconnect, "resume", {
      player_token: joined.token,
      request_id: "resume-after-end",
    });
    const firstResume = await resume();
    expect(firstResume).toMatchObject({
      ok: false,
      request_id: "resume-after-end",
      code: "SESSION_ENDED",
      deadline_ms: null,
    });
    expect(await resume()).toMatchObject({
      ok: false,
      request_id: "resume-after-end",
      code: "SESSION_ENDED",
      message: "This show has ended",
      deadline_ms: null,
    });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM command_outcomes WHERE session_id = ? AND actor_id = ? AND request_id = ?",
    ).get(classroom.sessionId, joined.player_id, "resume-after-end")).toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM game_events WHERE session_id = ? AND actor_id = ? AND request_id = ?",
    ).get(classroom.sessionId, joined.player_id, "resume-after-end")).toEqual({ count: 1 });
  });

  it.each(["teacher_advance", "teacher_pause", "teacher_resume", "teacher_force_reveal"])(
    "durably rejects ended 1v100 %s controls",
    async (event) => {
      database.prepare("UPDATE sessions SET settings_json = ? WHERE session_id = ?")
        .run(JSON.stringify(ONE_V_100_DEFAULT_SETTINGS), classroom.sessionId);
      const teacherSocket = client({ teacher_token: createTeacherToken(teacher.teacherId, TOKEN_SECRET) });
      await emitWithAck(teacherSocket, "teacher_attach", { session_id: classroom.sessionId });
      await emitWithAck(teacherSocket, "teacher_end_session", { request_id: `end-before-${event}` });
      const payload = { request_id: `ended-${event}` };

      expect(await emitWithAck(teacherSocket, event, payload)).toMatchObject({
        ok: false,
        code: "SESSION_ENDED",
      });
      expect(await emitWithAck(teacherSocket, event, payload)).toMatchObject({
        ok: false,
        code: "SESSION_ENDED",
        message: "This show has ended",
      });
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM command_outcomes WHERE session_id = ? AND actor_id = ? AND request_id = ?",
      ).get(classroom.sessionId, teacher.teacherId, payload.request_id)).toEqual({ count: 1 });
    },
  );

  it("joins a valid-code student, persists the player, and returns token plus roster", async () => {
    const socket = client();

    const ack = await emitWithAck<{
      player_id: string;
      token: string;
      roster: Array<{ nickname: string }>;
    }>(socket, "join_session", { code: classroom.code, nickname: "Avery" });
    const row = database
      .prepare("SELECT nickname, role FROM session_players WHERE player_id = ?")
      .get(ack.player_id) as { nickname: string; role: string };

    expect(ack.token).toMatch(/^p1\./);
    expect(ack.roster).toEqual([
      expect.objectContaining({ nickname: "Avery", connected: true }),
    ]);
    expect(row).toEqual({ nickname: "Avery", role: "mob" });
  });

  it("returns JOIN_BAD_CODE and creates no player for an invalid code", async () => {
    const ack = await emitWithAck<{ ok: false; code: string }>(client(), "join_session", {
      code: "ZZZZZZ",
      nickname: "Avery",
    });
    const count = database.prepare("SELECT COUNT(*) AS count FROM session_players").get() as {
      count: number;
    };

    expect(ack).toMatchObject({ ok: false, code: "JOIN_BAD_CODE" });
    expect(count.count).toBe(0);
  });

  it("isolates projector-room packets from student sockets", async () => {
    const student = client();
    await emitWithAck(student, "join_session", { code: classroom.code, nickname: "Avery" });
    const projector = client();
    const attach = await emitWithAck<{ ok: boolean }>(projector, "projector_attach", {
      projector_token: classroom.projectorToken,
    });
    let studentReceived = false;
    student.on("projector_only_test", () => {
      studentReceived = true;
    });
    const projectorPacket = new Promise((resolve) =>
      projector.once("projector_only_test", resolve),
    );

    gateway.to(projectorRoom(classroom.sessionId)).emit("projector_only_test", {
      audience: "projector",
    });

    await projectorPacket;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(attach.ok).toBe(true);
    expect(studentReceived).toBe(false);
  });

  it("delivers a complete generic question and reveal counts to the projector", async () => {
    const student = client();
    const joined = await emitWithAck<{ player_id: string }>(student, "join_session", {
      code: classroom.code,
      nickname: "Projector Player",
    });
    const teacherSocket = client({
      teacher_token: createTeacherToken(teacher.teacherId, TOKEN_SECRET),
    });
    await emitWithAck(teacherSocket, "teacher_attach", { session_id: classroom.sessionId });
    const projector = client();
    await emitWithAck(projector, "projector_attach", {
      projector_token: classroom.projectorToken,
    });
    const questionFrame = new Promise<Record<string, unknown>>((resolve) =>
      projector.once("question_open", resolve),
    );

    const opened = await emitWithAck<{ attempt_id: string }>(teacherSocket, "teacher_open_question", {
      request_id: "projector-question",
    });
    const question = await questionFrame;
    expect(question).toMatchObject({
      attempt_id: opened.attempt_id,
      prompt: expect.any(String),
      choices: expect.arrayContaining([expect.any(String)]),
    });

    await emitWithAck(student, "answer_submit", {
      request_id: "projector-answer",
      attempt_id: opened.attempt_id,
      question_id: question.question_id,
      choice: 0,
    });
    const revealFrame = new Promise<Record<string, unknown>>((resolve) =>
      projector.once("reveal", resolve),
    );
    await emitWithAck(teacherSocket, "teacher_force_reveal", {
      request_id: "projector-reveal",
      attempt_id: opened.attempt_id,
    });

    expect(await revealFrame).toMatchObject({
      correct_choice: expect.any(Number),
      counts: expect.any(Array),
      outcomes: expect.arrayContaining([expect.objectContaining({ player_id: joined.player_id })]),
    });
  });

  it("advances the deck cursor so repeated opens serve successive questions", async () => {
    const session = database
      .prepare("SELECT question_set_id FROM sessions WHERE session_id = ?")
      .get(classroom.sessionId) as { question_set_id: string };
    database
      .prepare(
        `INSERT INTO questions
          (question_id, question_set_id, position, prompt, choices_json, correct_choice, phase_a_seconds)
         VALUES (?, ?, 2, 'What is 2 + 2?', ?, 1, 20)`,
      )
      .run(crypto.randomUUID(), session.question_set_id, JSON.stringify(["3", "4", "5"]));

    const student = client();
    const joined = await emitWithAck<{ player_id: string }>(student, "join_session", {
      code: classroom.code,
      nickname: "Deck Tester",
    });
    const teacherSocket = client({
      teacher_token: createTeacherToken(teacher.teacherId, TOKEN_SECRET),
    });
    await emitWithAck(teacherSocket, "teacher_attach", { session_id: classroom.sessionId });

    const forbidden: string[] = [];
    const recordLeaks = (socketName: string) => (event: string, ...args: unknown[]) => {
      if (event === "reveal") return;
      const serialized = JSON.stringify(args);
      if (serialized.includes("correct_choice") || serialized.includes("correctChoice")) {
        forbidden.push(socketName + ":" + event);
      }
    };
    student.onAny(recordLeaks("student"));
    const deckProjector = client();
    await emitWithAck(deckProjector, "projector_attach", { projector_token: classroom.projectorToken });
    deckProjector.onAny(recordLeaks("projector"));

    const firstFrame = new Promise<Record<string, unknown>>((resolve) => student.once("question_open", resolve));
    const first = await emitWithAck<{ ok: boolean; attempt_id: string }>(teacherSocket, "teacher_open_question", {
      request_id: "deck-open-1",
    });
    expect(first.ok).toBe(true);
    const firstQuestion = await firstFrame;

    await emitWithAck(student, "answer_submit", {
      request_id: "deck-answer-1",
      attempt_id: first.attempt_id,
      question_id: firstQuestion.question_id,
      choice: 0,
    });
    await emitWithAck(teacherSocket, "teacher_force_reveal", {
      request_id: "deck-reveal-1",
      attempt_id: first.attempt_id,
    });

    const secondFrame = new Promise<Record<string, unknown>>((resolve) => student.once("question_open", resolve));
    const second = await emitWithAck<{ ok: boolean; attempt_id: string }>(teacherSocket, "teacher_open_question", {
      request_id: "deck-open-2",
    });
    expect(second.ok).toBe(true);
    const secondQuestion = await secondFrame;

    expect(secondQuestion.question_id).not.toBe(firstQuestion.question_id);
    expect(secondQuestion.prompt).toBe("What is 2 + 2?");
    expect(joined.player_id).toBeTruthy();

    await emitWithAck(student, "answer_submit", {
      request_id: "deck-answer-2",
      attempt_id: second.attempt_id,
      question_id: secondQuestion.question_id,
      choice: 1,
    });
    await emitWithAck(teacherSocket, "teacher_force_reveal", {
      request_id: "deck-reveal-2",
      attempt_id: second.attempt_id,
    });

    const exhausted = await emitWithAck<{ ok: boolean; code?: string }>(teacherSocket, "teacher_open_question", {
      request_id: "deck-open-3",
    });
    expect(exhausted).toMatchObject({ ok: false, code: "NO_QUESTION" });
    expect(forbidden).toEqual([]);
  });

  it("applies generic timer settings from the next question and logs invalid changes", async () => {
    const session = database
      .prepare("SELECT question_set_id FROM sessions WHERE session_id = ?")
      .get(classroom.sessionId) as { question_set_id: string };
    database.prepare(
      `INSERT INTO questions
        (question_id, question_set_id, position, prompt, choices_json, correct_choice, phase_a_seconds)
       VALUES (?, ?, 2, 'Second timed question', ?, 1, 45)`,
    ).run(crypto.randomUUID(), session.question_set_id, JSON.stringify(["A", "B", "C"]));
    const teacherSocket = client({ teacher_token: createTeacherToken(teacher.teacherId, TOKEN_SECRET) });
    const attached = await emitWithAck<Record<string, unknown>>(teacherSocket, "teacher_attach", {
      session_id: classroom.sessionId,
    });
    expect(attached).toMatchObject({ ok: true, settings_revision: 1, phase_a_seconds: 20 });

    const first = await emitWithAck<{ ok: boolean; attempt_id: string; deadline_ms: number }>(
      teacherSocket,
      "teacher_open_question",
      { request_id: "generic-settings-open-1" },
    );
    const firstDeadline = first.deadline_ms;
    const changed = await emitWithAck<Record<string, unknown>>(teacherSocket, "teacher_settings", {
      request_id: "generic-settings-change",
      phase_a_seconds: 10,
    });
    expect(changed).toMatchObject({
      ok: true,
      settings_revision: 2,
      phase_a_seconds: 10,
      deadline_ms: firstDeadline,
    });
    expect(await emitWithAck(teacherSocket, "teacher_settings", {
      request_id: "generic-settings-change",
      phase_a_seconds: 10,
    })).toMatchObject({
      ok: true,
      requestId: "generic-settings-change",
      serverSeq: changed.serverSeq,
      settings_revision: 2,
      phase_a_seconds: 10,
      deadline_ms: firstDeadline,
    });
    expect(await emitWithAck(teacherSocket, "teacher_settings", {
      request_id: "generic-settings-invalid",
      phase_a_seconds: 9,
    })).toMatchObject({
      ok: false,
      code: "INVALID_SETTINGS",
      message: "phase_a_seconds must be an integer from 10 to 60",
    });

    await emitWithAck(teacherSocket, "teacher_force_reveal", {
      request_id: "generic-settings-reveal-1",
      attempt_id: first.attempt_id,
    });
    const second = await emitWithAck<{ ok: boolean; deadline_ms: number; server_time_ms: number }>(
      teacherSocket,
      "teacher_open_question",
      { request_id: "generic-settings-open-2" },
    );
    expect(second.deadline_ms - second.server_time_ms).toBeGreaterThan(9_900);
    expect(second.deadline_ms - second.server_time_ms).toBeLessThanOrEqual(10_000);

    const events = new GameEventStore(database).readSession(classroom.sessionId);
    expect(events.filter((event) => event.eventType === "settings_updated")).toHaveLength(1);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventType: "command_rejected",
        requestId: "generic-settings-invalid",
        payload: expect.objectContaining({ code: "INVALID_SETTINGS" }),
      }),
    ]));
  });

  it("keeps an explicit question's imported timer until the session timer is edited", async () => {
    const session = database.prepare(
      "SELECT question_set_id FROM sessions WHERE session_id = ?",
    ).get(classroom.sessionId) as { question_set_id: string };
    const questionId = crypto.randomUUID();
    database.prepare(
      `INSERT INTO questions
        (question_id, question_set_id, position, prompt, choices_json, correct_choice, phase_a_seconds)
       VALUES (?, ?, 2, 'Explicit timer question', ?, 0, 45)`,
    ).run(questionId, session.question_set_id, JSON.stringify(["A", "B", "C"]));
    const teacherSocket = client({ teacher_token: createTeacherToken(teacher.teacherId, TOKEN_SECRET) });
    await emitWithAck(teacherSocket, "teacher_attach", { session_id: classroom.sessionId });

    expect(await emitWithAck(teacherSocket, "teacher_settings", {
      request_id: "explicit-timer-settings",
      phase_a_seconds: 10,
    })).toMatchObject({ ok: true, phase_a_seconds: 10 });

    const opened = await emitWithAck<{ deadline_ms: number; server_time_ms: number }>(
      teacherSocket,
      "teacher_open_question",
      { request_id: "explicit-timer-open", question_id: questionId },
    );

    expect(opened.deadline_ms - opened.server_time_ms).toBeGreaterThan(44_900);
    expect(opened.deadline_ms - opened.server_time_ms).toBeLessThanOrEqual(45_000);
  });

  it("activates 1v100 on a generic session when the teacher picks the first One", async () => {
    const studentA = client();
    const joinedA = await emitWithAck<{ player_id: string }>(studentA, "join_session", {
      code: classroom.code,
      nickname: "First One",
    });
    const studentB = client();
    await emitWithAck(studentB, "join_session", {
      code: classroom.code,
      nickname: "Mob Member",
    });
    const teacherSocket = client({
      teacher_token: createTeacherToken(teacher.teacherId, TOKEN_SECRET),
    });
    await emitWithAck(teacherSocket, "teacher_attach", { session_id: classroom.sessionId });

    const gameStart = new Promise<Record<string, unknown>>((resolve) => studentB.once("game_start", resolve));
    const started = await emitWithAck<{ ok: boolean }>(teacherSocket, "teacher_start_session", {
      request_id: "start-activation",
      first_one_player_id: joinedA.player_id,
    });
    expect(started.ok).toBe(true);
    expect((await gameStart).one).toMatchObject({ nickname: "First One" });

    const settings = database
      .prepare("SELECT settings_json FROM sessions WHERE session_id = ?")
      .get(classroom.sessionId) as { settings_json: string };
    expect(JSON.parse(settings.settings_json)).toMatchObject({ mode: "one_v_100" });

    const replayed = await emitWithAck<{ ok: boolean }>(teacherSocket, "teacher_start_session", {
      request_id: "start-activation",
      first_one_player_id: joinedA.player_id,
    });
    expect(replayed.ok).toBe(true);
  });

  it("acknowledges all 30 loopback students with their own identity", async () => {
    const sockets = Array.from({ length: 30 }, () => client());

    const acknowledgements = await Promise.all(
      sockets.map((socket, index) =>
        emitWithAck<{ player_id: string; roster: unknown[] }>(socket, "join_session", {
          code: classroom.code,
          nickname: `Student ${index + 1}`,
        }),
      ),
    );

    expect(new Set(acknowledgements.map((ack) => ack.player_id)).size).toBe(30);
    expect(
      (database.prepare("SELECT COUNT(*) AS count FROM session_players").get() as { count: number })
        .count,
    ).toBe(30);
  }, 10_000);
});
