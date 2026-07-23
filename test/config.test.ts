import { once } from "node:events";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const VALID_ENV = {
  NODE_ENV: "production",
  HOST: "127.0.0.1",
  PORT: "3000",
  DATABASE_PATH: "/tmp/1v100-test.db",
  PLAYER_TOKEN_SECRET: Buffer.from("0123456789abcdef".repeat(2)).toString("base64url"),
  META_KEY_SHA256: "a".repeat(64),
  LOG_LEVEL: "info",
  BUILD_SHA: "test-build",
  BASE_URL: "https://classroom.example.test",
};
const LEGACY_TEST_SECRET = Buffer.from(
  Array.from({ length: 32 }, (_, index) => index),
).toString("hex");

describe("runtime configuration", () => {
  it("fails boot nonzero and names a missing TOKEN_SECRET", async () => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: new URL("..", import.meta.url),
      env: {
        PATH: process.env.PATH,
        PORT: "0",
        DATABASE_PATH: VALID_ENV.DATABASE_PATH,
        META_KEY_SHA256: VALID_ENV.META_KEY_SHA256,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const [exitCode] = (await once(child, "exit")) as [number, NodeJS.Signals | null];

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("PLAYER_TOKEN_SECRET");
    expect(stderr).toContain("TOKEN_SECRET");
  });

  it("returns a frozen, typed configuration when every required variable is valid", () => {
    const config = loadConfig(VALID_ENV);

    expect(config).toEqual({
      port: 3000,
      dbPath: "/tmp/1v100-test.db",
      tokenSecret: VALID_ENV.PLAYER_TOKEN_SECRET,
      metaKeyHash: VALID_ENV.META_KEY_SHA256,
      logLevel: "info",
      buildSha: "test-build",
      baseUrl: "https://classroom.example.test/",
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("rejects short or obviously low-entropy token secrets", () => {
    expect(() =>
      loadConfig({ ...VALID_ENV, PLAYER_TOKEN_SECRET: "a".repeat(31) }),
    ).toThrow(/at least 32 characters/);
    expect(() =>
      loadConfig({ ...VALID_ENV, PLAYER_TOKEN_SECRET: "a".repeat(32) }),
    ).toThrow(/low entropy/);
    expect(() =>
      loadConfig({
        ...VALID_ENV,
        PLAYER_TOKEN_SECRET: `${VALID_ENV.PLAYER_TOKEN_SECRET.slice(0, -1)}!`,
      }),
    ).toThrow(/base64url-encoded 32-byte secret/);
  });

  it("accepts the legacy variable aliases with the same secret checks", () => {
    const config = loadConfig({
      PORT: VALID_ENV.PORT,
      DB_PATH: VALID_ENV.DATABASE_PATH,
      TOKEN_SECRET: LEGACY_TEST_SECRET,
      META_KEY_HASH: VALID_ENV.META_KEY_SHA256,
    });

    expect(config.dbPath).toBe(VALID_ENV.DATABASE_PATH);
    expect(config.tokenSecret).toBe(LEGACY_TEST_SECRET);
    expect(config.metaKeyHash).toBe(VALID_ENV.META_KEY_SHA256);
    expect(config.logLevel).toBe("info");
    expect(() =>
      loadConfig({
        PORT: VALID_ENV.PORT,
        DB_PATH: VALID_ENV.DATABASE_PATH,
        TOKEN_SECRET: "b".repeat(31),
        META_KEY_HASH: VALID_ENV.META_KEY_SHA256,
      }),
    ).toThrow(/TOKEN_SECRET.*at least 32 characters/);
  });

  it("documents every variable in the example environment file", async () => {
    const example = await readFile(new URL("../.env.example", import.meta.url), "utf8");

    for (const name of [
      "NODE_ENV",
      "HOST",
      "PORT",
      "DATABASE_PATH",
      "PLAYER_TOKEN_SECRET",
      "META_KEY_SHA256",
      "LOG_LEVEL",
      "BUILD_SHA",
      "BASE_URL",
    ]) {
      expect(example).toMatch(new RegExp(`# [^\\n]+\\n${name}=`));
    }
    expect(example.toLowerCase()).toContain(
      "legacy aliases remain accepted for upgrades: db_path, token_secret, meta_key_hash",
    );
  });

  it("validates operational metadata settings", () => {
    expect(loadConfig({ ...VALID_ENV, LOG_LEVEL: "warn" }).logLevel).toBe("warn");
    expect(() => loadConfig({ ...VALID_ENV, LOG_LEVEL: "debug" })).toThrow(/LOG_LEVEL/);
    expect(() => loadConfig({ ...VALID_ENV, BUILD_SHA: "not a sha with spaces" })).toThrow(
      /BUILD_SHA/,
    );
  });
});
