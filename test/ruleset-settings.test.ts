import { describe, expect, it } from "vitest";

import {
  ONE_V_100_DEFAULT_SETTINGS,
  parseSessionSettings,
  SettingsValidationError,
} from "../src/engine/ruleset-settings.js";
import { DEFAULT_SESSION_SETTINGS } from "../src/sessions.js";

describe("1v100 settings", () => {
  it("keeps an unmarked session on the generic engine", () => {
    expect(parseSessionSettings(DEFAULT_SESSION_SETTINGS)).toEqual({
      mode: "generic",
      ...DEFAULT_SESSION_SETTINGS,
    });
  });

  it("fills every approved ruleset default", () => {
    expect(parseSessionSettings({ mode: "one_v_100" })).toEqual(ONE_V_100_DEFAULT_SETTINGS);
  });

  it("rejects unknown keys and invalid ranges", () => {
    expect(() => parseSessionSettings({ mode: "one_v_100", surprise: true })).toThrow(SettingsValidationError);
    expect(() => parseSessionSettings({ mode: "one_v_100", base_strikes: 0 })).toThrow(/base_strikes/);
    expect(() => parseSessionSettings({
      mode: "one_v_100",
      momentum_window_min_ms: 20_000,
      momentum_window_max_ms: 8_000,
    })).toThrow(/cannot exceed/);
  });
});
