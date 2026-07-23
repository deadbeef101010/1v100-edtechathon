import type { Server as SocketIoServer } from "socket.io";

import { createSilentLogger, type ServerLogger } from "./log.js";

export const EXCLUDE = Symbol("EXCLUDE");
export type Exclude = typeof EXCLUDE;

export const studentRoom = (sessionId: string): string => `s:${sessionId}:players`;
export const projectorRoom = (sessionId: string): string => `s:${sessionId}:projector`;
export const teacherRoom = (sessionId: string): string => `s:${sessionId}:teacher`;
export const answererRoom = (sessionId: string): string => `s:${sessionId}:answerers`;
export const oneRoom = (sessionId: string): string => `s:${sessionId}:one`;
export const playerRoom = (sessionId: string, playerId: string): string =>
  `s:${sessionId}:p:${playerId}`;

type QuestionPacket = Readonly<Partial<{
  attempt_id: unknown;
  question_id: unknown;
  index: unknown;
  prompt: unknown;
  choices: unknown;
  started_at_ms: unknown;
  deadline_ms: unknown;
  server_time_ms: unknown;
  server_seq: unknown;
}>>;
type StatusPacket = Readonly<Partial<{
  phase: unknown;
  index: unknown;
  reason: unknown;
  locked_count: unknown;
  eligible_count: unknown;
  remaining_ms: unknown;
  deadline_ms: unknown;
  server_time_ms: unknown;
  server_seq: unknown;
  momentum: unknown;
}>>;
type RevealPacket = Readonly<Partial<{
  attempt_id: unknown;
  question_id: unknown;
  correct_choice: unknown;
  counts: unknown;
  outcomes: unknown;
  one_correct: unknown;
  demoted: unknown;
  score_deltas: unknown;
  bank_delta: unknown;
  bank: unknown;
  fast_window_ms: unknown;
  one_duration_ms: unknown;
  forced: unknown;
  server_time_ms: unknown;
  deadline_ms: unknown;
  server_seq: unknown;
}>>;
type PhaseBPacket = Readonly<Partial<{
  attempt_id: unknown;
  question_id: unknown;
  index: unknown;
  prompt: unknown;
  choices: unknown;
  started_at_ms: unknown;
  helps_available: unknown;
  bank: unknown;
  strikes: unknown;
  momentum: unknown;
  server_seq: unknown;
  server_time_ms: unknown;
}>>;
type StrikePacket = Readonly<Partial<{
  remaining: unknown;
  base: unknown;
  earned_extra: unknown;
  server_seq: unknown;
  server_time_ms: unknown;
}>>;
type MeterProgressPacket = Readonly<Partial<{
  progress: unknown;
  threshold: unknown;
  credited: unknown;
  reason: unknown;
  server_seq: unknown;
  server_time_ms: unknown;
}>>;
type MeterFilledPacket = Readonly<Partial<{
  progress: unknown;
  threshold: unknown;
  strikes_remaining: unknown;
  awarded_once: unknown;
  server_seq: unknown;
  server_time_ms: unknown;
}>>;
type SnapshotPacket = Readonly<Partial<{
  phase: unknown;
  attempt_id: unknown;
  index: unknown;
  question: unknown;
  own_answer: unknown;
  locked_count: unknown;
  eligible_count: unknown;
  bank: unknown;
  strikes: unknown;
  paused: unknown;
  helps_available: unknown;
  helps_used: unknown;
  help_result: unknown;
  server_seq: unknown;
  session: unknown;
  game: unknown;
  momentum: unknown;
  leaderboard: unknown;
  self: unknown;
  server_time_ms: unknown;
  deadline_ms: unknown;
}>>;
type LeaderboardPacket = Readonly<Partial<{
  scope: unknown;
  rows: unknown;
  deadline_ms: unknown;
  server_time_ms: unknown;
  server_seq: unknown;
}>>;
type RosterPacket = readonly Readonly<Partial<{
  player_id: unknown;
  nickname: unknown;
  connected: unknown;
  role: unknown;
}>>[];
type EndedPacket = Readonly<Partial<{
  session_id: unknown;
  reason: unknown;
  server_seq: unknown;
  server_time_ms: unknown;
  deadline_ms: unknown;
  final_leaderboard: unknown;
}>>;
type GameStartPacket = Readonly<Partial<{
  game_id: unknown;
  ordinal: unknown;
  one: unknown;
  mob_count: unknown;
  deck_size: unknown;
  base_strikes: unknown;
  momentum_enabled: unknown;
  server_seq: unknown;
  server_time_ms: unknown;
}>>;
type NextGamePacket = Readonly<Partial<{
  ordinal: unknown;
  one: unknown;
  starts_at_ms: unknown;
  server_seq: unknown;
  server_time_ms: unknown;
}>>;
type GameEndPacket = Readonly<Partial<{
  reason: unknown;
  payouts: unknown;
  bank: unknown;
  banked_by_one: unknown;
  leaderboard_at_ms: unknown;
  server_seq: unknown;
  server_time_ms: unknown;
}>>;
type CommandErrorPacket = Readonly<Partial<{
  ok: unknown;
  requestId: unknown;
  request_id: unknown;
  code: unknown;
  message: unknown;
}>>;
type PauseStatePacket = Readonly<Partial<{
  paused: unknown;
  reason: unknown;
  remaining_ms: unknown;
  deadline_ms: unknown;
  server_seq: unknown;
  server_time_ms: unknown;
}>>;
type HelpPollPacket = Readonly<Partial<{
  choice: unknown; count: unknown; total_answers: unknown; server_seq: unknown; server_time_ms: unknown;
}>>;
type HelpAskPacket = Readonly<Partial<{
  speakers: unknown; bonus_each: unknown; server_seq: unknown; server_time_ms: unknown;
}>>;
type HelpTrustPacket = Readonly<Partial<{
  plurality_choice: unknown; counts: unknown; tie_candidates: unknown; locked: unknown;
  server_seq: unknown; server_time_ms: unknown;
}>>;

