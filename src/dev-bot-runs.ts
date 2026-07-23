import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { AppDatabase } from "./db.js";
import type { ServerLogger } from "./log.js";
import { teacherSessionCode } from "./sessions.js";

export type BotRunStatus = Readonly<{
  run_id: string;
  session_id: string;
  count: number;
  accuracy: number;
  policy: "random" | "llm";
  state: "running" | "stopping" | "stopped" | "exited" | "failed";
  joined: number;
  answered: number;
  correct: number;
  errors: number;
  reconnects: number;
  started_at_ms: number;
  ended_at_ms: number | null;
  exit_code: number | null;
  message: string | null;
}>;

export type DevBotRunCloseResult = Readonly<{
  completed: Promise<void>;
}>;

export type BotCommand = readonly [string, ...string[]];

type MutableBotRun = {
  runId: string;
  sessionId: string;
  count: number;
  accuracy: number;
  policy: "random" | "llm";
  state: BotRunStatus["state"];
  joined: number;
  answered: number;
  correct: number;
  errors: number;
  reconnects: number;
  startedAtMs: number;
  endedAtMs: number | null;
  exitCode: number | null;
  message: string | null;
  child: ChildProcessWithoutNullStreams;
  stopTimer: NodeJS.Timeout | null;
  loggedSummaryLines: number;
  loggedSummaryBytes: number;
  suppressionLogged: boolean;
  // Bounded stderr tail kept ONLY for the dev-authed status endpoint (never the
  // teacher-readable session log) so startup failures are diagnosable.
  stderrTail: string;
  completionSequence: number | null;
};

const ACTIVE_STATES = new Set<BotRunStatus["state"]>(["running", "stopping"]);
const MAX_PENDING_LINE_BYTES = 16 * 1_024;
const MAX_OUTPUT_LINES = 200;
const MAX_OUTPUT_BYTES = 64 * 1_024;
export const DEV_BOT_MAX_COMPLETED_RUNS = 20;
export const DEV_BOT_REQUEST_RETENTION_MS = 10 * 60 * 1_000;
const STOP_TIMEOUT_MS = 3_000;

function defaultBotCommand(): BotCommand {
  const compiled = fileURLToPath(new URL("../tools/bots.js", import.meta.url));
  if (existsSync(compiled)) return [process.execPath, compiled];
  return [
    process.execPath,
    "--import",
    "tsx",
    fileURLToPath(new URL("../tools/bots.ts", import.meta.url)),
  ];
}

function status(run: MutableBotRun): BotRunStatus {
  return Object.freeze({
    run_id: run.runId,
    session_id: run.sessionId,
    count: run.count,
    accuracy: run.accuracy,
    policy: run.policy,
    state: run.state,
    joined: run.joined,
    answered: run.answered,
    correct: run.correct,
    errors: run.errors,
    reconnects: run.reconnects,
    started_at_ms: run.startedAtMs,
    ended_at_ms: run.endedAtMs,
    exit_code: run.exitCode,
    message: run.message,
  });
}

function lineReader(stream: NodeJS.ReadableStream, receive: (line: string | null) => void): void {
  let pending = "";
  let dropping = false;
  stream.setEncoding("utf8");
  stream.on("data", (received: string) => {
    let chunk = received;
    while (chunk.length > 0) {
      if (dropping) {
        const newline = chunk.indexOf("\n");
        if (newline < 0) return;
        dropping = false;
        chunk = chunk.slice(newline + 1);
        continue;
      }
      const newline = chunk.indexOf("\n");
      const fragment = newline < 0 ? chunk : chunk.slice(0, newline);
      const candidate = pending + fragment;
      if (Buffer.byteLength(candidate) > MAX_PENDING_LINE_BYTES) {
        pending = "";
        receive(null);
        if (newline < 0) {
          dropping = true;
          return;
        }
      } else if (newline < 0) {
        pending = candidate;
        return;
      } else {
        const line = candidate.endsWith("\r") ? candidate.slice(0, -1) : candidate;
        pending = "";
        if (line.length > 0) receive(line);
      }
      chunk = newline < 0 ? "" : chunk.slice(newline + 1);
    }
  });
  stream.on("end", () => {
    if (!dropping && pending.length > 0) receive(pending);
  });
}

type SafeRunnerUpdate = "joined" | "answered" | "correct" | "error" | "reconnect" | "recognized";

