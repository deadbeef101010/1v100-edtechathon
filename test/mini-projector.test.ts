import { readFile } from "node:fs/promises";

import { beforeAll, describe, expect, it } from "vitest";

type MiniProjectorModule = {
  computeMiniProjectorLayout: (
    containerWidth: number,
    designWidth?: number,
    designHeight?: number,
  ) => Readonly<{ scale: number; width: number; height: number }>;
  credentialWaitDecision: (
    storedValue: string | null,
    elapsedMs: number,
    timeoutMs: number,
  ) => "wait" | "mount" | "give_up";
  startCredentialWait: (options: {
    read: () => string | null;
    onMount: () => void;
    onTimeout: () => void;
    schedule: (callback: () => void, delay: number) => number;
    clear: (timer: number) => void;
    now: () => number;
    pollMs: number;
    timeoutMs: number;
  }) => Readonly<{ stop: () => void }>;
};

function createFakeScheduler() {
  let nextTimer = 1;
  let currentTime = 0;
  const pending = new Map<number, { callback: () => void; delay: number }>();
  const scheduledDelays: number[] = [];
  const clearedTimers: number[] = [];

  return {
    schedule(callback: () => void, delay: number) {
      const timer = nextTimer;
      nextTimer += 1;
      pending.set(timer, { callback, delay });
      scheduledDelays.push(delay);
      return timer;
    },
    clear(timer: number) {
      clearedTimers.push(timer);
      pending.delete(timer);
    },
    runNext() {
      const entry = pending.entries().next().value as [number, { callback: () => void; delay: number }] | undefined;
      if (entry === undefined) throw new Error("No timer is pending.");
      const [timer, task] = entry;
      pending.delete(timer);
      currentTime += task.delay;
      task.callback();
    },
    now: () => currentTime,
    pending,
    scheduledDelays,
    clearedTimers,
  };
}

let miniProjector: MiniProjectorModule;

beforeAll(async () => {
  const source = await readFile(new URL("../static/mini-projector.js", import.meta.url), "utf8");
  miniProjector = await import(`data:text/javascript,${encodeURIComponent(source)}`) as MiniProjectorModule;
});

describe("mini-projector layout", () => {
  it("scales the 1280 by 720 design to the container width", () => {
    expect(miniProjector.computeMiniProjectorLayout(640)).toEqual({
      scale: 0.5,
      width: 640,
      height: 360,
    });
  });

  it("clamps zero, negative, and non-finite widths", () => {
    expect(miniProjector.computeMiniProjectorLayout(0)).toEqual({ scale: 0, width: 0, height: 0 });
    expect(miniProjector.computeMiniProjectorLayout(-100)).toEqual({ scale: 0, width: 0, height: 0 });
    expect(miniProjector.computeMiniProjectorLayout(Number.NaN)).toEqual({ scale: 0, width: 0, height: 0 });
  });

  it("supports a custom design size", () => {
    expect(miniProjector.computeMiniProjectorLayout(300, 600, 400)).toEqual({
      scale: 0.5,
      width: 300,
      height: 200,
    });
  });

  it("returns a frozen layout value", () => {
    expect(Object.isFrozen(miniProjector.computeMiniProjectorLayout(640))).toBe(true);
  });
});

describe("mini-projector credential wait", () => {
  it("mounts as soon as a stored credential exists", () => {
    expect(miniProjector.credentialWaitDecision("credential", 0, 15000)).toBe("mount");
    expect(miniProjector.credentialWaitDecision("credential", 15000, 15000)).toBe("mount");
  });

  it("waits before the timeout and gives up at the timeout", () => {
    expect(miniProjector.credentialWaitDecision(null, 14999, 15000)).toBe("wait");
    expect(miniProjector.credentialWaitDecision(null, 15000, 15000)).toBe("give_up");
  });

  it("mounts when a credential appears and stops polling", () => {
    const scheduler = createFakeScheduler();
    let reads = 0;
    let mounts = 0;
    let timeouts = 0;

    miniProjector.startCredentialWait({
      read: () => {
        reads += 1;
        return reads === 3 ? "credential" : null;
      },
      onMount: () => { mounts += 1; },
      onTimeout: () => { timeouts += 1; },
      schedule: scheduler.schedule,
      clear: scheduler.clear,
      now: scheduler.now,
      pollMs: 500,
      timeoutMs: 15000,
    });

    expect(scheduler.pending.size).toBe(1);
    scheduler.runNext();
    expect(scheduler.pending.size).toBe(1);
    scheduler.runNext();

    expect(mounts).toBe(1);
    expect(timeouts).toBe(0);
    expect(scheduler.scheduledDelays).toEqual([500, 500]);
    expect(scheduler.clearedTimers).toEqual([1, 2]);
    expect(scheduler.pending.size).toBe(0);
  });

  it("times out once and stops polling", () => {
    const scheduler = createFakeScheduler();
    let mounts = 0;
    let timeouts = 0;

    miniProjector.startCredentialWait({
      read: () => null,
      onMount: () => { mounts += 1; },
      onTimeout: () => { timeouts += 1; },
      schedule: scheduler.schedule,
      clear: scheduler.clear,
      now: scheduler.now,
      pollMs: 500,
      timeoutMs: 1000,
    });

    scheduler.runNext();
    scheduler.runNext();

    expect(mounts).toBe(0);
    expect(timeouts).toBe(1);
    expect(scheduler.scheduledDelays).toEqual([500, 500]);
    expect(scheduler.clearedTimers).toEqual([1, 2]);
    expect(scheduler.pending.size).toBe(0);
  });

  it("cancels a pending poll when stopped", () => {
    const scheduler = createFakeScheduler();
    let mounts = 0;
    let timeouts = 0;
    const wait = miniProjector.startCredentialWait({
      read: () => null,
      onMount: () => { mounts += 1; },
      onTimeout: () => { timeouts += 1; },
      schedule: scheduler.schedule,
      clear: scheduler.clear,
      now: () => 0,
      pollMs: 500,
      timeoutMs: 15000,
    });

    wait.stop();
    wait.stop();

    expect(mounts).toBe(0);
    expect(timeouts).toBe(0);
    expect(scheduler.scheduledDelays).toEqual([500]);
    expect(scheduler.clearedTimers).toEqual([1]);
    expect(scheduler.pending.size).toBe(0);
  });
});
