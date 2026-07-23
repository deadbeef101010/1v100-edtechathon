import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEV_BOT_MAX_COMPLETED_RUNS,
  DEV_BOT_REQUEST_RETENTION_MS,
  DevBotRunRegistry,
  type BotCommand,
  type BotRunStatus,
} from "../src/dev-bot-runs.js";
import { openDatabase, type AppDatabase } from "../src/db.js";
import { ServerLogger } from "../src/log.js";
import { createClassroomSession, type CreatedClassroomSession } from "../src/sessions.js";
import { mintTeacherKey } from "../src/teachers.js";

const SECRET = "dev-bot-runs-secret-at-least-32-characters";
const DEV_TOKEN = "private-dev-token";
const fixture = new URL("fixtures/fake-bot-runner.ts", import.meta.url).pathname;

let directory: string;
let database: AppDatabase;
let classroom: CreatedClassroomSession;
let logger: ServerLogger;
let registry: DevBotRunRegistry | undefined;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "game-dev-bot-runs-"));
  database = openDatabase(join(directory, "game.db"));
  const teacher = mintTeacherKey(database, "Bot Runner Teacher");
  classroom = createClassroomSession(database, teacher.teacherId, SECRET);
  logger = new ServerLogger({ write: () => undefined });
});

afterEach(async () => {
  const closed = registry?.close();
  if (closed !== undefined) await closed.completed;
  registry = undefined;
  database.close();
  await rm(directory, { recursive: true, force: true });
});

function createRegistry(command: BotCommand, stopTimeoutMs = 100): DevBotRunRegistry {
  registry = new DevBotRunRegistry({
    database,
    tokenSecret: SECRET,
    devToken: DEV_TOKEN,
    logger,
    command,
    stopTimeoutMs,
  });
  return registry;
}

function start(target: DevBotRunRegistry, count = 2): BotRunStatus {
  const result = target.start({
    sessionId: classroom.sessionId,
    count,
    accuracy: 0.7,
    policy: "random",
    requestId: crypto.randomUUID(),
    port: 1,
  });
  if (!result.ok) throw new Error(result.error);
  return result.run;
}

async function waitFor(
  target: DevBotRunRegistry,
  predicate: (status: BotRunStatus) => boolean,
  timeoutMs = 2_000,
): Promise<BotRunStatus> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = target.statuses().find(predicate);
    if (current !== undefined) return current;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Bot run status timed out");
}

