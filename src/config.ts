export type AppConfig = Readonly<{
  port: number;
  dbPath: string;
  tokenSecret: string;
  metaKeyHash: string;
  logLevel: "info" | "warn" | "error";
  buildSha?: string;
  baseUrl?: string;
}>;

type Environment = Readonly<Record<string, string | undefined>>;

function requireValue(environment: Environment, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function requireCanonicalValue(
  environment: Environment,
  canonicalName: string,
  legacyName: string,
): Readonly<{ name: string; value: string }> {
  const canonicalValue = environment[canonicalName]?.trim();
  const legacyValue = environment[legacyName]?.trim();
  if (
    canonicalValue !== undefined &&
    canonicalValue.length > 0 &&
    legacyValue !== undefined &&
    legacyValue.length > 0 &&
    canonicalValue !== legacyValue
  ) {
    throw new Error(
      `Conflicting environment variables: ${canonicalName} and legacy alias ${legacyName}`,
    );
  }
  if (canonicalValue !== undefined && canonicalValue.length > 0) {
    return Object.freeze({ name: canonicalName, value: canonicalValue });
  }
  if (legacyValue !== undefined && legacyValue.length > 0) {
    return Object.freeze({ name: legacyName, value: legacyValue });
  }
  throw new Error(
    `Missing required environment variable: ${canonicalName} (legacy alias ${legacyName})`,
  );
}

export function loadConfig(environment: Environment = process.env): AppConfig {
  const portText = requireValue(environment, "PORT");
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("Invalid environment variable PORT: expected an integer from 0 to 65535");
  }

  const tokenSecretSetting = requireCanonicalValue(
    environment,
    "PLAYER_TOKEN_SECRET",
    "TOKEN_SECRET",
  );
  if (tokenSecretSetting.value.length < 32) {
    throw new Error(
      `Invalid environment variable ${tokenSecretSetting.name}: expected at least 32 characters`,
    );
  }
  if (new Set(tokenSecretSetting.value).size < 8) {
    throw new Error(
      `Invalid environment variable ${tokenSecretSetting.name}: obvious low entropy`,
    );
  }
  if (
    tokenSecretSetting.name === "PLAYER_TOKEN_SECRET" &&
    (!/^[A-Za-z0-9_-]{43}$/.test(tokenSecretSetting.value) ||
      Buffer.from(tokenSecretSetting.value, "base64url").length !== 32)
  ) {
    throw new Error(
      "Invalid environment variable PLAYER_TOKEN_SECRET: expected a base64url-encoded 32-byte secret",
    );
  }
  const tokenSecret = tokenSecretSetting.value;

  const metaKeySetting = requireCanonicalValue(
    environment,
    "META_KEY_SHA256",
    "META_KEY_HASH",
  );
  const metaKeyHash = metaKeySetting.value.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(metaKeyHash)) {
    throw new Error(
      `Invalid environment variable ${metaKeySetting.name}: expected a SHA-256 hex digest`,
    );
  }

  const baseUrlText = environment.BASE_URL?.trim();
  let baseUrl: string | undefined;
  if (baseUrlText !== undefined && baseUrlText.length > 0) {
    try {
      baseUrl = new URL(baseUrlText).toString();
    } catch {
      throw new Error("Invalid environment variable BASE_URL: expected an absolute URL");
    }
  }

  const logLevelText = environment.LOG_LEVEL?.trim().toLowerCase() || "info";
  if (logLevelText !== "info" && logLevelText !== "warn" && logLevelText !== "error") {
    throw new Error("Invalid environment variable LOG_LEVEL: expected info, warn, or error");
  }

  const buildShaText = environment.BUILD_SHA?.trim();
  let buildSha: string | undefined;
  if (buildShaText !== undefined && buildShaText.length > 0) {
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(buildShaText)) {
      throw new Error(
        "Invalid environment variable BUILD_SHA: expected 1-100 letters, numbers, dots, underscores, or hyphens",
      );
    }
    buildSha = buildShaText;
  }

  return Object.freeze({
    port,
    dbPath: requireCanonicalValue(environment, "DATABASE_PATH", "DB_PATH").value,
    tokenSecret,
    metaKeyHash,
    logLevel: logLevelText,
    ...(buildSha === undefined ? {} : { buildSha }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
  });
}

export function loadEnvironmentFile(): void {
  try {
    process.loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}
