import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { AppDatabase } from "./db.js";
import { type BotRunStatus, type DevBotRunRegistry } from "./dev-bot-runs.js";
import { GameEventStore, type StoredGameEvent } from "./game-event-store.js";
import { type ServerLogger, type StoredServerLogEntry } from "./log.js";
import type { QuestionRound } from "./question-round.js";
import { teacherSessionCode } from "./sessions.js";
import type { PresenceRegistry } from "./presence.js";

export type DevViewsOptions = Readonly<{
  database: AppDatabase;
  rounds: ReadonlyMap<string, QuestionRound>;
  enabled: boolean;
  devToken?: string;
  tokenSecret: string;
  botRuns?: DevBotRunRegistry;
  loginLimiter: DevLoginRateLimiter;
  logger: ServerLogger;
  teacherIdFromRequest: (request: IncomingMessage) => string | undefined;
  presence?: PresenceRegistry;
}>;

type Authorization =
  | Readonly<{ ok: true; scope: "dev" | "teacher" }>
  | Readonly<{ ok: false; status: 401 | 403 }>;

const DEV_COOKIE_NAME = "dev_session";
const DEV_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
const DEV_LOGIN_LIMIT = 10;
const DEV_LOGIN_WINDOW_MS = 60_000;

export class DevLoginRateLimiter {
  #bucket = -1;
  #count = 0;

  consume(now = Date.now()): boolean {
    const bucket = Math.floor(now / DEV_LOGIN_WINDOW_MS);
    if (bucket !== this.#bucket) {
      this.#bucket = bucket;
      this.#count = 0;
    }
    this.#count += 1;
    return this.#count <= DEV_LOGIN_LIMIT;
  }
}

function cookieValue(request: IncomingMessage, name: string): string | undefined {
  const prefix = `${name}=`;
  return request.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
}

function devSessionSignature(unsigned: string, tokenSecret: string, devToken: string): string {
  const tokenDigest = createHash("sha256").update(devToken).digest("base64url");
  return createHmac("sha256", tokenSecret)
    .update(`dev-session.${tokenDigest}.${unsigned}`)
    .digest("base64url");
}

function createDevSession(tokenSecret: string, devToken: string, now = Date.now()): string {
  const expiresAtMs = now + DEV_SESSION_MAX_AGE_SECONDS * 1_000;
  const unsigned = `d1.${expiresAtMs}.${randomBytes(16).toString("base64url")}`;
  return `${unsigned}.${devSessionSignature(unsigned, tokenSecret, devToken)}`;
}

function verifyDevSession(token: string, tokenSecret: string, devToken: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "d1") return false;
  const [version, expiresText, nonce, suppliedText] = parts;
  if (version === undefined || expiresText === undefined || nonce === undefined || suppliedText === undefined) return false;
  const expiresAtMs = Number(expiresText);
  const unsigned = `${version}.${expiresText}.${nonce}`;
  const expected = Buffer.from(devSessionSignature(unsigned, tokenSecret, devToken));
  const supplied = Buffer.from(suppliedText);
  return Number.isSafeInteger(expiresAtMs) && expiresAtMs > Date.now() &&
    expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

function suppliedTokenMatches(supplied: string, expected: string): boolean {
  const suppliedHash = createHash("sha256").update(supplied).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(suppliedHash, expectedHash);
}

function cookieAuthorized(request: IncomingMessage, options: DevViewsOptions): boolean {
  const token = cookieValue(request, DEV_COOKIE_NAME);
  return token !== undefined && options.devToken !== undefined &&
    verifyDevSession(token, options.tokenSecret, options.devToken);
}

function suppliedDevToken(request: IncomingMessage, url: URL, allowQuery: boolean): string | undefined {
  const header = request.headers["x-dev-token"];
  if (typeof header === "string") {
    return header;
  }
  const authorization = request.headers.authorization;
  const bearer = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
  return bearer ?? (allowQuery ? url.searchParams.get("dev_token") ?? undefined : undefined);
}

