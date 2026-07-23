import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { verifyTeacherToken } from "../src/auth.js";
import { openDatabase, type AppDatabase } from "../src/db.js";
import { createAppServer } from "../src/server.js";
import { mintTeacherKey } from "../src/teachers.js";
import { runMintTeacherKeyCli } from "../tools/mint-teacher-key.js";
import { ServerLogger } from "../src/log.js";

const TOKEN_SECRET = "teacher-token-secret-32-characters-minimum";

let directory: string;
let database: AppDatabase;
const servers: Array<ReturnType<typeof createAppServer>> = [];
let logger: ServerLogger;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "game-1v100-auth-"));
  database = openDatabase(join(directory, "game.db"));
  logger = new ServerLogger({ write: () => undefined });
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  if (database.open) {
    database.close();
  }
  await rm(directory, { recursive: true, force: true });
});

async function baseUrl(): Promise<string> {
  const server = createAppServer({ database, tokenSecret: TOKEN_SECRET, logger });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP listener");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function login(url: string, key: string): Promise<Response> {
  return fetch(`${url}/api/teacher/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
  });
}

describe("teacher keys", () => {
  it("mints through the CLI and logs in with a verifiable teacher HMAC token", async () => {
    database.close();
    const requestId = crypto.randomUUID();
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "tools/mint-teacher-key.ts",
        "--label",
        "Ms Rivera",
        "--request-id",
        requestId,
      ],
      {
        cwd: new URL("..", import.meta.url),
        env: { ...process.env, DB_PATH: join(directory, "game.db") },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    const [exitCode] = (await once(child, "exit")) as [number, NodeJS.Signals | null];
    expect(exitCode).toBe(0);
    const key = stdout.trim();
    expect(key).toMatch(/^tch_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}$/);

    const retry = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "tools/mint-teacher-key.ts",
        "--label",
        "Ms Rivera",
        "--request-id",
        requestId,
      ],
      {
        cwd: new URL("..", import.meta.url),
        env: { ...process.env, DB_PATH: join(directory, "game.db") },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let retryStdout = "";
    retry.stdout.setEncoding("utf8");
    retry.stdout.on("data", (chunk: string) => {
      retryStdout += chunk;
    });
    let retryStderr = "";
    retry.stderr.setEncoding("utf8");
    retry.stderr.on("data", (chunk: string) => {
      retryStderr += chunk;
    });
    const [retryExitCode] = (await once(retry, "exit")) as [number, NodeJS.Signals | null];
    expect(retryExitCode).toBe(1);
    expect(retryStdout.trim()).toBe("");
    expect(retryStderr).toContain("shown only once");
    expect(retryStderr).not.toContain(key);

    database = openDatabase(join(directory, "game.db"));
    const mintEvent = database.prepare(
      "SELECT event_type, payload_json FROM meta_events WHERE event_type = 'teacher_key_minted'",
    ).get() as { event_type: string; payload_json: string };
    const mintOutcome = database.prepare(
      "SELECT outcome_json FROM meta_command_outcomes WHERE command_type = 'mint_teacher_key'",
    ).get() as { outcome_json: string };
    const mintAttempt = database.prepare(
      "SELECT payload_json FROM auth_events WHERE event_type = 'meta_admin_attempt'",
    ).get() as { payload_json: string };
    const response = await login(await baseUrl(), key);
    expect(await response.json()).toEqual({ ok: true });
    const cookie = response.headers.get("set-cookie");
    const token = /teacher_session=([^;]+)/.exec(cookie ?? "")?.[1];
    if (token === undefined) throw new Error("Expected teacher session cookie");
    const claims = verifyTeacherToken(token, TOKEN_SECRET);

    expect(response.status).toBe(200);
    expect(claims.teacherId).toMatch(/^[0-9a-f-]{36}$/);
    expect(mintEvent.event_type).toBe("teacher_key_minted");
    expect(mintEvent.payload_json).not.toContain(key);
    expect(mintOutcome.outcome_json).not.toContain(key);
    expect(mintOutcome.outcome_json).not.toContain("tch_");
    expect(JSON.parse(mintAttempt.payload_json)).toEqual({
      surface: "meta",
      action: "mint",
      outcome: "succeeded",
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM teachers").get()).toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM auth_events WHERE event_type = 'meta_admin_attempt'",
    ).get()).toEqual({ count: 1 });
  });

  it("records successful authentication as the observable last-used source", async () => {
    const minted = mintTeacherKey(database, "Ms Rivera");

    expect((await login(await baseUrl(), minted.key)).status).toBe(200);
    expect(database.prepare("SELECT last_used_at_ms FROM teachers WHERE teacher_id = ?").get(
      minted.teacherId,
    )).toEqual({ last_used_at_ms: null });
    expect(database.prepare(
      "SELECT event_type, actor_id FROM auth_events WHERE event_type = 'teacher_login_succeeded'",
    ).get()).toEqual({
      event_type: "teacher_login_succeeded",
      actor_id: minted.teacherId,
    });
  });

  it("rolls back a CLI mint when its coordinated attempt audit fails", () => {
    database.exec(`
      CREATE TRIGGER reject_cli_attempt_audit
      BEFORE INSERT ON auth_events
      BEGIN
        SELECT RAISE(ABORT, 'attempt audit rejected');
      END
    `);
    database.close();

    expect(() => runMintTeacherKeyCli(
      ["--label", "Ms Rivera", "--request-id", crypto.randomUUID()],
      { DATABASE_PATH: join(directory, "game.db") },
      () => undefined,
    )).toThrow("attempt audit rejected");

    database = openDatabase(join(directory, "game.db"));
    expect(database.prepare("SELECT COUNT(*) AS count FROM teachers").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM meta_events").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM meta_command_outcomes").get()).toEqual({
      count: 0,
    });
  });

  it("documents the optional request id in CLI help and usage errors", () => {
    const output: string[] = [];

    runMintTeacherKeyCli(["--help"], {}, (value) => output.push(value));

    expect(output).toEqual([
      "Usage: mint-teacher-key --label <teacher label> [--request-id <request id>]",
    ]);
    expect(() => runMintTeacherKeyCli([], {}, () => undefined)).toThrow("--request-id");
  });

  it("rejects a wrong key and records a credential-free auth event", async () => {
    mintTeacherKey(database, "Ms Rivera");
    const wrongKey = "tch_BADKEY00_this-is-not-a-valid-teacher-secret";

    const response = await login(await baseUrl(), wrongKey);
    const event = database
      .prepare("SELECT event_type, payload_json FROM auth_events ORDER BY event_id DESC LIMIT 1")
      .get() as { event_type: string; payload_json: string };

    expect(response.status).toBe(401);
    expect(event.event_type).toBe("teacher_login_failed");
    expect(event.payload_json).not.toContain(wrongKey);
    expect(logger.entries()).toContainEqual(expect.objectContaining({
      event: "auth_failure",
      actor: { kind: "teacher" },
      detail: { surface: "teacher_login", reason: "invalid_credentials" },
    }));
    expect(JSON.stringify(logger.entries())).not.toContain(wrongKey);
  });

  it("stores only the teacher key prefix and hash, never the raw key", () => {
    const minted = mintTeacherKey(database, "Ms Rivera");
    const columns = database
      .prepare("PRAGMA table_info(teachers)")
      .all()
      .map((row) => (row as { name: string }).name);
    const row = database.prepare("SELECT * FROM teachers").get();

    expect(columns).toContain("key_prefix");
    expect(columns).toContain("key_hash");
    expect(columns).not.toContain("key");
    expect(JSON.stringify(row)).not.toContain(minted.key);
  });

  it("rate limits repeated failed logins per source without writing further audit rows", async () => {
    const minted = mintTeacherKey(database, "Ms Rivera");
    const url = await baseUrl();
    const wrongKey = "tch_BADKEY00_this-is-not-a-valid-teacher-secret";

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await login(url, wrongKey)).status).toBe(401);
    }
    const limited = await login(url, minted.key);
    const failedRows = database
      .prepare("SELECT COUNT(*) AS count FROM auth_events WHERE event_type = 'teacher_login_failed'")
      .get() as { count: number };

    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    // The limited attempt must not touch the append-only audit table.
    expect(failedRows.count).toBe(5);
    expect(logger.entries()).toContainEqual(expect.objectContaining({
      event: "auth_rate_limited",
      detail: { surface: "teacher_login" },
    }));
  });

  it("rejects an otherwise valid key after its teacher is revoked", async () => {
    const minted = mintTeacherKey(database, "Ms Rivera");
    database
      .prepare("UPDATE teachers SET status = 'revoked', revoked_at_ms = ? WHERE teacher_id = ?")
      .run(Date.now(), minted.teacherId);

    const response = await login(await baseUrl(), minted.key);

    expect(response.status).toBe(401);
  });
});
