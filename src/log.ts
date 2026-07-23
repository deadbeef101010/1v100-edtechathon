export type LogLevel = "info" | "warn" | "error";

export type LogActor = Readonly<{
  kind: "system" | "teacher" | "player" | "projector" | "dev" | "meta" | "unbound";
  id?: string;
}>;

export type ServerLogEntry = Readonly<{
  ts: string;
  level: LogLevel;
  event: string;
  session_id?: string;
  actor?: LogActor;
  detail: Readonly<Record<string, unknown>>;
}>;

export type StoredServerLogEntry = ServerLogEntry & Readonly<{ sequence: number }>;

export type LogContext = Readonly<{
  sessionId?: string;
  actor?: LogActor;
  detail?: Readonly<Record<string, unknown>>;
}>;

export type LoggerOptions = Readonly<{
  capacity?: number;
  minimumLevel?: LogLevel;
  now?: () => number;
  write?: (line: string) => void;
}>;

const LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = Object.freeze({
  info: 0,
  warn: 1,
  error: 2,
});

const PRIVATE_KEY_PARTS = new Set([
  "answer", "answers", "choice", "choices", "correct", "credential", "credentials",
  "key", "keys", "secret", "secrets", "token", "tokens",
]);

function isPrivateKey(key: string): boolean {
  const parts = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length > 0);
  return parts.some((part) => PRIVATE_KEY_PARTS.has(part)) || parts.join("") === "apikey";
}

function safeIdentifier(value: string): string {
  return isPrivateKey(value) ? "[redacted]" : value;
}

function safeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => safeValue(entry, seen)));
  return Object.freeze(Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !isPrivateKey(key))
      .map(([key, entry]) => [key, safeValue(entry, seen)]),
  ));
}

export class ServerLogger {
  readonly #capacity: number;
  readonly #minimumLevel: LogLevel;
  readonly #now: () => number;
  readonly #write: (line: string) => void;
  readonly #entries: StoredServerLogEntry[] = [];
  readonly #listeners = new Set<(entry: StoredServerLogEntry) => void>();
  #sequence = 0;
  #droppedCount = 0;

  constructor(options: LoggerOptions = {}) {
    this.#capacity = options.capacity ?? 500;
    if (!Number.isInteger(this.#capacity) || this.#capacity < 1) {
      throw new Error("Log capacity must be a positive integer");
    }
    this.#minimumLevel = options.minimumLevel ?? "info";
    this.#now = options.now ?? Date.now;
    this.#write = options.write ?? ((line) => process.stdout.write(`${line}\n`));
  }

  info(event: string, context: LogContext = {}): StoredServerLogEntry {
    return this.log("info", event, context);
  }

  warn(event: string, context: LogContext = {}): StoredServerLogEntry {
    return this.log("warn", event, context);
  }

  error(event: string, context: LogContext = {}): StoredServerLogEntry {
    return this.log("error", event, context);
  }

  log(level: LogLevel, event: string, context: LogContext = {}): StoredServerLogEntry {
    let timestamp: string;
    try {
      timestamp = new Date(this.#now()).toISOString();
    } catch {
      this.#droppedCount += 1;
      timestamp = new Date(0).toISOString();
    }
    const sequence = this.#sequence += 1;
    let entry: StoredServerLogEntry;
    try {
      entry = Object.freeze(safeValue({
        sequence,
        ts: timestamp,
        level,
        event: safeIdentifier(event),
        ...(context.sessionId === undefined ? {} : { session_id: safeIdentifier(context.sessionId) }),
        ...(context.actor === undefined
          ? {}
          : { actor: { ...context.actor, ...(context.actor.id === undefined ? {} : { id: safeIdentifier(context.actor.id) }) } }),
        detail: context.detail ?? {},
      }, new WeakSet()) as StoredServerLogEntry);
    } catch {
      this.#droppedCount += 1;
      entry = Object.freeze({
        sequence,
        ts: timestamp,
        level,
        event: "log_redaction_failed",
        detail: Object.freeze({ redaction_failed: true }),
      });
    }
    this.#entries.push(entry);
    if (this.#entries.length > this.#capacity) {
      this.#entries.splice(0, this.#entries.length - this.#capacity);
    }
    if (LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[this.#minimumLevel]) {
      try {
        this.#write(JSON.stringify({
          ts: entry.ts,
          level: entry.level,
          event: entry.event,
          ...(entry.session_id === undefined ? {} : { session_id: entry.session_id }),
          ...(entry.actor === undefined ? {} : { actor: entry.actor }),
          detail: entry.detail,
        }));
      } catch {
        this.#droppedCount += 1;
      }
    }
    for (const listener of [...this.#listeners]) {
      try {
        listener(entry);
      } catch {
        this.#droppedCount += 1;
      }
    }
    return entry;
  }

  get droppedCount(): number {
    return this.#droppedCount;
  }

  entries(): readonly StoredServerLogEntry[] {
    return Object.freeze([...this.#entries]);
  }

  subscribe(listener: (entry: StoredServerLogEntry) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

export const serverLogger = new ServerLogger();

export function createSilentLogger(capacity = 500): ServerLogger {
  return new ServerLogger({ capacity, write: () => undefined });
}
