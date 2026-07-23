import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export type TeacherTokenClaims = Readonly<{
  teacherId: string;
  expiresAtMs: number;
  keyPrefix?: string;
}>;

export type ProjectorTokenClaims = Readonly<{
  sessionId: string;
  expiresAtMs: number;
}>;

export type PlayerTokenClaims = Readonly<{
  playerId: string;
  expiresAtMs: number;
}>;

export type MetaTokenClaims = Readonly<{
  expiresAtMs: number;
}>;

function signature(value: string, secret: string): string {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function metaSignature(value: string, secret: string, metaKeyHash: string): string {
  return signature(`meta-session.${metaKeyHash}.${value}`, secret);
}

export function createMetaToken(
  secret: string,
  metaKeyHash: string,
  now = Date.now(),
): string {
  const expiresAtMs = now + 30 * 60 * 1_000;
  const unsigned = `m1.${expiresAtMs}.${randomBytes(16).toString("base64url")}`;
  return `${unsigned}.${metaSignature(unsigned, secret, metaKeyHash)}`;
}

export function verifyMetaToken(
  token: string,
  secret: string,
  metaKeyHash: string,
  now = Date.now(),
): MetaTokenClaims {
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "m1") {
    throw new Error("Invalid meta token");
  }
  const [version, expiresText, nonce, suppliedSignature] = parts;
  if (
    version === undefined ||
    expiresText === undefined ||
    nonce === undefined ||
    suppliedSignature === undefined
  ) {
    throw new Error("Invalid meta token");
  }
  const unsigned = `${version}.${expiresText}.${nonce}`;
  const expected = Buffer.from(metaSignature(unsigned, secret, metaKeyHash));
  const supplied = Buffer.from(suppliedSignature);
  const expiresAtMs = Number(expiresText);
  if (
    expected.length !== supplied.length ||
    !timingSafeEqual(expected, supplied) ||
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= now
  ) {
    throw new Error("Invalid meta token");
  }
  return Object.freeze({ expiresAtMs });
}

export function createTeacherToken(
  teacherId: string,
  secret: string,
  now = Date.now(),
  keyPrefix?: string,
): string {
  const expiresAtMs = now + 12 * 60 * 60 * 1_000;
  const unsigned = keyPrefix === undefined
    ? `t1.${teacherId}.${expiresAtMs}.${randomBytes(16).toString("base64url")}`
    : `t2.${teacherId}.${keyPrefix}.${expiresAtMs}.${randomBytes(16).toString("base64url")}`;
  return `${unsigned}.${signature(unsigned, secret)}`;
}

export function verifyTeacherToken(
  token: string,
  secret: string,
  now = Date.now(),
): TeacherTokenClaims {
  const parts = token.split(".");
  if (
    (parts.length !== 5 || parts[0] !== "t1") &&
    (parts.length !== 6 || parts[0] !== "t2")
  ) {
    throw new Error("Invalid teacher token");
  }
  const version = parts[0];
  const teacherId = parts[1];
  const keyPrefix = version === "t2" ? parts[2] : undefined;
  const expiresText = parts[version === "t2" ? 3 : 2];
  const nonce = parts[version === "t2" ? 4 : 3];
  const suppliedSignature = parts[version === "t2" ? 5 : 4];
  if (
    version === undefined ||
    teacherId === undefined ||
    expiresText === undefined ||
    nonce === undefined ||
    suppliedSignature === undefined
  ) {
    throw new Error("Invalid teacher token");
  }
  if (keyPrefix !== undefined && !/^[A-Za-z0-9_-]{8}$/.test(keyPrefix)) {
    throw new Error("Invalid teacher token");
  }
  const unsigned = version === "t2"
    ? `${version}.${teacherId}.${keyPrefix}.${expiresText}.${nonce}`
    : `${version}.${teacherId}.${expiresText}.${nonce}`;
  const expected = Buffer.from(signature(unsigned, secret));
  const supplied = Buffer.from(suppliedSignature);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw new Error("Invalid teacher token");
  }
  const expiresAtMs = Number(expiresText);
  if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= now) {
    throw new Error("Expired teacher token");
  }
  return Object.freeze({
    teacherId,
    expiresAtMs,
    ...(keyPrefix === undefined ? {} : { keyPrefix }),
  });
}