function safeRunnerUpdate(line: string): SafeRunnerUpdate | null {
  const message = /^\[[^\]\r\n]{1,80}\] (.+)$/.exec(line)?.[1];
  if (message === undefined) return null;
  if (/^joined player=\S{1,128}$/.test(message)) return "joined";
  if (/^answered q=\S{1,256} choice=\S{1,32}$/.test(message)) return "answered";
  if (/^reveal q=\S{1,256} correct=yes$/.test(message)) return "correct";
  if (/^reveal q=\S{1,256} correct=no$/.test(message)) return "recognized";
  if (/^error=.+$/.test(message)) return "error";
  if (/^resumed phase=\S{1,64}$/.test(message)) return "reconnect";
  return null;
}

export class DevBotRunRegistry {
  readonly #database: AppDatabase;
  readonly #tokenSecret: string;
  readonly #devToken: string;
  readonly #logger: ServerLogger;
  readonly #command: BotCommand;
  readonly #runs = new Map<string, MutableBotRun>();
  readonly #requests = new Map<string, Readonly<{ fingerprint: string; runId: string; expiresAtMs: number }>>();
  readonly #reaper: NodeJS.Timeout;
  readonly #stopTimeoutMs: number;
  readonly #closeWaiters = new Set<() => void>();
  #completionSequence = 0;
  #closing = false;

  constructor(options: Readonly<{
    database: AppDatabase;
    tokenSecret: string;
    devToken: string;
    logger: ServerLogger;
    command?: BotCommand;
    stopTimeoutMs?: number;
  }>) {
    this.#database = options.database;
    this.#tokenSecret = options.tokenSecret;
    this.#devToken = options.devToken;
    this.#logger = options.logger;
    this.#command = options.command ?? defaultBotCommand();
    this.#stopTimeoutMs = options.stopTimeoutMs ?? STOP_TIMEOUT_MS;
    this.#reaper = setInterval(() => this.#reapEndedSessions(), 500);
    this.#reaper.unref();
  }

