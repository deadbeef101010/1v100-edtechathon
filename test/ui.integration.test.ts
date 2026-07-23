import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { io as createClient, type Socket as ClientSocket } from "socket.io-client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type AppDatabase } from "../src/db.js";
import { createGameServer } from "../src/server.js";
import type { RosterEntry } from "../src/socket-gateway.js";
import { createTeacherToken } from "../src/auth.js";
import { mintTeacherKey, type MintedTeacherKey } from "../src/teachers.js";

const TOKEN_SECRET = "ui-integration-secret-32-characters-minimum";

let directory: string;
let database: AppDatabase;
let teacher: MintedTeacherKey;
let server: ReturnType<typeof createGameServer>["server"];
let gateway: ReturnType<typeof createGameServer>["gateway"];
let url: string;
const clients: ClientSocket[] = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "game-1v100-ui-"));
  database = openDatabase(join(directory, "game.db"));
  teacher = mintTeacherKey(database, "Ms Rivera");
  ({ server, gateway } = createGameServer({ database, tokenSecret: TOKEN_SECRET }));
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

function client(auth?: Record<string, string>): ClientSocket {
  const socket = createClient(url, {
    forceNew: true,
    reconnection: false,
    ...(auth === undefined ? {} : { auth }),
  });
  clients.push(socket);
  return socket;
}

function cookieClient(cookie: string): ClientSocket {
  const socket = createClient(url, {
    forceNew: true,
    reconnection: false,
    extraHeaders: { cookie },
  });
  clients.push(socket);
  return socket;
}

function ack<T>(socket: ClientSocket, event: string, payload: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    socket.timeout(2_000).emit(event, payload, (error: Error | null, response: T) => {
      if (error !== null) reject(new Error(`${event} acknowledgement timed out`, { cause: error }));
      else resolve(response);
    });
  });
}