function authorize(
  request: IncomingMessage,
  sessionId: string,
  options: DevViewsOptions,
  url: URL,
  allowQuery: boolean,
): Authorization {
  const token = suppliedDevToken(request, url, allowQuery);
  if (
    cookieAuthorized(request, options) ||
    (options.devToken !== undefined && token !== undefined && suppliedTokenMatches(token, options.devToken))
  ) {
    return Object.freeze({ ok: true, scope: "dev" });
  }
  const teacherId = options.teacherIdFromRequest(request);
  if (teacherId === undefined) {
    return Object.freeze({ ok: false, status: token === undefined ? 401 : 403 });
  }
  const owned = options.database
    .prepare("SELECT 1 FROM sessions WHERE session_id = ? AND teacher_id = ?")
    .get(sessionId, teacherId);
  return owned === undefined
    ? Object.freeze({ ok: false, status: 403 })
    : Object.freeze({ ok: true, scope: "teacher" });
}

function devAuthorized(request: IncomingMessage, options: DevViewsOptions): boolean {
  const token = suppliedDevToken(request, new URL(request.url ?? "/", "http://localhost"), false);
  return cookieAuthorized(request, options) ||
    (options.devToken !== undefined && token !== undefined && suppliedTokenMatches(token, options.devToken));
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function sendError(response: ServerResponse, status: number): void {
  sendJson(response, status, { error: status === 401 ? "unauthorized" : "forbidden" });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > 16 * 1_024) throw new Error("body_too_large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function requestId(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length < 1 || value.length > 100) return undefined;
  return value;
}

function signInPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Developer console</title>
<link rel="stylesheet" href="/static/styles.css"></head>
<body class="dev-surface"><main class="dev-console"><p class="eyebrow">Developer console</p><h1>Demo control room</h1>
<section class="card" aria-labelledby="dev-sign-in-title"><h2 id="dev-sign-in-title">Enter dev token</h2>
<form id="dev-login-form"><label for="dev-token">Dev token<input id="dev-token" type="password" autocomplete="off" required></label>
<button type="submit">Continue</button></form><p id="dev-login-status" role="status" aria-live="polite"></p></section></main>
<script type="module" src="/static/dev.js"></script></body></html>`;
}

type DevSession = Readonly<{
  session_id: string;
  teacher_id: string;
  status: string;
  created_at_ms: number;
  player_count: number;
}>;

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function landingPage(options: DevViewsOptions): string {
  const sessions = options.database.prepare(
    `SELECT s.session_id, s.teacher_id, s.status, s.created_at_ms,
            COUNT(p.player_id) AS player_count
     FROM sessions s LEFT JOIN session_players p
       ON p.session_id = s.session_id AND p.kicked_at_ms IS NULL
     GROUP BY s.session_id ORDER BY s.created_at_ms DESC, s.session_id DESC`,
  ).all() as DevSession[];
  const listed = sessions.map((session) => {
    let code: string | null = null;
    try {
      code = teacherSessionCode(options.database, session.teacher_id, session.session_id, options.tokenSecret);
    } catch (error) {
      options.logger.warn("session_display_code_decrypt_failed", {
        sessionId: session.session_id,
        actor: { kind: "dev" },
        detail: { cause: error instanceof Error ? error.name : "unknown" },
      });
    }
    return Object.freeze({ ...session, code });
  });
  const rows = listed.map((session) => {
    const id = escapeHtml(session.session_id);
    return `<tr><td>${escapeHtml(session.code ?? "Unavailable")}</td><td><code>${id}</code></td><td>${escapeHtml(session.status)}</td><td>${session.player_count}</td><td>${new Date(session.created_at_ms).toISOString()}</td><td><a href="/dev/graph?session=${id}">Graph</a> <a href="/dev/logs?session=${id}">Logs</a> <a href="/dev/state?session=${id}">State</a></td></tr>`;
  }).join("");
  const choices = listed.map((session) =>
    `<option value="${escapeHtml(session.session_id)}"${session.status === "ended" ? " disabled" : ""}>${escapeHtml(session.code ?? "No code")} - ${escapeHtml(session.status)} - ${session.player_count} players</option>`,
  ).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Developer console</title><link rel="stylesheet" href="/static/styles.css"></head>
<body class="dev-surface"><main class="dev-console"><p class="eyebrow">Developer console</p><h1>Demo control room</h1>
<section class="live-card dev-bots" aria-labelledby="bots-title"><div class="live-heading"><div><p class="eyebrow">Live load</p><h2 id="bots-title">Bots</h2></div><span class="dev-cap">2 runs max</span></div>
<form id="bot-form"><label for="bot-session">Session<select id="bot-session" required>${choices}</select></label>
<div class="dev-bot-fields"><label for="bot-count">Count<input id="bot-count" type="number" min="1" max="100" value="10" required></label>
<label for="bot-accuracy">Accuracy<input id="bot-accuracy" type="number" min="0" max="1" step="0.05" value="0.7" required></label>
<label for="bot-policy">Policy<select id="bot-policy"><option value="random">Random</option><option value="llm">LLM</option></select><small class="dev-policy-help">Random = hits the target accuracy via the answer oracle, no LLM cost. LLM = real model via the gateway, uses org credits.</small></label></div>
<button id="bot-start" type="submit">Start bots</button></form><p id="bot-status" role="status" aria-live="polite">Ready.</p><div id="bot-runs" class="dev-runs"></div></section>
<section class="card" aria-labelledby="sessions-title"><div class="section-heading"><h2 id="sessions-title">Sessions</h2><button id="refresh-sessions" class="quiet-button" type="button">Refresh</button></div>
<div class="table-scroll"><table><thead><tr><th>Code</th><th>Session ID</th><th>Status</th><th>Players</th><th>Created</th><th>Views</th></tr></thead><tbody>${rows}</tbody></table></div></section>
</main><script type="module" src="/static/dev.js"></script></body></html>`;
}

