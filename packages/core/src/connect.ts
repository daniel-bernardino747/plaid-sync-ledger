import { forUser, type Db } from "@psl/db";
import type { Keyring } from "@psl/crypto";
import type { PlaidGateway } from "@psl/plaid";
import { encryptAccessToken, getOrCreateDataKey } from "./keys.ts";

/**
 * Exchanges a public token and stores the Item for `userId` (item 1 of the
 * spec). Runs on the user-scoped app_web connection, so RLS applies to every
 * write here (ADR 0007).
 *
 * The public token is never persisted. The access token only exists in
 * memory between the exchange and encryption.
 *
 * The initial sync is enqueued here rather than left to the
 * SYNC_UPDATES_AVAILABLE webhook: Plaid may send that webhook before this
 * function has stored the Item, and the Worker cannot enqueue a job for an
 * Item it does not know yet.
 */
export async function connectItem(
  deps: { webDb: Db; keyring: Keyring; plaid: PlaidGateway },
  input: { userId: string; publicToken: string },
): Promise<{ itemId: string; plaidItemId: string }> {
  // Network call outside any database transaction.
  const { itemId: plaidItemId, accessToken } = await deps.plaid.exchangePublicToken(input.publicToken);
  const itemId = globalThis.crypto.randomUUID();

  await forUser(deps.webDb, input.userId, async (tx) => {
    const dk = await getOrCreateDataKey(tx, deps.keyring, input.userId);
    const accessTokenCt = await encryptAccessToken(dk, itemId, accessToken);
    await tx.item.create({ data: { id: itemId, userId: input.userId, plaidItemId, accessTokenCt } });
    await tx.$executeRaw`SELECT enqueue_job(${itemId}::uuid, 'transactions_sync')`;
  });
  return { itemId, plaidItemId };
}
