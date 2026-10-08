import type { Db, Tx } from "@psl/db";
import type { Keyring } from "@psl/crypto";
import { PlaidCallError, type PlaidGateway, type PlaidTransaction, type SyncPage } from "@psl/plaid";
import { decryptAccessToken, loadDataKey } from "./keys.ts";

/**
 * One sync run for one Item (ADR 0003, ADR 0004).
 *
 *   C0 := stored cursor
 *   fetch pages from C0 until has_more = false, accumulating them in memory
 *     MUTATION_DURING_PAGINATION -> drop every page, start again from C0
 *   BEGIN
 *     UPDATE items SET cursor = final WHERE cursor IS NOT DISTINCT FROM C0
 *       0 rows -> someone else already advanced the cursor: stop, apply nothing
 *     upsert accounts, then apply pages in order (added, modified, removed)
 *   COMMIT
 *
 * Correctness does not depend on locks or on webhook deduplication: applying
 * the same update twice is a no-op (upserts keyed on Plaid's transaction_id),
 * and a stale run cannot commit because the cursor it started from is gone.
 */

export interface SyncHooks {
  /** Called after each transaction upsert inside the commit (chaos failpoint). */
  afterUpsert?: (count: number) => void | Promise<void>;
  /** Called after each page fetch; return false if the lease was lost. */
  onPage?: () => Promise<boolean>;
}

export interface SyncDeps {
  db: Db; // app_system
  plaid: PlaidGateway;
  keyring: Keyring;
  pageSize: number;
  maxRestarts?: number;
  hooks?: SyncHooks;
}

export type SyncResult =
  | { outcome: "committed"; pages: number; added: number; modified: number; removed: number; restarts: number }
  | { outcome: "cursor_moved"; restarts: number } // fenced out by the compare-and-set
  | { outcome: "item_not_active" };

export class LeaseLostError extends Error {
  constructor() {
    super("lease lost");
    this.name = "LeaseLostError";
  }
}

