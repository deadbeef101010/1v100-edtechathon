import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { io as createClient, type Socket as ClientSocket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTeacherToken } from "../src/auth.js";
import { openDatabase, type AppDatabase } from "../src/db.js";
import { answererRoom, attachSocketGateway, oneRoom } from "../src/socket-gateway.js";
import { createAppServer } from "../src/server.js";
import { createClassroomSession, type CreatedClassroomSession } from "../src/sessions.js";
import { mintTeacherKey } from "../src/teachers.js";

const SECRET = "role-assignment-secret-at-least-32-chars";
let directory: string;
let database: AppDatabase;
let classroom: CreatedClassroomSession;
let teacherId: string;
let server: ReturnType<typeof createAppServer>;
let gateway: ReturnType<typeof attachSocketGateway>;
let url: string;
const clients: ClientSocket[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "game-role-assignment-"));
  database = openDatabase(join(directory, "game.db"));
  const teacher = mintTeacherKey(database, "Role Teacher");
  teacherId = teacher.teacherId;
  classroom = createClassroomSession(database, teacherId, SECRET);
  server = createAppServer();
  gateway = attachSocketGateway(server, { database, tokenSecret: SECRET });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP listener");
  url = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const socket of clients.splice(0)) socket.disconnect();
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

async function teacherSocket(): Promise<ClientSocket> {
  const teacher = client({ teacher_token: createTeacherToken(teacherId, SECRET) });
  await ack(teacher, "teacher_attach", { session_id: classroom.sessionId });
  return teacher;
}