function sendHtml(response: ServerResponse, body: string): void {
  response.writeHead(200, { "cache-control": "no-store", "content-type": "text/html; charset=utf-8" });
  response.end(body);
}

async function handleDevLogin(request: IncomingMessage, response: ServerResponse, options: DevViewsOptions): Promise<void> {
  const allowed = options.loginLimiter.consume();
  let body: unknown;
  try {
    body = await readJsonBody(request);
  } catch {
    body = null;
  }
  const supplied = typeof body === "object" && body !== null && "token" in body && typeof body.token === "string"
    ? body.token.trim()
    : "";
  const authenticated = allowed && options.devToken !== undefined && suppliedTokenMatches(supplied, options.devToken);
  if (!authenticated) {
    options.logger.warn(allowed ? "dev_login_failed" : "dev_login_rate_limited", {
      actor: { kind: "dev" },
      detail: { surface: "dev_login", ...(allowed ? { reason: "invalid_credentials" } : { scope: "global" }) },
    });
    sendJson(response, 404, { error: "not_found" });
    return;
  }
  const secure = request.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  response.setHeader("set-cookie", `${DEV_COOKIE_NAME}=${createDevSession(options.tokenSecret, options.devToken)}; Path=/; HttpOnly${secure}; SameSite=Strict; Max-Age=${DEV_SESSION_MAX_AGE_SECONDS}`);
  options.logger.info("dev_login_succeeded", { actor: { kind: "dev" }, detail: { surface: "dev_login" } });
  sendJson(response, 200, { ok: true });
}

function statusBody(runs: readonly BotRunStatus[]): Readonly<{ runs: readonly BotRunStatus[] }> {
  return Object.freeze({ runs });
}

function eventPayloadKeyParts(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 0);
}

function isSensitiveEventPayloadKey(key: string): boolean {
  const parts = eventPayloadKeyParts(key);
  if (parts.some((part) => part.startsWith("correct") || part.startsWith("incorrect"))) return true;
  const hasAnswer = parts.some((part) => part.startsWith("answer") || part.startsWith("unanswer"));
  const hasChoice = parts.some((part) => part === "choice" || part === "choices");
  const isCount = parts.some((part) => part === "count" || part === "counts");
  if (isCount && (hasAnswer || hasChoice)) return false;
  if (hasAnswer) return true;
  return hasChoice && !(parts.length === 1 && parts[0] === "choices");
}

function redactPreRevealPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactPreRevealPayload);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !isSensitiveEventPayloadKey(key))
      .map(([key, entry]) => [key, redactPreRevealPayload(entry)]),
  );
}

function serializeEvent(event: StoredGameEvent): string {
  const payload = event.eventType === "reveal"
    ? event.payload
    : redactPreRevealPayload(event.payload);
  return JSON.stringify({
    source: "events",
    server_seq: event.serverSeq,
    event_type: event.eventType,
    actor_kind: event.actorKind,
    actor_id: event.actorId,
    attempt_id: event.attemptId,
    payload,
    created_at_ms: event.createdAtMs,
  });
}

function serializeServerLog(entry: StoredServerLogEntry): string {
  return JSON.stringify({
    source: "server",
    ts: entry.ts,
    level: entry.level,
    event: entry.event,
    ...(entry.session_id === undefined ? {} : { session_id: entry.session_id }),
    ...(entry.actor === undefined ? {} : { actor: entry.actor }),
    detail: entry.detail,
  });
}

export function createBoundedSseWriter(
  response: Readonly<{
    write: (frame: string) => boolean;
    once: (event: "drain", listener: () => void) => unknown;
    removeListener: (event: "drain", listener: () => void) => unknown;
    destroyed?: boolean;
    writableEnded?: boolean;
  }>,
  capacity = 256,
): Readonly<{ send: (frame: string) => void; close: () => void }> {
  const queue: string[] = [];
  let blocked = false;
  let closed = false;
  let droppedCount = 0;

  const writable = (): boolean => !closed && response.destroyed !== true && response.writableEnded !== true;
  const write = (frame: string): void => {
    if (writable()) blocked = !response.write(frame);
  };
  const flush = (): void => {
    blocked = false;
    if (!writable()) return;
    if (droppedCount > 0) {
      const count = droppedCount;
      droppedCount = 0;
      write(`event: stream_dropped\ndata: ${JSON.stringify({ source: "stream", dropped_count: count })}\n\n`);
    }
    while (queue.length > 0 && !blocked) {
      const frame = queue.shift();
      if (frame !== undefined) write(frame);
    }
    if (blocked) response.once("drain", flush);
  };
  const send = (frame: string): void => {
    if (!writable()) return;
    if (!blocked && queue.length === 0) {
      write(frame);
      if (blocked) response.once("drain", flush);
      return;
    }
    queue.push(frame);
    if (queue.length > capacity) {
      queue.shift();
      droppedCount += 1;
    }
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    queue.length = 0;
    response.removeListener("drain", flush);
  };
  return Object.freeze({ send, close });
}

type EventRow = {
  event_id: number;
  session_id: string;
  game_id: string | null;
  server_seq: number;
  attempt_id: string | null;
  event_type: string;
  actor_kind: "system" | "teacher" | "player";
  actor_id: string | null;
  request_id: string | null;
  payload_json: string;
  created_at_ms: number;
};

const INITIAL_REPLAY_LIMIT = 256;

function storedEvent(row: EventRow): StoredGameEvent {
  return Object.freeze({
    eventId: row.event_id,
    sessionId: row.session_id,
    gameId: row.game_id,
    serverSeq: row.server_seq,
    attemptId: row.attempt_id,
    eventType: row.event_type,
    actorKind: row.actor_kind,
    actorId: row.actor_id,
    requestId: row.request_id,
    payload: JSON.parse(row.payload_json) as unknown,
    createdAtMs: row.created_at_ms,
  });
}

function readEventRows(
  database: AppDatabase,
  sessionId: string,
  after: number,
  limit?: number,
): EventRow[] {
  return database.prepare(
    `SELECT * FROM game_events
     WHERE session_id = ? AND server_seq > ?
     ORDER BY server_seq${limit === undefined ? "" : " LIMIT ?"}`,
  ).all(sessionId, after, ...(limit === undefined ? [] : [limit])) as EventRow[];
}

