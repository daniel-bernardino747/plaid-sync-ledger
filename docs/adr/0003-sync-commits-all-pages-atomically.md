# ADR 0003: A sync run commits all pages and the cursor in one transaction

- Status: Accepted
- Date: 2026-10-08

## Context

`/transactions/sync` is paginated (`has_more`, `next_cursor`). Plaid's docs
state that on `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` "the entire
pagination request loop must be restarted beginning with the cursor for the
first page of the update". Retrying only the failed page is wrong.

If each page were committed with its own `next_cursor`, the stored cursor would
point mid-update. Restarting after a mutation would then need a second cursor
(`update_start_cursor`) and the ledger would exist in partially applied states.

## Decision

A sync run:

1. Reads the stored cursor `C0` for the Item.
2. Calls `/transactions/sync` repeatedly, accumulating pages in memory until
   `has_more` is `false`.
3. On `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`, discards every
   accumulated page and restarts from `C0`.
4. Opens one Postgres transaction that applies all pages and writes the final
   `next_cursor`, then commits.

Pages are applied in the order they were received, and within a page in the
order `added`, `modified`, `removed`. A later `removed` therefore wins over an
earlier `added` of the same `transaction_id`.

`added` and `modified` are upserts keyed on Plaid's `transaction_id`. They
clear `removed_at`: Plaid reporting a transaction as added or modified means it
is live. `removed` is a soft delete (`removed_at` is set), not a physical
`DELETE`, so removals stay auditable: when and what was removed is kept.

What prevents a stale upsert from resurrecting a removed row is **not** the
soft delete. Within one run, page order handles it (a later `removed` wins).
Across runs, a run working from an old cursor cannot commit at all, because of
the cursor compare-and-set (ADR 0004). Making removals irreversible instead
would be wrong: if Plaid ever reported a removed id as live again, the row
would stay hidden forever.

> Amended after code review. The first version claimed the soft delete itself
> stopped "a late upsert" from resurrecting a row, while the code (correctly)
> clears `removed_at` on upsert. The guarantee comes from the fence, and
> `packages/core/test/sync.test.ts` ("cannot resurrect a transaction a newer
> sync already removed") proves it: without the fence, 3 removed transactions
> come back.

## Consequences

- A crash, Plaid `5xx`, timeout, or mutation at any point before commit leaves
  the stored cursor at `C0` and the ledger untouched. Retrying is trivially
  correct.
- `FAIL_AFTER_N_UPSERTS` kills the process inside the transaction. Postgres
  rolls it back, which is exactly what the chaos test asserts.
- Memory grows with the size of one update. The initial historical pull can be
  thousands of transactions, which is fine for this demo. In production the
  fix would be a staging table keyed by `sync_run_id`, merged in one
  transaction at the end.
- The ledger hash used by the chaos suite covers live rows only (ADR 0009, as
  amended). A soft-deleted row that should have been removed but was not still
  shows up as a live row, so missed removals are caught.