// Declaring an event here is what permits it to leave the server. Each audience
// shape lists the only top-level fields that its runtime schema may project.
export type ApplicationEventPayloads = Readonly<{
  question_open: Readonly<{
    teacher: QuestionPacket;
    projector: QuestionPacket;
    one: QuestionPacket;
    answerers: QuestionPacket;
    players: QuestionPacket;
  }>;
  phase_a_start: Readonly<{ answerers: QuestionPacket; teacher: QuestionPacket }>;
  phase_a_status: Readonly<{ teacher: StatusPacket; projector: StatusPacket; one: StatusPacket }>;
  phase_b_start: Readonly<{
    teacher: PhaseBPacket; projector: PhaseBPacket; one: PhaseBPacket; answerers: PhaseBPacket;
  }>;
  help_poll_result: Readonly<{
    teacher: HelpPollPacket; projector: HelpPollPacket; one: HelpPollPacket; answerers: HelpPollPacket; players: HelpPollPacket;
  }>;
  help_ask_result: Readonly<{
    teacher: HelpAskPacket; projector: HelpAskPacket; one: HelpAskPacket; answerers: HelpAskPacket; players: HelpAskPacket;
  }>;
  help_trust_result: Readonly<{
    teacher: HelpTrustPacket; projector: HelpTrustPacket; one: HelpTrustPacket; answerers: HelpTrustPacket; players: HelpTrustPacket;
  }>;
  pause_state: Readonly<{
    teacher: PauseStatePacket; projector: PauseStatePacket; one: PauseStatePacket; answerers: PauseStatePacket;
  }>;
  strike: Readonly<{
    teacher: StrikePacket; projector: StrikePacket; one: StrikePacket; answerers: StrikePacket;
  }>;
  meter_progress: Readonly<{
    teacher: MeterProgressPacket; projector: MeterProgressPacket; one: MeterProgressPacket;
    answerers: MeterProgressPacket; players: MeterProgressPacket;
  }>;
  meter_filled: Readonly<{
    teacher: MeterFilledPacket; projector: MeterFilledPacket; one: MeterFilledPacket;
    answerers: MeterFilledPacket; players: MeterFilledPacket;
  }>;
  lock_counts: Readonly<{
    teacher: StatusPacket;
    projector: StatusPacket;
    one: StatusPacket;
    answerers: StatusPacket;
    players: StatusPacket;
  }>;
  phase_a_locked: Readonly<{
    teacher: StatusPacket;
    projector: StatusPacket;
    one: StatusPacket;
    answerers: StatusPacket;
    players: StatusPacket;
  }>;
  phase_state: Readonly<{
    teacher: StatusPacket;
    projector: StatusPacket;
    one: StatusPacket;
    answerers: StatusPacket;
    players: StatusPacket;
  }>;
  reveal: Readonly<{
    teacher: RevealPacket;
    projector: RevealPacket;
    one: RevealPacket;
    answerers: RevealPacket;
    players: RevealPacket;
    "player:*": RevealPacket;
  }>;
  leaderboard: Readonly<{ teacher: LeaderboardPacket; projector: LeaderboardPacket; players: LeaderboardPacket }>;
  roster_update: Readonly<{ teacher: RosterPacket; projector: RosterPacket; players: RosterPacket }>;
  state_snapshot: Readonly<{
    teacher: SnapshotPacket;
    projector: SnapshotPacket;
    one: SnapshotPacket;
    answerers: SnapshotPacket;
    players: SnapshotPacket;
    "player:*": SnapshotPacket;
  }>;
  session_ended: Readonly<{ teacher: EndedPacket; projector: EndedPacket; players: EndedPacket }>;
  session_end: Readonly<{ teacher: EndedPacket; projector: EndedPacket; players: EndedPacket }>;
  game_start: Readonly<{
    teacher: GameStartPacket; projector: GameStartPacket; one: GameStartPacket;
    answerers: GameStartPacket; players: GameStartPacket;
  }>;
  next_game: Readonly<{
    teacher: NextGamePacket; projector: NextGamePacket; one: NextGamePacket;
    answerers: NextGamePacket; players: NextGamePacket;
  }>;
  game_end: Readonly<{
    teacher: GameEndPacket; projector: GameEndPacket; one: GameEndPacket;
    answerers: GameEndPacket; players: GameEndPacket;
  }>;
  question_set_attached: Readonly<{ teacher: Readonly<Partial<{
    question_set_id: unknown;
    server_seq: unknown;
    server_time_ms: unknown;
  }>> }>;
  kicked: Readonly<{ "player:*": Readonly<Partial<{ code: unknown; message: unknown }>> }>;
  command_error: Readonly<{
    teacher: CommandErrorPacket;
    projector: CommandErrorPacket;
    one: CommandErrorPacket;
    answerers: CommandErrorPacket;
    "player:*": CommandErrorPacket;
  }>;
}>;

