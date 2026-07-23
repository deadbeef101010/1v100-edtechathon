import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDatabase, type AppDatabase } from "../src/db.js";
import { ServerLogger } from "../src/log.js";
import { MetaAdminService } from "../src/meta-admin.js";
import { createAppServer } from "../src/server.js";
import { createClassroomSession } from "../src/sessions.js";

const TOKEN_SECRET = "meta-token-secret-at-least-32-characters";
const META_KEY = "meta_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
const META_KEY_HASH = createHash("sha256").update(META_KEY).digest("hex");

let directory: string;
let database: AppDatabase;
let logger: ServerLogger;
const servers: Array<ReturnType<typeof createAppServer>> = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "game-1v100-meta-"));
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
  if (database.open) database.close();
  await rm(directory, { recursive: true, force: true });
});

async function baseUrl(): Promise<string> {
  const server = createAppServer({
    database,
    tokenSecret: TOKEN_SECRET,
    metaKeyHash: META_KEY_HASH,
    logger,
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected TCP listener");
  return `http://127.0.0.1:${address.port}`;
}

async function login(url: string, key = META_KEY): Promise<Response> {
  return fetch(`${url}/api/meta/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
    body: JSON.stringify({ key }),
  });
}

function cookieFrom(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  if (setCookie === null) throw new Error("Expected meta cookie");
  return setCookie.split(";", 1)[0] as string;
}

async function mint(url: string, cookie: string, label = "Ms Rivera"): Promise<Response> {
  return fetch(`${url}/api/meta/teachers`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ label, request_id: crypto.randomUUID() }),
  });
}

async function reissue(
  url: string,
  cookie: string,
  teacherId: string,
  requestId: string = crypto.randomUUID(),
): Promise<Response> {
  return fetch(`${url}/api/meta/teachers/${teacherId}/reissue`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ request_id: requestId, confirm: true }),
  });
}

describe("meta admin", () => {
  it("serves an unlinked root-relative landing page", async () => {
    const url = await baseUrl();
    const response = await fetch(`${url}/meta`);
    const page = await response.text();

    expect(response.status).toBe(200);
    expect(page).toContain("Organizer access");
    expect(page).toContain('src="/static/meta.js"');
    expect(await (await fetch(`${url}/`)).text()).not.toContain("/meta");
  });

  it("uses an HTTP-compatible cookie on a plain-HTTP private-network deployment", async () => {
    const url = await baseUrl();
    const response = await fetch(`${url}/api/meta/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: META_KEY }),
    });
    const setCookie = response.headers.get("set-cookie");

    expect(response.status).toBe(200);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).not.toContain("; Secure");
  });

  it("returns the same generic response for wrong and missing meta keys without logging them", async () => {
    const url = await baseUrl();
    const wrong = "meta_wrong-secret-material";
    const wrongResponse = await login(url, wrong);
    const missingResponse = await login(url, "");
    const malformedResponse = await fetch(`${url}/api/meta/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    const events = database.prepare("SELECT event_type, payload_json FROM auth_events").all() as Array<{
      event_type: string;
      payload_json: string;
    }>;

    expect(wrongResponse.status).toBe(404);
    expect(await wrongResponse.json()).toEqual({ error: "not_found" });
    expect(missingResponse.status).toBe(404);
    expect(await missingResponse.json()).toEqual({ error: "not_found" });
    expect(malformedResponse.status).toBe(404);
    expect(await malformedResponse.json()).toEqual({ error: "not_found" });
    expect(events.map((event) => event.event_type)).toEqual([
      "meta_login_failed",
      "meta_login_failed",
      "meta_login_failed",
    ]);
    expect(JSON.stringify(events)).not.toContain(wrong);
    expect(JSON.stringify(events)).not.toContain(META_KEY_HASH);
  });

  it("globally rate limits all login attempts without key material", async () => {
    const url = await baseUrl();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await login(url, `wrong-${attempt}`)).status).toBe(404);
    }
    expect((await login(url)).status).toBe(404);
    const events = database
      .prepare("SELECT event_type, payload_json FROM auth_events ORDER BY event_id")
      .all() as Array<{ event_type: string; payload_json: string }>;

    expect(events).toHaveLength(11);
    expect(events.filter((event) => event.event_type === "meta_login_failed")).toHaveLength(5);
    expect(events.filter((event) => event.event_type === "meta_login_rate_limited")).toHaveLength(6);
    expect(events.at(-1)?.event_type).toBe("meta_login_rate_limited");
    expect(JSON.stringify(events)).not.toContain("wrong-");
  });

  it("does not trust forwarded addresses to evade the socket-source limit", async () => {
    const url = await baseUrl();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await fetch(`${url}/api/meta/login`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forwarded-for": `203.0.113.${attempt + 1}`,
          "x-real-ip": "10.0.0.2",
        },
        body: JSON.stringify({ key: `wrong-${attempt}` }),
      });
    }
    const rotatedHeader = await fetch(`${url}/api/meta/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.5, 10.0.0.2",
        "x-real-ip": "10.0.0.2",
      },
      body: JSON.stringify({ key: META_KEY }),
    });
    const limitedLogs = database
      .prepare("SELECT COUNT(*) AS count FROM auth_events WHERE event_type = 'meta_login_rate_limited'")
      .get() as { count: number };

    expect(rotatedHeader.status).toBe(404);
    expect(limitedLogs.count).toBe(1);
  });

  it("mints through the coordinator, redacts replays and lists, and never stores raw keys", async () => {
    const url = await baseUrl();
    const loginResponse = await login(url);
    const cookie = cookieFrom(loginResponse);
    const response = await mint(url, cookie);
    const body = (await response.json()) as { teacher_id: string; key: string; warning: string };
    const listResponse = await fetch(`${url}/api/meta/teachers`, { headers: { cookie } });
    const listText = await listResponse.text();
    const repeatedRequest = await fetch(`${url}/api/meta/teachers`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ label: "Replay", request_id: "fixed-request" }),
    });
    const repeated = await fetch(`${url}/api/meta/teachers`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ label: "Replay", request_id: "fixed-request" }),
    });

    expect(loginResponse.status).toBe(200);
    expect(loginResponse.headers.get("set-cookie")).toContain("meta_session=");
    expect(loginResponse.headers.get("set-cookie")).toContain("HttpOnly");
    expect(loginResponse.headers.get("set-cookie")).toContain("Secure");
    expect(response.status).toBe(201);
    expect(body.key).toMatch(/^tch_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}$/);
    expect(body.warning).toContain("not be shown again");
    expect(listResponse.status).toBe(200);
    expect(listText).toContain("Ms Rivera");
    expect(listText).not.toContain(body.key);
    expect(listText).not.toContain("key_hash");
    const firstMint = (await repeatedRequest.json()) as { teacher_id: string; key: string };
    const replayed = (await repeated.json()) as { teacher_id: string; key: null; code: string };
    expect(repeatedRequest.status).toBe(201);
    expect(firstMint.key).toMatch(/^tch_/);
    expect(repeated.status).toBe(200);
    expect(replayed.teacher_id).toBe(firstMint.teacher_id);
    expect(replayed.key).toBeNull();
    expect(replayed.code).toBe("key_already_issued");

    const stored = database.prepare("SELECT key_prefix, key_hash FROM teachers WHERE teacher_id = ?").get(
      body.teacher_id,
    ) as { key_prefix: string; key_hash: Buffer };
    const event = database.prepare("SELECT * FROM meta_events WHERE event_type = 'teacher_key_minted'").get() as {
      actor_kind: string;
      payload_json: string;
    };
    expect(stored.key_hash).toEqual(createHash("sha256").update(body.key).digest());
    expect(event.actor_kind).toBe("organizer");
    expect(event.payload_json).not.toContain(body.key);
    expect(event.payload_json).not.toContain(stored.key_hash.toString("hex"));
    const outcomes = database.prepare(
      "SELECT outcome_json FROM meta_command_outcomes",
    ).all() as Array<{ outcome_json: string }>;
    expect(outcomes.length).toBeGreaterThan(0);
    for (const row of outcomes) {
      expect(row.outcome_json).not.toContain("tch_");
      expect(row.outcome_json).not.toContain(body.key);
      expect(row.outcome_json).not.toContain(firstMint.key);
    }
  });

  it("validates labels before persistence and observes malformed mutation attempts", async () => {
    const url = await baseUrl();
    const cookie = cookieFrom(await login(url));
    const credentialLabel = await mint(url, cookie, "tch_ABCDEFGH_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG");
    const longLabel = await mint(url, cookie, "A".repeat(65));
    const malformed = await fetch(`${url}/api/meta/teachers`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: "not-json",
    });
    const attempts = database.prepare(
      "SELECT payload_json FROM auth_events WHERE event_type = 'meta_admin_attempt' ORDER BY event_id",
    ).all() as Array<{ payload_json: string }>;

    expect(credentialLabel.status).toBe(400);
    expect(await credentialLabel.json()).toEqual({
      error: "invalid_label",
      message: "Teacher labels cannot contain credential-like text",
    });
    expect(longLabel.status).toBe(400);
    expect(malformed.status).toBe(400);
    expect(database.prepare("SELECT COUNT(*) AS count FROM teachers").get()).toEqual({ count: 0 });
    expect(attempts.map((entry) => JSON.parse(entry.payload_json))).toEqual([
      expect.objectContaining({ action: "mint", outcome: "invalid_label" }),
      expect.objectContaining({ action: "mint", outcome: "invalid_label" }),
      expect.objectContaining({ action: "mint", outcome: "malformed_json" }),
    ]);
    expect(JSON.stringify(attempts)).not.toContain("tch_ABCDEFGH");
  });

  it("accepts JSON charset parameters and observes rejected content types", async () => {
    const url = await baseUrl();
    const accepted = await fetch(`${url}/api/meta/login`, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify({ key: META_KEY }),
    });
    const rejected = await fetch(`${url}/api/meta/login`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ key: META_KEY }),
    });
    const events = database.prepare(
      "SELECT event_type, payload_json FROM auth_events ORDER BY event_id",
    ).all() as Array<{ event_type: string; payload_json: string }>;

    expect(accepted.status).toBe(200);
    expect(rejected.status).toBe(404);
    expect(events).toEqual([
      expect.objectContaining({ event_type: "meta_login_succeeded" }),
      expect.objectContaining({
        event_type: "meta_login_failed",
        payload_json: expect.stringContaining("content_type_rejected"),
      }),
    ]);
  });

  it("requires confirmation and revocation immediately invalidates login and existing cookies", async () => {
    const url = await baseUrl();
    const cookie = cookieFrom(await login(url));
    const mintedResponse = await mint(url, cookie);
    const minted = (await mintedResponse.json()) as { teacher_id: string; key: string };
    const teacherLogin = await fetch(`${url}/api/teacher/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: minted.key }),
    });
    const teacherCookie = cookieFrom(teacherLogin);

    const unconfirmed = await fetch(`${url}/api/meta/teachers/${minted.teacher_id}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ request_id: crypto.randomUUID() }),
    });
    const revoked = await fetch(`${url}/api/meta/teachers/${minted.teacher_id}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ request_id: crypto.randomUUID(), confirm: true }),
    });
    const relogin = await fetch(`${url}/api/teacher/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: minted.key }),
    });
    const existingSession = await fetch(`${url}/api/question-sets`, {
      headers: { cookie: teacherCookie },
    });
    const event = database.prepare("SELECT actor_kind, payload_json FROM meta_events WHERE event_type = 'teacher_key_revoked'").get() as {
      actor_kind: string;
      payload_json: string;
    };

    expect(teacherLogin.status).toBe(200);
    expect(unconfirmed.status).toBe(400);
    expect(revoked.status).toBe(200);
    expect(relogin.status).toBe(401);
    expect(existingSession.status).toBe(401);
    expect(event.actor_kind).toBe("organizer");
    expect(event.payload_json).toContain(minted.teacher_id);
    expect(event.payload_json).not.toContain(minted.key);
  });

  it("reissues on the same teacher, retains sessions, and invalidates the old key and cookie", async () => {
    const url = await baseUrl();
    const metaCookie = cookieFrom(await login(url));
    const minted = (await (await mint(url, metaCookie)).json()) as {
      teacher_id: string;
      key: string;
    };
    const oldLogin = await fetch(`${url}/api/teacher/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: minted.key }),
    });
    const oldCookie = cookieFrom(oldLogin);
    const classroom = createClassroomSession(database, minted.teacher_id, TOKEN_SECRET);
    const before = database.prepare(
      "SELECT key_prefix, key_hash FROM teachers WHERE teacher_id = ?",
    ).get(minted.teacher_id) as { key_prefix: string; key_hash: Buffer };

    const response = await reissue(url, metaCookie, minted.teacher_id);
    const replacement = (await response.json()) as { teacher_id: string; key: string };
    const after = database.prepare(
      "SELECT key_prefix, key_hash FROM teachers WHERE teacher_id = ?",
    ).get(minted.teacher_id) as { key_prefix: string; key_hash: Buffer };
    const oldRelogin = await fetch(`${url}/api/teacher/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: minted.key }),
    });
    const oldSession = await fetch(`${url}/api/question-sets`, { headers: { cookie: oldCookie } });
    const replacementLogin = await fetch(`${url}/api/teacher/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: replacement.key }),
    });
    const replacementCookie = cookieFrom(replacementLogin);
    const retainedData = await fetch(`${url}/api/question-sets`, {
      headers: { cookie: replacementCookie },
    });
    const retainedSession = database.prepare(
      "SELECT teacher_id FROM sessions WHERE session_id = ?",
    ).get(classroom.sessionId);
    const event = database.prepare(
      "SELECT payload_json FROM meta_events WHERE event_type = 'teacher_key_reissued'",
    ).get() as { payload_json: string };

    expect(response.status).toBe(200);
    expect(replacement.teacher_id).toBe(minted.teacher_id);
    expect(replacement.key).not.toBe(minted.key);
    expect(after.key_prefix).not.toBe(before.key_prefix);
    expect(after.key_hash).not.toEqual(before.key_hash);
    expect(oldRelogin.status).toBe(401);
    expect(oldSession.status).toBe(401);
    expect(replacementLogin.status).toBe(200);
    expect(retainedData.status).toBe(200);
    expect(retainedSession).toEqual({ teacher_id: minted.teacher_id });
    expect(event.payload_json).toContain(minted.teacher_id);
    expect(event.payload_json).not.toContain(minted.key);
    expect(event.payload_json).not.toContain(replacement.key);
    expect(logger.entries()).toContainEqual(expect.objectContaining({
      event: "teacher_access_rotated",
      actor: { kind: "meta", id: "meta-organizer" },
      detail: { teacher_id: minted.teacher_id },
    }));
    expect(JSON.stringify(logger.entries())).not.toContain(minted.key);
    expect(JSON.stringify(logger.entries())).not.toContain(replacement.key);
  });

  it("replays a reissue without rotating twice and without disclosing the key again", async () => {
    const url = await baseUrl();
    const metaCookie = cookieFrom(await login(url));
    const minted = (await (await mint(url, metaCookie)).json()) as {
      teacher_id: string;
      key: string;
    };
    const requestId = "reissue-replay-request";

    const first = await reissue(url, metaCookie, minted.teacher_id, requestId);
    const firstBody = (await first.json()) as { teacher_id: string; key: string };
    const firstHash = (database.prepare(
      "SELECT key_hash FROM teachers WHERE teacher_id = ?",
    ).get(minted.teacher_id) as { key_hash: Buffer }).key_hash;
    const replay = await reissue(url, metaCookie, minted.teacher_id, requestId);
    const replayBody = (await replay.json()) as { teacher_id: string; key: null; code: string };
    const replayHash = (database.prepare(
      "SELECT key_hash FROM teachers WHERE teacher_id = ?",
    ).get(minted.teacher_id) as { key_hash: Buffer }).key_hash;

    expect(first.status).toBe(200);
    expect(firstBody.key).toMatch(/^tch_/);
    expect(replay.status).toBe(200);
    expect(replayBody.teacher_id).toBe(firstBody.teacher_id);
    expect(replayBody.key).toBeNull();
    expect(replayBody.code).toBe("key_already_issued");
    expect(replayHash).toEqual(firstHash);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM meta_events WHERE event_type = 'teacher_key_reissued'",
    ).get()).toEqual({ count: 1 });
    const outcomes = database.prepare(
      "SELECT outcome_json FROM meta_command_outcomes",
    ).all() as Array<{ outcome_json: string }>;
    for (const row of outcomes) {
      expect(row.outcome_json).not.toContain("tch_");
    }
  });

  it("does not reissue revoked teachers", async () => {
    const url = await baseUrl();
    const metaCookie = cookieFrom(await login(url));
    const minted = (await (await mint(url, metaCookie)).json()) as {
      teacher_id: string;
      key: string;
    };
    const before = database.prepare(
      "SELECT key_hash FROM teachers WHERE teacher_id = ?",
    ).get(minted.teacher_id) as { key_hash: Buffer };
    const unconfirmed = await fetch(`${url}/api/meta/teachers/${minted.teacher_id}/reissue`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: metaCookie },
      body: JSON.stringify({ request_id: crypto.randomUUID() }),
    });
    const invalidRequestId = await fetch(
      `${url}/api/meta/teachers/${minted.teacher_id}/reissue`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie: metaCookie },
        body: JSON.stringify({ confirm: true }),
      },
    );
    const afterUnconfirmed = database.prepare(
      "SELECT key_hash FROM teachers WHERE teacher_id = ?",
    ).get(minted.teacher_id) as { key_hash: Buffer };
    await fetch(`${url}/api/meta/teachers/${minted.teacher_id}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: metaCookie },
      body: JSON.stringify({ request_id: crypto.randomUUID(), confirm: true }),
    });

    const response = await reissue(url, metaCookie, minted.teacher_id);

    expect(unconfirmed.status).toBe(400);
    expect(await unconfirmed.json()).toEqual({ error: "confirmation_required" });
    expect(invalidRequestId.status).toBe(400);
    expect(await invalidRequestId.json()).toEqual({ error: "invalid_request" });
    expect(afterUnconfirmed.key_hash).toEqual(before.key_hash);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "revoked" });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM meta_events WHERE event_type = 'teacher_key_reissued'",
    ).get()).toEqual({ count: 0 });
  });

  it("lists session counts and last use derived from successful teacher logins", async () => {
    const url = await baseUrl();
    const metaCookie = cookieFrom(await login(url));
    const minted = (await (await mint(url, metaCookie)).json()) as {
      teacher_id: string;
      key: string;
    };
    createClassroomSession(database, minted.teacher_id, TOKEN_SECRET);
    createClassroomSession(database, minted.teacher_id, TOKEN_SECRET);
    const before = await fetch(`${url}/api/meta/teachers`, { headers: { cookie: metaCookie } });
    const beforeTeacher = ((await before.json()) as {
      teachers: Array<{ last_used_at_ms: number | null; session_count: number }>;
    }).teachers[0];

    const teacherLogin = await fetch(`${url}/api/teacher/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: minted.key }),
    });
    const after = await fetch(`${url}/api/meta/teachers`, { headers: { cookie: metaCookie } });
    const afterTeacher = ((await after.json()) as {
      teachers: Array<{ last_used_at_ms: number | null; session_count: number }>;
    }).teachers[0];

    expect(beforeTeacher).toEqual(expect.objectContaining({
      last_used_at_ms: null,
      session_count: 2,
    }));
    expect(teacherLogin.status).toBe(200);
    expect(afterTeacher?.last_used_at_ms).toEqual(expect.any(Number));
    expect(afterTeacher?.session_count).toBe(2);
    expect(database.prepare(
      "SELECT event_type, actor_id FROM auth_events WHERE event_type = 'teacher_login_succeeded'",
    ).get()).toEqual({
      event_type: "teacher_login_succeeded",
      actor_id: minted.teacher_id,
    });
    expect(database.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'index' AND name = 'idx_auth_events_teacher_login'`,
    ).get()).toEqual({ name: "idx_auth_events_teacher_login" });
  });

  it("audits malformed and unauthorized reissue attempts without key material", async () => {
    const url = await baseUrl();
    const metaCookie = cookieFrom(await login(url));
    const minted = (await (await mint(url, metaCookie)).json()) as {
      teacher_id: string;
      key: string;
    };
    const unauthorized = await reissue(url, "", minted.teacher_id);
    const malformed = await fetch(`${url}/api/meta/teachers/${minted.teacher_id}/reissue`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: metaCookie },
      body: "not-json",
    });
    const malformedId = await reissue(url, metaCookie, "not-a-uuid");
    const attempts = database.prepare(
      `SELECT payload_json FROM auth_events
       WHERE event_type = 'meta_admin_attempt' AND payload_json LIKE '%"reissue"%'
       ORDER BY event_id`,
    ).all() as Array<{ payload_json: string }>;

    expect(unauthorized.status).toBe(404);
    expect(malformed.status).toBe(400);
    expect(malformedId.status).toBe(404);
    expect(attempts.map((entry) => JSON.parse(entry.payload_json))).toEqual([
      expect.objectContaining({ action: "reissue", outcome: "unauthorized" }),
      expect.objectContaining({ action: "reissue", outcome: "malformed_json" }),
      expect.objectContaining({ action: "reissue", outcome: "malformed_teacher_id" }),
    ]);
    expect(JSON.stringify(attempts)).not.toContain(minted.key);
  });

  it("rejects unauthorized and cross-site meta mutations as not found", async () => {
    const url = await baseUrl();
    const unauthorized = await fetch(`${url}/api/meta/teachers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "No access", request_id: crypto.randomUUID() }),
    });
    const cookie = cookieFrom(await login(url));
    const crossSite = await fetch(`${url}/api/meta/teachers`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({ label: "Cross site", request_id: crypto.randomUUID() }),
    });

    expect(unauthorized.status).toBe(404);
    expect(await unauthorized.json()).toEqual({ error: "not_found" });
    expect(crossSite.status).toBe(404);
    expect(await crossSite.json()).toEqual({ error: "not_found" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM teachers").get()).toEqual({ count: 0 });
  });

  it("records mint and revoke exceptions before returning generic errors", async () => {
    const url = await baseUrl();
    const cookie = cookieFrom(await login(url));
    vi.spyOn(MetaAdminService.prototype, "mintTeacher").mockImplementationOnce(() => {
      throw new Error("mint failed");
    });
    const mintResponse = await mint(url, cookie);
    vi.spyOn(MetaAdminService.prototype, "revokeTeacher").mockImplementationOnce(() => {
      throw new Error("revoke failed");
    });
    const revokeResponse = await fetch(
      `${url}/api/meta/teachers/${crypto.randomUUID()}/revoke`,
      {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ request_id: crypto.randomUUID(), confirm: true }),
      },
    );
    const attempts = database.prepare(
      "SELECT payload_json FROM auth_events WHERE event_type = 'meta_admin_attempt' ORDER BY event_id",
    ).all() as Array<{ payload_json: string }>;

    expect(mintResponse.status).toBe(500);
    expect(await mintResponse.json()).toEqual({ error: "internal_error" });
    expect(revokeResponse.status).toBe(500);
    expect(await revokeResponse.json()).toEqual({ error: "internal_error" });
    expect(attempts.map((entry) => JSON.parse(entry.payload_json))).toEqual([
      expect.objectContaining({ action: "mint", outcome: "internal_error" }),
      expect.objectContaining({ action: "revoke", outcome: "internal_error" }),
    ]);
  });

  it("counts and records a malformed revoke teacher id", async () => {
    const url = await baseUrl();
    const cookie = cookieFrom(await login(url));
    const response = await fetch(`${url}/api/meta/teachers/not-a-uuid/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ request_id: crypto.randomUUID(), confirm: true }),
    });
    const attempt = database.prepare(
      "SELECT payload_json FROM auth_events WHERE event_type = 'meta_admin_attempt'",
    ).get() as { payload_json: string };

    expect(response.status).toBe(404);
    expect(JSON.parse(attempt.payload_json)).toEqual({
      surface: "meta",
      action: "revoke",
      outcome: "malformed_teacher_id",
    });
  });
});
