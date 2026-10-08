import { getDeps } from "../../../../../lib/deps.ts";
import { mutation, requireUser, UUID } from "../../../../../lib/auth.ts";
import { accessTokenFor, enqueueForUser } from "../../../../../lib/items.ts";
import { HttpError } from "../../../../../lib/session.ts";

/**
 * Demo helper: /sandbox/item/reset_login forces ITEM_LOGIN_REQUIRED (spec,
 * item 4). Plaid also fires the ITEM ERROR webhook; a sync is enqueued too so
 * the failure is observed even without a reachable webhook URL.
 */
export const POST = async (request: Request, ctx: RouteContext<"/api/items/[id]/sandbox-reset-login">) =>
  mutation("items.sandbox_reset_login", async () => {
    const userId = await requireUser();
    const { id } = await ctx.params;
    if (!UUID.test(id)) throw new HttpError(400, "invalid item id");
    const deps = await getDeps();
    if (deps.realPlaid && !/sandbox\.plaid\.com/.test(process.env.PLAID_BASE_URL ?? "")) {
      throw new HttpError(403, "sandbox only");
    }
    await deps.plaid.resetLogin(await accessTokenFor(deps, userId, id));
    await enqueueForUser(deps, userId, id, "transactions_sync");
    return Response.json({ ok: true });
  })(request);
