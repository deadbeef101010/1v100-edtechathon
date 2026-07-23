export type Ruleset1v100Settings = Readonly<{
  mode: "one_v_100";
  phase_a_seconds: number;
  base_strikes: number;
  momentum_enabled: boolean;
  momentum_threshold: number;
  questions_per_game: number;
  session_question_budget: number;
  survival_drip: number;
  bank_per_elimination: number;
  jackpot_multiplier: number;
  bank_keep_fraction_on_flameout: number;
  mob_correct_points: number;
  crowd_correct_points: number;
  streak_bonus_per_step: number;
  deck_survived_mob_bonus: number;
  helps_per_game: Readonly<{ poll: number; ask: number; trust: number }>;
  ask_speaker_bonus: number;
  momentum_fast_k: number;
  momentum_window_min_ms: number;
  momentum_window_max_ms: number;
}>;

export const ONE_V_100_DEFAULT_SETTINGS: Ruleset1v100Settings = Object.freeze({
  mode: "one_v_100" as const,
  phase_a_seconds: 20,
  base_strikes: 2,
  momentum_enabled: false,
  momentum_threshold: 4,
  questions_per_game: 12,
  session_question_budget: 36,
  survival_drip: 10,
  bank_per_elimination: 20,
  jackpot_multiplier: 1.5,
  bank_keep_fraction_on_flameout: 0,
  mob_correct_points: 10,
  crowd_correct_points: 5,
  streak_bonus_per_step: 2,
  deck_survived_mob_bonus: 15,
  helps_per_game: Object.freeze({ poll: 1, ask: 1, trust: 1 }),
  ask_speaker_bonus: 5,
  momentum_fast_k: 1.25,
  momentum_window_min_ms: 8_000,
  momentum_window_max_ms: 20_000,
});

export type GenericSettings = Readonly<{
  mode: "generic";
  phase_a_seconds: number;
  base_strikes: number;
  momentum_enabled: boolean;
  momentum_threshold: number;
  questions_per_game: number;
  session_question_budget: number;
}>;

export type SessionSettings = GenericSettings | Ruleset1v100Settings;
export type TeacherSettingsPatch = Readonly<{
  phase_a_seconds?: number;
  base_strikes?: number;
  momentum_enabled?: boolean;
}>;

export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsValidationError";
  }
}

const BASE_KEYS = [
  "phase_a_seconds",
  "base_strikes",
  "momentum_enabled",
  "momentum_threshold",
  "questions_per_game",
  "session_question_budget",
] as const;

const RULESET_KEYS = Object.freeze(Object.keys(ONE_V_100_DEFAULT_SETTINGS));

function plainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function integerIn(settings: Record<string, unknown>, key: string, minimum: number, maximum: number): number {
  const value = settings[key];
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new SettingsValidationError(`${key} must be an integer from ${minimum} to ${maximum}`);
  }
  return value as number;
}

function numberIn(settings: Record<string, unknown>, key: string, minimum: number, maximum: number): number {
  const value = settings[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new SettingsValidationError(`${key} must be a number from ${minimum} to ${maximum}`);
  }
  return value;
}

function booleanAt(settings: Record<string, unknown>, key: string): boolean {
  const value = settings[key];
  if (typeof value !== "boolean") throw new SettingsValidationError(`${key} must be true or false`);
  return value;
}

function rejectUnknown(settings: Record<string, unknown>, keys: readonly string[]): void {
  const allowed = new Set(keys);
  const unknown = Object.keys(settings).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new SettingsValidationError(`Unknown setting: ${unknown}`);
}

function baseSettings(settings: Record<string, unknown>): Omit<GenericSettings, "mode"> {
  return Object.freeze({
    phase_a_seconds: integerIn(settings, "phase_a_seconds", 10, 60),
    base_strikes: integerIn(settings, "base_strikes", 1, 3),
    momentum_enabled: booleanAt(settings, "momentum_enabled"),
    momentum_threshold: integerIn(settings, "momentum_threshold", 1, 20),
    questions_per_game: integerIn(settings, "questions_per_game", 1, 12),
    session_question_budget: integerIn(settings, "session_question_budget", 1, 500),
  });
}

