import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { io as createClient, type Socket as ClientSocket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTeacherToken } from "../src/auth.js";
import { openDatabase, type AppDatabase } from "../src/db.js";
import { createAppServer } from "../src/server.js";
import {
  answererRoom,
  attachSocketGateway,
  playerRoom,
  studentRoom,
} from "../src/socket-gateway.js";
import { createClassroomSession, type CreatedClassroomSession } from "../src/sessions.js";
import { mintTeacherKey } from "../src/teachers.js";

const SECRET = "reconnect-secret-at-least-32-characters";
let directory: string;
let database: AppDatabase;
let classroom: CreatedClassroomSession;
let teacherId: string;
let server: ReturnType<typeof createAppServer>;
let gateway: ReturnType<typeof attachSocketGateway>;
let url: string;
const clients: ClientSocket[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "game-reconnect-"));
  database = openDatabase(join(directory, "game.db"));
  const teacher = mintTeacherKey(database, "Reconnect Teacher");
  teacherId = teacher.teacherId;
  classroom = createClassroomSession(database, teacherId, SECRET);
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

describe("player reconnect", () => {
  it("restores identity, points, snapshot, rooms, and subsequent roster delivery", async () => {
    const first = client();
    const joined = await ack<{ player_id: string; token: string }>(first, "join_session", {
      code: classroom.code,
      nickname: "Maya",
    });
    database.prepare("UPDATE session_players SET points = 42 WHERE player_id = ?").run(joined.player_id);
    first.disconnect();

    const resumed = client();
    const result = await ack<{
      ok: true;
      player_id: string;
      nickname: string;
      role: string;
      points: number;
      session_state: string;
    }>(resumed, "resume", { token: joined.token, session_id: classroom.sessionId });
    const serverSocket = gateway.sockets.sockets.get(resumed.id ?? "");

    expect(result).toMatchObject({
      ok: true,
      player_id: joined.player_id,
      nickname: "Maya",
      role: "mob",
      points: 42,
      session_state: "lobby",
    });
    expect(serverSocket?.rooms).toContain(studentRoom(classroom.sessionId));
    expect(serverSocket?.rooms).toContain(playerRoom(classroom.sessionId, joined.player_id));
    expect(serverSocket?.rooms).toContain(answererRoom(classroom.sessionId));

    const roster = new Promise<unknown>((resolve) => resumed.once("roster_update", resolve));
    await ack(client(), "join_session", { code: classroom.code, nickname: "Blake" });
    expect(await roster).toEqual(expect.arrayContaining([expect.objectContaining({ nickname: "Blake" })]));
  });

  it("computes a fresh snapshot for each resume attempt from the same browser", async () => {
    const joined = await ack<{ player_id: string; token: string }>(client(), "join_session", {
      code: classroom.code,
      nickname: "Fresh Maya",
    });
    const first = await ack<{ points: number; snapshot: { phase: string } }>(client(), "resume", {
      token: joined.token,
      session_id: classroom.sessionId,
      request_id: "resume-one",
      client_instance_id: "stable-browser",
    });
    const teacher = client({ teacher_token: createTeacherToken(teacherId, SECRET) });
    await ack(teacher, "teacher_attach", { session_id: classroom.sessionId });
    const opened = await ack<{ ok: true; attempt_id: string }>(teacher, "teacher_open_question", {
      request_id: "question-after-first-resume",
    });

    const second = await ack<{
      snapshot: { phase: string; attempt_id: string; question: { question_id: string } };
    }>(client(), "resume", {
      token: joined.token,
      session_id: classroom.sessionId,
      request_id: "resume-two",
      client_instance_id: "stable-browser",
    });

    expect(first).toMatchObject({ points: 0, snapshot: { phase: "LOBBY" } });
    expect(second.snapshot).toMatchObject({
      phase: "QUESTION_OPEN",
      attempt_id: opened.attempt_id,
      question: { question_id: expect.any(String) },
    });
  });

  it("rejects a token when the claimed session differs", async () => {
    const joined = await ack<{ token: string }>(client(), "join_session", {
      code: classroom.code,
      nickname: "Maya",
    });
    const other = createClassroomSession(
      database,
      (database.prepare("SELECT teacher_id FROM sessions WHERE session_id = ?").get(classroom.sessionId) as { teacher_id: string }).teacher_id,
      SECRET,
    );

    expect(await ack(client(), "resume", { token: joined.token, session_id: other.sessionId })).toEqual({
      ok: false,
      code: "RECONNECT_BAD_TOKEN",
    });
  });

  it("rejects a token with a tampered HMAC", async () => {
    const joined = await ack<{ token: string }>(client(), "join_session", {
      code: classroom.code,
      nickname: "Maya",
    });
    const tampered = `${joined.token.slice(0, -1)}${joined.token.endsWith("A") ? "B" : "A"}`;

    expect(await ack(client(), "resume", { token: tampered })).toEqual({
      ok: false,
      code: "RECONNECT_BAD_TOKEN",
    });
  });
});
