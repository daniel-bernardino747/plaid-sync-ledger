import { getDeps } from "../../../../lib/deps.ts";
import { mutation, readJson, requireUser, stringField, UUID } from "../../../../lib/auth.ts";
import { accessTokenFor } from "../../../../lib/items.ts";

/**
 * Link token for connecting a new Item, or for update mode when `itemId` is
 * given (ADR 0005): update mode passes the Item's access token and no products.
 */
export const POST = mutation("plaid.link_token", async (request) => {
  const userId = await requireUser();
  const body = await readJson(request);
  const deps = await getDeps();
  const itemId = body.itemId === undefined ? null : stringField(body, "itemId", UUID);
  const linkToken = await deps.plaid.createLinkToken({
    userId,
    webhook: deps.webhookUrl,
    ...(itemId ? { accessToken: await accessTokenFor(deps, userId, itemId) } : {}),
  });
  return Response.json({ linkToken });
});
