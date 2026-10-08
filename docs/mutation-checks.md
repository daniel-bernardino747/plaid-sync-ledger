# Mutation checks

A test that cannot fail proves nothing. For the guarantees below, the code was
deliberately broken (temporarily, never committed) and the named test was run
to confirm it fails. Every row was actually executed while building this
repository; none is hypothetical. Two of these checks found tests that were
too weak and had to be rewritten (AI errata #10 and #15).

| Guarantee | Mutation applied | Test that must fail | Result |
| --- | --- | --- | --- |
| Concurrent and stale runs are fenced by the cursor (ADR 0004) | Cursor compare-and-set disabled (`WHERE true OR cursor IS NOT DISTINCT FROM ...`) | `sync.test.ts`: "fences out a concurrent run", "fences out a zombie" | Both failed (the zombie moved the cursor back) |
| A stale run cannot resurrect a removed transaction (ADR 0003, amended) | Same: fence disabled | `sync.test.ts`: "cannot resurrect a transaction a newer sync already removed" | Failed: 3 removed transactions came back |
| Cursor committed with its changes (RCA-001) | [`rca-001-repro.patch`](rca-001-repro.patch): cursor written in its own statement first | `sync.test.ts`: "a crash mid-commit leaves both untouched"; `pnpm chaos kill-mid-commit` | Both failed. `clean` still passed, which is the point of the RCA |
| Resume from the saved cursor after re-auth (ADR 0005) | Sync starts every run from `cursor = null` | `queue.test.ts`: "... then resumes from the saved cursor" | Failed: first call after repair used `null` |
| A late `LOGIN_REPAIRED` cannot mark a broken Item healthy (ADR 0005) | `refreshItemStatus` ignores `/item/get` and always classifies as healthy | `queue.test.ts`: "a late LOGIN_REPAIRED webhook ..." | Failed (after errata #10: the first version drained the queue and hid the wrong state) |
| A late `ERROR` cannot park a repaired Item (ADR 0005) | `refreshItemStatus` always classifies as `ITEM_LOGIN_REQUIRED` | `queue.test.ts`: "a late ERROR webhook ..." | Failed |
| Park-for-reauth survives a concurrent enqueue (ADR 0005) | The single retry on SQLSTATE 23505 removed | `queue.test.ts`: "retries once when a concurrent enqueue collides ..." | Failed with the unique violation (after errata #15: the first version never reached the conflict) |
| No secrets in logs (ADR 0013) | Worker logs an error's `cause` under the allowed field `reason` | `no-secrets-in-logs.test.ts` | Failed: the leaked `access-sandbox-CANARY-…` line was reported |
| No `console` outside the logger (ADR 0013) | A `console.log` added to `apps/worker` | `pnpm lint` | Failed: `no-console` |
| Chaos catches a broken system | RCA-001 patch | `pnpm chaos` | `kill-mid-commit` failed with hash `3467c3382ce3` and 85% of transactions missing |

To repeat one: apply the mutation, run the test, confirm it fails, revert. For
the RCA case: `git apply docs/rca-001-repro.patch`, run, then
`git apply -R docs/rca-001-repro.patch`.
