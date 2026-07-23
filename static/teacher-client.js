export const LEGACY_CODE_TEXT = "Code unavailable (created before display-code recovery)";

export function bootstrapDecision(status) {
  if (status === 200) return Object.freeze({ state: "signed-in" });
  if (status === 401) return Object.freeze({ state: "signed-out" });
  return Object.freeze({
    state: "error",
    message: "Could not restore your sign-in. Try again.",
  });
}

export function sessionRowModel(entry, formatDate = (value) => new Date(value).toLocaleString()) {
  const codeText = entry.code ?? LEGACY_CODE_TEXT;
  const rejoinable = entry.status !== "ended";
  const archived = entry.archived_at_ms !== null && entry.archived_at_ms !== undefined;
  return Object.freeze({
    cells: Object.freeze([
      codeText,
      formatDate(entry.created_at_ms),
      entry.status,
      String(entry.player_count),
    ]),
    codeText,
    rejoinable: rejoinable && !archived,
    canRotateCode: rejoinable && !archived,
    archived,
    canArchive: !archived && entry.status !== "live",
    archiveLabel: entry.status === "lobby" ? "End & archive" : "Archive",
    ariaLabel: `Rejoin session ${entry.code ?? "with unavailable code"}`,
    projectorPath: `/projector/${entry.session_id}`,
  });
}

export function uploadErrorModel(status, body = {}) {
  const errors = Array.isArray(body.errors) && body.errors.length > 0
    ? body.errors
    : [{ row: null, reason: typeof body.message === "string" ? body.message : "The CSV could not be imported." }];
  return Object.freeze({
    items: Object.freeze(errors.map((error) =>
      error.row === null ? error.reason : `Row ${error.row}: ${error.reason}`)),
    statusText: status === 413
      ? "That file is too large. Choose a CSV smaller than 256 KiB."
      : "Fix the listed rows and upload the CSV again.",
  });
}

export function projectorCredential(storageValue, sessionId, now = Date.now()) {
  if (typeof storageValue !== "string") return null;
  try {
    const value = JSON.parse(storageValue);
    if (typeof value.token !== "string") return null;
    const parts = value.token.split(".");
    const expiresAtMs = Number(parts[2]);
    if (
      parts.length !== 5 ||
      parts[0] !== "prj1" ||
      parts[1] !== sessionId ||
      !Number.isSafeInteger(expiresAtMs) ||
      expiresAtMs <= now
    ) return null;
    return Object.freeze({
      token: value.token,
      code: typeof value.code === "string" ? value.code : null,
      path: `/projector/${sessionId}`,
    });
  } catch {
    return null;
  }
}

export function deckViewModel(deck) {
  const cursor = Number.isInteger(deck?.cursor_position) ? deck.cursor_position : 1;
  const questions = Array.isArray(deck?.questions) ? deck.questions : [];
  const next = questions.find((question) => question.position >= cursor) ?? null;
  return Object.freeze({
    cursor,
    nextPrompt: next === null ? "Deck finished" : next.prompt,
    rows: Object.freeze(questions.map((question) => Object.freeze({
      ...question,
      played: question.position < cursor,
      current: question.position === cursor,
    }))),
  });
}
