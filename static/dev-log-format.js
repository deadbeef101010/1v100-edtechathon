const MAX_CHIP_LENGTH = 120;

function timestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--:--:--.---";
  return date.toISOString().slice(11, 23);
}

function chipValue(value) {
  const encoded = typeof value === "string" ? value : JSON.stringify(value);
  const full = encoded ?? String(value);
  const text = full.length > MAX_CHIP_LENGTH ? `${full.slice(0, MAX_CHIP_LENGTH - 3)}...` : full;
  return { text, full, truncated: text !== full };
}

function chips(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  return Object.entries(value).map(([key, entry]) => ({ key, ...chipValue(entry) }));
}

/**
 * @param {Record<string, unknown>} data
 * @returns {{ ts: string, tag: string, badge: string, name: string, chips: Array<{key: string, text: string, full: string, truncated: boolean}>, level: string, cssClass: string, notice: boolean }}
 */
export function formatRow(data) {
  if (data.source === "stream") {
    const dropped = typeof data.dropped_count === "number";
    return {
      ts: timestamp(data.ts),
      tag: "SYS",
      badge: "",
      name: dropped ? "Stream dropped frames" : "History truncated",
      chips: chips(data),
      level: "warn",
      cssClass: "is-notice",
      notice: true,
    };
  }
  if (data.source === "events") {
    return {
      ts: timestamp(data.created_at_ms),
      tag: "EVT",
      badge: typeof data.server_seq === "number" ? `#${data.server_seq}` : "",
      name: typeof data.event_type === "string" ? data.event_type : "game_event",
      chips: chips(data.payload),
      level: "events",
      cssClass: "is-event",
      notice: false,
    };
  }
  const level = data.level === "warn" || data.level === "error" ? data.level : "info";
  return {
    ts: timestamp(data.ts),
    tag: "SRV",
    badge: "",
    name: typeof data.event === "string" ? data.event : "server_log",
    chips: chips(data.detail),
    level,
    cssClass: `is-${level}`,
    notice: false,
  };
}