describe("development bot run supervision", () => {
  it("force-kills a process group that ignores SIGTERM and frees its slot", async () => {
    const descendantCapture = join(directory, "descendant.pid");
    const target = createRegistry([
      process.execPath,
      "--import",
      "tsx",
      fixture,
      "--ignore-term",
      "--spawn-descendant",
      "--descendant-capture",
      descendantCapture,
    ]);
    const first = start(target);
    start(target);
    await waitFor(target, (run) => run.run_id === first.run_id && run.joined === 1);
    let descendantPid: number | undefined;
    const pidDeadline = Date.now() + 2_000;
    while (Date.now() < pidDeadline && descendantPid === undefined) {
      try {
        const [pid, group, runnerPid] = (await readFile(descendantCapture, "utf8")).split(":");
        descendantPid = Number(pid);
        expect(Number(group)).toBe(Number(runnerPid));
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    expect(descendantPid).toEqual(expect.any(Number));

    expect(target.stop(first.run_id).ok).toBe(true);
    await waitFor(target, (run) => run.run_id === first.run_id && run.state === "stopped");

    if (descendantPid !== undefined) {
      // Generous deadline: the SIGKILL fires at stopTimeoutMs (100ms), but group
      // signal delivery + zombie reaping can lag under full-suite parallel load.
      const deathDeadline = Date.now() + 10_000;
      while (Date.now() < deathDeadline && await processIsRunning(descendantPid)) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(await processIsRunning(descendantPid)).toBe(false);
    }
    expect(logger.entries()).toContainEqual(expect.objectContaining({ event: "dev_bot_run_force_stopped" }));
    expect(() => start(target)).not.toThrow();
  });

  it("never logs runner answer choices or raw output", async () => {
    const target = createRegistry([process.execPath, "--import", "tsx", fixture]);
    start(target);
    const run = await waitFor(target, (value) =>
      value.answered === 1 && value.correct === 1 && value.reconnects === 1 && value.errors === 1
    );
    const exposed = { run, entries: logger.entries() };
    const serialized = JSON.stringify(exposed);

    expect(serialized).not.toContain("choice");
    expect(serialized).not.toContain("choice=2");
    expect(logger.entries()).toContainEqual(expect.objectContaining({ event: "dev_bot_runner_summary" }));
  });

  it("makes an asynchronous spawn error terminal and immediately reusable", async () => {
    const target = createRegistry([join(directory, "missing-runner")]);
    const failedRun = start(target);
    const secondFailedRun = start(target);
    await waitFor(target, (run) => run.run_id === failedRun.run_id && run.state === "failed");
    await waitFor(target, (run) => run.run_id === secondFailedRun.run_id && run.state === "failed");

    const next = target.start({
      sessionId: classroom.sessionId,
      count: 2,
      accuracy: 0.7,
      policy: "random",
      requestId: crypto.randomUUID(),
      port: 1,
    });
    expect(next.ok).toBe(true);
    expect(next.ok ? next.run.state : "rejected").toBe("running");
  });

  it("suppresses a runaway line without retaining its contents", async () => {
    const target = createRegistry([process.execPath, "--import", "tsx", fixture, "--runaway"]);
    start(target, 1);
    await waitFor(target, (run) => run.state === "exited");

    expect(logger.entries()).toContainEqual(expect.objectContaining({ event: "runner_output_suppressed" }));
    expect(JSON.stringify(logger.entries())).not.toContain("x".repeat(1_024));
  });

  it("coalesces repeated oversized-line suppression logs", async () => {
    const target = createRegistry([process.execPath, "--import", "tsx", fixture, "--many-oversized-lines"]);
    start(target, 1);
    await waitFor(target, (run) => run.state === "exited");

    expect(logger.entries().filter((entry) => entry.event === "runner_output_suppressed")).toHaveLength(1);
  });

  it("continues aggregate accounting after the retained-log cap", async () => {
    const target = createRegistry([process.execPath, "--import", "tsx", fixture, "--many-safe-lines"]);
    start(target, 1);
    const run = await waitFor(target, (value) => value.state === "exited");

    expect(run.answered).toBe(250);
    expect(logger.entries().filter((entry) => entry.event === "dev_bot_runner_summary")).toHaveLength(200);
    expect(logger.entries().filter((entry) => entry.event === "runner_output_suppressed")).toHaveLength(1);
  });

  it("retains only the twenty most recent completed runs", async () => {
    const target = createRegistry([process.execPath, "--import", "tsx", fixture]);
    for (let index = 0; index < 25; index += 2) {
      const run = start(target, 1);
      const second = start(target, 1);
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const states = new Map(target.statuses().map((value) => [value.run_id, value.state]));
        if (states.get(run.run_id) === "exited" && states.get(second.run_id) === "exited") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(target.statuses().filter((value) => ACTIVE_FOR_TEST.has(value.state))).toHaveLength(0);
    }

    expect(target.statuses()).toHaveLength(DEV_BOT_MAX_COMPLETED_RUNS);
  }, 15_000);

  it("expires request-id records", async () => {
    const target = createRegistry([process.execPath, "--import", "tsx", fixture]);
    const requestId = crypto.randomUUID();
    const result = target.start({
      sessionId: classroom.sessionId,
      count: 1,
      accuracy: 0.7,
      policy: "random",
      requestId,
      port: 1,
    });
    if (!result.ok) throw new Error(result.error);
    await waitFor(target, (run) => run.run_id === result.run.run_id && run.state === "exited");

    const realNow = Date.now;
    Date.now = () => realNow() + DEV_BOT_REQUEST_RETENTION_MS + 1;
    try {
      const replay = target.start({
        sessionId: classroom.sessionId,
        count: 1,
        accuracy: 0.7,
        policy: "random",
        requestId,
        port: 1,
      });
      expect(replay.ok && replay.created).toBe(true);
    } finally {
      Date.now = realNow;
    }
  });
});

const ACTIVE_FOR_TEST = new Set<BotRunStatus["state"]>(["running", "stopping"]);

async function processIsRunning(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return stat.split(" ")[2] !== "Z";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
