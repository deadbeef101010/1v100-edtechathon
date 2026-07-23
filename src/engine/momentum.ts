export type MomentumPhaseAAnswer = Readonly<{
  choice: number;
  receiveDurationMs: number;
  role: "mob" | "crowd";
}>;

export type MomentumFastWindow = Readonly<{
  fastWindowMs: number;
  correctMobDurationsMs: readonly number[];
  selectedDurationsMs: readonly number[];
  selectedCount: number;
  meanMs: number | null;
  fastK: number;
  windowMinMs: number;
  windowMaxMs: number;
  fallback: boolean;
}>;

// RULESET-v1: when no Mob answer is correct, the logged fallback window is a
// fixed 20 seconds regardless of the configured clamp bounds.
export const MOMENTUM_FALLBACK_WINDOW_MS = 20_000;

export function computeMomentumFastWindow(input: Readonly<{
  answers: readonly MomentumPhaseAAnswer[];
  correctChoice: number;
  fastK: number;
  windowMinMs: number;
  windowMaxMs: number;
}>): MomentumFastWindow {
  const correctMobDurationsMs = Object.freeze(input.answers
    .filter((answer) => answer.role === "mob" && answer.choice === input.correctChoice)
    .map((answer) => answer.receiveDurationMs)
    .sort((left, right) => left - right));
  const selectedCount = Math.ceil(correctMobDurationsMs.length / 2);
  const selectedDurationsMs = Object.freeze(correctMobDurationsMs.slice(0, selectedCount));
  const meanMs = selectedCount === 0
    ? null
    : selectedDurationsMs.reduce((total, duration) => total + duration, 0) / selectedCount;
  const fastWindowMs = meanMs === null
    ? MOMENTUM_FALLBACK_WINDOW_MS
    : Math.min(input.windowMaxMs, Math.max(input.windowMinMs, input.fastK * meanMs));

  return Object.freeze({
    fastWindowMs,
    correctMobDurationsMs,
    selectedDurationsMs,
    selectedCount,
    meanMs,
    fastK: input.fastK,
    windowMinMs: input.windowMinMs,
    windowMaxMs: input.windowMaxMs,
    fallback: meanMs === null,
  });
}