  start(input: Readonly<{
    sessionId: string;
    count: number;
    accuracy: number;
    policy: "random" | "llm";
    requestId: string;
    port: number;
  }>):
    | Readonly<{ ok: true; run: BotRunStatus; created: boolean }>
    | Readonly<{ ok: false; status: number; error: string; message: string }> {
    this.#prune();
    const fingerprint = JSON.stringify([input.sessionId, input.count, input.accuracy, input.policy]);
    const replay = this.#requests.get(input.requestId);
    if (replay !== undefined) {
      const run = this.#runs.get(replay.runId);
      if (replay.fingerprint !== fingerprint || run === undefined) {
        return { ok: false, status: 409, error: "request_mismatch", message: "That start request was already used with different settings." };
      }
      return { ok: true, run: status(run), created: false };
    }
    const row = this.#database.prepare(
      "SELECT teacher_id, status FROM sessions WHERE session_id = ?",
    ).get(input.sessionId) as { teacher_id: string; status: string } | undefined;
    if (row === undefined) {
      return { ok: false, status: 404, error: "session_not_found", message: "That session could not be found." };
    }
    if (row.status === "ended") {
      return { ok: false, status: 409, error: "session_ended", message: "This session has ended. Choose an active session." };
    }
    if ([...this.#runs.values()].filter((run) => ACTIVE_STATES.has(run.state)).length >= 2) {
      return { ok: false, status: 409, error: "run_cap_reached", message: "Two bot runs are already active. Stop one before starting another." };
    }
    let code: string | null;
    try {
      code = teacherSessionCode(this.#database, row.teacher_id, input.sessionId, this.#tokenSecret);
    } catch {
      code = null;
    }
    if (code === null) {
      this.#logger.warn("dev_bot_run_rejected", {
        sessionId: input.sessionId,
        actor: { kind: "dev" },
        detail: { reason: "display_code_unavailable", request_id: input.requestId },
      });
      return {
        ok: false,
        status: 409,
        error: "display_code_unavailable",
        message: "This session has no displayable join code. Rotate its code in the teacher console, then try again.",
      };
    }
    const runId = randomUUID();
    const [command, ...prefix] = this.#command;
    const args = [
      ...prefix,
      "--url", `http://127.0.0.1:${input.port}`,
      "--code", code,
      "--count", String(input.count),
      "--accuracy", String(input.accuracy),
      "--policy", input.policy,
      "--oracle-token", this.#devToken,
    ];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, { detached: true, stdio: ["pipe", "pipe", "pipe"] });
      child.unref();
      (child.stdin as NodeJS.WritableStream & { unref?: () => void }).unref?.();
      (child.stdout as NodeJS.ReadableStream & { unref?: () => void }).unref?.();
      (child.stderr as NodeJS.ReadableStream & { unref?: () => void }).unref?.();
    } catch (error) {
      this.#logger.error("dev_bot_run_spawn_failed", {
        sessionId: input.sessionId,
        actor: { kind: "dev" },
        detail: { run_id: runId, cause: error instanceof Error ? error.name : "unknown" },
      });
      return { ok: false, status: 500, error: "runner_unavailable", message: "The bot runner could not be started." };
    }
    const run: MutableBotRun = {
      runId,
      sessionId: input.sessionId,
      count: input.count,
      accuracy: input.accuracy,
      policy: input.policy,
      state: "running",
      joined: 0,
      answered: 0,
      correct: 0,
      errors: 0,
      reconnects: 0,
      startedAtMs: Date.now(),
      endedAtMs: null,
      exitCode: null,
      message: null,
      child,
      stopTimer: null,
      loggedSummaryLines: 0,
      loggedSummaryBytes: 0,
      suppressionLogged: false,
      stderrTail: "",
      completionSequence: null,
    };
    this.#runs.set(runId, run);
    this.#requests.set(input.requestId, Object.freeze({
      fingerprint,
      runId,
      expiresAtMs: Date.now() + DEV_BOT_REQUEST_RETENTION_MS,
    }));
    const suppress = (source: "stdout" | "stderr"): void => {
      if (run.suppressionLogged) return;
      run.suppressionLogged = true;
      this.#logger.warn("runner_output_suppressed", {
        sessionId: run.sessionId,
        actor: { kind: "dev" },
        detail: { run_id: run.runId, source },
      });
    };
    const receive = (source: "stdout" | "stderr", line: string | null): void => {
      if (line === null) {
        suppress(source);
        return;
      }
      const update = source === "stdout" ? safeRunnerUpdate(line) : null;
      if (update === null) {
        if (source === "stderr") {
          run.errors += 1;
          // Keep a small tail for the dev-only status endpoint (diagnostics).
          run.stderrTail = `${run.stderrTail}${line}\n`.slice(-600);
        }
        suppress(source);
        return;
      }
      if (update === "joined") run.joined += 1;
      else if (update === "answered") run.answered += 1;
      else if (update === "correct") run.correct += 1;
      else if (update === "error") run.errors += 1;
      else if (update === "reconnect") run.reconnects += 1;
      const bytes = Buffer.byteLength(line);
      if (run.loggedSummaryLines >= MAX_OUTPUT_LINES || run.loggedSummaryBytes + bytes > MAX_OUTPUT_BYTES) {
        suppress(source);
        return;
      }
      run.loggedSummaryLines += 1;
      run.loggedSummaryBytes += bytes;
      this.#logger.info("dev_bot_runner_summary", {
        sessionId: run.sessionId,
        actor: { kind: "dev" },
        detail: {
          run_id: run.runId,
          joined: run.joined,
          answered: run.answered,
          correct: run.correct,
          errors: run.errors,
          reconnects: run.reconnects,
        },
      });
    };
    lineReader(child.stdout, (line) => receive("stdout", line));
    lineReader(child.stderr, (line) => receive("stderr", line));
    child.once("error", (error) => {
      if (run.stopTimer !== null) {
        clearTimeout(run.stopTimer);
        run.stopTimer = null;
      }
      run.errors += 1;
      run.state = "failed";
      run.endedAtMs = Date.now();
      run.completionSequence = this.#completionSequence += 1;
      run.message = "The bot runner failed to start.";
      this.#logger.error("dev_bot_run_process_error", {
        sessionId: run.sessionId,
        actor: { kind: "dev" },
        detail: { run_id: run.runId, cause: error.name },
      });
      this.#prune();
      this.#resolveCloseWaiters();
    });
    child.once("close", (exitCode, signal) => {
      if (run.stopTimer !== null) {
        clearTimeout(run.stopTimer);
        run.stopTimer = null;
      }
      const processFailed = run.state === "failed" && run.endedAtMs !== null;
      run.endedAtMs = Date.now();
      run.exitCode = exitCode;
      if (!processFailed) {
        if (run.state === "stopping" || run.state === "stopped") run.state = "stopped";
        else run.state = exitCode === 0 ? "exited" : "failed";
        if (run.completionSequence === null) run.completionSequence = this.#completionSequence += 1;
      }
      if (run.state === "failed" && run.stderrTail.trim().length > 0) {
        run.message = `Bot runner failed: ${run.stderrTail.trim().split("\n").slice(-3).join(" ").slice(-240)}`;
      } else if (run.message === null && signal !== null) {
        run.message = `Runner stopped by ${signal}.`;
      }
      this.#logger[run.state === "failed" ? "warn" : "info"]("dev_bot_run_exited", {
        sessionId: run.sessionId,
        actor: { kind: "dev" },
        detail: { run_id: run.runId, state: run.state, exit_code: exitCode, signal },
      });
      this.#prune();
      this.#resolveCloseWaiters();
    });
    this.#logger.info("dev_bot_run_started", {
      sessionId: input.sessionId,
      actor: { kind: "dev" },
      detail: { run_id: runId, request_id: input.requestId, count: input.count, accuracy: input.accuracy, policy: input.policy },
    });
    return { ok: true, run: status(run), created: true };
  }

  stop(runId: string, reason = "requested"): Readonly<{ ok: true; run: BotRunStatus }> | Readonly<{ ok: false; status: number; error: string; message: string }> {
    const run = this.#runs.get(runId);
    if (run === undefined) return { ok: false, status: 404, error: "run_not_found", message: "That bot run could not be found." };
    if (run.state === "running") {
      this.#requestStop(run, reason, false);
    }
    return { ok: true, run: status(run) };
  }

  statuses(): readonly BotRunStatus[] {
    this.#reapEndedSessions();
    this.#prune();
    return [...this.#runs.values()]
      .sort((left, right) => right.startedAtMs - left.startedAtMs)
      .map(status);
  }

  close(): DevBotRunCloseResult {
    this.#closing = true;
    clearInterval(this.#reaper);
    for (const run of this.#runs.values()) {
      if (run.state === "running") this.#requestStop(run, "server_close", true);
      else if (run.state === "stopping" && run.stopTimer !== null) run.stopTimer.ref();
    }
    const completed = [...this.#runs.values()].some((run) => ACTIVE_STATES.has(run.state))
      ? new Promise<void>((resolve) => this.#closeWaiters.add(resolve))
      : Promise.resolve();
    return Object.freeze({ completed });
  }

  #requestStop(run: MutableBotRun, reason: string, keepAlive: boolean): void {
    run.state = "stopping";
    run.message = reason === "session_ended" ? "Session ended; stopping bots." : "Stopping bots...";
    this.#signalGroup(run, "SIGTERM");
    run.stopTimer = setTimeout(() => {
      run.stopTimer = null;
      if (run.state !== "stopping") return;
      this.#signalGroup(run, "SIGKILL");
      run.state = "stopped";
      run.endedAtMs = Date.now();
      run.completionSequence = this.#completionSequence += 1;
      run.message = "Bot runner was force-stopped.";
      this.#logger.warn("dev_bot_run_force_stopped", {
        sessionId: run.sessionId,
        actor: { kind: "dev" },
        detail: { run_id: run.runId },
      });
      this.#prune();
      this.#resolveCloseWaiters();
    }, this.#stopTimeoutMs);
    if (!keepAlive) run.stopTimer.unref();
    this.#logger.info("dev_bot_run_stop_requested", {
      sessionId: run.sessionId,
      actor: { kind: "dev" },
      detail: { run_id: run.runId, reason },
    });
  }

  #signalGroup(run: MutableBotRun, signal: NodeJS.Signals): void {
    const pid = run.child.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        this.#logger.warn("dev_bot_run_signal_failed", {
          sessionId: run.sessionId,
          actor: { kind: "dev" },
          detail: { run_id: run.runId, signal, cause: error instanceof Error ? error.name : "unknown" },
        });
      }
    }
  }

  #prune(): void {
    const now = Date.now();
    for (const [requestId, request] of this.#requests) {
      if (request.expiresAtMs <= now) this.#requests.delete(requestId);
    }
    const completed = [...this.#runs.values()]
      .filter((run) => !ACTIVE_STATES.has(run.state))
      .sort((left, right) => (right.completionSequence ?? 0) - (left.completionSequence ?? 0));
    for (const run of completed.slice(DEV_BOT_MAX_COMPLETED_RUNS)) this.#runs.delete(run.runId);
  }

  #resolveCloseWaiters(): void {
    if (!this.#closing || [...this.#runs.values()].some((run) => ACTIVE_STATES.has(run.state))) return;
    for (const resolve of this.#closeWaiters) resolve();
    this.#closeWaiters.clear();
  }

  #reapEndedSessions(): void {
    const active = [...this.#runs.values()].filter((run) => run.state === "running");
    if (active.length === 0) return;
    const ended = new Set(
      (this.#database.prepare("SELECT session_id FROM sessions WHERE status = 'ended'").all() as Array<{ session_id: string }>)
        .map((row) => row.session_id),
    );
    for (const run of active) if (ended.has(run.sessionId)) this.stop(run.runId, "session_ended");
  }
}