export type ApplicationEvent = keyof ApplicationEventPayloads;
type DeclaredAudience<Event extends ApplicationEvent> = keyof ApplicationEventPayloads[Event] & string;
type ConcreteAudience<Audience extends string> = Audience extends "player:*"
  ? `player:${string}`
  : Audience;
export type Audience = "teacher" | "projector" | "one" | "answerers" | "players" | `player:${string}`;
export type EventViews<Event extends ApplicationEvent> = Partial<{
  readonly [Audience in DeclaredAudience<Event> as ConcreteAudience<Audience>]:
    ApplicationEventPayloads[Event][Audience] | Exclude;
}>;

const VALUE: unique symbol = Symbol("VALUE");
type ProjectionSchema = typeof VALUE | Readonly<{ array: ProjectionSchema }> |
  Readonly<{ fields: Readonly<Record<string, ProjectionSchema>> }>;
const value: typeof VALUE = VALUE;
const array = (item: ProjectionSchema): ProjectionSchema => Object.freeze({ array: item });
const fields = (entries: Readonly<Record<string, ProjectionSchema>>): ProjectionSchema =>
  Object.freeze({ fields: Object.freeze(entries) });

const timingFields = {
  deadline_ms: value,
  server_time_ms: value,
  server_seq: value,
} as const;
const statusSchema = fields({
  phase: value,
  index: value,
  reason: value,
  locked_count: value,
  eligible_count: value,
  remaining_ms: value,
  momentum: fields({ enabled: value, progress: value }),
  ...timingFields,
});
const questionSchema = fields({
  attempt_id: value,
  question_id: value,
  index: value,
  prompt: value,
  choices: array(value),
  started_at_ms: value,
  ...timingFields,
});
const revealSchema = fields({
  attempt_id: value,
  question_id: value,
  correct_choice: value,
  counts: array(value),
  outcomes: array(fields({
    player_id: value,
    choice: value,
    correct: value,
    delta: value,
    streak: value,
  })),
  one_correct: value,
  demoted: array(value),
  score_deltas: array(fields({ player_id: value, points: value, reason: value })),
  bank_delta: value,
  bank: value,
  fast_window_ms: value,
  one_duration_ms: value,
  forced: value,
  ...timingFields,
});
const phaseBSchema = fields({
  attempt_id: value,
  question_id: value,
  index: value,
  prompt: value,
  choices: array(value),
  started_at_ms: value,
  helps_available: fields({ poll: value, ask: value, trust: value }),
  bank: value,
  strikes: value,
  momentum: fields({ enabled: value, progress: value }),
  server_seq: value,
  server_time_ms: value,
});
const strikeSchema = fields({
  remaining: value,
  base: value,
  earned_extra: value,
  server_seq: value,
  server_time_ms: value,
});
const meterProgressSchema = fields({
  progress: value,
  threshold: value,
  credited: value,
  reason: value,
  server_seq: value,
  server_time_ms: value,
});
const meterFilledSchema = fields({
  progress: value,
  threshold: value,
  strikes_remaining: value,
  awarded_once: value,
  server_seq: value,
  server_time_ms: value,
});
const pauseStateSchema = fields({
  paused: value,
  reason: value,
  remaining_ms: value,
  deadline_ms: value,
  server_seq: value,
  server_time_ms: value,
});
const helpPollSchema = fields({
  choice: value, count: value, total_answers: value, server_seq: value, server_time_ms: value,
});
const helpAskSchema = fields({
  speakers: array(fields({ player_id: value, nickname: value, choice: value })),
  bonus_each: value,
  server_seq: value,
  server_time_ms: value,
});
const helpTrustSchema = fields({
  plurality_choice: value,
  counts: array(value),
  tie_candidates: array(value),
  locked: value,
  server_seq: value,
  server_time_ms: value,
});
const leaderboardSchema = fields({
  scope: value,
  rows: array(fields({
    rank: value,
    player_id: value,
    nickname: value,
    points: value,
    connected: value,
    has_been_one: value,
  })),
  ...timingFields,
});
const rosterSchema = array(fields({
  player_id: value,
  nickname: value,
  connected: value,
  role: value,
}));
const snapshotSchema = fields({
  phase: value,
  attempt_id: value,
  index: value,
  question: fields({ question_id: value, prompt: value, choices: array(value) }),
  own_answer: value,
  locked_count: value,
  eligible_count: value,
  bank: value,
  strikes: value,
  paused: value,
  helps_available: fields({ poll: value, ask: value, trust: value }),
  helps_used: fields({ poll: value, ask: value, trust: value }),
  help_result: fields({
    type: value,
    choice: value,
    count: value,
    total_answers: value,
    speakers: array(fields({ player_id: value, nickname: value, choice: value })),
    bonus_each: value,
    plurality_choice: value,
    counts: array(value),
    tie_candidates: array(value),
    locked: value,
  }),
  question_exposed: value,
  server_seq: value,
  session: fields({ session_id: value, status: value, mode: value }),
  game: fields({
    game_id: value,
    ordinal: value,
    one: fields({ player_id: value, nickname: value }),
    mob_count: value,
    crowd_count: value,
    phase: value,
    strikes_remaining: value,
    base_strikes: value,
    bank: value,
    momentum_enabled: value,
    momentum: fields({
      enabled: value,
      progress: value,
      threshold: value,
      awarded_once: value,
    }),
    helps_available: fields({ poll: value, ask: value, trust: value }),
    paused: fields({ active: value, reason: value }),
    question: fields({ index: value, question_id: value, prompt: value, choices: array(value), deadline_ms: value }),
    last_result: fields({
      reason: value,
      payouts: array(fields({ player_id: value, points: value })),
      bank: value,
      banked_by_one: value,
    }),
  }),
  momentum: fields({
    enabled: value,
    progress: value,
    threshold: value,
    awarded_once: value,
  }),
  leaderboard: array(fields({
    rank: value,
    player_id: value,
    nickname: value,
    points: value,
    has_been_one: value,
  })),
  self: fields({
    player_id: value,
    role: value,
    points: value,
    streak: value,
    answered: value,
    choice: value,
    is_speaker: value,
  }),
  server_time_ms: value,
  deadline_ms: value,
});
const endedSchema = fields({
  session_id: value,
  reason: value,
  server_seq: value,
  server_time_ms: value,
  deadline_ms: value,
  final_leaderboard: array(fields({
    rank: value,
    player_id: value,
    nickname: value,
    points: value,
    has_been_one: value,
  })),
});
const commandErrorSchema = fields({
  ok: value,
  requestId: value,
  request_id: value,
  code: value,
  message: value,
});
const gameStartSchema = fields({
  game_id: value,
  ordinal: value,
  one: fields({ id: value, nickname: value }),
  mob_count: value,
  deck_size: value,
  base_strikes: value,
  momentum_enabled: value,
  server_seq: value,
  server_time_ms: value,
});
const nextGameSchema = fields({
  ordinal: value,
  one: fields({ id: value, nickname: value }),
  starts_at_ms: value,
  server_seq: value,
  server_time_ms: value,
});
const gameEndSchema = fields({
  reason: value,
  payouts: array(fields({ player_id: value, points: value })),
  bank: value,
  banked_by_one: value,
  leaderboard_at_ms: value,
  server_seq: value,
  server_time_ms: value,
});

