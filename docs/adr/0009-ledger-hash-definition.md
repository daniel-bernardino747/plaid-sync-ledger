# ADR 0009: Ledger hash definition

- Status: Accepted
- Date: 2026-10-08

## Context

The chaos suite judges every scenario by one question: is the final ledger
identical to the ledger of a clean run? If the hash covers too little, chaos
proves little. If it covers anything non-deterministic, chaos fails
spuriously.

## Decision

**Money.** Plaid sends `amount` as a JSON number. It is parsed once, at the
gateway boundary, into a decimal string and stored as `NUMERIC(19,4)`. Floats
never reach the database. The parsing is the only place a float exists, and
it has its own tests (for example `0.1 + 0.2`-style values and negative
amounts).

**Canonical row.** One line per transaction, fields joined with `|`:

```
transaction_id | account_id | amount (e.g. 12.3400) | iso_currency_code |
date | authorized_date | name | merchant_name | pending |
pending_transaction_id | removed
```

`removed` is `removed_at IS NOT NULL`. `NULL` values are rendered as an
explicit `∅` token so they cannot collide with empty strings.

**Excluded on purpose.**

- `created_at`, `updated_at`, `removed_at` values: they are wall-clock values
  and differ between runs.
- Internal surrogate ids and the stored raw Plaid JSON.
- The cursor: it is opaque, and Plaid may issue different cursors for the
  same logical state.

**Computation.** In Postgres, so the hash describes what is actually
persisted:

```sql
SELECT encode(sha256(convert_to(
  coalesce(string_agg(line, E'\n' ORDER BY transaction_id), ''), 'UTF8')), 'hex')
FROM ledger_lines;  -- view producing the canonical line
```

**Invariants checked alongside the hash** in every chaos scenario:

- no job is left `running` with an expired lease;
- no job is `dead` unless the scenario expects it;
- the number of executed sync runs stays within a bound (proves coalescing);
- each Item's stored cursor equals the fake's final cursor.

## Consequences

- One SQL view (`ledger_lines`) is the single definition of the ledger, and
  it is reused by tests, `pnpm chaos`, and the README table.
- Field order in the canonical line is part of the contract. Changing it
  changes every recorded hash, which is intentional and visible in review.