function readRecentEventRows(
  database: AppDatabase,
  sessionId: string,
  after: number,
  limit: number,
): EventRow[] {
  return database.prepare(
    `SELECT * FROM (
       SELECT * FROM game_events
       WHERE session_id = ? AND server_seq > ?
       ORDER BY server_seq DESC LIMIT ?
     ) ORDER BY server_seq`,
  ).all(sessionId, after, limit) as EventRow[];
}

function streamEvents(
  request: IncomingMessage,
  response: ServerResponse,
  sessionId: string,
  database: AppDatabase,
  logger: ServerLogger,
  scope: "dev" | "teacher",
): void {
  response.writeHead(200, {
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
  });
  const writer = createBoundedSseWriter(response);
  writer.send(": connected\n\n");
  const parsedAfter = Number(new URL(request.url ?? "/", "http://localhost").searchParams.get("after") ?? 0);
  let lastSequence = Number.isSafeInteger(parsedAfter) && parsedAfter >= 0 ? parsedAfter : 0;
  let lastLogSequence = 0;
  const relevantLog = (entry: StoredServerLogEntry): boolean =>
    entry.session_id === sessionId || (scope === "dev" && entry.session_id === undefined);
  const sendServerLog = (entry: StoredServerLogEntry): void => {
    if (!relevantLog(entry) || entry.sequence <= lastLogSequence) return;
    sendNewEvents();
    lastLogSequence = entry.sequence;
    writer.send(`id: server-${entry.sequence}\nevent: server_log\ndata: ${serializeServerLog(entry)}\n\n`);
  };
  const historicalLogs = logger.entries().filter(relevantLog);
  lastLogSequence = historicalLogs.at(-1)?.sequence ?? 0;
  const historicalRows = readRecentEventRows(database, sessionId, lastSequence, INITIAL_REPLAY_LIMIT);
  const initialLastSequence = historicalRows.at(-1)?.server_seq ?? lastSequence;
  const initialLastLogSequence = historicalLogs.at(-1)?.sequence ?? 0;
  const replay = [
    ...historicalLogs.map((entry) => ({
      timestamp: Date.parse(entry.ts),
      source: 1,
      sequence: entry.sequence,
      entry,
    })),
    ...historicalRows.map((row) => ({
      timestamp: row.created_at_ms,
      source: 0,
      sequence: row.server_seq,
      row,
    })),
  ].sort((left, right) =>
    left.timestamp - right.timestamp || left.source - right.source || left.sequence - right.sequence,
  );
  if (historicalRows.length === INITIAL_REPLAY_LIMIT && historicalRows[0]?.server_seq !== lastSequence + 1) {
    writer.send(`event: history_truncated\ndata: ${JSON.stringify({ source: "stream", retained_events: INITIAL_REPLAY_LIMIT })}\n\n`);
  }
  for (const item of replay) {
    if ("entry" in item) {
      writer.send(`id: server-${item.entry.sequence}\nevent: server_log\ndata: ${serializeServerLog(item.entry)}\n\n`);
    } else {
      writer.send(`id: ${item.row.server_seq}\nevent: game_event\ndata: ${serializeEvent(storedEvent(item.row))}\n\n`);
    }
  }
  lastSequence = initialLastSequence;
  function sendNewEvents(): void {
    const rows = readEventRows(database, sessionId, lastSequence, 100);
    for (const row of rows) {
      lastSequence = row.server_seq;
      writer.send(`id: ${row.server_seq}\nevent: game_event\ndata: ${serializeEvent(storedEvent(row))}\n\n`);
    }
  }
  const unsubscribe = logger.subscribe((entry) => {
    if (entry.sequence > initialLastLogSequence) sendServerLog(entry);
  });
  sendNewEvents();
  const interval = setInterval(sendNewEvents, 100);
  interval.unref();
  request.once("close", () => {
    clearInterval(interval);
    unsubscribe();
    writer.close();
  });
}

