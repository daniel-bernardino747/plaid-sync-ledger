import { forUser } from "@psl/db";
import { plaidConfigFromEnv } from "@psl/plaid";
import { getDeps } from "../../../../../lib/deps.ts";
import { mutation, requireUser, UUID } from "../../../../../lib/auth.ts";
import { enqueueForUser } from "../../../../../lib/items.ts";
import { HttpError } from "../../../../../lib/session.ts";

/**
 * Only when running against the Plaid fake, where the real Link UI cannot run:
 * stands in for "the user completed Link update mode". It then follows the
 * exact same server path as the real flow (refresh_item_status).
 */
export const POST = async (request: Request, ctx: RouteContext<"/api/items/[id]/fake-repair">) =>
  mutation("items.fake_repair", async () => {
    const userId = await requireUser();
    const { id } = await ctx.params;
    if (!UUID.test(id)) throw new HttpError(400, "invalid item id");
    const deps = await getDeps();
    if (deps.plaidTarget !== "fake") throw new HttpError(403, "only available against the Plaid fake");
    const item = await forUser(deps.webDb, userId, (tx) => tx.item.findUnique({ where: { id } }));
    if (!item) throw new HttpError(404, "item not found");
    const res = await fetch(`${plaidConfigFromEnv(process.env).baseUrl}/__control/repair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ item_id: item.plaidItemId }),
    });
    if (!res.ok) throw new HttpError(502, "fake repair failed");
    await enqueueForUser(deps, userId, id, "refresh_item_status");
    return Response.json({ ok: true });
  })(request);
