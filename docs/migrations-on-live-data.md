# Schema changes on live data

How this repository changes a large, busy table without blocking it, and what
Prisma Migrate does (and does not do) with the statements that make that
possible. Measured results on ~5M rows are in
[`migration-5m-results.md`](migration-5m-results.md), produced by
`pnpm --filter @psl/migration-demo start`.

## The procedure: expand, backfill, contract

Example change: add `transactions.merchant_key text NOT NULL`.

| Step | Statement | Lock | Why it is safe on a live table |
| --- | --- | --- | --- |
| 1. Expand | `ALTER TABLE transactions ADD COLUMN merchant_key text` | `ACCESS EXCLUSIVE`, catalog only | No default and nullable means no table rewrite: it takes milliseconds. Run it with `SET lock_timeout = '2s'`. Without it, the `ALTER` waits behind any long transaction **and every query that arrives afterwards queues behind the `ALTER`**. A timeout fails fast and is retried instead. |
| 2. Dual write | Application deploy that writes `merchant_key` on every insert and update. | none | From here on, no new row is created without the value. |
| 3. Backfill | `UPDATE ... WHERE pk > $last AND pk <= $upper AND merchant_key IS NULL`, in keyset batches with a pause | row locks, one short transaction per batch | Row locks live only for one batch, so the worst wait a writer can see is about one batch's duration. Batch size is the dial. The `IS NULL` guard makes the backfill resumable and idempotent. |
| 4. Index | `CREATE INDEX CONCURRENTLY ...` | `SHARE UPDATE EXCLUSIVE` | Does not block reads or writes. It cannot run inside a transaction block, and a failed build leaves an `INVALID` index behind (see below). |
| 5. Constraint, unvalidated | `ADD CONSTRAINT ... CHECK (merchant_key IS NOT NULL) NOT VALID` | `ACCESS EXCLUSIVE`, catalog only | Instant: it enforces new writes but does not scan existing rows. |
| 6. Validate | `ALTER TABLE ... VALIDATE CONSTRAINT ...` | `SHARE UPDATE EXCLUSIVE` | Scans the table, but writes continue. |
| 7. Contract | `ALTER COLUMN merchant_key SET NOT NULL`, then `DROP CONSTRAINT` the check | `ACCESS EXCLUSIVE`, catalog only | Since PostgreSQL 12, `SET NOT NULL` skips the full scan when a validated `CHECK (col IS NOT NULL)` proves it. Without that check, the same statement scans the whole table **while blocking reads and writes**. The demo measures both. |

Each step ships separately and can be paused between steps. Only steps 1, 5
and 7 take `ACCESS EXCLUSIVE`, and each for a catalog update only.

## What the measurements show

From [`migration-5m-results.md`](migration-5m-results.md), with a concurrent
writer running throughout:

- A plain `CREATE INDEX` stalled writes for **4.28 s**, the whole build. The
  concurrent build of a comparable index never delayed a write by more than
  **63 ms**.
- `SET NOT NULL` without a validated check held `ACCESS EXCLUSIVE` for
  **1.31 s** (reads blocked too). Through `CHECK ... NOT VALID` + `VALIDATE` +
  `SET NOT NULL`, the worst write during any of those steps was **18 ms**.
- The catalog-only steps (add column, add `NOT VALID` check, final
  `SET NOT NULL`) took about 10 ms each.
- The backfill is the long step (172 s for 5M rows, 1,000 batches) and the one
  to tune. Median write latency stayed at 5.8 ms, but one write took **1.54 s**.
  The demo does not record whether that was a row-lock wait on the batch in
  flight or an I/O stall (5M row updates generate a lot of WAL on a laptop's
  Docker volume), so the cause is reported as unknown. In production the next
  step would be to log per-batch duration and `pg_stat_activity` wait events
  during the backfill, and shrink the batch or lengthen the pause until the
  tail fits the latency budget.
- The query that motivated the change went from a parallel sequential scan to
  an index scan (plans in the results file).

## What Prisma Migrate does with this

Verified on Prisma **7.10.0** against PostgreSQL 17. The experiments run
`prisma migrate deploy` on hand-written migration files.

| Experiment | Result |
| --- | --- |
| A migration whose only statement is `CREATE INDEX CONCURRENTLY` | Applied. |
| A migration with `ALTER TABLE ... ADD COLUMN` followed by `CREATE INDEX CONCURRENTLY` | Applied. Prisma 7 does **not** wrap a migration in a transaction, and sends the statements in a way PostgreSQL does not treat as one implicit transaction. Otherwise `CONCURRENTLY` would fail with "cannot run inside a transaction block", which is exactly what happens when the same file is wrapped in `BEGIN ... COMMIT`. |
| A migration with `ADD COLUMN half_applied` followed by a failing `CREATE INDEX CONCURRENTLY` | The migration is recorded as **failed** (P3018). The column **stays** in the database: the migration was half applied. Every later `migrate deploy` refuses to run (P3009) until someone runs `prisma migrate resolve`. |

Consequences, and the rules this repository follows:

1. **A Prisma migration is not atomic on PostgreSQL in this version.** Treat each
   statement as its own deployment step. That is the same discipline
   expand/contract already needs, so it is not an extra burden.
2. **One `CONCURRENTLY` statement per migration, alone in its file.** If it
   fails, the only thing left half-done is that index, and the recovery is
   unambiguous.
3. **Make index migrations re-runnable** before marking a failure as rolled
   back. A failed concurrent build leaves an `INVALID` index, and
   `CREATE INDEX CONCURRENTLY IF NOT EXISTS` would then silently keep the
   broken index. Since Prisma does not use a transaction, the file can start by
   removing it:

   ```sql
   DROP INDEX CONCURRENTLY IF EXISTS transactions_merchant_key_date_idx;
   CREATE INDEX CONCURRENTLY transactions_merchant_key_date_idx ON transactions (merchant_key, date);
   ```

   Then: `prisma migrate resolve --rolled-back <name>` and `prisma migrate deploy`.
4. **Long backfills do not belong in a migration file.** A 5M-row `UPDATE` in a
   migration is one huge transaction holding row locks on every row it touched
   until it commits. Backfills run as a separate, resumable job (here,
   `tools/migration-demo`), between the expand and contract migrations.
5. **Set `lock_timeout` in migrations that take `ACCESS EXCLUSIVE`**
   (`SET lock_timeout = '2s';` as the first line), so a blocked migration fails
   instead of stalling the whole table behind it.
6. **Never ship Prisma's generated SQL for these changes unedited.** Checked
   with `prisma migrate diff --script`: making the field required generates
   `ALTER TABLE "transactions" ALTER COLUMN "merchant_key" SET NOT NULL;` (the
   scanning version that blocks reads and writes), and adding `@@index` generates
   a plain `CREATE INDEX` (blocks writes for the whole build). `schema.prisma`
   cannot express `CHECK` constraints at all. For these changes the migration
   SQL is written by hand, following the table above, and `schema.prisma` is
   updated so that a later `migrate diff` reports no drift.
