/** @typedef {{ player_id: string, role?: string, kicked_at_ms?: number | null }} Player */

/**
 * @param {Player[]} players
 * @returns {{ one: Player[], mob: Player[], crowd: Player[] }}
 */
export function groupPlayers(players) {
  const groups = { one: [], mob: [], crowd: [] };
  for (const player of players) {
    if (player.kicked_at_ms !== null && player.kicked_at_ms !== undefined) continue;
    if (player.role === "one") groups.one.push(player);
    else if (player.role === "crowd") groups.crowd.push(player);
    else groups.mob.push(player);
  }
  return groups;
}

/**
 * @param {unknown} round
 * @param {string} playerId
 * @returns {{ visible: boolean, time: string, correct: boolean | null }}
 */
export function answerChip(round, playerId) {
  if (typeof round !== "object" || round === null) return { visible: false, time: "", correct: null };
  const snapshot = /** @type {Record<string, unknown>} */ (round);
  const active = typeof snapshot.active === "object" && snapshot.active !== null
    ? /** @type {Record<string, unknown>} */ (snapshot.active)
    : null;
  if (active === null || !Array.isArray(snapshot.answers)) return { visible: false, time: "", correct: null };
  const answer = snapshot.answers.find((entry) =>
    typeof entry === "object" && entry !== null && /** @type {Record<string, unknown>} */ (entry).playerId === playerId,
  );
  if (typeof answer !== "object" || answer === null) return { visible: false, time: "", correct: null };
  const value = /** @type {Record<string, unknown>} */ (answer);
  const receivedAtMs = typeof value.receivedAtMs === "number" ? value.receivedAtMs : NaN;
  const startedWallMs = typeof active.startedWallMs === "number" ? active.startedWallMs : NaN;
  const elapsed = Number.isFinite(receivedAtMs) && Number.isFinite(startedWallMs)
    ? `${(receivedAtMs - startedWallMs) / 1_000}`
    : "";
  const time = elapsed === "" ? "?s" : `${Number(elapsed).toFixed(1)}s`;
  if (snapshot.phase !== "REVEALED") return { visible: true, time, correct: null };
  const question = typeof active.question === "object" && active.question !== null
    ? /** @type {Record<string, unknown>} */ (active.question)
    : {};
  return { visible: true, time, correct: value.choice === question.correctChoice };
}

/**
 * @param {unknown} round
 * @returns {{ phase: string, answered: number, eligible: number }}
 */
export function roundSummary(round) {
  if (typeof round !== "object" || round === null) return { phase: "NO ROUND", answered: 0, eligible: 0 };
  const snapshot = /** @type {Record<string, unknown>} */ (round);
  const active = typeof snapshot.active === "object" && snapshot.active !== null
    ? /** @type {Record<string, unknown>} */ (snapshot.active)
    : {};
  return {
    phase: typeof snapshot.phase === "string" ? snapshot.phase : "UNKNOWN",
    answered: Array.isArray(snapshot.answers) ? snapshot.answers.length : 0,
    eligible: Array.isArray(active.eligiblePlayerIds) ? active.eligiblePlayerIds.length : 0,
  };
}
