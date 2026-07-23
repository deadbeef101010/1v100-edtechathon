import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { io as createClient, type Socket as ClientSocket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type AppDatabase } from "../src/db.js";
import { GameEventStore } from "../src/game-event-store.js";
import { createAppServer } from "../src/server.js";
import { attachSocketGateway } from "../src/socket-gateway.js";
import { createClassroomSession, type CreatedClassroomSession } from "../src/sessions.js";
import { mintTeacherKey } from "../src/teachers.js";
import { ServerLogger } from "../src/log.js";

const SECRET = `join-hardening-${"test-only-".repeat(3)}`;
let directory: string;
let database: AppDatabase;
let classroom: CreatedClassroomSession;
let server: ReturnType<typeof createAppServer>;
let gateway: ReturnType<typeof attachSocketGateway>;
let url: string;
const clients: ClientSocket[] = [];
let logger: ServerLogger;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "game-join-hardening-"));
  database = openDatabase(join(directory, "game.db"));
  const teacher = mintTeacherKey(database, "Join Teacher");
  classroom = createClassroomSession(database, teacher.teacherId, SECRET);
  server = createAppServer();
  logger = new ServerLogger({ write: () => undefined });
  gateway = attachSocketGateway(server, {
    database,
    tokenSecret: SECRET,
    rateLimitPerSecond: 2,
    logger,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected listener");
  url = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  for (const socket of clients.splice(0)) socket.disconnect();
  await gateway.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  database.close();
  await rm(directory, { recursive: true, force: true });
});

function client(): ClientSocket {
  const socket = createClient(url, { forceNew: true, reconnection: false });
  clients.push(socket);
  return socket;
}

function ack<T>(socket: ClientSocket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

describe("join and command hardening", () => {
  it("recovers a lost join ack with the same player and token", async () => {
    const identity = crypto.randomUUID();
    const payload = {
      code: classroom.code,
      nickname: "Maya",
      client_instance_id: identity,
      request_id: crypto.randomUUID(),
    };
    const first = await ack<{ player_id: string; token: string }>(client(), "join_session", payload);
    const retry = await ack<{ player_id: string; token: string }>(client(), "join_session", payload);

    expect(retry).toMatchObject(first);
    expect(database.prepare("SELECT COUNT(*) AS count FROM session_players").get()).toEqual({ count: 1 });
  });

  it("rejects the 41st active player with a kid-safe SESSION_FULL", async () => {
    for (let index = 1; index <= 40; index += 1) {
      await ack(client(), "join_session", { code: classroom.code, nickname: `Player ${index}` });
    }
    expect(await ack(client(), "join_session", { code: classroom.code, nickname: "Player 41" })).toEqual({
      ok: false,
      code: "SESSION_FULL",
      message: "This game is full. Ask your teacher for help",
    });
  }, 10_000);

  it("rate-limits excess commands and logs the durable rejection", async () => {
    const socket = client();
    const joined = await ack<{ player_id: string }>(socket, "join_session", {
      code: classroom.code,
      nickname: "Maya",
    });
    const errors: Array<{ code: string }> = [];
    socket.on("command_error", (error) => errors.push(error));
    socket.emit("answer_submit", { request_id: "a1", attempt_id: "x", question_id: "q", choice: 0 });
    socket.emit("answer_submit", { request_id: "a2", attempt_id: "x", question_id: "q", choice: 0 });
    socket.emit("answer_submit", { request_id: "a3", attempt_id: "x", question_id: "q", choice: 0 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(errors.some((error) => error.code === "RATE_LIMITED")).toBe(true);
    expect(
      new GameEventStore(database)
        .readSession(classroom.sessionId)
        .some((event) => event.eventType === "command_rejected" && event.actorId === joined.player_id),
    ).toBe(true);
    expect(logger.entries()).toContainEqual(expect.objectContaining({
      event: "rate_limit_hit",
      session_id: classroom.sessionId,
      actor: { kind: "player", id: joined.player_id },
      detail: { command: "answer_submit", limit_per_second: 2 },
    }));
  });

  it("rejects a 20 KiB application envelope before parsing", async () => {
    expect(await ack(client(), "join_session", "{" + "x".repeat(20 * 1_024))).toEqual({
      ok: false,
      code: "PAYLOAD_TOO_LARGE",
      message: "That message is too large",
    });
  });

  it("expires the join code when the session ends", async () => {
    database.prepare("UPDATE sessions SET status = 'ended', ended_at_ms = ? WHERE session_id = ?").run(Date.now(), classroom.sessionId);
    expect(await ack(client(), "join_session", { code: classroom.code, nickname: "Maya" })).toMatchObject({
      ok: false,
      code: "JOIN_BAD_CODE",
    });
  });
});
