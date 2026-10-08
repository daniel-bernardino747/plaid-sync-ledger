# ADR 0010: Chaos harness design

- Status: Accepted
- Date: 2026-10-08

## Context

`pnpm chaos` is the centerpiece of the project. Its table is only credible if
every scenario is isolated and reproducible, and if "kill the worker" and
"two workers" are literal rather than simulated in-process.

## Decision

**Isolation.** A `chaos_template` database is created once with all
migrations applied. Each scenario gets a fresh database via
`CREATE DATABASE chaos_<scenario> TEMPLATE chaos_template`. The Plaid fake is
reset with the same seed for every scenario.

**Baseline.** The `clean` scenario runs first (one worker, no faults) and
produces the reference ledger hash (ADR 0009). Every other scenario must
reproduce it.

**Real processes.** The orchestrator starts the Plaid fake, `wrangler dev`
(the real `apps/webhooks` Worker), and workers as child processes. Webhooks in
every scenario are emitted by the fake, signed with ES256, and delivered to
the real Worker over HTTP, so verification and ingestion (ADR 0002) are on the
tested path.

**Kill.** With `FAIL_AFTER_N_UPSERTS=N`, the worker calls
`process.kill(process.pid, 'SIGKILL')` after N upserts, inside the open commit
transaction. No `finally`, no explicit rollback, and no exit handler runs.
Postgres rolls back when the connection drops. The orchestrator observes the
exit and starts a replacement worker. `LEASE_SECONDS` is configurable so the
reaper (ADR 0004) recovers the orphaned job within seconds during chaos runs.

**Scenarios.**

| Scenario | Fault |
| --- | --- |
| `clean` | none (baseline) |
| `kill-mid-commit` | `FAIL_AFTER_N_UPSERTS`, then restart |
| `webhook-x10` | every webhook delivered 10 times |
| `two-workers` | two workers consume the queue concurrently |
| `mutation-page-2` | `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` on page 2 |
| `plaid-500` | injected `500` responses |
| `plaid-timeout` | responses delayed beyond the client timeout |

**Termination.** A scenario ends when no job is `queued` or `running` and the
fake has nothing left to deliver. A global timeout marks the scenario `FAIL`.

**Output.** A terminal table with scenario, result, ledger hash (first 12 hex
characters), sync runs executed, invariant checks (ADR 0009), and duration.
The same table is written to `docs/chaos-results.md` and embedded in the
README.

## Consequences

- The suite depends on `wrangler dev` starting cleanly, which is slower and
  more fragile than calling the ingestion function directly. That price buys
  fidelity: the code under test is the code that would be deployed.
- Running against real child processes makes timing non-deterministic. The
  result must not be: every scenario must converge to the same hash regardless
  of interleaving, which is exactly the property being demonstrated.
