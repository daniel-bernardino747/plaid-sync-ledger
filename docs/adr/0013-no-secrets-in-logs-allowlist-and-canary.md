# ADR 0013: No secrets in logs, enforced by an allowlist logger and a canary test

- Status: Accepted
- Date: 2026-10-08

## Context

The requirement is that no access token or PII ever reaches the logs, and a
test must guarantee it. Testing a `redact()` helper only proves the helper.
Real leaks come from error paths: `console.log(err)` serializing a request
body, a database error echoing query parameters, an `Error.cause` chain
carrying a Plaid response.

## Decision

1. **One logger** in `packages/log`. It emits structured JSON and keeps an
   **allowlist** of field names (for example `job_id`, `item_id`, `attempt`,
   `error_code`, `duration_ms`). Fields not on the list are dropped, not
   masked, and objects or arrays are never logged even under an allowed name.
   The allowlist fails closed, while a denylist always misses something. It is
   global rather than per event: simpler to review, and the canary test covers
   the remaining risk of an allowed name carrying a sensitive value.
2. **Errors** are logged only through `serializeError()`, which emits `name`,
   our internal `code`, and Plaid's `error_type` / `error_code`. It never emits
   `message`, `stack`, `cause`, request or response bodies, or query
   parameters.
3. **ESLint `no-console` is an error** in every app and package except the
   logger itself.
4. **Canary tests.** A fast one in `pnpm test`
   (`packages/core/test/no-secrets-in-logs.test.ts`) drives the worker through
   success, retries, timeouts, a crash inside the commit, a dead job and
   re-auth, and greps every log line. The full one: The Plaid fake issues marked values: access tokens such as
   `access-sandbox-CANARY-…`, public tokens, account names, and merchant
   names containing `CANARY`. The test captures stdout and stderr of every
   process during a full `pnpm chaos` run (Plaid fake excluded, workers,
   `wrangler dev`, web), with kills, `500`s, timeouts, and retries, and fails
   if any canary value appears. This covers exactly the error paths where
   leaks happen.

## Consequences

- Plaid's `item_id` and our internal ids are logged on purpose. They are not
  secrets or PII by themselves, and operating the system without them would be
  blind.
- The canary test can only catch values the fake emits. Real production data
  needs the allowlist to hold, and the canary run is evidence that it does
  under failure.
- Adding a log field requires editing the allowlist, which makes every new
  field a reviewed decision.
