# ADR 0001: Coalesce sync jobs per item instead of permanent webhook dedup

- Status: Accepted
- Date: 2026-10-08

## Context

The original proposal deduplicated incoming Plaid webhooks with a derived key
`item_id + webhook_code + sha256(body)` under a permanent `UNIQUE` constraint.

Plaid webhooks carry no event id. The `SYNC_UPDATES_AVAILABLE` payload is only:

```json
{
  "webhook_type": "TRANSACTIONS",
  "webhook_code": "SYNC_UPDATES_AVAILABLE",
  "item_id": "...",
  "user_id": "...",
  "initial_update_complete": true,
  "historical_update_complete": true,
  "environment": "sandbox"
}
```

Once the historical pull finishes, both flags stay `true`, so every later
`SYNC_UPDATES_AVAILABLE` for the same Item has a byte-identical body. A
permanent unique key would treat tomorrow's legitimate notification as a
duplicate of today's and drop it. The sync would never run, and new
transactions would never reach the ledger.

"Dedup is an optimization, correctness comes from idempotent sync" only holds
if the sync is actually triggered. A dedup that can suppress a trigger is a
correctness bug, not an optimization.

## Decision

Split the two concerns into two tables.

1. `webhook_events` is an append-only audit log. Every verified webhook is
   stored with its derived `dedup_key`. There is no unique constraint on it,
   so redeliveries stay visible and countable.
2. `sync_jobs` has a partial unique index:
   `UNIQUE (item_id) WHERE status = 'queued'`.
   Enqueueing uses `INSERT ... ON CONFLICT DO NOTHING`.
   - If a job for the Item is already `queued`, the new webhook is absorbed.
     The queued job has not read the cursor yet, so it will see the new data.
   - If the only job for the Item is `running`, a new `queued` job is
     created. The running job may have read Plaid before the new data
     existed, so one more pass is required.

At most one queued plus one running job can exist per Item. Ten redeliveries
of the same webhook collapse into at most one extra sync.

## Consequences

- No legitimate update is lost, because a trigger is only absorbed by a job
  that has not started yet.
- Redundant syncs are still possible (for example, a webhook arriving right
  after a job starts). They are safe because applying a `/transactions/sync`
  page is idempotent: upserts keyed on Plaid `transaction_id`, with the cursor
  committed in the same database transaction as the changes.
- The `dedup_key` stays useful for observability, for example counting
  redeliveries per key in the chaos report.
- The chaos scenario "resend every webhook 10 times" asserts both properties:
  the ledger hash is identical to a clean run, and the number of syncs
  executed is bounded.

## Alternatives considered

- **Time-windowed unique key** (`dedup_key + date_trunc('minute', received_at)`).
  Rejected. It still drops a legitimate update that arrives in the same window
  after a sync already ran, and correctness then depends on clock buckets.
- **No dedup at all.** Correct, but ten redeliveries cause ten full syncs and
  more lock contention. Coalescing gets the same correctness for less work.