type EventPolicy = Readonly<Record<string, ProjectionSchema>>;
const EVENT_POLICIES: Readonly<Record<ApplicationEvent, EventPolicy>> = Object.freeze({
  question_open: Object.freeze({
    teacher: questionSchema,
    projector: questionSchema,
    one: questionSchema,
    answerers: questionSchema,
    players: questionSchema,
  }),
  phase_a_start: Object.freeze({ answerers: questionSchema, teacher: questionSchema }),
  phase_a_status: Object.freeze({ teacher: statusSchema, projector: statusSchema, one: statusSchema }),
  phase_b_start: Object.freeze({ teacher: phaseBSchema, projector: phaseBSchema, one: phaseBSchema, answerers: phaseBSchema }),
  help_poll_result: Object.freeze({ teacher: helpPollSchema, projector: helpPollSchema, one: helpPollSchema, answerers: helpPollSchema, players: helpPollSchema }),
  help_ask_result: Object.freeze({ teacher: helpAskSchema, projector: helpAskSchema, one: helpAskSchema, answerers: helpAskSchema, players: helpAskSchema }),
  help_trust_result: Object.freeze({ teacher: helpTrustSchema, projector: helpTrustSchema, one: helpTrustSchema, answerers: helpTrustSchema, players: helpTrustSchema }),
  pause_state: Object.freeze({ teacher: pauseStateSchema, projector: pauseStateSchema, one: pauseStateSchema, answerers: pauseStateSchema }),
  strike: Object.freeze({ teacher: strikeSchema, projector: strikeSchema, one: strikeSchema, answerers: strikeSchema }),
  meter_progress: Object.freeze({ teacher: meterProgressSchema, projector: meterProgressSchema, one: meterProgressSchema, answerers: meterProgressSchema, players: meterProgressSchema }),
  meter_filled: Object.freeze({ teacher: meterFilledSchema, projector: meterFilledSchema, one: meterFilledSchema, answerers: meterFilledSchema, players: meterFilledSchema }),
  lock_counts: Object.freeze({ teacher: statusSchema, projector: statusSchema, one: statusSchema, answerers: statusSchema, players: statusSchema }),
  phase_a_locked: Object.freeze({ teacher: statusSchema, projector: statusSchema, one: statusSchema, answerers: statusSchema, players: statusSchema }),
  phase_state: Object.freeze({ teacher: statusSchema, projector: statusSchema, one: statusSchema, answerers: statusSchema, players: statusSchema }),
  reveal: Object.freeze({ teacher: revealSchema, projector: revealSchema, one: revealSchema, answerers: revealSchema, players: revealSchema, "player:*": revealSchema }),
  leaderboard: Object.freeze({ teacher: leaderboardSchema, projector: leaderboardSchema, players: leaderboardSchema }),
  roster_update: Object.freeze({ teacher: rosterSchema, projector: rosterSchema, players: rosterSchema }),
  state_snapshot: Object.freeze({ teacher: snapshotSchema, projector: snapshotSchema, one: snapshotSchema, answerers: snapshotSchema, players: snapshotSchema, "player:*": snapshotSchema }),
  session_ended: Object.freeze({ teacher: endedSchema, projector: endedSchema, players: endedSchema }),
  session_end: Object.freeze({ teacher: endedSchema, projector: endedSchema, players: endedSchema }),
  game_start: Object.freeze({ teacher: gameStartSchema, projector: gameStartSchema, one: gameStartSchema, answerers: gameStartSchema, players: gameStartSchema }),
  next_game: Object.freeze({ teacher: nextGameSchema, projector: nextGameSchema, one: nextGameSchema, answerers: nextGameSchema, players: nextGameSchema }),
  game_end: Object.freeze({ teacher: gameEndSchema, projector: gameEndSchema, one: gameEndSchema, answerers: gameEndSchema, players: gameEndSchema }),
  question_set_attached: Object.freeze({ teacher: fields({ question_set_id: value, server_seq: value, server_time_ms: value }) }),
  kicked: Object.freeze({ "player:*": fields({ code: value, message: value }) }),
  command_error: Object.freeze({ teacher: commandErrorSchema, projector: commandErrorSchema, one: commandErrorSchema, answerers: commandErrorSchema, "player:*": commandErrorSchema }),
});

