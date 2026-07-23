export const enginePhases = [
  "LOBBY",
  "QUESTION_OPEN",
  "REVEAL",
  "STANDINGS",
  "PAUSED",
  "ENDED",
] as const;

export type EnginePhase = (typeof enginePhases)[number];

export const commandTypes = [
  "ADVANCE",
  "LOCK",
  "SHOW_STANDINGS",
  "PAUSE",
  "RESUME",
  "END",
] as const;

export type EngineCommand = Readonly<{
  type: (typeof commandTypes)[number];
  attempt_id: string;
}>;

type ActivePhase = Exclude<EnginePhase, "LOBBY" | "PAUSED" | "ENDED">;

export type EngineState = Readonly<{
  phase: EnginePhase;
  attemptId: string | null;
  pausedFrom: ActivePhase | null;
}>;

export type EngineEvent =
  | Readonly<{
      type: "PHASE_CHANGED";
      command: EngineCommand["type"];
      attempt_id: string;
      from: EnginePhase;
      to: EnginePhase;
    }>
  | Readonly<{
      type: "COMMAND_REJECTED";
      command: EngineCommand["type"];
      attempt_id: string;
      code: "WRONG_PHASE" | "STALE_ATTEMPT";
    }>;

export type TransitionResult = Readonly<{
  state: EngineState;
  events: readonly EngineEvent[];
}>;

const legalTransitions: Readonly<
  Record<EnginePhase, Partial<Record<EngineCommand["type"], EnginePhase>>>
> = Object.freeze({
  LOBBY: Object.freeze({ ADVANCE: "QUESTION_OPEN", END: "ENDED" }),
  QUESTION_OPEN: Object.freeze({ LOCK: "REVEAL", PAUSE: "PAUSED", END: "ENDED" }),
  REVEAL: Object.freeze({
    SHOW_STANDINGS: "STANDINGS",
    PAUSE: "PAUSED",
    END: "ENDED",
  }),
  STANDINGS: Object.freeze({ ADVANCE: "QUESTION_OPEN", END: "ENDED" }),
  PAUSED: Object.freeze({ RESUME: "QUESTION_OPEN", END: "ENDED" }),
  ENDED: Object.freeze({}),
});

export function initialEngineState(): EngineState {
  return Object.freeze({ phase: "LOBBY", attemptId: null, pausedFrom: null });
}

function rejected(
  state: EngineState,
  command: EngineCommand,
  code: "WRONG_PHASE" | "STALE_ATTEMPT",
): TransitionResult {
  return Object.freeze({
    state,
    events: Object.freeze([
      Object.freeze({
        type: "COMMAND_REJECTED" as const,
        command: command.type,
        attempt_id: command.attempt_id,
        code,
      }),
    ]),
  });
}

export function transition(state: EngineState, command: EngineCommand): TransitionResult {
  const target = legalTransitions[state.phase][command.type];
  if (target === undefined) {
    return rejected(state, command, "WRONG_PHASE");
  }

  const startsAttempt =
    command.type === "ADVANCE" && (state.phase === "LOBBY" || state.phase === "STANDINGS");
  if (!startsAttempt && state.attemptId !== null && command.attempt_id !== state.attemptId) {
    return rejected(state, command, "STALE_ATTEMPT");
  }

  const resolvedTarget =
    command.type === "RESUME" && state.phase === "PAUSED" && state.pausedFrom !== null
      ? state.pausedFrom
      : target;
  const nextState: EngineState = Object.freeze({
    phase: resolvedTarget,
    attemptId:
      resolvedTarget === "LOBBY" || resolvedTarget === "ENDED"
        ? null
        : startsAttempt
          ? command.attempt_id
          : state.attemptId,
    pausedFrom:
      resolvedTarget === "PAUSED" && state.phase !== "PAUSED"
        ? (state.phase as ActivePhase)
        : null,
  });

  return Object.freeze({
    state: nextState,
    events: Object.freeze([
      Object.freeze({
        type: "PHASE_CHANGED" as const,
        command: command.type,
        attempt_id: command.attempt_id,
        from: state.phase,
        to: resolvedTarget,
      }),
    ]),
  });
}