function logsPage(sessionId: string, devToken?: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Session event log</title><link rel="stylesheet" href="/static/styles.css"></head>
<body class="dev-surface dev-log-surface" data-session="${escapeHtml(sessionId)}" data-dev-token="${escapeHtml(devToken ?? "")}"><main class="dev-log-console">
<header class="dev-log-header"><div><p class="eyebrow"><a href="/dev">&#9664; Control room</a> &middot; Developer view</p><h1>Session event log</h1><p id="log-status">Connecting to live events...</p></div></header>
<div class="dev-log-filters"><label for="log-search">Filter<input id="log-search" type="search" placeholder="event or detail"></label>
<fieldset><legend>Levels</legend><label><input type="checkbox" data-log-level="info" checked> Info</label><label><input type="checkbox" data-log-level="warn" checked> Warn</label><label><input type="checkbox" data-log-level="error" checked> Error</label><label><input type="checkbox" data-log-level="events" checked> Events</label></fieldset></div>
<ol id="event-log" class="dev-log-list"></ol><button id="jump-live" class="dev-jump-live" type="button" hidden>Jump to live</button></main>
<script type="module" src="/static/dev-logs.js"></script></body></html>`;
}

function statePage(sessionId: string, devToken?: string): string {
  const id = escapeHtml(sessionId);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Session state</title><link rel="stylesheet" href="/static/styles.css"></head>
<body class="dev-surface dev-state-surface" data-session="${id}" data-dev-token="${escapeHtml(devToken ?? "")}">
<main class="dev-state-console"><header class="dev-graph-header"><div><p class="eyebrow"><a href="/dev">&#9664; Control room</a> &middot; Developer view</p><h1>Session state</h1>
<p class="dev-state-links"><a href="/dev/graph?session=${id}">Graph</a> <a href="/dev/logs?session=${id}">Logs</a> <a href="/api/dev/session/${id}/state">Raw JSON</a></p></div>
<span id="state-status" class="dev-live-status is-stale">STALE</span></header>
<div class="dev-state-cards">
<section class="dev-state-card" aria-labelledby="state-session-title"><h2 id="state-session-title">Session</h2><dl id="state-session"></dl></section>
<section class="dev-state-card" aria-labelledby="state-round-title"><h2 id="state-round-title">Round</h2><dl id="state-round"></dl></section>
</div>
<section class="dev-state-card" aria-labelledby="state-players-title"><h2 id="state-players-title">Players</h2><p id="state-player-summary" class="dev-graph-summary">Loading…</p>
<div class="table-scroll"><table><thead><tr><th>Player</th><th>Role</th><th>Points</th><th>Streak</th><th>Sockets</th></tr></thead><tbody id="state-player-rows"></tbody></table></div></section>
<section class="dev-state-card" aria-labelledby="state-events-title"><h2 id="state-events-title">Events</h2><p id="state-event-summary" class="dev-graph-summary">Loading…</p>
<ol id="state-event-rows" class="dev-log-list"></ol></section>
</main><script type="module" src="/static/dev-state.js"></script></body></html>`;
}

