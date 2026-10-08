import { getDeps } from "../../../../../lib/deps.ts";
import { mutation, requireUser, UUID } from "../../../../../lib/auth.ts";
import { enqueueForUser } from "../../../../../lib/items.ts";
import { HttpError } from "../../../../../lib/session.ts";

/**
 * Called after Link update mode succeeds. The client is not trusted to say the
 * Item is healthy: this only enqueues refresh_item_status, which asks Plaid
 * (/item/get) and, if healthy, reactivates the Item and resumes syncing from
 * the saved cursor (ADR 0005).
 */
export const POST = async (request: Request, ctx: RouteContext<"/api/items/[id]/reauth-complete">) =>
  mutation("items.reauth_complete", async () => {
    const userId = await requireUser();
    const { id } = await ctx.params;
    if (!UUID.test(id)) throw new HttpError(400, "invalid item id");
    await enqueueForUser(await getDeps(), userId, id, "refresh_item_status");
    return Response.json({ ok: true });
  })(request);
