import { decryptAccessToken, loadDataKey } from "@psl/core";
import { forUser } from "@psl/db";
import type { Deps } from "./deps.ts";
import { HttpError } from "./session.ts";

/**
 * Decrypts an Item's access token for its owner. The lookup runs under RLS, so
 * another user's Item id simply does not exist here. The token stays in
 * memory for the duration of one Plaid call and is never returned to the
 * browser.
 */
export async function accessTokenFor(deps: Deps, userId: string, itemId: string): Promise<string> {
  return forUser(deps.webDb, userId, async (tx) => {
    const item = await tx.item.findUnique({ where: { id: itemId } });
    if (!item) throw new HttpError(404, "item not found");
    const dk = await loadDataKey(tx, deps.keyring, userId);
    return decryptAccessToken(dk, item.id, item.accessTokenCt);
  });
}

/** Enqueues work for an Item the user owns, via the SECURITY DEFINER function (ADR 0007). */
export async function enqueueForUser(
  deps: Deps,
  userId: string,
  itemId: string,
  kind: "transactions_sync" | "refresh_item_status",
): Promise<void> {
  try {
    await forUser(deps.webDb, userId, (tx) => tx.$executeRaw`SELECT enqueue_job(${itemId}::uuid, ${kind}::job_kind)`);
  } catch (e) {
    if (/item not found/.test(String((e as Error).message))) throw new HttpError(404, "item not found");
    throw e;
  }
}
