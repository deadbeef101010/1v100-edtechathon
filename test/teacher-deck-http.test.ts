import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTeacherToken } from "../src/auth.js";
import { openDatabase, type AppDatabase } from "../src/db.js";
import { ServerLogger } from "../src/log.js";
import { createAppServer } from "../src/server.js";
import { createClassroomSession } from "../src/sessions.js";
import { mintTeacherKey } from "../src/teachers.js";

const SECRET = "teacher-deck-http-secret-32-characters";
let directory: string;
let database: AppDatabase;
let server: ReturnType<typeof createAppServer>;
let url: string;
let logger: ServerLogger;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "teacher-deck-http-"));
  database = openDatabase(join(directory, "game.db"));
  logger = new ServerLogger({ write: () => undefined });
  server = createAppServer({ database, tokenSecret: SECRET, logger });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a TCP listener");
  url = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  database.close();
  await rm(directory, { recursive: true, force: true });
});

describe("teacher deck HTTP API", () => {
  it("requires a cookie and returns the complete owner-only answer key", async () => {
    const owner = mintTeacherKey(database, "Deck Owner");
    const classroom = createClassroomSession(database, owner.teacherId, SECRET);
    const session = database.prepare(
      "SELECT question_set_id FROM sessions WHERE session_id = ?",
    ).get(classroom.sessionId) as { question_set_id: string };
    database.prepare(
      `INSERT INTO questions
        (question_id, question_set_id, position, prompt, choices_json, correct_choice, phase_a_seconds)
       VALUES (?, ?, 2, 'Second prompt', ?, 2, NULL)`,
    ).run(crypto.randomUUID(), session.question_set_id, JSON.stringify(["One", "Two", "Three"]));
    database.prepare("UPDATE sessions SET deck_start_position = 2 WHERE session_id = ?")
      .run(classroom.sessionId);
    const endpoint = `${url}/api/teacher/sessions/${classroom.sessionId}/deck`;

    expect((await fetch(endpoint)).status).toBe(401);
    const token = createTeacherToken(owner.teacherId, SECRET);
    expect((await fetch(endpoint, { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    const response = await fetch(endpoint, { headers: { cookie: `teacher_session=${token}` } });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      cursor_position: 2,
      questions: [
        expect.objectContaining({
          position: 1,
          prompt: expect.any(String),
          choices: expect.any(Array),
          correct_choice: expect.any(Number),
          played: true,
        }),
        expect.objectContaining({
          position: 2,
          prompt: "Second prompt",
          choices: ["One", "Two", "Three"],
          correct_choice: 2,
          played: false,
        }),
      ],
    });
    expect(logger.entries()).toContainEqual(expect.objectContaining({
      event: "teacher_deck_viewed",
      session_id: classroom.sessionId,
      actor: { kind: "teacher", id: owner.teacherId },
      detail: { cursor_position: 2, question_count: 2 },
    }));
    // Raw-frame no-leak proof lives in socket-gateway.test.ts (deck cursor
    // test records every student/projector frame and asserts correct_choice
    // never appears pre-reveal).
  });

  it("rejects Authorization-only callers: the answer key requires the owner cookie", async () => {
    const owner = mintTeacherKey(database, "Bearer Owner");
    const classroom = createClassroomSession(database, owner.teacherId, SECRET);
    const bearerOnly = await fetch(`${url}/api/teacher/sessions/${classroom.sessionId}/deck`, {
      headers: { authorization: "Bearer " + createTeacherToken(owner.teacherId, SECRET) },
    });
    expect(bearerOnly.status).toBe(401);
    const junkCookie = await fetch(`${url}/api/teacher/sessions/${classroom.sessionId}/deck`, {
      headers: {
        authorization: "Bearer " + createTeacherToken(owner.teacherId, SECRET),
        cookie: "teacher_session=junk-token",
      },
    });
    expect(junkCookie.status).toBe(401);
  });

  it("distinguishes an unknown session from another teacher's session", async () => {
    const owner = mintTeacherKey(database, "Deck Owner");
    const other = mintTeacherKey(database, "Other Teacher");
    const classroom = createClassroomSession(database, owner.teacherId, SECRET);
    const token = createTeacherToken(other.teacherId, SECRET);
    const headers = { cookie: `teacher_session=${token}` };

    expect((await fetch(
      `${url}/api/teacher/sessions/${crypto.randomUUID()}/deck`,
      { headers },
    )).status).toBe(404);
    expect((await fetch(
      `${url}/api/teacher/sessions/${classroom.sessionId}/deck`,
      { headers },
    )).status).toBe(403);
    expect(logger.entries().filter((entry) => entry.event === "teacher_deck_access_rejected"))
      .toHaveLength(2);
  });
});
