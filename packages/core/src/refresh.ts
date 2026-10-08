import type { Db } from "@psl/db";
import type { Keyring } from "@psl/crypto";
import { classifyItemHealth, type PlaidGateway } from "@psl/plaid";
import { decryptAccessToken, loadDataKey } from "./keys.ts";
import { enqueue } from "./queue.ts";

/**
 * refresh_item_status (ADR 0005). Item webhooks carry no timestamp and no
 * ordering guarantee, so they never change Item state directly. They enqueue
 * this job, which reads the Item's current state from /item/get and applies
 * that. A delayed ERROR delivered after LOGIN_REPAIRED therefore cannot push a
 * healthy Item back into needs_reauth.
 */

export type RefreshResult = { outcome: "active" | "needs_reauth" | "revoked" | "unchanged"; resumed: boolean };

export async function refreshItemStatus(
  deps: { db: Db; plaid: PlaidGateway; keyring: Keyring },
  itemId: string,
): Promise<RefreshResult> {
  const item = await deps.db.item.findUnique({ where: { id: itemId } });
  if (!item || item.status === "revoked") return { outcome: "unchanged", resumed: false };

  const dk = await loadDataKey(deps.db, deps.keyring, item.userId);
  const status = await deps.plaid.getItem(await decryptAccessToken(dk, item.id, item.accessTokenCt));
  const consentExpiresAt = status.consentExpirationTime ? new Date(status.consentExpirationTime) : null;

  switch (classifyItemHealth(status.errorCode)) {
    case "healthy": {
      await deps.db.item.update({ where: { id: item.id }, data: { status: "active", consentExpiresAt } });
      // Recovering from needs_reauth: resume from the stored cursor.
      const resumed = item.status === "needs_reauth" ? await enqueue(deps.db, item.id, "transactions_sync") : false;
      return { outcome: "active", resumed };
    }
    case "needs_reauth":
      await deps.db.item.update({ where: { id: item.id }, data: { status: "needs_reauth", consentExpiresAt } });
      return { outcome: "needs_reauth", resumed: false };
    case "revoked":
      await deps.db.item.update({ where: { id: item.id }, data: { status: "revoked" } });
      return { outcome: "revoked", resumed: false };
    case "unchanged":
      // Warnings and other Item errors (institution down, pending expiration):
      // keep syncing and let the sync's own error handling decide.
      await deps.db.item.update({ where: { id: item.id }, data: { consentExpiresAt } });
      return { outcome: "unchanged", resumed: false };
  }
}
