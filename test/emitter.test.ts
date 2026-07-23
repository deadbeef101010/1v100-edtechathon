import { once } from "node:events";
import { createServer, type Server as HttpServer } from "node:http";

import { io as createClient, type Socket as ClientSocket } from "socket.io-client";
import { Server as SocketIoServer, type Socket } from "socket.io";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ApplicationEmitter,
  EXCLUDE,
  answererRoom,
  emitApplicationPacket,
  oneRoom,
  playerRoom,
  projectApplicationPacket,
  projectorRoom,
  snapshotView,
  studentRoom,
  teacherRoom,
} from "../src/emitter.js";

const SESSION_ID = "emitter-session";
let httpServer: HttpServer;
let io: SocketIoServer;
let url: string;
const clients: ClientSocket[] = [];

beforeEach(async () => {
  httpServer = createServer();
  io = new SocketIoServer(httpServer);
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  const address = httpServer.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP listener");
  url = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  await io.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

async function connect(rooms: readonly string[]): Promise<ClientSocket> {
  const serverSocket = new Promise<Socket>((resolve) => io.once("connection", resolve));
  const client = createClient(url, { forceNew: true, reconnection: false, transports: ["websocket"] });
  clients.push(client);
  const socket = await serverSocket;
  await socket.join([...rooms]);
  return client;
}

function packet<T>(socket: ClientSocket, event: string): Promise<T> {
  return new Promise((resolve) => socket.once(event, resolve));
}

describe("recipient-matrix emitter", () => {
  it("projects a synthetic Phase-A event without leaking question fields", async () => {
    const answerer = await connect([studentRoom(SESSION_ID), answererRoom(SESSION_ID)]);
    const one = await connect([studentRoom(SESSION_ID), oneRoom(SESSION_ID)]);
    const projector = await connect([projectorRoom(SESSION_ID)]);
    const answererFrame = packet<Record<string, unknown>>(answerer, "phase_a_start");
    const oneFrame = packet<Record<string, unknown>>(one, "phase_a_status");
    const projectorFrame = packet<Record<string, unknown>>(projector, "phase_a_status");
    const full = {
      attempt_id: "attempt-1",
      question_id: "question-1",
      prompt: "Secret prompt",
      choices: ["A", "B", "C"],
      locked_count: 0,
      eligible_count: 2,
      deadline_ms: 100,
      server_time_ms: 10,
    };

    emitApplicationPacket(new ApplicationEmitter(io, SESSION_ID), "phase_a_start", {
      answerers: full,
    });

    emitApplicationPacket(new ApplicationEmitter(io, SESSION_ID), "phase_a_status", {
      one: full,
      projector: full,
    });

    expect(await answererFrame).toMatchObject({ prompt: "Secret prompt", choices: ["A", "B", "C"] });
    const receivedByOne = await oneFrame;
    const receivedByProjector = await projectorFrame;
    expect(receivedByOne).toMatchObject({ locked_count: 0, eligible_count: 2 });
    expect(receivedByProjector).toMatchObject({ locked_count: 0, eligible_count: 2 });
    expect(receivedByOne).not.toHaveProperty("prompt");
    expect(receivedByProjector).not.toHaveProperty("choices");
  });

  it("projects and prioritizes synthetic question views for overlapping recipients", async () => {
    const player = await connect([studentRoom(SESSION_ID)]);
    const one = await connect([studentRoom(SESSION_ID), oneRoom(SESSION_ID)]);
    const projector = await connect([studentRoom(SESSION_ID), projectorRoom(SESSION_ID)]);
    const playerFrame = packet<Record<string, unknown>>(player, "question_open");
    const oneFrame = packet<Record<string, unknown>>(one, "question_open");
    const projectorFrame = packet<Record<string, unknown>>(projector, "question_open");

    emitApplicationPacket(new ApplicationEmitter(io, SESSION_ID), "question_open", {
      players: { prompt: "Players", choices: ["A"] },
      one: { prompt: "One", choices: ["B"] },
      projector: { prompt: "Projector", choices: ["C"] },
    });

    expect(await playerFrame).toEqual({ prompt: "Players", choices: ["A"] });
    expect(await oneFrame).toEqual({ prompt: "One", choices: ["B"] });
    expect(await projectorFrame).toEqual({ prompt: "Projector", choices: ["C"] });
  });

  it("delivers nothing to an excluded audience", async () => {
    const one = await connect([studentRoom(SESSION_ID), oneRoom(SESSION_ID)]);
    let received = false;
    one.on("question_open", () => { received = true; });

    emitApplicationPacket(new ApplicationEmitter(io, SESSION_ID), "question_open", {
      players: { prompt: "Broad data", choices: [], attempt_id: "a", question_id: "q" },
      one: EXCLUDE,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(received).toBe(false);
  });

  it("sends the same personal view to every socket of an identity", async () => {
    const identityRoom = playerRoom(SESSION_ID, "player-1");
    const first = await connect([studentRoom(SESSION_ID), identityRoom]);
    const second = await connect([studentRoom(SESSION_ID), identityRoom]);
    const firstFrame = packet(first, "state_snapshot");
    const secondFrame = packet(second, "state_snapshot");
    const personal = { phase: "LOBBY", own_answer: 1, secret: true };

    emitApplicationPacket(new ApplicationEmitter(io, SESSION_ID), "state_snapshot", {
      players: { phase: "LOBBY" },
      "player:player-1": personal,
    });

    expect(await firstFrame).toEqual({ phase: "LOBBY", own_answer: 1 });
    expect(await secondFrame).toEqual({ phase: "LOBBY", own_answer: 1 });
  });

  it("fails closed for unknown events and undeclared audiences", async () => {
    const projector = await connect([projectorRoom(SESSION_ID)]);
    let received = false;
    projector.onAny(() => { received = true; });
    const emitter = new ApplicationEmitter(io, SESSION_ID);

    emitter.emit("not_declared", { projector: { secret: true } });
    emitApplicationPacket(emitter, "question_set_attached", {
      projector: { secret: true },
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(received).toBe(false);
  });

  it.each([
    ["broad-first", { players: { locked_count: 9 }, projector: { locked_count: 1 } }],
    ["specific-first", { projector: { locked_count: 1 }, players: { locked_count: 9 } }],
  ] as const)("uses specificity rather than %s key order", async (_name, views) => {
    const projector = await connect([studentRoom(SESSION_ID), projectorRoom(SESSION_ID)]);
    const frame = packet<Record<string, unknown>>(projector, "lock_counts");

    emitApplicationPacket(new ApplicationEmitter(io, SESSION_ID), "lock_counts", views);

    expect(await frame).toEqual({ locked_count: 1 });
  });

  it("lets a specific exclusion override a broad audience", async () => {
    const projector = await connect([studentRoom(SESSION_ID), projectorRoom(SESSION_ID)]);
    let received = false;
    projector.on("lock_counts", () => { received = true; });

    emitApplicationPacket(new ApplicationEmitter(io, SESSION_ID), "lock_counts", {
      players: { locked_count: 9 },
      projector: EXCLUDE,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(received).toBe(false);
  });

  it("drops undeclared fields from every audience projection", () => {
    const payload = {
      attempt_id: "attempt-1",
      question_id: "question-1",
      prompt: "Question",
      choices: ["A", "B", "C"],
      deadline_ms: 100,
      server_time_ms: 10,
      secret: "answer-key",
      nested_secret: { correct_choice: 2 },
    };

    for (const audience of ["teacher", "projector", "one", "answerers", "players"] as const) {
      expect(projectApplicationPacket("question_open", audience, payload)).not.toHaveProperty("secret");
      expect(projectApplicationPacket("question_open", audience, payload)).not.toHaveProperty("nested_secret");
    }
  });

  it("fails closed for question visibility in an unknown snapshot phase", () => {
    const snapshot = { phase: "FUTURE_SECRET_PHASE", question: { prompt: "secret" }, locked_count: 0 };

    for (const audience of ["teacher", "projector", "one"] as const) {
      expect(snapshotView(snapshot, { audience })).not.toHaveProperty("question");
    }
    expect(snapshotView(snapshot, { audience: "answerer", eligible: true })).not.toHaveProperty("question");
  });

  it("documents teacher and projector as narrower than broad player rooms", async () => {
    const teacher = await connect([studentRoom(SESSION_ID), teacherRoom(SESSION_ID)]);
    const projector = await connect([studentRoom(SESSION_ID), projectorRoom(SESSION_ID)]);
    const teacherFrame = packet<Record<string, unknown>>(teacher, "lock_counts");
    const projectorFrame = packet<Record<string, unknown>>(projector, "lock_counts");

    emitApplicationPacket(new ApplicationEmitter(io, SESSION_ID), "lock_counts", {
      players: { locked_count: 9 },
      teacher: { locked_count: 2 },
      projector: { locked_count: 1 },
    });

    expect(await teacherFrame).toEqual({ locked_count: 2 });
    expect(await projectorFrame).toEqual({ locked_count: 1 });
  });

  it.each(["meter_progress", "meter_filled"] as const)("delivers raw %s frames to every declared audience", async (event) => {
    const teacher = await connect([teacherRoom(SESSION_ID)]);
    const projector = await connect([projectorRoom(SESSION_ID)]);
    const one = await connect([studentRoom(SESSION_ID), oneRoom(SESSION_ID)]);
    const answerer = await connect([studentRoom(SESSION_ID), answererRoom(SESSION_ID)]);
    const player = await connect([studentRoom(SESSION_ID)]);
    const sockets = [teacher, projector, one, answerer, player];
    const frames = sockets.map((socket) => packet<Record<string, unknown>>(socket, event));
    const payload = event === "meter_progress"
      ? { progress: 2, threshold: 4, credited: true, reason: "fast_correct", secret: "drop" }
      : { progress: 4, threshold: 4, strikes_remaining: 3, awarded_once: true, secret: "drop" };

    emitApplicationPacket(new ApplicationEmitter(io, SESSION_ID), event, {
      teacher: payload,
      projector: payload,
      one: payload,
      answerers: payload,
      players: payload,
    });

    for (const frame of await Promise.all(frames)) {
      expect(frame).toMatchObject(event === "meter_progress"
        ? { progress: 2, threshold: 4, credited: true, reason: "fast_correct" }
        : { progress: 4, threshold: 4, strikes_remaining: 3, awarded_once: true });
      expect(frame).not.toHaveProperty("secret");
    }
  });
});
