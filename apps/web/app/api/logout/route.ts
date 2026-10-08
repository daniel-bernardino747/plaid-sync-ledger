import { cookies } from "next/headers";
import { mutation } from "../../../lib/auth.ts";
import { SESSION_COOKIE } from "../../../lib/session.ts";

export const POST = mutation("session.delete", async () => {
  (await cookies()).delete(SESSION_COOKIE);
  return Response.json({ ok: true });
});
