import { cookies } from "next/headers";
import { getDeps } from "../../../lib/deps.ts";
import { mutation, readJson, stringField, UUID } from "../../../lib/auth.ts";
import { cookieOptions, HttpError, SESSION_COOKIE, signSession } from "../../../lib/session.ts";

// Demo "login": pick one of the seeded users (ADR 0011). No password on purpose.
export const POST = mutation("session.create", async (request) => {
  const userId = stringField(await readJson(request), "userId", UUID);
  const { webDb, sessionSecret } = await getDeps();
  const user = await webDb.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) throw new HttpError(404, "unknown user");
  (await cookies()).set(SESSION_COOKIE, signSession(sessionSecret, user.id), cookieOptions());
  return Response.json({ ok: true });
});
