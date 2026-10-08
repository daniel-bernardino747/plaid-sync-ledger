import { connectItem } from "@psl/core";
import { getDeps } from "../../../../lib/deps.ts";
import { mutation, readJson, requireUser, stringField } from "../../../../lib/auth.ts";

// Link onSuccess: the public token is exchanged server-side and never stored.
export const POST = mutation("plaid.exchange", async (request) => {
  const userId = await requireUser();
  const publicToken = stringField(await readJson(request), "publicToken", /^public-[\w-]{1,200}$/);
  const deps = await getDeps();
  const { itemId } = await connectItem(deps, { userId, publicToken });
  return Response.json({ itemId });
});