export function createProjectorToken(
  sessionId: string,
  secret: string,
  now = Date.now(),
): string {
  const expiresAtMs = now + 8 * 60 * 60 * 1_000;
  const unsigned = `prj1.${sessionId}.${expiresAtMs}.${randomBytes(16).toString("base64url")}`;
  return `${unsigned}.${signature(unsigned, secret)}`;
}

export function createProjectorTokenForRequest(
  sessionId: string,
  requestId: string,
  expiresAtMs: number,
  secret: string,
): string {
  const nonce = createHmac("sha256", secret)
    .update(`projector-request:${sessionId}:${requestId}`)
    .digest()
    .subarray(0, 16)
    .toString("base64url");
  const unsigned = `prj1.${sessionId}.${expiresAtMs}.${nonce}`;
  return `${unsigned}.${signature(unsigned, secret)}`;
}

export function verifyProjectorToken(
  token: string,
  secret: string,
  now = Date.now(),
): ProjectorTokenClaims {
  const parts = token.split(".");
  if (parts.length !== 5 || parts[0] !== "prj1") {
    throw new Error("Invalid projector token");
  }
  const [version, sessionId, expiresText, nonce, suppliedSignature] = parts;
  if (
    version === undefined ||
    sessionId === undefined ||
    expiresText === undefined ||
    nonce === undefined ||
    suppliedSignature === undefined
  ) {
    throw new Error("Invalid projector token");
  }
  const unsigned = `${version}.${sessionId}.${expiresText}.${nonce}`;
  const expected = Buffer.from(signature(unsigned, secret));
  const supplied = Buffer.from(suppliedSignature);
  const expiresAtMs = Number(expiresText);
  if (
    expected.length !== supplied.length ||
    !timingSafeEqual(expected, supplied) ||
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= now
  ) {
    throw new Error("Invalid projector token");
  }
  return Object.freeze({ sessionId, expiresAtMs });
}

export function tokenHash(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export function createPlayerToken(
  playerId: string,
  sessionId: string,
  secret: string,
  now = Date.now(),
): string {
  const expiresAtMs = now + 24 * 60 * 60 * 1_000;
  const unsigned = `p1.${playerId}.${expiresAtMs}.${randomBytes(16).toString("base64url")}`;
  return `${unsigned}.${signature(`${unsigned}.${sessionId}`, secret)}`;
}

export function verifyPlayerToken(
  token: string,
  sessionId: string,
  secret: string,
  now = Date.now(),
): PlayerTokenClaims {
  const parts = token.split(".");
  if (parts.length !== 5 || parts[0] !== "p1") {
    throw new Error("Invalid player token");
  }
  const [version, playerId, expiresText, nonce, suppliedSignature] = parts;
  if (
    version === undefined ||
    playerId === undefined ||
    expiresText === undefined ||
    nonce === undefined ||
    suppliedSignature === undefined
  ) {
    throw new Error("Invalid player token");
  }
  const unsigned = `${version}.${playerId}.${expiresText}.${nonce}`;
  const expected = Buffer.from(signature(`${unsigned}.${sessionId}`, secret));
  const supplied = Buffer.from(suppliedSignature);
  const expiresAtMs = Number(expiresText);
  if (
    expected.length !== supplied.length ||
    !timingSafeEqual(expected, supplied) ||
    !Number.isSafeInteger(expiresAtMs) ||
    expiresAtMs <= now
  ) {
    throw new Error("Invalid player token");
  }
  return Object.freeze({ playerId, expiresAtMs });
}
