import type { Db } from "@psl/db";
import { keyVersionOf, rewrapDek, type Keyring } from "@psl/crypto";

/**
 * Master key rotation without downtime (ADR 0006).
 *
 *   1. Deploy with MASTER_KEYS = {old, new} and MASTER_KEY_CURRENT = new.
 *      Readers can unwrap both versions; new DEKs are wrapped with `new`.
 *   2. Run this: re-wrap every DEK still on `from`, in small batches.
 *   3. When it reports 0 remaining, remove `from` from MASTER_KEYS.
 *
 * Only DEKs are re-wrapped. The DEK itself does not change, so no access
 * token is re-encrypted and no reader ever sees a ciphertext it cannot open.
 *
 * Each row is updated with a compare-and-set on its current wrapped value, so
 * a concurrent writer (or a second copy of this script) cannot be overwritten:
 * the loser simply skips the row and the next batch re-reads it.
 */
export async function rotateMasterKey(
  db: Db, // app_system
  keyring: Keyring,
  opts: { from: number; to: number; batchSize?: number; pauseMs?: number; onBatch?: (done: number) => void },
): Promise<{ rewrapped: number; remaining: number }> {
  if (!keyring.has(opts.from) || !keyring.has(opts.to)) throw new Error("both versions must be in MASTER_KEYS");
  const batchSize = opts.batchSize ?? 100;
  let rewrapped = 0;
  let lastUserId = "00000000-0000-0000-0000-000000000000";

  for (;;) {
    // Keyset pagination: never rescans rows already handled, and short
    // statements keep row locks brief (no long transaction over the table).
    const batch = await db.$queryRaw<{ user_id: string; wrapped_dek: string }[]>`
      SELECT user_id::text, wrapped_dek FROM user_keys
       WHERE master_key_version = ${opts.from} AND user_id > ${lastUserId}::uuid
       ORDER BY user_id LIMIT ${batchSize}`;
    if (batch.length === 0) break;

    for (const row of batch) {
      const next = await rewrapDek(keyring, row.user_id, row.wrapped_dek, opts.to);
      if (keyVersionOf(next) !== opts.to) throw new Error("re-wrap produced the wrong version");
      rewrapped += await db.$executeRaw`
        UPDATE user_keys
           SET wrapped_dek = ${next}, master_key_version = ${opts.to}, rotated_at = now()
         WHERE user_id = ${row.user_id}::uuid AND wrapped_dek = ${row.wrapped_dek}`;
    }
    lastUserId = batch.at(-1)!.user_id;
    opts.onBatch?.(rewrapped);
    if (opts.pauseMs) await new Promise((r) => setTimeout(r, opts.pauseMs));
  }

  const [r] = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM user_keys WHERE master_key_version = ${opts.from}`;
  return { rewrapped, remaining: r?.n ?? 0 };
}
