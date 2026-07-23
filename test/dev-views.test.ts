import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CommandCoordinator } from "../src/command-coordinator.js";
import { openDatabase, type AppDatabase } from "../src/db.js";
import { GameEventStore } from "../src/game-event-store.js";
import { QuestionRound } from "../src/question-round.js";
import { createAppServer } from "../src/server.js";
import { createClassroomSession, type CreatedClassroomSession } from "../src/sessions.js";
import { createPlayerToken, createTeacherToken } from "../src/auth.js";
import { mintTeacherKey, type MintedTeacherKey } from "../src/teachers.js";
import { ServerLogger } from "../src/log.js";
import { createBoundedSseWriter } from "../src/dev-views.js";

const SECRET = "dev-views-secret-at-least-32-characters";
const DEV_TOKEN = "private-dev-token";
let directory: string;
let database: AppDatabase;
let teacher: MintedTeacherKey;
let classroom: CreatedClassroomSession;
let rounds: Map<string, QuestionRound>;
let server: ReturnType<typeof createAppServer>;
let url: string;
let logger: ServerLogger;
let botCommand: readonly [string, ...string[]] | undefined;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "game-dev-views-"));
  database = openDatabase(join(directory, "game.db"));
  teacher = mintTeacherKey(database, "Dev Teacher");
  classroom = createClassroomSession(database, teacher.teacherId, SECRET);
  rounds = new Map();
  logger = new ServerLogger({ write: () => undefined });
  botCommand = undefined;
});

afterEach(async () => {
  if (server?.listening) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  database.close();
  await rm(directory, { recursive: true, force: true });
});

