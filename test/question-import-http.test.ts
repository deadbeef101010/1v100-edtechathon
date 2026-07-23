import { once } from "node:events";
import { readFile } from "node:fs/promises";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTeacherToken } from "../src/auth.js";
import { openDatabase, type AppDatabase } from "../src/db.js";
import { createAppServer } from "../src/server.js";
import { mintTeacherKey } from "../src/teachers.js";

const TOKEN_SECRET = "import-http-secret-32-characters-minimum";
let database: AppDatabase;
let server: ReturnType<typeof createAppServer>;
let url: string;
let teacherId: string;
let token: string;

beforeEach(async () => {
  database = openDatabase(":memory:");
  teacherId = mintTeacherKey(database, "Question uploader").teacherId;
  token = createTeacherToken(teacherId, TOKEN_SECRET);
  server = createAppServer({ database, tokenSecret: TOKEN_SECRET });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP listener");
  url = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  database.close();
});

async function fixture(name: string): Promise<string> {
  return readFile(new URL(`fixtures/${name}`, import.meta.url), "utf8");
}

function upload(csv: string, requestId = "upload-1", authorized = true): Promise<Response> {
  return fetch(`${url}/api/question-sets/import`, {
    method: "POST",
    headers: {
      "content-type": "text/csv",
      "x-request-id": requestId,
      "x-file-name": "questions.csv",
      ...(authorized ? { authorization: `Bearer ${token}` } : {}),
    },
    body: csv,
  });
}

describe("question-set import API", () => {
  it("requires teacher authentication", async () => {
    const response = await upload(await fixture("good.csv"), "unauthorized", false);

    expect(response.status).toBe(401);
    expect(database.prepare("SELECT COUNT(*) AS count FROM question_sets").get()).toEqual({ count: 0 });
  });

  it("imports a reusable set, records an event, and exposes it in the picker", async () => {
    const response = await upload(await fixture("good.csv"));
    const picker = await fetch(`${url}/api/question-sets`, {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ sets_created: 1, questions_imported: 10 });
    expect(await picker.json()).toMatchObject({
      question_sets: [{
        title: "Fraction Foundations",
        subject: "Fractions",
        grade: "5",
        question_count: 10,
      }],
    });
    expect(database.prepare(
      "SELECT event_type, actor_kind FROM teacher_events WHERE teacher_id = ?",
    ).get(teacherId)).toEqual({ event_type: "question_set_imported", actor_kind: "teacher" });
  });

  it("replays matching requests without duplicates and rejects changed CSV", async () => {
    const csv = await fixture("good.csv");
    const first = await upload(csv, "stable-upload");
    const replay = await upload(csv, "stable-upload");
    const mismatch = await upload(csv.replace("Fraction Foundations", "Changed set"), "stable-upload");

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual({ sets_created: 1, questions_imported: 10 });
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toEqual({ error: "request_mismatch" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM question_sets").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM teacher_events").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM teacher_command_outcomes").get())
      .toEqual({ count: 1 });
  });

  it("returns every row error and leaves the import atomic", async () => {
    const response = await upload(await fixture("bad.csv"));
    const body = await response.json() as { errors: Array<{ row: number; reason: string }> };

    expect(response.status).toBe(422);
    expect(body.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ row: 3, reason: expect.stringContaining("duplicated") }),
      expect.objectContaining({ row: 4, reason: expect.stringContaining("integer from 0 to 2") }),
      expect.objectContaining({ row: 5, reason: expect.stringContaining("empty option") }),
    ]));
    expect(database.prepare("SELECT COUNT(*) AS count FROM question_sets").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM teacher_events").get()).toEqual({ count: 0 });
  });

  it("uses a dedicated 256 KiB request limit", async () => {
    const rows = Array.from({ length: 200 }, (_, index) =>
      `Large valid set,Math,5,Question ${index + 1}: ${"x".repeat(100)},"[""A"",""B"",""C""]",0,A is correct,${index + 1}`);
    const overGenericLimit = [
      "set title,subject,grade,question,choices,correct,explanation,position",
      ...rows,
    ].join("\n");
    expect(Buffer.byteLength(overGenericLimit)).toBeGreaterThan(16 * 1_024);
    expect(Buffer.byteLength(overGenericLimit)).toBeLessThanOrEqual(256 * 1_024);
    const accepted = await upload(overGenericLimit, "large-valid");
    const rejected = await upload("x".repeat(256 * 1_024 + 1), "too-large");

    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toEqual({ sets_created: 1, questions_imported: 200 });
    expect(rejected.status).toBe(413);
    expect(await rejected.json()).toEqual({ error: "payload_too_large", max_bytes: 262_144 });
  });
});
