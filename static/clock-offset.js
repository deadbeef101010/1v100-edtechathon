export function createClockOffsetEstimator(sampleLimit = 8) {
  const samples = [];

  return Object.freeze({
    observe(serverTimeMs, clientTimeMs = Date.now()) {
      samples.push(serverTimeMs - clientTimeMs);
      if (samples.length > sampleLimit) samples.shift();
      return samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
    },
    offsetMs() {
      return samples.length === 0
        ? 0
        : samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
    },
    remainingMs(deadlineMs, clientTimeMs = Date.now()) {
      return Math.max(0, deadlineMs - (clientTimeMs + this.offsetMs()));
    },
  });
}
