import { describe, expect, it } from "vitest";

import { ServerLogger } from "../src/log.js";

describe("structured server logger", () => {
  it("filters console output below the configured minimum level", () => {
    const lines: string[] = [];
    const logger = new ServerLogger({ minimumLevel: "warn", write: (line) => lines.push(line) });

    logger.info("quiet_info");
    logger.warn("visible_warning");

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("visible_warning");
    expect(logger.entries()).toHaveLength(2);
  });

  it("writes JSON lines and retains only the configured ring capacity", () => {
    const lines: string[] = [];
    let now = 1_000;
    const logger = new ServerLogger({
      capacity: 2,
      now: () => now += 1_000,
      write: (line) => lines.push(line),
    });

    logger.info("first", { detail: { ordinal: 1 } });
    logger.warn("second", { sessionId: "session-1", detail: { ordinal: 2 } });
    logger.error("third", { actor: { kind: "system", id: "system" }, detail: { ordinal: 3 } });

    expect(logger.entries().map((entry) => entry.event)).toEqual(["second", "third"]);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1] ?? "") as unknown).toEqual({
      ts: "1970-01-01T00:00:03.000Z",
      level: "warn",
      event: "second",
      session_id: "session-1",
      detail: { ordinal: 2 },
    });
  });

  it("notifies subscribers and recursively removes credential and answer fields", () => {
    const lines: string[] = [];
    const delivered: string[] = [];
    const logger = new ServerLogger({ write: (line) => lines.push(line) });
    const unsubscribe = logger.subscribe((entry) => delivered.push(entry.event));

    logger.warn("safe", {
      detail: {
        reason: "invalid",
        teacher_token: "teacher-canary",
        nested: { correct_choice: 2, answer: "answer-canary", visible: true },
      },
    });
    unsubscribe();
    logger.info("after", { detail: {} });

    expect(delivered).toEqual(["safe"]);
    expect(lines[0]).not.toContain("teacher-canary");
    expect(lines[0]).not.toContain("answer-canary");
    expect(JSON.parse(lines[0] ?? "")).toMatchObject({
      event: "safe",
      detail: { reason: "invalid", nested: { visible: true } },
    });
  });

  it("isolates sink and subscriber failures and counts dropped deliveries", () => {
    const delivered: string[] = [];
    const logger = new ServerLogger({ write: () => { throw new Error("broken pipe"); } });
    logger.subscribe(() => { throw new Error("bad subscriber"); });
    logger.subscribe((entry) => delivered.push(entry.event));

    expect(() => logger.info("still_safe")).not.toThrow();
    expect(delivered).toEqual(["still_safe"]);
    expect(logger.entries()).toHaveLength(1);
    expect(logger.droppedCount).toBe(2);
  });

  it("redacts normalized credential and answer key families at every level", () => {
    const lines: string[] = [];
    const logger = new ServerLogger({ write: (line) => lines.push(line) });
    logger.info("leak_scan", {
      actor: { kind: "teacher", id: "teacher-id", apiKey: "actor-canary" } as never,
      detail: {
        correctChoice: 2,
        apiKey: "api-canary",
        nested: { teacherToken: "token-canary", credentials: { private_key: "key-canary" } },
        list: [{ submittedAnswer: "answer-canary" }, { selected_choice: 1 }],
        visible: "keep-me",
      },
    });

    const output = `${lines.join("\n")}\n${JSON.stringify(logger.entries())}`;
    for (const canary of ["actor-canary", "api-canary", "token-canary", "key-canary", "answer-canary"]) {
      expect(output).not.toContain(canary);
    }
    expect(output).toContain("keep-me");
    expect(output).toContain("teacher-id");
    expect(output).not.toContain("correctChoice");
    expect(output).not.toContain("selected_choice");

    for (const family of ["answer", "correct", "choice", "key", "token", "secret", "credential"]) {
      const topLevelLines: string[] = [];
      new ServerLogger({ write: (line) => topLevelLines.push(line) }).info(`${family}-canary`, {
        sessionId: "token-canary",
        actor: { kind: "teacher", id: "credential-canary" },
      });
      expect(topLevelLines[0]).not.toContain(`${family}-canary`);
      expect(topLevelLines[0]).not.toContain("token-canary");
      expect(topLevelLines[0]).not.toContain("credential-canary");
    }
  });

  it("fails closed when recursive redaction throws", () => {
    const lines: string[] = [];
    const logger = new ServerLogger({ write: (line) => lines.push(line) });
    const detail = new Proxy({}, {
      ownKeys: () => { throw new Error("redaction failed"); },
    });

    expect(() => logger.info("secret-canary", { detail })).not.toThrow();

    const output = `${lines.join("\n")}\n${JSON.stringify(logger.entries())}`;
    expect(output).not.toContain("secret-canary");
    expect(logger.entries()).toEqual([
      expect.objectContaining({
        sequence: 1,
        event: "log_redaction_failed",
        detail: { redaction_failed: true },
      }),
    ]);
    expect(logger.droppedCount).toBe(1);
  });
});
