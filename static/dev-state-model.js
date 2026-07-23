/** Pure render models for the formatted /dev/state session view. */

function formatTime(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return `${date.toISOString().slice(0, 10)} ${date.toISOString().slice(11, 19)}Z`;
}

/**
 * @param {unknown} session
 * @returns {Array<{ label: string, value: string }>}
 */
export function sessionRows(session) {
  if (typeof session !== "object" || session === null) return [{ label: "Session", value: "Unavailable" }];
  const value = /** @type {Record<string, unknown>} */ (session);
  return [
    { label: "Status", value: typeof value.status === "string" ? value.status : "unknown" },
    { label: "Started", value: formatTime(/** @type {number} */ (value.started_at_ms)) },
    { label: "Ended", value: formatTime(/** @type {number} */ (value.ended_at_ms)) },
  ];
}

/**
 * @param {unknown} round
 * @param {unknown} serverTimeMs
 * @returns {Array<{ label: string, value: string }>}
 */
export function roundRows(round, serverTimeMs) {
  if (typeof round !== "object" || round === null) return [{ label: "Phase", value: "NO ROUND" }];
  const snapshot = /** @type {Record<string, unknown>} */ (round);
  const active = typeof snapshot.active === "object" && snapshot.active !== null
    ? /** @type {Record<string, unknown>} */ (snapshot.active)
    : null;
  const rows = [{ label: "Phase", value: typeof snapshot.phase === "string" ? snapshot.phase : "UNKNOWN" }];
  if (active === null) return rows;
  const question = typeof active.question === "object" && active.question !== null
    ? /** @type {Record<string, unknown>} */ (active.question)
    : {};
  if (typeof question.prompt === "string") rows.push({ label: "Question", value: question.prompt });
  const answered = Array.isArray(snapshot.answers) ? snapshot.answers.length : 0;
  const eligible = Array.isArray(active.eligiblePlayerIds) ? active.eligiblePlayerIds.length : 0;
  rows.push({ label: "Locked", value: `${answered} of ${eligible}` });
  if (snapshot.phase === "QUESTION_OPEN" && typeof active.deadlineWallMs === "number" && typeof serverTimeMs === "number") {
    rows.push({ label: "Remaining", value: `${Math.max(0, (active.deadlineWallMs - serverTimeMs) / 1_000).toFixed(1)}s` });
  }
  if (snapshot.phase === "PAUSED" && typeof snapshot.pauseRemainingMs === "number") {
    rows.push({ label: "Paused with", value: `${(snapshot.pauseRemainingMs / 1_000).toFixed(1)}s left` });
  }
  return rows;
}

/**
 * Map a stored game event (camelCase state payload) onto the SSE frame shape
 * consumed by dev-log-format's formatRow.
 * @param {unknown} event
 * @returns {Record<string, unknown>}
 */
export function storedEventFrame(event) {
  const value = typeof event === "object" && event !== null
    ? /** @type {Record<string, unknown>} */ (event)
    : {};
  return {
    source: "events",
    server_seq: value.serverSeq,
    event_type: value.eventType,
    payload: value.payload,
    created_at_ms: value.createdAtMs,
  };
}