export async function syncItem(deps: SyncDeps, itemId: string): Promise<SyncResult> {
  const item = await deps.db.item.findUnique({ where: { id: itemId } });
  if (!item || item.status !== "active") return { outcome: "item_not_active" };

  const dk = await loadDataKey(deps.db, deps.keyring, item.userId);
  const accessToken = await decryptAccessToken(dk, item.id, item.accessTokenCt);
  const c0 = item.cursor;
  const maxRestarts = deps.maxRestarts ?? 5;

  let restarts = 0;
  let pages: SyncPage[];
  for (;;) {
    try {
      pages = await fetchUpdate(deps, accessToken, c0);
      break;
    } catch (e) {
      if (e instanceof PlaidCallError && e.kind === "mutation_during_pagination" && restarts < maxRestarts) {
        // Plaid: restart "beginning with the cursor for the first page of the update".
        restarts++;
        continue;
      }
      throw e;
    }
  }

  const finalCursor = pages.at(-1)!.nextCursor;
  return deps.db.$transaction(
    async (tx) => {
      // Fence (ADR 0004, layer 3). Taking the row lock here also serializes
      // concurrent commits for this Item: the second waits, re-reads the
      // predicate after the first commits, and matches zero rows.
      const fenced = await tx.$executeRaw`
        UPDATE items SET cursor = ${finalCursor}, last_synced_at = now(), updated_at = now()
         WHERE id = ${item.id}::uuid AND cursor IS NOT DISTINCT FROM ${c0}::text`;
      if (fenced !== 1) return { outcome: "cursor_moved", restarts } as const;

      const counts = await applyPages(tx, { itemId: item.id, userId: item.userId }, pages, deps.hooks);
      return { outcome: "committed", pages: pages.length, restarts, ...counts } as const;
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
}

async function fetchUpdate(deps: SyncDeps, accessToken: string, c0: string | null): Promise<SyncPage[]> {
  const pages: SyncPage[] = [];
  let cursor = c0;
  for (;;) {
    const page = await deps.plaid.syncTransactions({ accessToken, cursor, count: deps.pageSize });
    pages.push(page);
    if (deps.hooks?.onPage && !(await deps.hooks.onPage())) throw new LeaseLostError();
    if (!page.hasMore) return pages;
    cursor = page.nextCursor;
  }
}

async function applyPages(
  tx: Tx,
  owner: { itemId: string; userId: string },
  pages: SyncPage[],
  hooks: SyncHooks | undefined,
): Promise<{ added: number; modified: number; removed: number }> {
  // Accounts first: transactions reference them.
  const accounts = new Map(pages.flatMap((p) => p.accounts).map((a) => [a.accountId, a]));
  for (const a of accounts.values()) {
    await tx.$executeRaw`
      INSERT INTO accounts (plaid_account_id, user_id, item_id, name, mask, type, subtype)
      VALUES (${a.accountId}, ${owner.userId}::uuid, ${owner.itemId}::uuid, ${a.name}, ${a.mask}, ${a.type}, ${a.subtype})
      ON CONFLICT (plaid_account_id) DO UPDATE
        SET name = EXCLUDED.name, mask = EXCLUDED.mask, type = EXCLUDED.type,
            subtype = EXCLUDED.subtype, updated_at = now()
      WHERE accounts.item_id = EXCLUDED.item_id`;
  }

  let upserts = 0;
  const counts = { added: 0, modified: 0, removed: 0 };
  // Page order, then added -> modified -> removed within a page: a later
  // removal of the same transaction_id wins over an earlier add (ADR 0003).
  for (const page of pages) {
    for (const [list, key] of [
      [page.added, "added"],
      [page.modified, "modified"],
    ] as const) {
      for (const t of list) {
        await upsertTransaction(tx, owner, t);
        counts[key]++;
        upserts++;
        await hooks?.afterUpsert?.(upserts);
      }
    }
    for (const r of page.removed) {
      // Soft delete. Scoped to this Item so a forged id cannot touch another
      // Item's rows. COALESCE keeps the first removal time on replays.
      await tx.$executeRaw`
        UPDATE transactions SET removed_at = COALESCE(removed_at, now()), updated_at = now()
         WHERE plaid_transaction_id = ${r.transactionId} AND item_id = ${owner.itemId}::uuid`;
      counts.removed++;
    }
  }
  return counts;
}

function upsertTransaction(tx: Tx, owner: { itemId: string; userId: string }, t: PlaidTransaction) {
  // amount is the exact decimal text Plaid sent; Postgres parses it into
  // NUMERIC(19,4). It never passes through a JavaScript number.
  // removed_at is cleared: Plaid saying added/modified means the row is live.
  return tx.$executeRaw`
    INSERT INTO transactions (
      plaid_transaction_id, user_id, item_id, plaid_account_id, amount, iso_currency_code,
      date, authorized_date, name, merchant_name, pending, pending_transaction_id)
    VALUES (
      ${t.transactionId}, ${owner.userId}::uuid, ${owner.itemId}::uuid, ${t.accountId}, ${t.amount}::numeric,
      ${t.isoCurrencyCode}, ${t.date}::date, ${t.authorizedDate}::date, ${t.name}, ${t.merchantName},
      ${t.pending}, ${t.pendingTransactionId})
    ON CONFLICT (plaid_transaction_id) DO UPDATE SET
      plaid_account_id = EXCLUDED.plaid_account_id,
      amount = EXCLUDED.amount,
      iso_currency_code = EXCLUDED.iso_currency_code,
      date = EXCLUDED.date,
      authorized_date = EXCLUDED.authorized_date,
      name = EXCLUDED.name,
      merchant_name = EXCLUDED.merchant_name,
      pending = EXCLUDED.pending,
      pending_transaction_id = EXCLUDED.pending_transaction_id,
      removed_at = NULL,
      updated_at = now()
    WHERE transactions.item_id = EXCLUDED.item_id`;
}