function graphPage(sessionId: string, devToken?: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>Live session graph</title><link rel="stylesheet" href="/static/styles.css"></head>
<body class="dev-surface dev-graph-surface" data-session="${escapeHtml(sessionId)}" data-dev-token="${escapeHtml(devToken ?? "")}">
<main class="dev-graph-console"><header class="dev-graph-header"><div><p class="eyebrow"><a href="/dev">&#9664; Control room</a> &middot; Developer view</p><h1>Live session graph</h1><p id="graph-summary" class="dev-graph-summary">Loading session state...</p></div><span id="graph-status" class="dev-live-status is-stale">STALE</span></header>
<div id="dev-graph" class="dev-role-columns" aria-live="polite"></div></main>
<script type="module" src="/static/dev-graph.js"></script></body></html>`;
}

export async function handleDevViewRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  options: DevViewsOptions,
): Promise<boolean> {
  const isLanding = request.method === "GET" && url.pathname === "/dev";
  const isLogin = request.method === "POST" && url.pathname === "/api/dev/login";
  const isBotStart = request.method === "POST" && url.pathname === "/api/dev/bots/start";
  const isBotStop = request.method === "POST" && url.pathname === "/api/dev/bots/stop";
  const isBotStatus = request.method === "GET" && url.pathname === "/api/dev/bots/status";
  const isLogs = request.method === "GET" && url.pathname === "/dev/logs";
  const isGraph = request.method === "GET" && url.pathname === "/dev/graph";
  const isState = request.method === "GET" && url.pathname === "/dev/state";
  const match = /^\/api\/dev\/session\/([0-9a-f-]{36})\/(state|oracle)$/.exec(url.pathname);
  if (!isLanding && !isLogin && !isBotStart && !isBotStop && !isBotStatus && !isLogs && !isGraph && !isState && match === null) {
    return false;
  }
  if (!options.enabled) {
    sendJson(response, 404, { error: "not_found" });
    return true;
  }
  if (isLogin) {
    if (
      request.headers["sec-fetch-site"] === "cross-site" ||
      !/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")
    ) {
      options.loginLimiter.consume();
      options.logger.warn("dev_login_failed", {
        actor: { kind: "dev" },
        detail: { surface: "dev_login", reason: "request_rejected" },
      });
      sendJson(response, 404, { error: "not_found" });
      return true;
    }
    await handleDevLogin(request, response, options);
    return true;
  }
  if (isLanding) {
    sendHtml(response, devAuthorized(request, options) ? landingPage(options) : signInPage());
    return true;
  }
  if (isBotStart || isBotStop || isBotStatus) {
    if (!devAuthorized(request, options)) {
      const supplied = suppliedDevToken(request, url, false);
      const deniedStatus = supplied === undefined ? 401 : 403;
      options.logger.warn("dev_view_access_denied", {
        actor: { kind: "dev" },
        detail: { path: url.pathname, status: deniedStatus },
      });
      sendError(response, deniedStatus);
      return true;
    }
    if (options.botRuns === undefined) {
      sendJson(response, 503, { error: "runner_unavailable", message: "Bot runs require a configured dev token." });
      return true;
    }
    if (isBotStatus) {
      sendJson(response, 200, statusBody(options.botRuns.statuses()));
      return true;
    }
    if (
      request.headers["sec-fetch-site"] === "cross-site" ||
      !/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")
    ) {
      sendJson(response, 400, { error: "invalid_request", message: "Send a JSON request." });
      return true;
    }
    let body: unknown;
    try {
      body = await readJsonBody(request);
    } catch {
      sendJson(response, 400, { error: "invalid_request", message: "The request was not valid JSON." });
      return true;
    }
    const value = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
    if (isBotStop) {
      const runId = typeof value.run_id === "string" ? value.run_id : "";
      if (!/^[0-9a-f-]{36}$/.test(runId)) {
        sendJson(response, 400, { error: "invalid_request", message: "Choose a valid bot run." });
        return true;
      }
      const result = options.botRuns.stop(runId);
      sendJson(response, result.ok ? 200 : result.status, result.ok ? { run: result.run } : { error: result.error, message: result.message });
      return true;
    }
    const sessionId = typeof value.session_id === "string" ? value.session_id : "";
    const count = value.count;
    const accuracy = value.accuracy;
    const policy = value.policy;
    const id = requestId(value.request_id);
    if (
      !/^[0-9a-f-]{36}$/.test(sessionId) ||
      !Number.isInteger(count) || typeof count !== "number" || count < 1 || count > 100 ||
      typeof accuracy !== "number" || !Number.isFinite(accuracy) || accuracy < 0 || accuracy > 1 ||
      (policy !== "random" && policy !== "llm") || id === undefined
    ) {
      options.logger.warn("dev_bot_run_rejected", {
        ...(sessionId.length === 0 ? {} : { sessionId }),
        actor: { kind: "dev" },
        detail: { reason: "invalid_request" },
      });
      sendJson(response, 400, { error: "invalid_request", message: "Check the session, count, accuracy, and policy." });
      return true;
    }
    const port = request.socket.localPort;
    if (port === undefined) {
      sendJson(response, 503, { error: "runner_unavailable", message: "The server port is unavailable." });
      return true;
    }
    const result = options.botRuns.start({ sessionId, count, accuracy, policy, requestId: id, port });
    sendJson(
      response,
      result.ok ? (result.created ? 201 : 200) : result.status,
      result.ok ? { run: result.run } : { error: result.error, message: result.message },
    );
    return true;
  }
  const sessionId = isLogs || isGraph || isState ? url.searchParams.get("session") : match?.[1];
  if (sessionId === null || sessionId === undefined || !/^[0-9a-f-]{36}$/.test(sessionId)) {
    sendJson(response, 400, { error: "invalid_session" });
    return true;
  }
  const authorization = authorize(request, sessionId, options, url, isLogs || isGraph || isState);
  if (!authorization.ok) {
    options.logger.warn("dev_view_access_denied", {
      sessionId,
      actor: { kind: "dev" },
      detail: { path: url.pathname, status: authorization.status },
    });
    sendError(response, authorization.status);
    return true;
  }
  const session = options.database
    .prepare("SELECT session_id, status, started_at_ms, ended_at_ms FROM sessions WHERE session_id = ?")
    .get(sessionId) as
    | { session_id: string; status: string; started_at_ms: number | null; ended_at_ms: number | null }
    | undefined;
  if (session === undefined) {
    sendJson(response, 404, { error: "not_found" });
    return true;
  }
  if (isLogs) {
    if (url.searchParams.get("stream") === "1" || request.headers.accept?.includes("text/event-stream")) {
      streamEvents(request, response, sessionId, options.database, options.logger, authorization.scope);
    } else {
      const suppliedToken = suppliedDevToken(request, url, true);
      const pageToken = suppliedToken !== undefined && options.devToken !== undefined &&
        suppliedTokenMatches(suppliedToken, options.devToken)
        ? suppliedToken
        : undefined;
      response.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      });
      response.end(logsPage(sessionId, pageToken));
    }
    return true;
  }
  if (isGraph) {
    const suppliedToken = suppliedDevToken(request, url, true);
    const pageToken = suppliedToken !== undefined && options.devToken !== undefined &&
      suppliedTokenMatches(suppliedToken, options.devToken)
      ? suppliedToken
      : undefined;
    sendHtml(response, graphPage(sessionId, pageToken));
    return true;
  }
  if (isState) {
    const suppliedToken = suppliedDevToken(request, url, true);
    const pageToken = suppliedToken !== undefined && options.devToken !== undefined &&
      suppliedTokenMatches(suppliedToken, options.devToken)
      ? suppliedToken
      : undefined;
    sendHtml(response, statePage(sessionId, pageToken));
    return true;
  }
  const round = options.rounds.get(sessionId);
  if (match?.[2] === "oracle") {
    const active = round?.snapshot().active;
    if (active === null || active === undefined) {
      sendJson(response, 404, { error: "no_active_question" });
    } else {
      sendJson(response, 200, {
        question_id: active.question.id,
        correct_choice: active.question.correctChoice,
      });
    }
    return true;
  }
  const storedPlayers = options.database
    .prepare(
      `SELECT player_id, nickname, role, points, streak, kicked_at_ms
       FROM session_players WHERE session_id = ? ORDER BY joined_at_ms, player_id`,
    )
    .all(sessionId) as Array<Record<string, unknown> & { player_id: string }>;
  const presenceLookup = options.presence?.lookup;
  const players = storedPlayers.map((player) => {
    const socketCount = presenceLookup?.(player.player_id) ?? 0;
    return Object.freeze({ ...player, connected: socketCount > 0, socket_count: socketCount });
  });
  sendJson(response, 200, {
    session,
    round: round?.snapshot() ?? null,
    players,
    events: new GameEventStore(options.database).readSession(sessionId),
    server_time_ms: Date.now(),
    presence_available: presenceLookup !== undefined,
  });
  return true;
}
