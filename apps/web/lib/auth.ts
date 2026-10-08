import { cookies } from "next/headers";
import { log, serializeError } from "@psl/log";
import { PlaidCallError } from "@psl/plaid";
import { getDeps } from "./deps.ts";
import { assertSameOrigin, HttpError, SESSION_COOKIE, verifySession } from "./session.ts";

/** The user id of the current request, or null. */
export async function currentUser(): Promise<string | null> {
  const { sessionSecret } = await getDeps();
  return verifySession(sessionSecret, (await cookies()).get(SESSION_COOKIE)?.value);
}

export async function requireUser(): Promise<string> {
  const user = await currentUser();
  if (!user) throw new HttpError(401, "not signed in");
  return user;
}

/**
 * Wraps a state-changing route: same-origin check, uniform error mapping, and
 * logging that never includes request bodies or error messages (ADR 0013).
 */
export function mutation(name: string, fn: (request: Request) => Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    try {
      assertSameOrigin(request);
      return await fn(request);
    } catch (e) {
      if (e instanceof HttpError) return Response.json({ error: e.message }, { status: e.status });
      if (e instanceof PlaidCallError) {
        log.warn("web.plaid_error", { reason: name, ...serializeError(e) });
        return Response.json({ error: "bank connection failed", code: e.errorCode }, { status: 502 });
      }
      log.error("web.route_failed", { reason: name, ...serializeError(e) });
      return Response.json({ error: "internal error" }, { status: 500 });
    }
  };
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json();
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {}
  throw new HttpError(400, "invalid JSON body");
}

export function stringField(body: Record<string, unknown>, key: string, pattern = /^[\w.-]{1,200}$/): string {
  const v = body[key];
  if (typeof v !== "string" || !pattern.test(v)) throw new HttpError(400, `invalid ${key}`);
  return v;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
