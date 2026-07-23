import { describe, expect, it } from "vitest";

import {
  commandTypes,
  initialEngineState,
  transition,
  type EngineCommand,
  type EnginePhase,
  type EngineState,
} from "../../src/engine/phase-machine.js";

const ATTEMPT_ID = "attempt-1";
const NEXT_ATTEMPT_ID = "attempt-2";

const stateFor = (phase: EnginePhase): EngineState =>
  phase === "LOBBY"
    ? initialEngineState()
    : phase === "PAUSED"
      ? Object.freeze({ phase, attemptId: ATTEMPT_ID, pausedFrom: "QUESTION_OPEN" })
      : Object.freeze({ phase, attemptId: ATTEMPT_ID, pausedFrom: null });

const commandFor = (type: EngineCommand["type"], phase: EnginePhase): EngineCommand => ({
  type,
  attempt_id:
    type === "ADVANCE" && (phase === "LOBBY" || phase === "STANDINGS")
      ? NEXT_ATTEMPT_ID
      : ATTEMPT_ID,
});

const expectedTransitions: Readonly<
  Record<EnginePhase, Partial<Record<EngineCommand["type"], EnginePhase>>>
> = Object.freeze({
  LOBBY: { ADVANCE: "QUESTION_OPEN", END: "ENDED" },
  QUESTION_OPEN: { LOCK: "REVEAL", PAUSE: "PAUSED", END: "ENDED" },
  REVEAL: { SHOW_STANDINGS: "STANDINGS", PAUSE: "PAUSED", END: "ENDED" },
  STANDINGS: { ADVANCE: "QUESTION_OPEN", END: "ENDED" },
  PAUSED: { RESUME: "QUESTION_OPEN", END: "ENDED" },
  ENDED: {},
});

describe("rules-agnostic phase machine", () => {
  it("matches the exhaustive phase and command transition table", () => {
    const phases = Object.keys(expectedTransitions) as EnginePhase[];

    for (const phase of phases) {
      for (const commandType of commandTypes) {
        const before = stateFor(phase);
        const command = commandFor(commandType, phase);
        const result = transition(before, command);
        const expectedPhase = expectedTransitions[phase][commandType];

        if (expectedPhase === undefined) {
          expect(result, `${phase} + ${commandType}`).toEqual({
            state: before,
            events: [
              {
                type: "COMMAND_REJECTED",
                command: commandType,
                attempt_id: command.attempt_id,
                code: "WRONG_PHASE",
              },
            ],
          });
        } else {
          expect(result.events, `${phase} + ${commandType}`).toEqual([
            {
              type: "PHASE_CHANGED",
              command: commandType,
              attempt_id: command.attempt_id,
              from: phase,
              to: expectedPhase,
            },
          ]);
          expect(result.state.phase, `${phase} + ${commandType}`).toBe(expectedPhase);
        }
      }
    }
  });

  it("returns WRONG_PHASE and the identical state for an illegal transition", () => {
    const before = stateFor("LOBBY");

    const result = transition(before, { type: "RESUME", attempt_id: ATTEMPT_ID });

    expect(result.state).toBe(before);
    expect(result.events[0]).toMatchObject({ code: "WRONG_PHASE" });
  });

  it("restores the source phase after a pause", () => {
    const open = stateFor("QUESTION_OPEN");
    const paused = transition(open, { type: "PAUSE", attempt_id: ATTEMPT_ID });
    const resumed = transition(paused.state, { type: "RESUME", attempt_id: ATTEMPT_ID });

    expect(paused.state).toEqual({
      phase: "PAUSED",
      attemptId: ATTEMPT_ID,
      pausedFrom: "QUESTION_OPEN",
    });
    expect(resumed.state).toEqual(open);
  });

  it("rejects a stale attempt without changing state", () => {
    const before = stateFor("QUESTION_OPEN");

    const result = transition(before, { type: "LOCK", attempt_id: "stale-attempt" });

    expect(result).toEqual({
      state: before,
      events: [
        {
          type: "COMMAND_REJECTED",
          command: "LOCK",
          attempt_id: "stale-attempt",
          code: "STALE_ATTEMPT",
        },
      ],
    });
  });

  it("produces the same event sequence for the same command sequence", () => {
    const commands: EngineCommand[] = [
      { type: "ADVANCE", attempt_id: ATTEMPT_ID },
      { type: "PAUSE", attempt_id: ATTEMPT_ID },
      { type: "RESUME", attempt_id: ATTEMPT_ID },
      { type: "LOCK", attempt_id: ATTEMPT_ID },
      { type: "SHOW_STANDINGS", attempt_id: ATTEMPT_ID },
      { type: "ADVANCE", attempt_id: NEXT_ATTEMPT_ID },
      { type: "END", attempt_id: NEXT_ATTEMPT_ID },
    ];
    const run = (): unknown[] => {
      let state = initialEngineState();
      return commands.flatMap((command) => {
        const result = transition(state, command);
        state = result.state;
        return result.events;
      });
    };

    expect(run()).toEqual(run());
    expect(run()).toMatchInlineSnapshot(`
      [
        {
          "attempt_id": "attempt-1",
          "command": "ADVANCE",
          "from": "LOBBY",
          "to": "QUESTION_OPEN",
          "type": "PHASE_CHANGED",
        },
        {
          "attempt_id": "attempt-1",
          "command": "PAUSE",
          "from": "QUESTION_OPEN",
          "to": "PAUSED",
          "type": "PHASE_CHANGED",
        },
        {
          "attempt_id": "attempt-1",
          "command": "RESUME",
          "from": "PAUSED",
          "to": "QUESTION_OPEN",
          "type": "PHASE_CHANGED",
        },
        {
          "attempt_id": "attempt-1",
          "command": "LOCK",
          "from": "QUESTION_OPEN",
          "to": "REVEAL",
          "type": "PHASE_CHANGED",
        },
        {
          "attempt_id": "attempt-1",
          "command": "SHOW_STANDINGS",
          "from": "REVEAL",
          "to": "STANDINGS",
          "type": "PHASE_CHANGED",
        },
        {
          "attempt_id": "attempt-2",
          "command": "ADVANCE",
          "from": "STANDINGS",
          "to": "QUESTION_OPEN",
          "type": "PHASE_CHANGED",
        },
        {
          "attempt_id": "attempt-2",
          "command": "END",
          "from": "QUESTION_OPEN",
          "to": "ENDED",
          "type": "PHASE_CHANGED",
        },
      ]
    `);
  });
});