const RESPONSE_EVENTS = new Set([
  "join_session",
  "projector_attach",
  "resume",
  "answer_submit",
  "one_answer",
  "help_poll",
  "help_ask",
  "help_trust",
  "teacher_open_question",
  "teacher_end_session",
  "teacher_rotate_session_code",
  "teacher_rotate_projector_credential",
  "kick_player",
  "assign_role",
  "teacher_attach_question_set",
  "teacher_attach",
  "teacher_advance",
  "teacher_pause",
  "teacher_resume",
  "teacher_force_reveal",
  "teacher_rotate_session_code",
  "teacher_rotate_projector_credential",
  "teacher_start_session",
  "teacher_select_next_one",
  "teacher_settings",
]);

type ResponseCallback = (...args: [payload: unknown]) => unknown;

function audiencePolicy(policy: EventPolicy, audience: string): ProjectionSchema | undefined {
  return policy[audience] ?? (audience.startsWith("player:") ? policy["player:*"] : undefined);
}

function audienceRoom(sessionId: string, audience: Audience): string {
  if (audience === "teacher") return teacherRoom(sessionId);
  if (audience === "projector") return projectorRoom(sessionId);
  if (audience === "one") return oneRoom(sessionId);
  if (audience === "answerers") return answererRoom(sessionId);
  if (audience === "players") return studentRoom(sessionId);
  return playerRoom(sessionId, audience.slice("player:".length));
}

