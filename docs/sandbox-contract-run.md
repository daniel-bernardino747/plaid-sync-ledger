# Contract suite against real Plaid Sandbox

The contract suite (`packages/plaid/test/contract.test.ts`) runs unchanged
against both the Plaid fake and `https://sandbox.plaid.com` (ADR 0008). This
file records the runs against the real Sandbox.

Command: `pnpm --filter @psl/plaid test:contract:sandbox` (needs
`PLAID_CLIENT_ID` and `PLAID_SECRET` for Sandbox in `.env`).

## Result (2026-10-08)

6 of 6 tests passed on each of 3 consecutive runs after the last fix below.
Before that fix, 4 of 5 runs passed and 1 failed intermittently.

| Test | What it checks against real Plaid |
| --- | --- |
| exchanges a public token | `/sandbox/public_token/create` then `/item/public_token/exchange` returns an item id and an `access-sandbox-` token |
| paginates `/transactions/sync` | pages with `count: 10` until `has_more = false`, amounts parsed as exact decimal text, unique `transaction_id`s, `accounts` present |
| no further changes from the final cursor | calling again with `next_cursor` returns no `added` / `removed` and `has_more = false` |
| invalid access token | classified as `fatal` with `error_code = INVALID_ACCESS_TOKEN` |
| `/sandbox/item/reset_login` | afterwards `/transactions/sync` fails with `ITEM_LOGIN_REQUIRED` (classified `item_login_required`) and `/item/get` reports `item.error.error_code = ITEM_LOGIN_REQUIRED` (spec item 4) |
| unknown webhook key id | `/webhook_verification_key/get` with an unknown `key_id` is answered with a non-retryable error, which the client maps to "no such key" |

## What the real Sandbox taught us

| Finding | Effect | Fix |
| --- | --- | --- |
| The default Sandbox Item (`ins_109508`, default credentials) has exactly 50 transactions. | The pagination test used `count: 50`, so Sandbox returned a single page and the test failed. The assumption was in the test, not in the contract. | The test paginates with `count: 10`. |
| Right after the exchange, `/transactions/sync` returns no data with `transactions_update_status = NOT_READY`; a few seconds later it returns everything with `HISTORICAL_UPDATE_COMPLETE`. | One run failed intermittently: the test stopped waiting at the first non-empty response. Our hypothesis (not proven) is that it caught a partially available pull. | The test waits for `HISTORICAL_UPDATE_COMPLETE` before asserting. |
| The fake always answered `HISTORICAL_UPDATE_COMPLETE`, even before any data existed. | A divergence between the fake and Sandbox. | The fake answers `NOT_READY` until its initial batch is released. |

## Not covered by these runs

- Webhooks from Sandbox to the local Worker. They need a public URL (a
  tunnel to port 8787). The webhook path is covered with real ES256 signatures
  produced by the fake: `apps/webhooks/test/*.test.ts` and every `pnpm chaos`
  scenario.
- Plaid Link UI flows. They need a browser and were exercised manually, see
  below.

## Manual run: Plaid Link and update mode (2026-10-08)

Web app and worker with `PLAID_TARGET=sandbox` (webhook URL unset, since
Sandbox cannot reach localhost). A person drove the browser; the sequence below
was read back from the database and the worker log afterwards.

| Time (UTC) | Step | Observed |
| --- | --- | --- |
| 17:13:39 | Connect a bank through Plaid Link (`user_good`) | `/plaid/exchange` 200; first sync committed 20 transactions in 1 page |
| 17:13:45 | "Simulate login required" (`/sandbox/item/reset_login`) | the sync got `ITEM_LOGIN_REQUIRED`; Item `needs_reauth`; the job was requeued with `attempts = 0` |
| 17:14:54 | "Reconnect": Link in update mode, then `/reauth-complete` | `refresh_item_status` read `/item/get` and set the Item `active` |
| 17:14:56 | Sync resumes | the parked job ran and fetched **3** transactions (20 + 3 = 23 live). A from-scratch resync would have fetched 23: it resumed from the saved cursor |
| 17:15:08 | "Simulate login required" clicked once more | Item `needs_reauth` again, job queued with `attempts = 0` (expected) |

No access token or public token appeared in the web or worker output.

Two `502` responses in the same session came from pressing "Simulate login
required" on an Item created earlier against the **fake**: its access token is
not valid in Sandbox. Items do not record which target created them, so mixing
targets in one database produces this. Use a fresh database (or delete fake
Items) when switching `PLAID_TARGET`.
