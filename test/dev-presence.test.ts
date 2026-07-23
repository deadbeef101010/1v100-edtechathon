import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { io, type Socket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type AppDatabase } from "../src/db.js";
import { createGameServer } from "../src/server.js";
import { createClassroomSession, type CreatedClassroomSession } from "../src/sessions.js";
import { mintTeacherKey } from "../src/teachers.js";

const SECRET = "dev-presence-secret-at-least-32-characters";
const DEV_TOKEN = "presence-dev-token";
let directory: string;
let database: AppDatabase;
let classroom: CreatedClassroomSession;
let runtime: ReturnType<typeof createGameServer>;
let url: string;
let sockets: Socket[];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "game-dev-presence-"));
  database = openDatabase(join(directory, "game.db"));
  const teacher = mintTeacherKey(database, "Presence teacher");
  classroom = createClassroomSession(database, teacher.teacherId, SECRET);
  runtime = createGameServer({ database, tokenSecret: SECRET, devViews: true, devToken: DEV_TOKEN });
  runtime.server.listen(0, "127.0.0.1");
  await once(runtime.server, "listening");
  const address = runtime.server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP address");
  url = `http://127.0.0.1:${address.port}`;
  sockets = [];
});

afterEach(async () => {
  for (const socket of sockets) socket.disconnect();
  runtime.gateway.close();
  if (runtime.server.listening) await new Promise<void>((resolve) => runtime.server.close(() => resolve()));
  database.close();
  await rm(directory, { recursive: true, force: true });
});

function client(): Socket {
  const socket = io(url, { transports: ["websocket"], forceNew: true });
  sockets.push(socket);
  return socket;
}

function ack<T>(socket: Socket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

async function state(playerId: string): Promise<{ presence_available: boolean; players: Array<{ player_id: string; connected: boolean; socket_count: number }> }> {
  const response = await fetch(`${url}/api/dev/session/${classroom.sessionId}/state`, {
    headers: { "x-dev-token": DEV_TOKEN },
  });
  expect(response.status).toBe(200);
  const body = await response.json() as { presence_available: boolean; players: Array<{ player_id: string; connected: boolean; socket_count: number }> };
  expect(body.players.some((player) => player.player_id === playerId)).toBe(true);
  return body;
}

describe("dev state presence", () => {
  it("tracks player socket attach and detach", async () => {
    const socket = client();
    const joined = await ack<{ player_id: string }>(socket, "join_session", {
      code: classroom.code,
      nickname: "Avery",
    });
    expect(joined.player_id).toBeTypeOf("string");

    let body = await state(joined.player_id);
    expect(body.presence_available).toBe(true);
    expect(body.players).toContainEqual(expect.objectContaining({
      player_id: joined.player_id,
      connected: true,
      socket_count: 1,
    }));

    socket.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 20));
    body = await state(joined.player_id);
    expect(body.players).toContainEqual(expect.objectContaining({
      player_id: joined.player_id,
      connected: false,
      socket_count: 0,
    }));
  });
});
