# ADR 0005: Item health comes from /item/get, webhooks are only hints

- Status: Accepted
- Date: 2026-10-08
- Amends: ADR 0001 (the coalescing index now includes the job kind)

## Context

An Item can lose its login (`ITEM_LOGIN_REQUIRED`), get repaired through Link
update mode, or have its consent revoked. Plaid reports this in two ways:

- **Synchronously**, as an error from an API call such as `/transactions/sync`.
- **Asynchronously**, through Item webhooks: `ERROR` (with
  `error.error_code = ITEM_LOGIN_REQUIRED`), `LOGIN_REPAIRED`,
  `USER_PERMISSION_REVOKED`, `PENDING_DISCONNECT` (US/CA) and
  `PENDING_EXPIRATION` (Europe/UK only).

Plaid webhooks carry no event timestamp and no ordering guarantee, and they
are retried. A delayed `ERROR` delivered after `LOGIN_REPAIRED` would push a
healthy Item back to `needs_reauth` if webhooks were applied as facts.

Note on the original spec: it treated `PENDING_EXPIRATION` as a trigger for
`needs_reauth`. Per Plaid's docs it only fires for European institutions, the
US/CA equivalent is `PENDING_DISCONNECT`, and in both cases the Item still
works until the stated time.

## Decision

Item states: `active`, `needs_reauth`, `revoked` (terminal).

| Signal | Action |
| --- | --- |
| `ITEM_LOGIN_REQUIRED` returned by `/transactions/sync` | Same transaction: Item to `needs_reauth`, job back to `queued`, and the attempt it was claimed with is given back (the failure is not the job's). First-hand fact, applied directly. A crash before that transaction commits applies nothing; like any crash (ADR 0004) it costs the attempt counted at claim, and the reaper retries the job. |
| Webhook `ITEM/ERROR`, `LOGIN_REPAIRED`, `USER_PERMISSION_REVOKED` | Enqueue a `refresh_item_status` job. It calls `/item/get` and applies the state implied by the current `item.error`. |
| Webhook `PENDING_DISCONNECT` / `PENDING_EXPIRATION` | Record `consent_expires_at`. Syncing continues. |
| Link update mode `onSuccess` | Server enqueues `refresh_item_status`, never trusts the client. If healthy, the Item goes to `active` and a `transactions_sync` job is enqueued, resuming from the stored cursor. |

The claim query (ADR 0004) only picks jobs whose Item is `active`, so an Item
in `needs_reauth` stops syncing without any job burning attempts.

`sync_jobs` gains `kind` (`transactions_sync` | `refresh_item_status`). The
coalescing index from ADR 0001 becomes
`UNIQUE (item_id, kind) WHERE status = 'queued'`.

## Consequences

- Webhook order and redelivery no longer matter for Item state, because every
  transition triggered by a webhook is based on a fresh read.
- One extra Plaid call per Item-state webhook, which is negligible.
- A second job kind goes through the same queue, lease, retry, and dead-letter
  machinery, so it adds no new failure modes.
- Testable in Sandbox: `/sandbox/item/reset_login` puts the Item in
  `ITEM_LOGIN_REQUIRED` and fires the `ERROR` webhook, and
  `/sandbox/item/fire_webhook` can fire `LOGIN_REPAIRED` and
  `PENDING_DISCONNECT`.

## Alternative considered and rejected: apply webhooks directly

Map each webhook straight to a state change: `ERROR` / `ITEM_LOGIN_REQUIRED`
to `needs_reauth`, `LOGIN_REPAIRED` to `active`, `USER_PERMISSION_REVOKED` to
`revoked`.

- **For:** no extra job kind, no `/item/get` call, less code for a weekend.
- **Against:** it is order-sensitive. A delayed or redelivered `ERROR` after a
  repair leaves a healthy Item stuck in `needs_reauth` and stops its sync. The
  argument that it is self-healing (the user runs update mode, which succeeds
  immediately) pushes a system bug onto the end user. This also contradicts
  the principle in ADR 0001 and ADR 0004: delivery mechanics (dedup, locks,
  webhook order) are optimizations or hints, never the source of truth.
