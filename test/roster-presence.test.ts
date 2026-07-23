import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { io as createClient, type Socket as ClientSocket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type AppDatabase } from "../src/db.js";
import { attachSocketGateway, type RosterEntry } from "../src/socket-gateway.js";
import { createAppServer } from "../src/server.js";
import { createClassroomSession, type CreatedClassroomSession } from "../src/sessions.js";
import { mintTeacherKey } from "../src/teachers.js";

const TOKEN_SECRET = "presence-token-secret-32-characters-minimum";

let directory: string;
let database: AppDatabase;
let classroom: CreatedClassroomSession;
let url: string;
let server: ReturnType<typeof createAppServer>;
let gateway: ReturnType<typeof attachSocketGateway>;
const clients: ClientSocket[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "game-1v100-presence-"));
  database = openDatabase(join(directory, "game.db"));
  const teacher = mintTeacherKey(database, "Ms Rivera");
  classroom = createClassroomSession(database, teacher.teacherId, TOKEN_SECRET);
  server = createAppServer();
  gateway = attachSocketGateway(server, { database, tokenSecret: TOKEN_SECRET });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected TCP address");
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

function client(): ClientSocket {
  const socket = createClient(url, { forceNew: true, reconnection: false });
  clients.push(socket);
  return socket;
}

function ack<T>(socket: ClientSocket, event: string, payload: unknown): Promise<T> {
  return new Promise<T>((resolve) => socket.emit(event, payload, resolve));
}

function nextRoster(projector: ClientSocket): Promise<RosterEntry[]> {
  return new Promise((resolve) => projector.once("roster_update", resolve));
}

describe("live roster presence", () => {
  it("keeps join order while disconnecting and token-resuming without a duplicate row", async () => {
    const projector = client();
    await ack(projector, "projector_attach", { projector_token: classroom.projectorToken });
    const avery = client();
    const averyRoster = nextRoster(projector);
    const averyAck = await ack<{ player_id: string; token: string }>(avery, "join_session", {
      code: classroom.code,
      nickname: "Avery",
    });
    await averyRoster;
    const blake = client();
    const joinedRoster = nextRoster(projector);
    await ack(blake, "join_session", { code: classroom.code, nickname: "Blake" });

    expect((await joinedRoster).map((player) => player.nickname)).toEqual(["Avery", "Blake"]);

    const disconnectedRoster = nextRoster(projector);
    const disconnectedAt = performance.now();
    avery.disconnect();
    const afterDisconnect = await disconnectedRoster;
    expect(afterDisconnect[0]).toMatchObject({ nickname: "Avery", connected: false });
    expect(performance.now() - disconnectedAt).toBeLessThan(20_000);

    const resumed = client();
    const reconnectedRoster = nextRoster(projector);
    const resumeAck = await ack<{ ok: boolean; player_id: string }>(resumed, "resume", {
      player_token: averyAck.token,
      client_instance_id: crypto.randomUUID(),
    });
    const afterReconnect = await reconnectedRoster;
    const count = database.prepare("SELECT COUNT(*) AS count FROM session_players").get() as {
      count: number;
    };

    expect(resumeAck).toMatchObject({ ok: true, player_id: averyAck.player_id });
    expect(afterReconnect).toEqual([
      expect.objectContaining({ nickname: "Avery", connected: true }),
      expect.objectContaining({ nickname: "Blake", connected: true }),
    ]);
    expect(count.count).toBe(2);
  });
});
