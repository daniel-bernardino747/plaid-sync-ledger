# ADR 0004: Job leases, a reaper, and cursor compare-and-set as the fence

- Status: Accepted
- Date: 2026-10-08

## Context

The queue is a Postgres table consumed with `FOR UPDATE SKIP LOCKED`. A worker
can die mid-sync, leaving its job `running` forever. Two workers must never
both apply a sync for the same Item. A lock alone cannot guarantee that: a
worker paused long enough (GC, VM freeze, network partition) loses its lease,
another worker takes over, and the first one wakes up and commits stale data.

## Decision

Three layers, each with a distinct job.

1. **Claim with a lease (avoids duplicate work).**

   ```sql
   UPDATE sync_jobs
      SET status = 'running', lease_until = now() + interval '60 seconds',
          attempts = attempts + 1, locked_by = $worker
    WHERE id = (
      SELECT j.id FROM sync_jobs j
        JOIN items i ON i.id = j.item_id
       WHERE j.status = 'queued' AND j.run_at <= now()
         AND i.status = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM sync_jobs r
            WHERE r.item_id = j.item_id AND r.status = 'running'
              AND r.lease_until > now())
       ORDER BY j.run_at
       FOR UPDATE OF j SKIP LOCKED
       LIMIT 1)
   RETURNING *;
   ```

   The worker renews `lease_until` after each page (heartbeat).

2. **Reaper (recovers orphans).** Each worker poll also reaps jobs with
   `status = 'running' AND lease_until < now()`:
   - if another `queued` job exists for the same Item, the orphan becomes
     `superseded`, because the queued job already covers the work;
   - else if `attempts >= 5`, it becomes `dead`;
   - else it returns to `queued` with backoff.

3. **Cursor compare-and-set (guarantees correctness).** The commit
   transaction from ADR 0003 starts with:

   ```sql
   UPDATE items SET cursor = $next_cursor
    WHERE id = $item_id AND cursor IS NOT DISTINCT FROM $start_cursor;
   ```

   If it affects zero rows, another run already advanced the cursor. The
   transaction rolls back and the job is marked `superseded`. The row lock
   taken by this `UPDATE` also serializes concurrent commits: the second
   waits, re-evaluates the predicate, and loses.

Retry policy: at most 5 attempts. Delay is full jitter over
`min(2^attempt * 2s, 5 min)`. Lease is 60 seconds.

## Consequences

- "Two workers in parallel" stays correct even if the lease logic is wrong.
  The lease is an optimization (fewer duplicate Plaid calls) and the CAS is
  the guarantee. This mirrors ADR 0001: suppression is an optimization,
  idempotent, fenced application is the guarantee.
- A crash consumes one attempt, since `attempts` is incremented on claim.
- `dead` jobs stay in the table and are visible through a query and the UI.

## Alternatives considered

- **Session-level `pg_advisory_lock` held for the whole sync.** It releases
  automatically when the process dies, but it pins one connection per Item
  (awkward with Prisma's pool), and it does not protect against a zombie
  worker whose connection is still alive.