// Most specific membership always wins, including EXCLUDE. This total order is
// independent of view object key order and prevents broad-room fallthrough.
function audiencePriority(audience: Audience): number {
  if (audience.startsWith("player:")) return 6;
  if (audience === "one") return 5;
  if (audience === "projector") return 4;
  if (audience === "answerers") return 3;
  if (audience === "teacher") return 2;
  return 1;
}

function project(schema: ProjectionSchema, payload: unknown): unknown {
  if (schema === VALUE) return payload;
  if ("array" in schema) {
    if (!Array.isArray(payload)) return undefined;
    return Object.freeze(payload.map((entry) => project(schema.array, entry)));
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const source = payload as Readonly<Record<string, unknown>>;
  const result: Record<string, unknown> = {};
  for (const [key, childSchema] of Object.entries(schema.fields)) {
    if (!(key in source)) continue;
    const projected = project(childSchema, source[key]);
    if (projected !== undefined) result[key] = projected;
  }
  return Object.freeze(result);
}

export function projectApplicationPacket(
  event: ApplicationEvent,
  audience: Audience,
  payload: unknown,
): unknown | Exclude {
  const policy = EVENT_POLICIES[event];
  const schema = audiencePolicy(policy, audience);
  return schema === undefined ? EXCLUDE : project(schema, payload);
}

export class ApplicationEmitter {
  readonly #io: SocketIoServer;
  readonly #sessionId: string;
  readonly #logger: ServerLogger;

  constructor(io: SocketIoServer, sessionId: string, logger: ServerLogger = createSilentLogger()) {
    this.#io = io;
    this.#sessionId = sessionId;
    this.#logger = logger;
  }

  emit<Event extends ApplicationEvent>(event: Event, views: EventViews<Event>): void;
  emit(event: string, views: Readonly<Record<string, unknown | Exclude>>): void;
  emit(event: string, views: Readonly<Record<string, unknown | Exclude>>): void {
    const policy = (EVENT_POLICIES as Readonly<Record<string, EventPolicy | undefined>>)[event];
    if (policy === undefined) {
      this.#logger.warn("broadcast_excluded", {
        sessionId: this.#sessionId,
        actor: { kind: "system", id: "system" },
        detail: { event, cause: "unknown_event" },
      });
      return;
    }

    const deliveries = new Map<string, Readonly<{ priority: number; payload: unknown | Exclude }>>();
    const audiences: string[] = [];
    for (const [rawAudience, payload] of Object.entries(views)) {
      const schema = audiencePolicy(policy, rawAudience);
      if (schema === undefined) continue;
      const audience = rawAudience as Audience;
      audiences.push(audience);
      const sockets = this.#io.sockets.adapter.rooms.get(audienceRoom(this.#sessionId, audience));
      if (sockets === undefined) continue;
      const priority = audiencePriority(audience);
      const projected = payload === EXCLUDE ? EXCLUDE : project(schema, payload);
      for (const socketId of sockets) {
        const current = deliveries.get(socketId);
        if (current === undefined || priority > current.priority) {
          deliveries.set(socketId, Object.freeze({ priority, payload: projected }));
        }
      }
    }

    const grouped = new Map<unknown, string[]>();
    for (const [socketId, delivery] of deliveries) {
      if (delivery.payload === EXCLUDE) continue;
      const socketIds = grouped.get(delivery.payload) ?? [];
      socketIds.push(socketId);
      grouped.set(delivery.payload, socketIds);
    }
    for (const [payload, socketIds] of grouped) {
      this.#io.to(socketIds).emit(event, payload);
    }
    this.#logger.info("broadcast_sent", {
      sessionId: this.#sessionId,
      actor: { kind: "system", id: "system" },
      detail: {
        event,
        audiences,
        recipient_count: [...grouped.values()].reduce((total, ids) => total + ids.length, 0),
      },
    });
  }
}

