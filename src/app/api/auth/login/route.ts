import { createSessionToken, passwordMatches, sessionCookie, authConfigurationReady } from "../../../../lib/auth";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const attemptsByIp = new Map<string, { count: number; resetAt: number }>();

function clientIp(request: Request) {
  // On hosting, configure the platform's edge/WAF limiter for this route.
  // This per-process fallback is useful locally but is not a global limit across instances.
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

function rateLimitResponse(retryAfter: number) {
  return Response.json(
    { error: "Za dużo prób. Poczekaj chwilę i spróbuj ponownie." },
    { status: 429, headers: { "Retry-After": String(retryAfter) } },
  );
}

export async function POST(request: Request) {
  if (!authConfigurationReady()) {
    return Response.json(
      { error: "Logowanie jest zablokowane. Ustaw CHAT_PASSWORD i SESSION_SECRET w .env.local." },
      { status: 503 },
    );
  }

  const now = Date.now();
  for (const [key, entry] of attemptsByIp) {
    if (entry.resetAt <= now) attemptsByIp.delete(key);
  }
  if (attemptsByIp.size >= 10_000) {
    const oldestKey = attemptsByIp.keys().next().value;
    if (oldestKey) attemptsByIp.delete(oldestKey);
  }
  const ip = clientIp(request);
  const current = attemptsByIp.get(ip);
  if (current && current.count >= MAX_ATTEMPTS) {
    return rateLimitResponse(Math.max(1, Math.ceil((current.resetAt - now) / 1000)));
  }

  let password: unknown;
  try {
    password = (await request.json()).password;
  } catch {
    return Response.json({ error: "Nieprawidłowe żądanie logowania." }, { status: 400 });
  }

  if (typeof password !== "string" || !passwordMatches(password)) {
    const entry = current ?? { count: 0, resetAt: now + WINDOW_MS };
    entry.count += 1;
    attemptsByIp.set(ip, entry);
    if (entry.count >= MAX_ATTEMPTS) {
      return rateLimitResponse(Math.max(1, Math.ceil((entry.resetAt - now) / 1000)));
    }
    return Response.json({ error: "Hasło jest nieprawidłowe." }, { status: 401 });
  }

  attemptsByIp.delete(ip);
  return Response.json(
    { ok: true },
    { headers: { "Set-Cookie": sessionCookie(createSessionToken()), "Cache-Control": "no-store" } },
  );
}
