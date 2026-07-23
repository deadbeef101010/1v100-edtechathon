import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("server sequence tracker", () => {
  it("rejects stale events per session and lets snapshots reset the watermark", async () => {
    const source = await readFile(new URL("../static/server-sequence.js", import.meta.url), "utf8");
    const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
    const { createServerSequenceTracker } = await import(moduleUrl) as {
      createServerSequenceTracker: () => {
        current: (sessionId: string) => number;
        applySnapshot: (sessionId: string, packet: unknown) => void;
        accept: (sessionId: string, packet: unknown) => boolean;
      };
    };
    const tracker = createServerSequenceTracker();

    expect(tracker.accept("one", { server_seq: 4 })).toBe(true);
    expect(tracker.accept("one", { server_seq: 4 })).toBe(false);
    expect(tracker.accept("one", { server_seq: 3 })).toBe(false);
    expect(tracker.accept("two", { server_seq: 3 })).toBe(true);
    tracker.applySnapshot("one", { server_seq: 9 });
    expect(tracker.current("one")).toBe(9);
    expect(tracker.accept("one", { server_seq: 8 })).toBe(false);
    expect(tracker.accept("one", { server_seq: 10 })).toBe(true);
    expect(tracker.accept("one", {})).toBe(true);
  });
});
