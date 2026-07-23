import type { Ruleset1v100Settings } from "./ruleset-settings.js";

export type ScoringPlayer = Readonly<{
  id: string;
  role: "one" | "mob" | "crowd";
  points: number;
  streak: number;
}>;

export type ScoringAnswer = Readonly<{
  playerId: string;
  choice: number | null;
}>;

export type GameEndReason = "flameout" | "deck_survived" | "mob_emptied";

export type ScoreDelta = Readonly<{
  player_id: string;
  points: number;
  reason: string;
}>;

export type RevealScoringResult = Readonly<{
  players: readonly ScoringPlayer[];
  demoted: readonly string[];
  scoreDeltas: readonly ScoreDelta[];
  payouts: readonly Readonly<{ player_id: string; points: number }>[];
  bankDelta: number;
  bank: number;
  strikesRemaining: number;
  endReason: GameEndReason | null;
  bankedByOne: number;
}>;

export function scoreOneV100Reveal(input: Readonly<{
  players: readonly ScoringPlayer[];
  eligiblePlayerIds: readonly string[];
  answers: readonly ScoringAnswer[];
  correctChoice: number;
  onePlayerId: string;
  oneCorrect: boolean;
  strikesRemaining: number;
  bank: number;
  questionNumber: number;
  deckSize: number;
  settings: Ruleset1v100Settings;
}>): RevealScoringResult {
  const eligible = new Set(input.eligiblePlayerIds);
  const answers = new Map(input.answers.map((answer) => [answer.playerId, answer.choice]));
  const next = new Map(input.players.map((player) => [player.id, { ...player }]));
  const deltas: ScoreDelta[] = [];
  const addPoints = (playerId: string, points: number, reason: string): void => {
    if (points === 0) return;
    const player = next.get(playerId);
    if (player === undefined) return;
    player.points += points;
    deltas.push(Object.freeze({ player_id: playerId, points, reason }));
  };

  for (const playerId of eligible) {
    const player = next.get(playerId);
    if (player === undefined || player.role === "one") continue;
    const correct = answers.get(playerId) === input.correctChoice;
    player.streak = correct ? player.streak + 1 : 0;
    if (correct) {
      const base = player.role === "mob"
        ? input.settings.mob_correct_points
        : input.settings.crowd_correct_points;
      addPoints(player.id, base + input.settings.streak_bonus_per_step * player.streak, "correct_answer");
    }
  }

  const demoted: string[] = [];
  let bankDelta = 0;
  if (input.oneCorrect) {
    for (const playerId of eligible) {
      const player = next.get(playerId);
      if (player?.role !== "mob" || answers.get(playerId) === input.correctChoice) continue;
      player.role = "crowd";
      demoted.push(player.id);
    }
    bankDelta = input.settings.bank_per_elimination * demoted.length;
  }
  const bank = input.bank + bankDelta;
  const strikesRemaining = input.oneCorrect
    ? input.strikesRemaining
    : Math.max(0, input.strikesRemaining - 1);
  const survivingMob = [...next.values()].filter((player) => player.role === "mob");
  const endReason: GameEndReason | null = strikesRemaining === 0
    ? "flameout"
    : survivingMob.length === 0
      ? "mob_emptied"
      : input.questionNumber >= input.deckSize
        ? "deck_survived"
        : null;

  // Momentum is intentionally a no-op here. Its later hook runs after the
  // survival drip and before ending payouts without changing this ordering.
  if (endReason !== "flameout") {
    addPoints(input.onePlayerId, input.settings.survival_drip, "survival_drip");
  }

  const payouts: Array<{ player_id: string; points: number }> = [];
  let bankedByOne = 0;
  const payout = (playerId: string, points: number, reason: string): void => {
    if (points === 0) return;
    if (!next.has(playerId)) return;
    addPoints(playerId, points, reason);
    payouts.push(Object.freeze({ player_id: playerId, points }));
  };
  if (endReason === "flameout") {
    bankedByOne = Math.floor(bank * input.settings.bank_keep_fraction_on_flameout);
    payout(input.onePlayerId, bankedByOne, "flameout_keep");
    const share = survivingMob.length === 0
      ? 0
      : Math.floor((bank - bankedByOne) / survivingMob.length);
    for (const player of survivingMob) payout(player.id, share, "flameout_split");
  } else if (endReason === "deck_survived") {
    bankedByOne = bank;
    payout(input.onePlayerId, bankedByOne, "bank");
    for (const player of survivingMob) {
      payout(player.id, input.settings.deck_survived_mob_bonus, "deck_survived");
    }
  } else if (endReason === "mob_emptied") {
    bankedByOne = Math.floor(bank * input.settings.jackpot_multiplier);
    payout(input.onePlayerId, bankedByOne, "jackpot");
  }

  return Object.freeze({
    players: Object.freeze([...next.values()].map((player) => Object.freeze(player))),
    demoted: Object.freeze(demoted),
    scoreDeltas: Object.freeze(deltas),
    payouts: Object.freeze(payouts),
    bankDelta,
    bank,
    strikesRemaining,
    endReason,
    bankedByOne,
  });
}
