export function createServerSequenceTracker() {
  const watermarks = new Map();

  function sequence(packet) {
    return Number.isSafeInteger(packet?.server_seq) && packet.server_seq >= 0
      ? packet.server_seq
      : null;
  }

  return Object.freeze({
    current(sessionId) {
      return watermarks.get(sessionId) ?? 0;
    },
    applySnapshot(sessionId, snapshot) {
      const next = sequence(snapshot);
      if (next !== null) watermarks.set(sessionId, next);
    },
    accept(sessionId, packet) {
      const next = sequence(packet);
      if (next === null) return true;
      if (next <= (watermarks.get(sessionId) ?? 0)) return false;
      watermarks.set(sessionId, next);
      return true;
    },
  });
}
