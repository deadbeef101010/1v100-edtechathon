import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { io as createClient, type Socket as ClientSocket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type AppDatabase } from "../src/db.js";
import { nicknameIsAllowed, normalizeNickname } from "../src/nickname-policy.js";
import { createAppServer } from "../src/server.js";
import { attachSocketGateway } from "../src/socket-gateway.js";
import { createClassroomSession, type CreatedClassroomSession } from "../src/sessions.js";
import { mintTeacherKey } from "../src/teachers.js";

const SECRET = "nickname-secret-at-least-32-characters";
let directory: string;
let database: AppDatabase;
let classroom: CreatedClassroomSession;
let server: ReturnType<typeof createAppServer>;
let gateway: ReturnType<typeof attachSocketGateway>;
let url: string;
const clients: ClientSocket[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "game-nickname-"));
  database = openDatabase(join(directory, "game.db"));
  const teacher = mintTeacherKey(database, "Nickname Teacher");
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

describe("nickname policy", () => {
  it("enforces normalized per-session uniqueness and suggests a safe alternative", async () => {
    await ack(client(), "join_session", { code: classroom.code, nickname: "Maya" });

    expect(
      await ack(client(), "join_session", { code: classroom.code, nickname: "  maya  " }),
    ).toEqual({
      ok: false,
      code: "NICKNAME_TAKEN",
      message: "That nickname is already playing. Try the suggestion!",
      suggestion: "maya 2",
    });
  });

  it("allows the original holder to reconnect only with their token", async () => {
    const joined = await ack<{ player_id: string; token: string }>(client(), "join_session", {
      code: classroom.code,
      nickname: "Maya",
    });

    expect(await ack(client(), "resume", { token: joined.token })).toMatchObject({
      ok: true,
      player_id: joined.player_id,
    });
  });

  it("rejects denylisted words with a kid-safe message and supports a swappable list", async () => {
    expect(nicknameIsAllowed(normalizeNickname("Zorg"), ["zorg"])).toBe(false);
    expect(await ack(client(), "join_session", { code: classroom.code, nickname: "Idiot" })).toEqual({
      ok: false,
      code: "NICKNAME_NOT_ALLOWED",
      message: "Please choose a classroom-friendly nickname",
    });
  });
});
