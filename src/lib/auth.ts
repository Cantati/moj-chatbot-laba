import { createHmac, createHash, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "workshop_session";
export const SESSION_MAX_AGE = 60 * 60 * 8;

function sessionSecret() {
  const secret = process.env.SESSION_SECRET?.trim();
  return secret && Buffer.byteLength(secret) >= 32 ? secret : null;
}

export function authConfigurationReady() {
  return Boolean(process.env.CHAT_PASSWORD?.length && sessionSecret());
}

export function passwordMatches(candidate: string) {
  const password = process.env.CHAT_PASSWORD;
  if (!password || !sessionSecret()) return false;

  const candidateHash = createHash("sha256").update(candidate).digest();
  const passwordHash = createHash("sha256").update(password).digest();
  return timingSafeEqual(candidateHash, passwordHash);
}

function sign(value: string, secret: string) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function createSessionToken(now = Date.now()) {
  const secret = sessionSecret();
  if (!secret) throw new Error("Session signing is not configured");

  const payload = Buffer.from(JSON.stringify({ expiresAt: now + SESSION_MAX_AGE * 1000 })).toString(
    "base64url",
  );
  return `${payload}.${sign(payload, secret)}`;
}

export function validSessionFromCookieHeader(cookieHeader: string | null, now = Date.now()) {
  const secret = sessionSecret();
  if (!process.env.CHAT_PASSWORD?.length || !secret || !cookieHeader) return false;

  const cookie = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  const token = cookie?.slice(SESSION_COOKIE.length + 1);
  if (!token) return false;

  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return false;

  const expected = sign(payload, secret);
  const providedBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (providedBytes.length !== expectedBytes.length || !timingSafeEqual(providedBytes, expectedBytes)) {
    return false;
  }

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      expiresAt?: unknown;
    };
    return typeof data.expiresAt === "number" && data.expiresAt > now;
  } catch {
    return false;
  }
}

export function sessionRequiredResponse() {
  return Response.json({ error: "Zaloguj się ponownie, aby kontynuować." }, { status: 401 });
}

export function requireActiveSession(cookieHeader: string | null) {
  return validSessionFromCookieHeader(cookieHeader) ? null : sessionRequiredResponse();
}

export function sessionCookie(token: string, maxAge = SESSION_MAX_AGE) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}