export function emitApplicationPacket<Event extends ApplicationEvent>(
  emitter: ApplicationEmitter,
  event: Event,
  views: EventViews<Event>,
): void {
  emitter.emit(event, views);
}

export function respondApplicationPacket(
  event: string,
  callback: ResponseCallback,
  payload: unknown,
  logger: ServerLogger = createSilentLogger(),
): void {
  if (!RESPONSE_EVENTS.has(event)) {
    logger.warn("response_excluded", {
      actor: { kind: "system", id: "system" },
      detail: { event, cause: "unknown_event" },
    });
    return;
  }
  callback(payload);
}

type Snapshot = Readonly<{
  phase?: string;
  question?: unknown;
  question_exposed?: boolean;
  own_answer?: unknown;
  question_phase?: unknown;
  game?: Readonly<{ phase?: unknown; question?: unknown }>;
  [key: string]: unknown;
}>;

export function snapshotView(
  snapshot: Snapshot,
  options: Readonly<{
    audience: "teacher" | "projector" | "one" | "answerer";
    eligible?: boolean;
  }>,
): Readonly<Record<string, unknown>> {
  const phaseProjected: Record<string, unknown> = { ...snapshot };
  if (snapshot.game !== undefined) {
    const phase = snapshot.question_phase ?? snapshot.game.phase;
    const maySeeQuestion = phase === "PHASE_B" || phase === "REVEAL" ||
      (phase === "PHASE_A" && (options.audience === "teacher" ||
        (options.audience === "answerer" && options.eligible === true)));
    const maySeeLegacyQuestion = maySeeQuestion &&
      !(snapshot.game.phase === "PAUSED" && snapshot.question_exposed === false);
    if (!maySeeQuestion) {
      phaseProjected.game = Object.freeze({ ...snapshot.game, question: undefined });
    }
    if (!maySeeLegacyQuestion) {
      delete phaseProjected.question;
    }
  } else {
    const visible = options.audience === "projector" || options.audience === "one"
      ? new Set(["QUESTION_OPEN", "LOCKED", "PAUSED", "REVEALED", "PHASE_B", "REVEAL"])
      : new Set(["QUESTION_OPEN", "LOCKED", "PAUSED", "REVEALED", "PHASE_A", "PHASE_B", "REVEAL"]);
    const maySeeQuestion = snapshot.phase !== undefined && visible.has(snapshot.phase) &&
      (snapshot.phase !== "PAUSED" || snapshot.question_exposed !== false) &&
      (options.audience !== "answerer" || options.eligible === true);
    if (!maySeeQuestion) delete phaseProjected.question;
  }
  const policyAudience = options.audience === "answerer" ? "answerers" : options.audience;
  return projectApplicationPacket("state_snapshot", policyAudience, phaseProjected) as Readonly<Record<string, unknown>>;
}
