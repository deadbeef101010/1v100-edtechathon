import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("client clock offset estimation", () => {
  it("renders a server deadline accurately with a skewed local clock", async () => {
    const source = await readFile(new URL("../static/clock-offset.js", import.meta.url), "utf8");
    const module = await import(`data:text/javascript,${encodeURIComponent(source)}`) as {
      createClockOffsetEstimator: () => {
        observe: (server: number, client: number) => number;
        remainingMs: (deadline: number, client: number) => number;
      };
    };
    const clock = module.createClockOffsetEstimator();
    const skewedClientNow = 9_000_000;
    const serverNow = 1_000_000;
    for (const noise of [-30, 20, -10, 40]) {
      clock.observe(serverNow + noise, skewedClientNow);
    }

    const remaining = clock.remainingMs(serverNow + 5_000, skewedClientNow);
    expect(Math.abs(remaining - 5_000)).toBeLessThanOrEqual(250);
  });
});
