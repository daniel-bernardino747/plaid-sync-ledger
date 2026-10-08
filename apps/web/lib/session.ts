import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Minimal signed session (ADR 0011). The cookie holds only the user id and an
 * expiry, signed with HMAC-SHA256. requireUser() is the single entry point that
 * turns a request into a user id; route handlers cannot reach user data
 * without it.
 */

export const SESSION_COOKIE = "psl_session";
export const SESSION_TTL_SECONDS = 8 * 3600;

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const b64url = (s: string) => Buffer.from(s, "utf8").toString("base64url");
const mac = (secret: string, payload: string) => createHmac("sha256", secret).update(payload).digest("base64url");

export function signSession(secret: string, userId: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const payload = b64url(JSON.stringify({ u: userId, exp: nowSeconds + SESSION_TTL_SECONDS }));
  return `${payload}.${mac(secret, payload)}`;
}

/** Returns the user id, or null for a missing, tampered, malformed or expired cookie. */
export function verifySession(secret: string, value: string | undefined, nowSeconds = Math.floor(Date.now() / 1000)): string | null {
  if (!value) return null;
  const [payload, sig, extra] = value.split(".");
  if (!payload || !sig || extra !== undefined) return null;
  const expected = Buffer.from(mac(secret, payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const { u, exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { u?: unknown; exp?: unknown };
    if (typeof u !== "string" || typeof exp !== "number" || exp <= nowSeconds) return null;
    return u;
  } catch {
    return null;
  }
}

/**
 * CSRF defence for state-changing routes (ADR 0011): POST only, and the
 * Origin header must be this app's origin. Browsers always send Origin on
 * cross-site POSTs, so a missing Origin is rejected too.
 */
export function assertSameOrigin(request: Request): void {
  if (request.method !== "POST") throw new HttpError(405, "method not allowed");
  const origin = request.headers.get("origin");
  const allowed = process.env.APP_ORIGIN || new URL(request.url).origin;
  if (origin !== allowed) throw new HttpError(403, "cross-origin request rejected");
}

export function cookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}