export function parseSessionSettings(value: unknown): SessionSettings {
  if (!plainObject(value)) throw new SettingsValidationError("Settings must be an object");
  const mode = value.mode;
  if (mode !== undefined && mode !== "generic" && mode !== "one_v_100") {
    throw new SettingsValidationError("mode must be generic or one_v_100");
  }
  if (mode !== "one_v_100") {
    rejectUnknown(value, mode === undefined ? BASE_KEYS : ["mode", ...BASE_KEYS]);
    return Object.freeze({ mode: "generic", ...baseSettings(value) });
  }

  rejectUnknown(value, RULESET_KEYS);
  const merged: Record<string, unknown> = {
    ...ONE_V_100_DEFAULT_SETTINGS,
    ...value,
    helps_per_game: plainObject(value.helps_per_game)
      ? { ...ONE_V_100_DEFAULT_SETTINGS.helps_per_game, ...value.helps_per_game }
      : value.helps_per_game ?? ONE_V_100_DEFAULT_SETTINGS.helps_per_game,
  };
  const helps = merged.helps_per_game;
  if (!plainObject(helps)) throw new SettingsValidationError("helps_per_game must be an object");
  rejectUnknown(helps, ["poll", "ask", "trust"]);
  const parsed = {
    mode: "one_v_100" as const,
    ...baseSettings(merged),
    survival_drip: integerIn(merged, "survival_drip", 0, 10_000),
    bank_per_elimination: integerIn(merged, "bank_per_elimination", 0, 10_000),
    jackpot_multiplier: numberIn(merged, "jackpot_multiplier", 1, 10),
    bank_keep_fraction_on_flameout: numberIn(merged, "bank_keep_fraction_on_flameout", 0, 1),
    mob_correct_points: integerIn(merged, "mob_correct_points", 0, 10_000),
    crowd_correct_points: integerIn(merged, "crowd_correct_points", 0, 10_000),
    streak_bonus_per_step: integerIn(merged, "streak_bonus_per_step", 0, 1_000),
    deck_survived_mob_bonus: integerIn(merged, "deck_survived_mob_bonus", 0, 10_000),
    helps_per_game: Object.freeze({
      poll: integerIn(helps, "poll", 0, 10),
      ask: integerIn(helps, "ask", 0, 10),
      trust: integerIn(helps, "trust", 0, 10),
    }),
    ask_speaker_bonus: integerIn(merged, "ask_speaker_bonus", 0, 10_000),
    momentum_fast_k: numberIn(merged, "momentum_fast_k", 0.1, 10),
    momentum_window_min_ms: integerIn(merged, "momentum_window_min_ms", 1_000, 60_000),
    momentum_window_max_ms: integerIn(merged, "momentum_window_max_ms", 1_000, 120_000),
  };
  if (parsed.momentum_window_min_ms > parsed.momentum_window_max_ms) {
    throw new SettingsValidationError("momentum_window_min_ms cannot exceed momentum_window_max_ms");
  }
  return Object.freeze(parsed);
}

export function parseSettingsJson(settingsJson: string): SessionSettings {
  let value: unknown;
  try {
    value = JSON.parse(settingsJson) as unknown;
  } catch {
    throw new SettingsValidationError("Settings are not valid JSON");
  }
  return parseSessionSettings(value);
}

export function isRuleset1v100(settings: SessionSettings): settings is Ruleset1v100Settings {
  return settings.mode === "one_v_100";
}

export function applyTeacherSettingsPatch(
  settings: SessionSettings,
  patch: unknown,
): SessionSettings {
  if (!plainObject(patch)) throw new SettingsValidationError("Settings patch must be an object");
  rejectUnknown(patch, ["phase_a_seconds", "base_strikes", "momentum_enabled"]);
  if (Object.keys(patch).length === 0) throw new SettingsValidationError("Choose at least one setting");
  return parseSessionSettings({ ...settings, ...patch });
}