describe("role assignment", () => {
  it("persists a role, moves every tab, and restores the role on reconnect", async () => {
    const first = client();
    const joined = await ack<{ player_id: string; token: string; role: string }>(first, "join_session", {
      code: classroom.code,
      nickname: "Role Player",
    });
    const second = client();
    await ack(second, "resume", { player_token: joined.token, request_id: "second-tab" });
    const teacher = await teacherSocket();

    const assigned = await ack<Record<string, unknown>>(teacher, "assign_role", {
      request_id: "assign-one",
      player_id: joined.player_id,
      role: "one",
    });
    const identitySockets = await gateway.in(`s:${classroom.sessionId}:p:${joined.player_id}`).fetchSockets();

    expect(assigned).toMatchObject({ ok: true, player_id: joined.player_id, role: "one" });
    expect(identitySockets).toHaveLength(2);
    identitySockets.forEach((socket) => {
      expect(socket.rooms).toContain(oneRoom(classroom.sessionId));
      expect(socket.rooms).not.toContain(answererRoom(classroom.sessionId));
    });
    expect(database.prepare("SELECT role FROM session_players WHERE player_id = ?").get(joined.player_id))
      .toEqual({ role: "one" });

    first.disconnect();
    second.disconnect();
    const resumed = client();
    const resume = await ack<{ role: string }>(resumed, "resume", {
      player_token: joined.token,
      request_id: "after-role-change",
    });
    const resumedServerSocket = gateway.sockets.sockets.get(resumed.id ?? "");
    expect(resume.role).toBe("one");
    expect(resumedServerSocket?.rooms).toContain(oneRoom(classroom.sessionId));
    expect(resumedServerSocket?.rooms).not.toContain(answererRoom(classroom.sessionId));
  });

  it("moves every identity socket through the production role transition without stale delivery", async () => {
    const first = client();
    const joined = await ack<{ player_id: string; token: string }>(first, "join_session", {
      code: classroom.code,
      nickname: "Raw Frames",
    });
    const second = client();
    await ack(second, "resume", { player_token: joined.token, request_id: "raw-second-tab" });
    const teacher = await teacherSocket();
    const oldRoleFrames: unknown[] = [];
    const newRoleFrames: unknown[] = [];
    const transitionFrames: unknown[] = [];
    for (const socket of [first, second]) {
      socket.on("old_role_only", (frame) => oldRoleFrames.push(frame));
      socket.on("new_role_only", (frame) => newRoleFrames.push(frame));
      socket.on("transition_old_role", (frame) => transitionFrames.push(frame));
      socket.on("transition_new_role", (frame) => transitionFrames.push(frame));
    }
    const identitySockets = await gateway.in(`s:${classroom.sessionId}:p:${joined.player_id}`).fetchSockets();
    let transitionProbed = false;
    for (const identitySocket of identitySockets) {
      const originalJoin = identitySocket.join.bind(identitySocket);
      identitySocket.join = async (room) => {
        const rooms = typeof room === "string" ? [room] : room;
        if (!transitionProbed && rooms.includes(oneRoom(classroom.sessionId))) {
          transitionProbed = true;
          gateway.to(answererRoom(classroom.sessionId)).emit("transition_old_role", { role: "answerer" });
          gateway.to(oneRoom(classroom.sessionId)).emit("transition_new_role", { role: "one" });
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await originalJoin(room);
      };
    }

    const assigned = await ack<Record<string, unknown>>(teacher, "assign_role", {
      request_id: "raw-assign-one",
      player_id: joined.player_id,
      role: "one",
    });
    gateway.to(answererRoom(classroom.sessionId)).emit("old_role_only", { role: "answerer" });
    gateway.to(oneRoom(classroom.sessionId)).emit("new_role_only", { role: "one" });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(assigned).toMatchObject({ ok: true, role: "one" });
    expect(transitionProbed).toBe(true);
    expect(transitionFrames).toEqual([]);
    expect(oldRoleFrames).toEqual([]);
    expect(newRoleFrames).toEqual([{ role: "one" }, { role: "one" }]);
  });

  it("rejects an open-attempt assignment transiently and accepts the same request after reveal", async () => {
    const player = client();
    const joined = await ack<{ player_id: string }>(player, "join_session", {
      code: classroom.code,
      nickname: "Boundary Player",
    });
    const teacher = await teacherSocket();
    const opened = await ack<{ attempt_id: string }>(teacher, "teacher_open_question", {
      request_id: "role-boundary-question",
    });
    const command = {
      request_id: "role-boundary-assignment",
      player_id: joined.player_id,
      role: "one",
    };

    const rejected = await ack<Record<string, unknown>>(teacher, "assign_role", command);
    expect(rejected).toMatchObject({
      ok: false,
      code: "WRONG_PHASE",
      message: "Wait until this question is finished",
    });
    expect(database.prepare("SELECT role FROM session_players WHERE player_id = ?").get(joined.player_id))
      .toEqual({ role: "mob" });
    expect(database.prepare(
      "SELECT request_id, payload_json FROM game_events WHERE session_id = ? AND event_type = 'command_rejected' AND payload_json LIKE '%WRONG_PHASE%'",
    ).all(classroom.sessionId)).toEqual([
      expect.objectContaining({
        request_id: null,
        payload_json: expect.stringContaining('"disposition":"transient"'),
      }),
    ]);

    await ack(teacher, "teacher_force_reveal", {
      request_id: "role-boundary-reveal",
      attempt_id: opened.attempt_id,
    });
    const badRole = await ack<Record<string, unknown>>(teacher, "assign_role", {
      request_id: "role-boundary-bad-role",
      player_id: joined.player_id,
      role: "captain",
    });
    const retried = await ack<Record<string, unknown>>(teacher, "assign_role", command);

    expect(badRole).toMatchObject({ ok: false, code: "INVALID_ROLE" });
    expect(retried).toMatchObject({ ok: true, player_id: joined.player_id, role: "one" });
    expect(database.prepare("SELECT role FROM session_players WHERE player_id = ?").get(joined.player_id))
      .toEqual({ role: "one" });
  });

  it("is idempotent and logs invalid role and player rejections", async () => {
    const joined = await ack<{ player_id: string }>(client(), "join_session", {
      code: classroom.code,
      nickname: "Validation Player",
    });
    const teacher = await teacherSocket();
    const command = { request_id: "same-assignment", player_id: joined.player_id, role: "crowd" };

    const first = await ack<Record<string, unknown>>(teacher, "assign_role", command);
    const replay = await ack<Record<string, unknown>>(teacher, "assign_role", command);
    const badRole = await ack<Record<string, unknown>>(teacher, "assign_role", {
      request_id: "bad-role",
      player_id: joined.player_id,
      role: "captain",
    });
    const badPlayer = await ack<Record<string, unknown>>(teacher, "assign_role", {
      request_id: "bad-player",
      player_id: "missing-player",
      role: "mob",
    });

    expect(replay).toEqual(first);
    expect(badRole).toMatchObject({ ok: false, code: "INVALID_ROLE", message: expect.any(String) });
    expect(badPlayer).toMatchObject({ ok: false, code: "PLAYER_NOT_FOUND", message: expect.any(String) });
    expect(database.prepare(
      "SELECT event_type, payload_json FROM game_events WHERE session_id = ? AND request_id IN ('bad-role', 'bad-player') ORDER BY event_id",
    ).all(classroom.sessionId)).toEqual([
      expect.objectContaining({ event_type: "command_rejected", payload_json: expect.stringContaining("INVALID_ROLE") }),
      expect.objectContaining({ event_type: "command_rejected", payload_json: expect.stringContaining("PLAYER_NOT_FOUND") }),
    ]);
  });

  it("keeps the persisted role and rooms unchanged when the transaction fails", async () => {
    const player = client();
    const joined = await ack<{ player_id: string }>(player, "join_session", {
      code: classroom.code,
      nickname: "Rollback Player",
    });
    const teacher = await teacherSocket();
    database.exec(`
      CREATE TRIGGER fail_role_assignment BEFORE UPDATE OF role ON session_players
      BEGIN SELECT RAISE(ABORT, 'role update failed'); END;
    `);

    const result = await ack<Record<string, unknown>>(teacher, "assign_role", {
      request_id: "failed-assignment",
      player_id: joined.player_id,
      role: "one",
    });
    const serverSocket = gateway.sockets.sockets.get(player.id ?? "");

    expect(result).toEqual({ error: "protocol_error" });
    expect(database.prepare("SELECT role FROM session_players WHERE player_id = ?").get(joined.player_id))
      .toEqual({ role: "mob" });
    expect(serverSocket?.rooms).toContain(answererRoom(classroom.sessionId));
    expect(serverSocket?.rooms).not.toContain(oneRoom(classroom.sessionId));
  });

  it("assigns late joins to crowd and includes role in roster and join ack", async () => {
    const early = await ack<{ role: string; roster: Array<{ role: string }> }>(client(), "join_session", {
      code: classroom.code,
      nickname: "Early Player",
    });
    database.prepare("UPDATE sessions SET status = 'live' WHERE session_id = ?").run(classroom.sessionId);
    const late = await ack<{ role: string; late_join: boolean; roster: Array<{ role: string }> }>(client(), "join_session", {
      code: classroom.code,
      nickname: "Late Player",
    });

    expect(early.role).toBe("mob");
    expect(early.roster[0]?.role).toBe("mob");
    expect(late).toMatchObject({ role: "crowd", late_join: true });
    expect(late.roster).toEqual(expect.arrayContaining([expect.objectContaining({ role: "crowd" })]));
  });
});