async function createSessionViaHttp(): Promise<{
  session_id: string;
  code: string;
  projector_token: string;
}> {
  const login = await fetch(`${url}/api/teacher/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: teacher.key }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (cookie === undefined) throw new Error("Expected teacher cookie");
  const response = await fetch(`${url}/api/sessions`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ request_id: `create-${crypto.randomUUID()}` }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    session_id: string;
    code: string;
    projector_token: string;
  };
}

function rosterUpdate(socket: ClientSocket): Promise<RosterEntry[]> {
  return packet(socket, "roster_update");
}

function packet<T>(socket: ClientSocket, event: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, receive);
      reject(new Error(`${event} packet timed out`));
    }, 2_000);
    const receive = (value: T): void => {
      clearTimeout(timer);
      resolve(value);
    };
    socket.once(event, receive);
  });
}

const PRIVATE_STUDENT_FIELDS = new Set([
  "correct_choice",
  "correctChoice",
  "teacher_token",
  "teacherToken",
  "projector_token",
  "projectorToken",
  "token_hash",
  "token_value",
  "token",
]);

function expectStudentSafe(value: unknown): void {
  const visit = (entry: unknown): void => {
    if (Array.isArray(entry)) {
      entry.forEach(visit);
      return;
    }
    if (typeof entry !== "object" || entry === null) return;
    for (const [key, nested] of Object.entries(entry as Record<string, unknown>)) {
      expect(PRIVATE_STUDENT_FIELDS.has(key), `student packet leaked ${key}`).toBe(false);
      visit(nested);
    }
  };
  visit(value);
}

describe("three classroom surfaces", () => {
  it("bootstraps from the teacher cookie and sign-out expires it", async () => {
    const login = await fetch(`${url}/api/teacher/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: teacher.key }),
    });
    const setCookie = login.headers.get("set-cookie") ?? "";
    const cookie = setCookie.split(";")[0] ?? "";
    const bootstrap = await fetch(`${url}/api/teacher/sessions`, { headers: { cookie } });
    const logout = await fetch(`${url}/api/teacher/logout`, {
      method: "POST",
      headers: { cookie },
    });

    expect(await login.json()).toEqual({ ok: true });
    expect(bootstrap.status).toBe(200);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("uses the teacher cookie for socket attachment", async () => {
    const classroom = await createSessionViaHttp();
    const login = await fetch(`${url}/api/teacher/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: teacher.key }),
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    if (cookie === undefined) throw new Error("Expected teacher cookie");
    const socket = cookieClient(cookie);

    expect(await ack(socket, "teacher_attach", { session_id: classroom.session_id }))
      .toMatchObject({ ok: true, session_id: classroom.session_id });
  });

  it("lists authenticated question sets with subject and grade filters", async () => {
    const token = createTeacherToken(teacher.teacherId, TOKEN_SECRET);
    const insertSet = database.prepare(
      `INSERT INTO question_sets
        (question_set_id, teacher_id, title, created_at_ms, updated_at_ms, subject, grade)
       VALUES (?, ?, ?, 1, 1, ?, ?)`,
    );
    insertSet.run("fractions-5", teacher.teacherId, "Fraction Foundations", "Fractions", "5");
    insertSet.run("geometry-5", teacher.teacherId, "Shape Lab", "Geometry", "5");
    insertSet.run("fractions-6", teacher.teacherId, "Fraction Fluency", "Fractions", "6");
    const insertQuestion = database.prepare(
      `INSERT INTO questions
        (question_id, question_set_id, position, prompt, choices_json, correct_choice)
       VALUES (?, ?, ?, 'Prompt', '["a","b","c"]', 0)`,
    );
    insertQuestion.run("f5-1", "fractions-5", 1);
    insertQuestion.run("f5-2", "fractions-5", 2);
    insertQuestion.run("g5-1", "geometry-5", 1);

    const unauthorized = await fetch(`${url}/api/question-sets`);
    const filtered = await fetch(`${url}/api/question-sets?subject=fractions&grade=5`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const cookie = await fetch(`${url}/api/question-sets?grade=6`, {
      headers: { cookie: `teacher_session=${token}` },
    });

    expect(unauthorized.status).toBe(401);
    expect(await filtered.json()).toEqual({
      question_sets: [{
        question_set_id: "fractions-5",
        title: "Fraction Foundations",
        subject: "Fractions",
        grade: "5",
        question_count: 2,
      }],
    });
    expect(await cookie.json()).toMatchObject({
      question_sets: [{ question_set_id: "fractions-6", question_count: 0 }],
    });
  });

  it("creates the session with the set selected on the teacher surface", async () => {
    database.prepare(
      `INSERT INTO question_sets
        (question_set_id, teacher_id, title, created_at_ms, updated_at_ms, subject, grade)
       VALUES ('selected-set', ?, 'Selected', 1, 1, 'Math', '5')`,
    ).run(teacher.teacherId);
    const login = await fetch(`${url}/api/teacher/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: teacher.key }),
    });
    const cookie = login.headers.get("set-cookie")?.split(";")[0];
    if (cookie === undefined) throw new Error("Expected teacher cookie");
    const response = await fetch(`${url}/api/sessions`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({ request_id: "create-selected", question_set_id: "selected-set" }),
    });
    const session = await response.json() as { session_id: string };

    expect(response.status).toBe(201);
    expect(database.prepare("SELECT question_set_id FROM sessions WHERE session_id = ?").get(session.session_id))
      .toEqual({ question_set_id: "selected-set" });
    const teacherHtml = await (await fetch(`${url}/teach`)).text();
    expect(teacherHtml).toContain('id="question-set-picker"');
    expect(teacherHtml).toContain('id="question-set-filters"');
  });

  it("replays session creation and question upload request IDs", async () => {
    const token = createTeacherToken(teacher.teacherId, TOKEN_SECRET);
    const create = () => fetch(`${url}/api/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ request_id: "ui-create-replay" }),
    });
    const csv = await readFile(new URL("fixtures/good.csv", import.meta.url), "utf8");
    const upload = () => fetch(`${url}/api/question-sets/import`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "text/csv",
        "x-request-id": "ui-upload-replay",
      },
      body: csv,
    });

    const firstCreate = await create();
    const replayCreate = await create();
    const firstUpload = await upload();
    const replayUpload = await upload();

    expect(await replayCreate.json()).toEqual(await firstCreate.json());
    expect(await replayUpload.json()).toEqual(await firstUpload.json());
    expect(database.prepare("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM question_sets").get()).toEqual({ count: 2 });
  });

  it("rotates a legacy session code through the coordinated teacher command", async () => {
    const classroom = await createSessionViaHttp();
    database.prepare("UPDATE sessions SET display_code_ciphertext = NULL WHERE session_id = ?")
      .run(classroom.session_id);
    const teacherSocket = client({ teacher_token: createTeacherToken(teacher.teacherId, TOKEN_SECRET) });
    await ack(teacherSocket, "teacher_attach", { session_id: classroom.session_id });

    const rotated = await ack<{ ok: boolean; code: string }>(
      teacherSocket,
      "teacher_rotate_session_code",
      { request_id: "ui-rotate-code" },
    );
    const replay = await ack<{ ok: boolean; code: string }>(
      teacherSocket,
      "teacher_rotate_session_code",
      { request_id: "ui-rotate-code" },
    );

    expect(rotated.ok).toBe(true);
    expect(rotated.code).toMatch(/^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{6}$/);
    expect(replay.code).toBe(rotated.code);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM game_events WHERE event_type = 'session_code_rotated'",
    ).get()).toEqual({ count: 1 });
  });

  it("mints and replays a missing projector credential without exposing it in events", async () => {
    const classroom = await createSessionViaHttp();
    const teacherSocket = client({ teacher_token: createTeacherToken(teacher.teacherId, TOKEN_SECRET) });
    await ack(teacherSocket, "teacher_attach", { session_id: classroom.session_id });

    const first = await ack<{ ok: boolean; projector_token: string }>(
      teacherSocket,
      "teacher_rotate_projector_credential",
      { request_id: "ui-projector-recovery" },
    );
    const replay = await ack<{ ok: boolean; projector_token: string }>(
      teacherSocket,
      "teacher_rotate_projector_credential",
      { request_id: "ui-projector-recovery" },
    );
    const projector = client();
    const attached = await ack<{ ok: boolean; session_id: string }>(projector, "projector_attach", {
      projector_token: replay.projector_token,
    });
    const event = database.prepare(
      "SELECT payload_json FROM game_events WHERE event_type = 'projector_credential_rotated'",
    ).get() as { payload_json: string };

    expect(first.projector_token).toBe(replay.projector_token);
    expect(attached).toMatchObject({ ok: true, session_id: classroom.session_id });
    expect(event.payload_json).not.toContain(first.projector_token);
  });

  it("serves teacher, student, and projector pages wired to their APIs and sockets", async () => {
    const classroom = await createSessionViaHttp();
    const responses = await Promise.all([
      fetch(`${url}/teach`),
      fetch(`${url}/join`),
      fetch(`${url}/projector/${classroom.session_id}`),
    ]);
    const [teacherHtml, studentHtml, projectorHtml] = await Promise.all(
      responses.map((response) => response.text()),
    );

    expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(teacherHtml).toContain('id="create-session"');
    expect(teacherHtml).toContain('src="/static/teacher.js"');
    expect(studentHtml).toContain('id="join-form"');
    expect(studentHtml).toContain('src="/socket.io/socket.io.js"');
    expect(projectorHtml).toContain('id="player-count"');
    expect(projectorHtml).toContain('id="standings"');
    expect(projectorHtml).toContain('id="standings-rows"');
    expect(projectorHtml).toContain("Challenge Team");
  });

  it("gates the entire teacher console behind sign-in and wires session rejoin", async () => {
    const teacherHtml = await (await fetch(`${url}/teach`)).text();
    const teacherJs = await (await fetch(`${url}/static/teacher.js`)).text();

    expect(teacherHtml).toMatch(/id="teacher-login" class="card"/);
    expect(teacherHtml).toMatch(/id="teacher-console" hidden/);
    expect(teacherHtml.indexOf('id="session-home"')).toBeGreaterThan(
      teacherHtml.indexOf('id="teacher-console"'),
    );
    expect(teacherHtml.indexOf('id="question-upload-form"')).toBeGreaterThan(
      teacherHtml.indexOf('id="teacher-console"'),
    );
    expect(teacherJs).toContain('fetch("/api/teacher/sessions", { credentials: "same-origin" })');
    expect(teacherJs).toContain("attachTeacher(entry.session_id, entry.code)");
    expect(teacherJs).toContain("renderSnapshot(ack.snapshot)");
    expect(teacherHtml).toContain('id="teacher-timer-seconds"');
    expect(teacherHtml).toContain('id="teacher-next-prompt"');
    expect(teacherHtml).toContain('id="teacher-deck-dialog"');
    expect(teacherJs).toContain('socket.emit("teacher_settings"');
    expect(teacherJs).toContain('/deck`');
  });

  it("lists a live session and reattaches with its current round snapshot", async () => {
    const classroom = await createSessionViaHttp();
    const token = createTeacherToken(teacher.teacherId, TOKEN_SECRET);
    const firstTeacher = client({ teacher_token: token });
    await ack(firstTeacher, "teacher_attach", { session_id: classroom.session_id });
    const opened = await ack<{ ok: true; attempt_id: string }>(
      firstTeacher,
      "teacher_open_question",
      { request_id: "open-before-rejoin" },
    );
    const listed = await fetch(`${url}/api/teacher/sessions`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const list = await listed.json() as {
      sessions: Array<{ session_id: string; code: string; status: string }>;
    };
    const rejoinedTeacher = client({ teacher_token: token });
    const rejoined = await ack<{
      ok: true;
      snapshot: { phase: string; attempt_id: string; question: { prompt: string } };
    }>(rejoinedTeacher, "teacher_attach", { session_id: list.sessions[0]?.session_id });

    expect(list.sessions[0]).toMatchObject({
      session_id: classroom.session_id,
      code: classroom.code,
      status: "live",
    });
    expect(rejoined.snapshot).toMatchObject({
      phase: "QUESTION_OPEN",
      attempt_id: opened.attempt_id,
      question: { prompt: expect.any(String) },
    });
  });

  it("imports a set that can be selected and attached to a new lobby", async () => {
    const token = createTeacherToken(teacher.teacherId, TOKEN_SECRET);
    const csv = await readFile(new URL("fixtures/good.csv", import.meta.url), "utf8");
    const imported = await fetch(`${url}/api/question-sets/import`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "text/csv",
        "x-request-id": "ui-upload",
      },
      body: csv,
    });
    expect(imported.status).toBe(201);
    const picker = await fetch(`${url}/api/question-sets`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const sets = await picker.json() as { question_sets: Array<{ question_set_id: string }> };
    const classroom = await createSessionViaHttp();
    const teacherSocket = client({ teacher_token: token });
    await ack(teacherSocket, "teacher_attach", { session_id: classroom.session_id });
    const attached = await ack<{ ok: boolean }>(teacherSocket, "teacher_attach_question_set", {
      request_id: "attach-uploaded-set",
      question_set_id: sets.question_sets[0]?.question_set_id,
    });

    expect(attached.ok).toBe(true);
    expect(database.prepare("SELECT question_set_id FROM sessions WHERE session_id = ?")
      .get(classroom.session_id)).toEqual({ question_set_id: sets.question_sets[0]?.question_set_id });
  });

  it("wires projector standings to leaderboard packets", async () => {
    const classroom = await createSessionViaHttp();
    const projectorJs = await (await fetch(`${url}/static/projector.js`)).text();

    expect(projectorJs).toContain('socket.on("leaderboard"');
    expect(projectorJs).toContain("applyShowPacket(packet, renderShowLeaderboard)");
    expect(projectorJs).toContain("renderStandings");
    expect(projectorJs).toContain("rows.slice(0, 5)");
    expect(classroom.session_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("runs the production round path for two students and reveals from auto-lock", async () => {
    const classroom = await createSessionViaHttp();
    const first = client();
    const second = client();
    const firstPackets: unknown[] = [];
    const secondPackets: unknown[] = [];
    first.onAny((_event, payload) => firstPackets.push(payload));
    second.onAny((_event, payload) => secondPackets.push(payload));
    const firstJoin = await ack<{ player_id: string; token: string }>(first, "join_session", {
      code: classroom.code,
      nickname: "Avery",
    });
    const secondJoin = await ack<{ player_id: string; token: string }>(second, "join_session", {
      code: classroom.code,
      nickname: "Blake",
    });
    expect(secondJoin.player_id).not.toBe(firstJoin.player_id);
    const projector = client();
    await ack(projector, "projector_attach", { projector_token: classroom.projector_token });
    const teacherSocket = client({ teacher_token: createTeacherToken(teacher.teacherId, TOKEN_SECRET) });
    await ack(teacherSocket, "teacher_attach", { session_id: classroom.session_id });
    const firstQuestion = packet<Record<string, unknown>>(first, "question_open");
    const secondQuestion = packet<Record<string, unknown>>(second, "question_open");
    const projectorQuestion = packet<Record<string, unknown>>(projector, "question_open");
    const teacherQuestion = packet<Record<string, unknown>>(teacherSocket, "question_open");
    const opened = await ack<{ ok: true; attempt_id: string }>(
      teacherSocket,
      "teacher_open_question",
      { request_id: "open-live-round" },
    );
    expect(opened).toMatchObject({
      ok: true,
      attempt_id: "open-live-round",
      server_time_ms: expect.any(Number),
      deadline_ms: expect.any(Number),
    });

    const questions = await Promise.all([firstQuestion, secondQuestion, projectorQuestion, teacherQuestion]);
    for (const question of questions) {
      expect(question).toMatchObject({
        attempt_id: opened.attempt_id,
        deadline_ms: expect.any(Number),
        server_time_ms: expect.any(Number),
      });
    }
    expect(questions[0]).toEqual(questions[1]);
    expectStudentSafe(questions[0]);
    expectStudentSafe(questions[1]);

    const firstCount = packet<Record<string, unknown>>(projector, "lock_counts");
    const firstAck = await ack<Record<string, unknown>>(first, "answer_submit", {
      request_id: "answer-first",
      attempt_id: opened.attempt_id,
      question_id: questions[0]?.question_id,
      choice: 1,
    });
    expect(firstAck).toMatchObject({
      ok: true,
      locked: true,
      server_time_ms: expect.any(Number),
      deadline_ms: expect.any(Number),
    });
    expectStudentSafe(firstAck);
    expect(await firstCount).toMatchObject({ locked_count: 1 });

    first.disconnect();
    const resumedSocket = client();
    const resumed = await ack<{
      ok: true;
      snapshot: { phase: string; question: { question_id: string }; own_answer: number };
    }>(resumedSocket, "resume", {
      token: firstJoin.token,
      session_id: classroom.session_id,
      request_id: "resume-mid-question",
      client_instance_id: "same-browser",
    });
    expect(resumed.snapshot).toMatchObject({
      phase: "QUESTION_OPEN",
      question: { question_id: questions[0]?.question_id },
      own_answer: 1,
    });
    expectStudentSafe(resumed);

    const locked = packet<{ locked_count: number }>(teacherSocket, "phase_a_locked");
    const reveal = packet<{ correct_choice: number; counts: number[] }>(projector, "reveal");
    const standings = packet<{ rows: Array<{ points: number }> }>(teacherSocket, "leaderboard");
    const secondAck = await ack<Record<string, unknown>>(second, "answer_submit", {
      request_id: "answer-second",
      attempt_id: opened.attempt_id,
      question_id: questions[1]?.question_id,
      choice: 3,
    });
    expect(secondAck).toMatchObject({ ok: true, deadline_ms: null, server_time_ms: expect.any(Number) });
    expectStudentSafe(secondAck);
    expect(await locked).toMatchObject({ locked_count: 2 });
    firstPackets.forEach(expectStudentSafe);
    secondPackets.forEach(expectStudentSafe);

    expect(await ack(teacherSocket, "teacher_force_reveal", {
      request_id: "force-live-round",
      attempt_id: opened.attempt_id,
    })).toMatchObject({ ok: true, deadline_ms: null, server_time_ms: expect.any(Number) });
    expect(await reveal).toMatchObject({ correct_choice: 1, counts: [0, 1, 0, 1] });
    expect((await standings).rows[0]?.points).toBe(10);
  });

  it("propagates two student joins from the teacher-created session to projector roster", async () => {
    const classroom = await createSessionViaHttp();
    const projector = client();
    await ack(projector, "projector_attach", {
      projector_token: classroom.projector_token,
    });

    const firstUpdate = rosterUpdate(projector);
    await ack(client(), "join_session", { code: classroom.code, nickname: "Avery" });
    const first = await firstUpdate;
    expect(first.map((player) => player.nickname)).toEqual(["Avery"]);

    const secondUpdate = rosterUpdate(projector);
    await ack(client(), "join_session", { code: classroom.code, nickname: "Blake" });
    const second = await secondUpdate;
    expect(second.map((player) => player.nickname)).toEqual(["Avery", "Blake"]);
    expect(second).toHaveLength(2);
  });

  it("provides baseline accessible semantics on all three surfaces", async () => {
    const classroom = await createSessionViaHttp();
    for (const path of ["/teach", "/join", `/projector/${classroom.session_id}`]) {
      const html = await (await fetch(`${url}${path}`)).text();
      expect(html).toContain('<html lang="en">');
      expect(html.match(/<h1[ >]/g)).toHaveLength(1);
      expect(html).toContain("<title>");
      expect(html).not.toMatch(/<img(?![^>]*\balt=)/i);
    }
  });

  it("stores session-scoped tokens and auto-resumes refreshes by token only", async () => {
    const studentJs = await (await fetch(`${url}/static/student.js`)).text();

    expect(studentJs).toContain('const TOKEN_PREFIX = "player:session:"');
    expect(studentJs).toMatch(/socket\.emit\("resume",\s*\{[^}]*request_id: createRequestId\(\)[^}]*client_instance_id: stableClientId\(\)/s);
    expect(studentJs).not.toMatch(/resume[^\n]+nickname/);
  });

  it("retries a lost join ack with stable request and client instance IDs", async () => {
    const studentJs = await (await fetch(`${url}/static/student.js`)).text();

    expect(studentJs).toContain("emitWithRetry");
    expect(studentJs).toContain("player:pending-join");
    expect(studentJs).toContain("request_id: createRequestId()");
    expect(studentJs).toContain("client_instance_id: stableClientId()");
  });

  it("clears expired, kicked, and ended identities and returns to the join form", async () => {
    const studentJs = await (await fetch(`${url}/static/student.js`)).text();

    expect(studentJs).toContain('["KICKED", "RECONNECT_BAD_TOKEN", "SESSION_ENDED"]');
    expect(studentJs).toContain('socket.on("kicked"');
    expect(studentJs).toContain('socket.on("session_end"');
    expect(studentJs).toContain("function applyOneV100Packet");
    expect(studentJs).toContain("form.hidden = false");
  });

  it("uses shared durable identity while allowing each tab its own socket", async () => {
    const studentJs = await (await fetch(`${url}/static/student.js`)).text();

    expect(studentJs).toContain('const socket = window.io(');
    expect(studentJs).toContain("localStorage.getItem(CLIENT_KEY)");
    expect(studentJs).not.toContain("sessionStorage");
  });
});