async function listen(enabled: boolean, stopTimeoutMs?: number): Promise<void> {
  server = createAppServer({
    database,
    tokenSecret: SECRET,
    rounds,
    devViews: enabled,
    devToken: DEV_TOKEN,
    ...(botCommand === undefined ? {} : { botCommand }),
    ...(stopTimeoutMs === undefined ? {} : { botStopTimeoutMs: stopTimeoutMs }),
    logger,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP address");
  url = `http://127.0.0.1:${address.port}`;
}

async function signIn(token = DEV_TOKEN, forwardedProto?: string): Promise<Response> {
  return fetch(`${url}/api/dev/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(forwardedProto === undefined ? {} : { "x-forwarded-proto": forwardedProto }),
    },
    body: JSON.stringify({ token }),
  });
}

function responseCookie(response: Response): string {
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined) throw new Error("Expected dev cookie");
  return cookie;
}

async function waitForRun(
  cookie: string,
  predicate: (run: { state: string; joined: number; answered: number; errors: number }) => boolean,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${url}/api/dev/bots/status`, { headers: { cookie } });
    const body = await response.json() as { runs: Array<Record<string, unknown> & { state: string; joined: number; answered: number; errors: number }> };
    const run = body.runs[0];
    if (run !== undefined && predicate(run)) return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Bot run status timed out");
}

function devHeaders(): HeadersInit {
  return { "x-dev-token": DEV_TOKEN };
}

function addPlayer(id: string): void {
  database.prepare(
    `INSERT INTO session_players
      (player_id, session_id, nickname, nickname_norm, token_hash, token_expires_at_ms,
       role, joined_at_ms, last_seen_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, 'mob', ?, ?)`,
  ).run(id, classroom.sessionId, id, id, Buffer.from(id), Date.now() + 10_000, Date.now(), Date.now());
}

function openRound(): QuestionRound {
  addPlayer("player-1");
  const round = new QuestionRound({
    sessionId: classroom.sessionId,
    store: new GameEventStore(database),
    database,
    monotonicNow: () => 100,
    wallNow: () => 10_100,
    emit: () => undefined,
  });
  round.openQuestion({
    actorId: teacher.teacherId,
    requestId: "open-dev-question",
    attemptId: "dev-attempt",
    question: {
      id: "dev-question",
      prompt: "Which answer?",
      choices: ["A", "B", "C"],
      correctChoice: 2,
    },
    durationMs: 20_000,
    eligiblePlayerIds: ["player-1"],
  });
  rounds.set(classroom.sessionId, round);
  return round;
}

describe("development session views", () => {
  it("bounds slow-client buffering and reports dropped frames", () => {
    const writes: string[] = [];
    let drain: (() => void) | undefined;
    const response = {
      write: (frame: string) => {
        writes.push(frame);
        return writes.length !== 1;
      },
      once: (_event: string, listener: () => void) => { drain = listener; return response; },
      removeListener: () => response,
      destroyed: false,
      writableEnded: false,
    };
    const writer = createBoundedSseWriter(response, 2);
    writer.send("one");
    writer.send("two");
    writer.send("three");
    writer.send("four");
    drain?.();

    expect(writes).toEqual([
      "one",
      expect.stringContaining('"dropped_count":1'),
      "three",
      "four",
    ]);
  });

  it("returns 404 while disabled", async () => {
    await listen(false);
    const response = await fetch(`${url}/api/dev/session/${classroom.sessionId}/state`, {
      headers: devHeaders(),
    });
    expect(response.status).toBe(404);
    expect((await fetch(`${url}/dev`)).status).toBe(404);
    expect((await fetch(`${url}/dev/graph?session=${classroom.sessionId}`, { headers: devHeaders() })).status).toBe(404);
    expect((await fetch(`${url}/dev/state?session=${classroom.sessionId}`, { headers: devHeaders() })).status).toBe(404);
    expect((await fetch(`${url}/api/dev/bots/status`, { headers: devHeaders() })).status).toBe(404);
  });

  it("signs in with a trimmed token and accepts the HttpOnly cookie across dev surfaces", async () => {
    openRound();
    await listen(true);
    const login = await signIn(`  ${DEV_TOKEN}\n`);
    const cookie = responseCookie(login);

    expect(login.status).toBe(200);
    expect(login.headers.get("set-cookie")).toContain("HttpOnly");
    expect(login.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(login.headers.get("set-cookie")).not.toContain("; Secure");
    const landing = await fetch(`${url}/dev`, { headers: { cookie } });
    expect(await landing.text()).toContain("Demo control room");
    expect((await fetch(`${url}/dev/logs?session=${classroom.sessionId}`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${url}/dev/graph?session=${classroom.sessionId}`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${url}/dev/state?session=${classroom.sessionId}`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${url}/api/dev/session/${classroom.sessionId}/state`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${url}/api/dev/session/${classroom.sessionId}/oracle`, { headers: { cookie } })).status).toBe(200);
    expect((await fetch(`${url}/api/dev/bots/status`, { headers: { cookie } })).status).toBe(200);

    const secureLogin = await signIn(DEV_TOKEN, "https");
    expect(secureLogin.headers.get("set-cookie")).toContain("; Secure");
  });

  it("uses generic sign-in failures and a global fixed-window limit without logging tokens", async () => {
    await listen(true);
    const wrong = "wrong-dev-token-canary";
    expect((await signIn(wrong)).status).toBe(404);
    expect((await signIn("")).status).toBe(404);
    for (let attempt = 0; attempt < 8; attempt += 1) expect((await signIn(`wrong-${attempt}`)).status).toBe(404);
    expect((await signIn(DEV_TOKEN)).status).toBe(404);

    expect(logger.entries().filter((entry) => entry.event === "dev_login_rate_limited")).toHaveLength(1);
    expect(JSON.stringify(logger.entries())).not.toContain(wrong);
    expect(JSON.stringify(logger.entries())).not.toContain(DEV_TOKEN);
  });

  it("rejects missing and wrong dev auth while preserving teacher ownership and rejecting students", async () => {
    await listen(true);
    const statePath = `${url}/api/dev/session/${classroom.sessionId}/state`;
    expect((await fetch(`${url}/api/dev/bots/status`)).status).toBe(401);
    expect((await fetch(`${url}/api/dev/bots/status`, { headers: { "x-dev-token": "wrong" } })).status).toBe(403);
    expect((await fetch(`${url}/dev/logs?session=${classroom.sessionId}`, {
      headers: { authorization: `Bearer ${createTeacherToken(teacher.teacherId, SECRET)}` },
    })).status).toBe(200);
    expect((await fetch(`${url}/dev/graph?session=${classroom.sessionId}`)).status).toBe(401);
    expect((await fetch(`${url}/dev/graph?session=${classroom.sessionId}`, {
      headers: { "x-dev-token": "wrong" },
    })).status).toBe(403);
    expect((await fetch(`${url}/dev/graph?session=${classroom.sessionId}`, {
      headers: { authorization: `Bearer ${createTeacherToken(teacher.teacherId, SECRET)}` },
    })).status).toBe(200);
    const otherTeacher = mintTeacherKey(database, "Graph intruder");
    expect((await fetch(`${url}/dev/graph?session=${classroom.sessionId}`, {
      headers: { authorization: `Bearer ${createTeacherToken(otherTeacher.teacherId, SECRET)}` },
    })).status).toBe(403);
    expect((await fetch(`${url}/dev/state?session=${classroom.sessionId}`)).status).toBe(401);
    expect((await fetch(`${url}/dev/state?session=${classroom.sessionId}`, {
      headers: { "x-dev-token": "wrong" },
    })).status).toBe(403);
    expect((await fetch(`${url}/dev/state?session=${classroom.sessionId}`, {
      headers: { authorization: `Bearer ${createTeacherToken(teacher.teacherId, SECRET)}` },
    })).status).toBe(200);
    expect((await fetch(`${url}/dev/state?session=${classroom.sessionId}`, {
      headers: { authorization: `Bearer ${createTeacherToken(otherTeacher.teacherId, SECRET)}` },
    })).status).toBe(403);
    const studentToken = createPlayerToken("student-player", classroom.sessionId, SECRET);
    expect((await fetch(statePath, { headers: { authorization: `Bearer ${studentToken}` } })).status).toBe(403);
  });

  it("starts, reports, stops, and logs an injected fake bot runner", async () => {
    const capture = join(directory, "bot-arguments.json");
    botCommand = [
      process.execPath,
      "--import",
      "tsx",
      new URL("fixtures/fake-bot-runner.ts", import.meta.url).pathname,
      "--capture",
      capture,
    ];
    await listen(true);
    const cookie = responseCookie(await signIn());
    const response = await fetch(`${url}/api/dev/bots/start`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        session_id: classroom.sessionId,
        count: 10,
        accuracy: 0.7,
        policy: "random",
        request_id: crypto.randomUUID(),
      }),
    });
    const started = await response.json() as { run: { run_id: string } };
    const running = await waitForRun(cookie, (run) => run.joined === 1 && run.answered === 1 && run.errors === 1);
    const arguments_ = JSON.parse(await readFile(capture, "utf8")) as string[];

    expect(response.status).toBe(201);
    expect(running).toMatchObject({ state: "running", joined: 1, answered: 1, errors: 1 });
    expect(arguments_).toEqual(expect.arrayContaining([
      "--url", expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      "--code", classroom.code,
      "--count", "10",
      "--accuracy", "0.7",
      "--policy", "random",
      "--oracle-token", DEV_TOKEN,
    ]));
    const stop = await fetch(`${url}/api/dev/bots/stop`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ run_id: started.run.run_id }),
    });
    expect(stop.status).toBe(200);
    expect(await waitForRun(cookie, (run) => run.state === "stopped")).toMatchObject({ state: "stopped" });
    expect(logger.entries().map((entry) => entry.event)).toEqual(expect.arrayContaining([
      "dev_bot_run_started",
      "dev_bot_runner_summary",
      "dev_bot_run_stop_requested",
      "dev_bot_run_exited",
    ]));
    expect(JSON.stringify(logger.entries())).not.toContain("choice=2");
  });

  it("reflects a natural fake-runner exit and enforces the two-run cap", async () => {
    botCommand = [process.execPath, "--import", "tsx", new URL("fixtures/fake-bot-runner.ts", import.meta.url).pathname];
    const second = createClassroomSession(database, teacher.teacherId, SECRET);
    const third = createClassroomSession(database, teacher.teacherId, SECRET);
    await listen(true);
    const cookie = responseCookie(await signIn());
    const start = async (sessionId: string, count: number): Promise<Response> => fetch(`${url}/api/dev/bots/start`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ session_id: sessionId, count, accuracy: 0.7, policy: "random", request_id: crypto.randomUUID() }),
    });

    expect((await start(classroom.sessionId, 2)).status).toBe(201);
    expect((await start(second.sessionId, 2)).status).toBe(201);
    const capped = await start(third.sessionId, 2);
    expect(capped.status).toBe(409);
    expect(await capped.json()).toMatchObject({ error: "run_cap_reached", message: expect.stringContaining("Two bot runs") });

    const statuses = await (await fetch(`${url}/api/dev/bots/status`, { headers: { cookie } })).json() as { runs: Array<{ run_id: string }> };
    for (const run of statuses.runs) {
      await fetch(`${url}/api/dev/bots/stop`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ run_id: run.run_id }),
      });
    }
    await waitForRun(cookie, (run) => run.state === "stopped");
    expect((await start(third.sessionId, 1)).status).toBe(201);
    expect(await waitForRun(cookie, (run) => run.state === "exited")).toMatchObject({ state: "exited", exit_code: 0 });
  });

  it("auto-reaps a running child when its session ends", async () => {
    botCommand = [process.execPath, "--import", "tsx", new URL("fixtures/fake-bot-runner.ts", import.meta.url).pathname];
    await listen(true);
    const cookie = responseCookie(await signIn());
    const started = await fetch(`${url}/api/dev/bots/start`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ session_id: classroom.sessionId, count: 2, accuracy: 0.7, policy: "random", request_id: crypto.randomUUID() }),
    });
    expect(started.status).toBe(201);

    database.prepare("UPDATE sessions SET status = 'ended', ended_at_ms = ? WHERE session_id = ?").run(Date.now(), classroom.sessionId);
    expect(await waitForRun(cookie, (run) => run.state === "stopped")).toMatchObject({
      state: "stopped",
      message: "Session ended; stopping bots.",
    });
    expect(logger.entries()).toContainEqual(expect.objectContaining({
      event: "dev_bot_run_stop_requested",
      session_id: classroom.sessionId,
      detail: expect.objectContaining({ reason: "session_ended" }),
    }));
  });

  it("force-reaps a SIGTERM-resistant child on server close", async () => {
    botCommand = [
      process.execPath,
      "--import",
      "tsx",
      new URL("fixtures/fake-bot-runner.ts", import.meta.url).pathname,
      "--ignore-term",
    ];
    await listen(true, 100);
    const cookie = responseCookie(await signIn());
    const started = await fetch(`${url}/api/dev/bots/start`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ session_id: classroom.sessionId, count: 2, accuracy: 0.7, policy: "random", request_id: crypto.randomUUID() }),
    });
    expect(started.status).toBe(201);
    await waitForRun(cookie, (run) => run.joined === 1);

    await new Promise<void>((resolve) => server.close(() => resolve()));
    const deadline = Date.now() + 2_000;
    while (
      Date.now() < deadline &&
      !logger.entries().some((entry) => entry.event === "dev_bot_run_force_stopped")
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(logger.entries()).toContainEqual(expect.objectContaining({ event: "dev_bot_run_force_stopped" }));
  });

  it("returns clear failures for ended sessions and unavailable display codes", async () => {
    botCommand = [process.execPath, "--import", "tsx", new URL("fixtures/fake-bot-runner.ts", import.meta.url).pathname];
    await listen(true);
    const cookie = responseCookie(await signIn());
    const start = async (): Promise<Response> => fetch(`${url}/api/dev/bots/start`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ session_id: classroom.sessionId, count: 2, accuracy: 0.7, policy: "random", request_id: crypto.randomUUID() }),
    });

    database.prepare("UPDATE sessions SET status = 'ended', ended_at_ms = ? WHERE session_id = ?").run(Date.now(), classroom.sessionId);
    const ended = await start();
    expect(ended.status).toBe(409);
    expect(await ended.json()).toMatchObject({ error: "session_ended", message: expect.stringContaining("ended") });

    database.prepare("UPDATE sessions SET status = 'lobby', ended_at_ms = NULL, display_code_ciphertext = NULL WHERE session_id = ?").run(classroom.sessionId);
    const unavailable = await start();
    expect(unavailable.status).toBe(409);
    expect(await unavailable.json()).toMatchObject({ error: "display_code_unavailable", message: expect.stringContaining("Rotate its code") });
  });

  it("requires a valid dev token or owning teacher authentication", async () => {
    await listen(true);
    const path = `${url}/api/dev/session/${classroom.sessionId}/state`;
    expect((await fetch(path)).status).toBe(401);
    expect((await fetch(path, { headers: { "x-dev-token": "wrong" } })).status).toBe(403);
    expect((await fetch(path, { headers: devHeaders() })).status).toBe(200);
    expect((await fetch(`${path}?dev_token=${DEV_TOKEN}`)).status).toBe(401);
    expect((await fetch(path, {
      headers: { authorization: `Bearer ${createTeacherToken(teacher.teacherId, SECRET)}` },
    })).status).toBe(200);
  });

  it("forwards a query dev token from the logs page to its EventSource only", async () => {
    await listen(true);
    const logsUrl = `${url}/dev/logs?session=${classroom.sessionId}&dev_token=${DEV_TOKEN}`;
    const response = await fetch(logsUrl);
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(html).toContain('src="/static/dev-logs.js"');
    expect(html).toContain(`data-dev-token="${DEV_TOKEN}"`);
    const headerPage = await fetch(`${url}/dev/logs?session=${classroom.sessionId}`, {
      headers: devHeaders(),
    });
    expect(await headerPage.text()).toContain(`data-dev-token="${DEV_TOKEN}"`);
    expect((await fetch(`${url}/dev/logs?session=${classroom.sessionId}&stream=1&dev_token=${DEV_TOKEN}`, {
      headers: { accept: "text/event-stream" },
      signal: AbortSignal.timeout(500),
    })).status).toBe(200);
  });

  it("dumps live state and exposes the active oracle only to authorized callers", async () => {
    const round = openRound();
    await listen(true);
    const state = await fetch(`${url}/api/dev/session/${classroom.sessionId}/state`, {
      headers: devHeaders(),
    });
    const body = await state.json() as {
      round: { phase: string; active: { question: { id: string } } };
      players: Array<{ player_id: string; connected: boolean; socket_count: number }>;
      presence_available: boolean;
    };
    expect(body.round).toMatchObject({
      phase: round.phase,
      active: { question: { id: "dev-question" } },
    });
    expect(body.players).toContainEqual(expect.objectContaining({
      player_id: "player-1",
      connected: false,
      socket_count: 0,
    }));
    expect(body.presence_available).toBe(false);

    const oracle = await fetch(`${url}/api/dev/session/${classroom.sessionId}/oracle`, {
      headers: devHeaders(),
    });
    expect(await oracle.json()).toEqual({ question_id: "dev-question", correct_choice: 2 });
    round.forceReveal({ actorId: teacher.teacherId, requestId: "reveal", attemptId: "dev-attempt" });
    round.advance({ actorId: teacher.teacherId, requestId: "advance", attemptId: "dev-attempt" });
    expect((await fetch(`${url}/api/dev/session/${classroom.sessionId}/oracle`, {
      headers: devHeaders(),
    })).status).toBe(404);
  });

  it("streams a newly appended event within one second", async () => {
    await listen(true);
    const controller = new AbortController();
    const response = await fetch(
      `${url}/dev/logs?session=${classroom.sessionId}&stream=1`,
      { headers: { ...devHeaders(), accept: "text/event-stream" }, signal: controller.signal },
    );
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("Expected SSE body");
    new CommandCoordinator(database).execute({
      sessionId: classroom.sessionId,
      commandType: "dev_test",
      actorKind: "teacher",
      actorId: teacher.teacherId,
      requestId: "dev-sse-event",
      payload: { live: true },
      createdAtMs: Date.now(),
      propose: () => ({
        state: null,
        eventType: "dev_test_appended",
        eventPayload: { live: true },
        outcome: (event) => ({ ok: true as const, requestId: "dev-sse-event", serverSeq: event.serverSeq }),
        apply: () => undefined,
      }),
    });
    const decoder = new TextDecoder();
    const deadline = Date.now() + 1_000;
    let received = "";
    while (!received.includes("dev_test_appended") && Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE timed out")), 1_000)),
      ]);
      if (chunk.done) break;
      received += decoder.decode(chunk.value, { stream: true });
    }
    controller.abort();
    expect(received).toContain("event: game_event");
    expect(received).toContain("dev_test_appended");
  });

  it("streams retained and live server-log entries alongside game events", async () => {
    logger.info("retained_server_event", {
      sessionId: classroom.sessionId,
      actor: { kind: "system", id: "system" },
      detail: { phase: "before_connect" },
    });
    await listen(true);
    const controller = new AbortController();
    const response = await fetch(
      `${url}/dev/logs?session=${classroom.sessionId}&stream=1`,
      { headers: { ...devHeaders(), accept: "text/event-stream" }, signal: controller.signal },
    );
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("Expected SSE body");
    logger.info("live_server_event", {
      sessionId: classroom.sessionId,
      actor: { kind: "teacher", id: teacher.teacherId },
      detail: { phase: "after_connect" },
    });
    const decoder = new TextDecoder();
    const deadline = Date.now() + 1_000;
    let received = "";
    while (!received.includes("live_server_event") && Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE timed out")), 1_000)),
      ]);
      if (chunk.done) break;
      received += decoder.decode(chunk.value, { stream: true });
    }
    controller.abort();

    expect(received).toContain("event: server_log");
    expect(received).toContain('"source":"server"');
    expect(received).toContain("retained_server_event");
    expect(received).toContain("live_server_event");
  });

  it("scopes teacher logs to their session while dev viewers also receive global logs", async () => {
    const otherTeacher = mintTeacherKey(database, "Other teacher");
    const other = createClassroomSession(database, otherTeacher.teacherId, SECRET);
    logger.info("requested_session_event", { sessionId: classroom.sessionId });
    logger.info("global_event");
    logger.info("other_session_event", { sessionId: other.sessionId });
    await listen(true);

    const readReplay = async (headers: HeadersInit): Promise<string> => {
      const controller = new AbortController();
      const response = await fetch(`${url}/dev/logs?session=${classroom.sessionId}&stream=1`, {
        headers: { ...headers, accept: "text/event-stream" },
        signal: controller.signal,
      });
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error("Expected SSE body");
      const chunk = await reader.read();
      controller.abort();
      return new TextDecoder().decode(chunk.value);
    };
    const teacherReplay = await readReplay({
      authorization: `Bearer ${createTeacherToken(teacher.teacherId, SECRET)}`,
    });
    const devReplay = await readReplay(devHeaders());

    expect(teacherReplay).toContain("requested_session_event");
    expect(teacherReplay).not.toContain("global_event");
    expect(teacherReplay).not.toContain("other_session_event");
    expect(devReplay).toContain("requested_session_event");
    expect(devReplay).toContain("global_event");
    expect(devReplay).not.toContain("other_session_event");
  });

  it("chronologically merges retained game events and server logs", async () => {
    logger = new ServerLogger({ now: () => 2_000, write: () => undefined });
    new GameEventStore(database).append({
      sessionId: classroom.sessionId,
      gameId: null,
      attemptId: null,
      eventType: "earlier_game_event",
      actorKind: "system",
      actorId: "system",
      requestId: null,
      payload: {},
      createdAtMs: 1_000,
    });
    logger.info("later_server_event", { sessionId: classroom.sessionId });
    await listen(true);
    const response = await fetch(`${url}/dev/logs?session=${classroom.sessionId}&stream=1`, {
      headers: { ...devHeaders(), accept: "text/event-stream" },
      signal: AbortSignal.timeout(1_000),
    });
    const chunk = await response.body?.getReader().read();
    const replay = new TextDecoder().decode(chunk?.value);

    const gameIndex = replay.indexOf("earlier_game_event");
    const logIndex = replay.indexOf("later_server_event");
    expect(gameIndex).toBeGreaterThanOrEqual(0);
    expect(logIndex).toBeGreaterThanOrEqual(0);
    expect(gameIndex).toBeLessThan(logIndex);
  });

  it("bounds initial game-event replay to the most recent window", async () => {
    const store = new GameEventStore(database);
    for (let index = 1; index <= 260; index += 1) {
      store.append({
        sessionId: classroom.sessionId,
        gameId: null,
        attemptId: null,
        eventType: index === 1 ? "oldest_history_canary" : index === 260 ? "newest_history_canary" : "history_event",
        actorKind: "system",
        actorId: "system",
        requestId: null,
        payload: { index },
        createdAtMs: index,
      });
    }
    await listen(true);
    const response = await fetch(`${url}/dev/logs?session=${classroom.sessionId}&stream=1`, {
      headers: { ...devHeaders(), accept: "text/event-stream" },
      signal: AbortSignal.timeout(1_000),
    });
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("Expected SSE body");
    let replay = "";
    while (!replay.includes("newest_history_canary")) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE timed out")), 1_000)),
      ]);
      if (chunk.done) break;
      replay += new TextDecoder().decode(chunk.value, { stream: true });
    }

    expect(replay).toContain("event: history_truncated");
    expect(replay).toContain("newest_history_canary");
    expect(replay).not.toContain("oldest_history_canary");
    expect(replay.match(/event: game_event/g)).toHaveLength(256);
  });

  it("flushes durable live events before their later server logs", async () => {
    await listen(true);
    const controller = new AbortController();
    const response = await fetch(`${url}/dev/logs?session=${classroom.sessionId}&stream=1`, {
      headers: { ...devHeaders(), accept: "text/event-stream" },
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("Expected SSE body");
    new GameEventStore(database).append({
      sessionId: classroom.sessionId,
      gameId: null,
      attemptId: null,
      eventType: "live_game_first",
      actorKind: "system",
      actorId: "system",
      requestId: null,
      payload: {},
      createdAtMs: 1_000,
    });
    logger.info("live_log_second", { sessionId: classroom.sessionId });
    let received = "";
    while (!received.includes("live_log_second")) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE timed out")), 1_000)),
      ]);
      if (chunk.done) break;
      received += new TextDecoder().decode(chunk.value);
    }
    controller.abort();

    const gameIndex = received.indexOf("live_game_first");
    const logIndex = received.indexOf("live_log_second");
    expect(gameIndex).toBeGreaterThanOrEqual(0);
    expect(logIndex).toBeGreaterThanOrEqual(0);
    expect(gameIndex).toBeLessThan(logIndex);
  });

  it("redacts correct answers and submitted choices from pre-reveal event log lines", async () => {
    const round = openRound();
    round.answer({
      actorId: "player-1",
      requestId: "private-answer",
      attemptId: "dev-attempt",
      questionId: "dev-question",
      choice: 2,
    });
    await listen(true);
    const response = await fetch(`${url}/dev/logs?session=${classroom.sessionId}&stream=1`, {
      headers: { ...devHeaders(), accept: "text/event-stream" },
      signal: AbortSignal.timeout(1_000),
    });
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("Expected SSE body");
    const decoder = new TextDecoder();
    let received = "";
    while (!received.includes("answer_accepted")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += decoder.decode(chunk.value, { stream: true });
    }

    const dataLines = received
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice("data: ".length));
    const open = dataLines.find((line) => line.includes('"event_type":"question_open"'));
    const answer = dataLines.find((line) => line.includes('"event_type":"answer_accepted"'));
    expect(open).toBeDefined();
    expect(answer).toBeDefined();
    expect(open).not.toContain("correct_choice");
    expect(answer).not.toContain('"choice"');
  });

  it("recursively redacts 1v100 answer data before reveal while preserving counts", async () => {
    const store = new GameEventStore(database);
    store.append({
      sessionId: classroom.sessionId,
      gameId: null,
      attemptId: "1v100-attempt",
      eventType: "phase_a_start",
      actorKind: "system",
      actorId: "system",
      requestId: null,
      payload: {
        question_id: "1v100-question",
        choices: ["A", "B", "C"],
        correct_choice: "correct-choice-canary",
        answer_count: 17,
        state: {
          correctChoice: "nested-correct-choice-canary",
          correctness: "correctness-canary",
          oneAnswer: "one-answer-canary",
          answerValue: "answer-value-canary",
          answerCount: 19,
          answered_count: 23,
          answer_counts_by_choice: [5, 7, 11],
          submissions: [{
            player_id: "player-1",
            choice: "choice-canary",
            wasCorrect: "was-correct-canary",
            answers: ["answers-canary"],
          }],
        },
      },
      createdAtMs: 1_000,
    });
    store.append({
      sessionId: classroom.sessionId,
      gameId: null,
      attemptId: "1v100-attempt",
      eventType: "reveal",
      actorKind: "system",
      actorId: "system",
      requestId: null,
      payload: {
        correct_choice: "reveal-correct-choice-canary",
        one_correct: "reveal-one-correct-canary",
        answers: [{ choice: "reveal-choice-canary" }],
      },
      createdAtMs: 2_000,
    });
    await listen(true);
    const controller = new AbortController();
    const response = await fetch(`${url}/dev/logs?session=${classroom.sessionId}&stream=1`, {
      headers: { ...devHeaders(), accept: "text/event-stream" },
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("Expected SSE body");
    const decoder = new TextDecoder();
    let received = "";
    while (!received.includes("reveal-correct-choice-canary")) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE timed out")), 1_000)),
      ]);
      if (chunk.done) break;
      received += decoder.decode(chunk.value, { stream: true });
    }
    controller.abort();

    const events = received
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as {
        event_type?: string;
        payload?: Record<string, unknown>;
      });
    const phaseA = events.find((event) => event.event_type === "phase_a_start");
    const reveal = events.find((event) => event.event_type === "reveal");
    expect(phaseA?.payload).toEqual({
      question_id: "1v100-question",
      choices: ["A", "B", "C"],
      answer_count: 17,
      state: {
        answerCount: 19,
        answered_count: 23,
        answer_counts_by_choice: [5, 7, 11],
        submissions: [{ player_id: "player-1" }],
      },
    });
    for (const canary of [
      "correct-choice-canary",
      "nested-correct-choice-canary",
      "correctness-canary",
      "one-answer-canary",
      "answer-value-canary",
      "choice-canary",
      "was-correct-canary",
      "answers-canary",
    ]) {
      expect(JSON.stringify(phaseA)).not.toContain(canary);
    }
    expect(reveal?.payload).toEqual({
      correct_choice: "reveal-correct-choice-canary",
      one_correct: "reveal-one-correct-canary",
      answers: [{ choice: "reveal-choice-canary" }],
    });
  });

  it("logs denied dev-view access without retaining the supplied token", async () => {
    await listen(true);
    const supplied = "wrong-dev-token-canary";
    const response = await fetch(`${url}/dev/logs?session=${classroom.sessionId}`, {
      headers: { "x-dev-token": supplied },
    });

    expect(response.status).toBe(403);
    expect(logger.entries()).toContainEqual(expect.objectContaining({
      event: "dev_view_access_denied",
      session_id: classroom.sessionId,
      detail: { path: "/dev/logs", status: 403 },
    }));
    expect(JSON.stringify(logger.entries())).not.toContain(supplied);
  });
});
