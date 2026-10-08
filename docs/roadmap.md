# Roadmap

Work proceeds strictly top to bottom. If time runs out, items are cut from the
bottom. An item is never sacrificed for one below it.

| # | Block | Notes |
| --- | --- | --- |
| 1 | Monorepo, Docker Postgres, Prisma schema, roles and RLS | ADR 0007 |
| 2 | `packages/plaid` (port + adapter) and `packages/plaid-fake` (paginated, deterministic sync) | ADR 0008 |
| 3 | Queue: claim, lease, reaper, cursor CAS, atomic sync, safety-net cron, integration tests | ADR 0001, 0003, 0004 |
| 4 | Webhook Worker: full JWT verification, ingestion, coalescing, tests | ADR 0002, 0012 |
| 5 | `pnpm chaos` with all scenarios and the results table | ADR 0009, 0010 |
| 6 | Envelope encryption with bound AAD, master-key rotation script | ADR 0006 |
| 7 | Allowlist logger and canary test | ADR 0013 |
| 8 | README and `docs/rca-001.md` | Protected: reserve the final stretch for it |
| 9 | Re-auth: `refresh_item_status`, Link update mode | ADR 0005 |
| 10 | Web: login, Plaid Link, transaction list | ADR 0011 |
| 11 | Contract suite against real Plaid Sandbox | ADR 0008 |
| 12 | Bonus: expand/contract migration on ~5M rows | Only if time remains |

## Safety-net sync (part of block 3)

A scheduled job enqueues a `transactions_sync` for every `active` Item with no
successful sync in the last 24 hours. It answers "what if Plaid never delivers
the webhook?". It uses the same coalescing index, so it cannot pile up jobs.

## Declared out of scope

- The Expo app.
- Stripe and SMS webhooks.
- Real identity (ADR 0011).
- DEK rotation and a real KMS (ADR 0006).
