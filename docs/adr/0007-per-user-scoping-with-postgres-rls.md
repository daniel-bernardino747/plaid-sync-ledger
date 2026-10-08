# ADR 0007: Per-user data scoping is enforced by Postgres row-level security

- Status: Accepted
- Date: 2026-10-08

## Context

Users must only ever see their own Items, accounts, and transactions. ADR 0006
relies on this: transaction PII is protected by access scope rather than
encryption. Enforcing the scope only in application code (every query must
remember `where: { userId }`) fails open. One unfiltered `findMany()` leaks
every user's data, and tests only cover the queries someone remembered to
test.

## Decision

Enforce scoping in Postgres with row-level security, and use the application
filters only as a second layer.

- RLS is enabled and **forced** on `items`, `accounts`, `transactions`,
  `user_keys`. Each table has the policy:

  ```sql
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  ```

  When the setting is missing, the predicate is `NULL` and no rows match: the
  table fails closed.
- Database roles:
  - `app_owner` owns the schema and runs migrations.
  - `app_web` is used by `apps/web`. It is not the owner and has no
    `BYPASSRLS`.
  - `app_system` is used by `apps/worker`, `apps/webhooks`, and scripts. It has
    `BYPASSRLS` because it processes every user's Items. It is never used to
    serve a user request.
- A Prisma Client extension in `packages/db` (`forUser(userId)`) runs each
  operation inside a transaction that first executes
  `SELECT set_config('app.user_id', $1, true)` (transaction-local, the same
  effect as `SET LOCAL`). The setting cannot leak to the next request that
  reuses the pooled connection.
- Policies and roles live in a hand-written SQL migration, because Prisma does
  not model RLS.

## Proof (tests)

Connected as `app_web`:

- an unfiltered `findMany()` without a user context returns zero rows;
- with user A's context, an unfiltered `findMany()` never returns user B's
  rows;
- inserting a row with another user's `user_id` is rejected by `WITH CHECK`;
- after a request for A, the next transaction on the same pooled connection
  has no `app.user_id` set.

## Consequences

- The guarantee also covers code that has not been written yet.
- Each web request pays for one short explicit transaction.
- The `app_system` role is a privileged path. It is confined to background
  processes and called out in the README.
