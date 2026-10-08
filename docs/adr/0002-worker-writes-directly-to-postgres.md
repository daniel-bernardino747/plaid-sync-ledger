# ADR 0002: The webhook Worker writes directly to Postgres

- Status: Accepted
- Date: 2026-10-08

## Context

`apps/webhooks` (Cloudflare Worker) receives Plaid webhooks. It must verify
them, persist them, and enqueue a sync job, without processing anything inside
the request. Plaid retries non-2xx responses, so the Worker must only return
`200` after the event is durably committed. Returning `200` first and writing
afterwards (for example via `ctx.waitUntil`) would silently lose events when
the write fails.

There were two ways to reach Postgres:

- A) Direct connection from the Worker, using the `postgres` driver over TCP
  sockets (`nodejs_compat`), through Hyperdrive in production and
  `localConnectionString` under `wrangler dev`.
- B) An authenticated (HMAC + timestamp) POST to an internal route in
  `apps/web`, which writes with Prisma.

## Decision

Option A. The Worker opens a single transaction that inserts into
`webhook_events` and enqueues into `sync_jobs` (`ON CONFLICT DO NOTHING`, see
ADR 0001), commits, and only then returns `200`. Any failure returns `5xx` so
Plaid retries.

The Worker uses raw SQL, not Prisma. Prisma owns the schema and migrations in
`packages/db`. The Worker's two statements are covered by an integration test
that runs the Prisma migrations against a real Postgres first and then
executes the Worker's SQL, so drift fails CI.

## Consequences

- One hop on the critical path, with no extra shared secret to rotate.
- A small amount of SQL is duplicated outside Prisma, and a test guards it.
- Option B stays documented as a fallback if a deployment target cannot open
  TCP sockets to the database. It is not implemented.
