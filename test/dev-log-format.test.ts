import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";

type LogFormatter = {
  formatRow: (data: Record<string, unknown>) => {
    ts: string;
    tag: string;
    badge: string;
    name: string;
    chips: Array<{ key: string; text: string; full: string; truncated: boolean }>;
    level: string;
    cssClass: string;
    notice: boolean;
  };
};

let formatter: LogFormatter;

beforeAll(async () => {
  const source = await readFile(new URL("../static/dev-log-format.js", import.meta.url), "utf8");
  formatter = await import(`data:text/javascript,${encodeURIComponent(source)}`) as LogFormatter;
});

describe("dev log formatter", () => {
  it("formats game events with timestamp, sequence badge, and payload chips", () => {
    expect(formatter.formatRow({
      source: "events",
      created_at_ms: Date.UTC(2026, 0, 1, 12, 34, 56, 789),
      server_seq: 42,
      event_type: "answer_accepted",
      payload: { count: 3 },
    })).toMatchObject({
      ts: "12:34:56.789",
      tag: "EVT",
      badge: "#42",
      name: "answer_accepted",
      level: "events",
      cssClass: "is-event",
      chips: [{ key: "count", text: "3", full: "3", truncated: false }],
    });
  });

  it("formats server levels and truncates object details while retaining full JSON", () => {
    const nested = { message: "x".repeat(140) };
    const row = formatter.formatRow({
      source: "server",
      ts: "2026-01-01T01:02:03.004Z",
      level: "error",
      event: "request_failed",
      detail: { nested },
    });

    expect(row).toMatchObject({ ts: "01:02:03.004", tag: "SRV", name: "request_failed", level: "error", cssClass: "is-error" });
    expect(row.chips[0]?.truncated).toBe(true);
    expect(row.chips[0]?.text.length).toBe(120);
    expect(row.chips[0]?.full).toBe(JSON.stringify(nested));
  });

  it("formats stream drop and history truncation metadata as notices", () => {
    expect(formatter.formatRow({ source: "stream", dropped_count: 4 })).toMatchObject({
      tag: "SYS",
      name: "Stream dropped frames",
      level: "warn",
      cssClass: "is-notice",
      notice: true,
    });
    expect(formatter.formatRow({ source: "stream", retained_events: 256 }).name).toBe("History truncated");
  });
});
