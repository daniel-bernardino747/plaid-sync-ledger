import { connectItem } from "@psl/core";
import { getDeps } from "../../../../lib/deps.ts";
import { mutation, requireUser } from "../../../../lib/auth.ts";
import { HttpError } from "../../../../lib/session.ts";

/**
 * Connect without the Link UI, using /sandbox/public_token/create (allowed by
 * the spec for tests). Works against Plaid Sandbox and the fake. Refused when
 * pointed at anything else.
 */
export const POST = mutation("plaid.sandbox_connect", async () => {
  const userId = await requireUser();
  const deps = await getDeps();
  if (deps.realPlaid && !/sandbox\.plaid\.com/.test(process.env.PLAID_BASE_URL ?? "")) {
    throw new HttpError(403, "sandbox only");
  }
  const publicToken = await deps.plaid.createPublicToken({ institutionId: "ins_109508", webhook: deps.webhookUrl });
  const { itemId } = await connectItem(deps, { userId, publicToken });
  return Response.json({ itemId });
});
