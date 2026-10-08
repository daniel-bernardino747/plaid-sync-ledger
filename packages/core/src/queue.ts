import type { Db, JobKind } from "@psl/db";

/**
 * The job queue is a Postgres table (ADR 0001, ADR 0004). No broker.
 *
 * Every state transition of a running job is guarded by
 * `status = 'running' AND locked_by = <me>`, so a worker that lost its lease
 * (and whose job was reaped and possibly re-claimed) can never overwrite the
 * outcome recorded by the current owner.
 */

export interface ClaimedJob {
  id: bigint;
  itemId: string;
  kind: JobKind;
  attempts: number;
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 5, baseDelayMs: 2_000, maxDelayMs: 300_000 };

/** Full jitter: uniform in [0, min(cap, base * 2^attempt)]. */
export function backoffMs(attempt: number, p: RetryPolicy, rand: () => number = Math.random): number {
  const ceiling = Math.min(p.maxDelayMs, p.baseDelayMs * 2 ** attempt);
  return Math.floor(rand() * ceiling);
}

const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(e: unknown): boolean {
  // Prisma wraps driver errors; the SQLSTATE survives in different places
  // depending on the path, so check the ones the pg adapter uses.
  const o = e as { code?: string; meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string } } } };
  return (
    o?.code === "P2002" ||
    o?.meta?.code === UNIQUE_VIOLATION ||
    o?.meta?.driverAdapterError?.cause?.originalCode === UNIQUE_VIOLATION ||
    /23505|unique constraint/i.test(String((e as Error)?.message ?? ""))
  );
}

/** Enqueue with coalescing: a no-op if a queued job for (item, kind) exists. */
export async function enqueue(db: Db, itemId: string, kind: JobKind): Promise<boolean> {
  const n = await db.$executeRaw`
    INSERT INTO sync_jobs (item_id, kind) VALUES (${itemId}::uuid, ${kind}::job_kind)
    ON CONFLICT (item_id, kind) WHERE status = 'queued' DO NOTHING`;
  return n === 1;
}

/**
 * Claims one runnable job and leases it (ADR 0004, layer 1).
 *
 * - SKIP LOCKED lets concurrent workers pass over rows another worker is
 *   claiming right now instead of blocking on them.
 * - A job is not runnable while another job of the same kind for the same
 *   Item is running with a live lease: this keeps two workers from syncing
 *   one Item at the same time. It is an optimization; the cursor
 *   compare-and-set at commit time is what guarantees correctness.
 * - Transaction syncs only run for active Items; status refreshes run for
 *   any Item that is not revoked, because they are how an Item recovers.
 */
export async function claimJob(db: Db, workerId: string, leaseSeconds: number): Promise<ClaimedJob | null> {
  const rows = await db.$queryRaw<{ id: bigint; item_id: string; kind: JobKind; attempts: number }[]>`
    UPDATE sync_jobs
       SET status = 'running',
           lease_until = now() + make_interval(secs => ${leaseSeconds}),
           attempts = attempts + 1,
           locked_by = ${workerId},
           updated_at = now()
     WHERE id = (
       SELECT j.id
         FROM sync_jobs j
         JOIN items i ON i.id = j.item_id
        WHERE j.status = 'queued'
          AND j.run_at <= now()
          AND (   (j.kind = 'transactions_sync' AND i.status = 'active')
               OR (j.kind = 'refresh_item_status' AND i.status <> 'revoked'))
          AND NOT EXISTS (
                SELECT 1 FROM sync_jobs r
                 WHERE r.item_id = j.item_id AND r.kind = j.kind
                   AND r.status = 'running' AND r.lease_until > now())
        ORDER BY j.run_at, j.id
        FOR UPDATE OF j SKIP LOCKED
        LIMIT 1)
    RETURNING id, item_id, kind, attempts`;
  const r = rows[0];
  return r ? { id: r.id, itemId: r.item_id, kind: r.kind, attempts: r.attempts } : null;
}

/** Extends the lease. Returns false if this worker no longer owns the job. */
export async function heartbeat(db: Db, job: ClaimedJob, workerId: string, leaseSeconds: number): Promise<boolean> {
  const n = await db.$executeRaw`
    UPDATE sync_jobs SET lease_until = now() + make_interval(secs => ${leaseSeconds}), updated_at = now()
     WHERE id = ${job.id} AND status = 'running' AND locked_by = ${workerId}`;
  return n === 1;
}

export async function finishJob(
  db: Db,
  job: ClaimedJob,
  workerId: string,
  status: "succeeded" | "superseded" | "dead",
  errorCode: string | null = null,
): Promise<boolean> {
  const n = await db.$executeRaw`
    UPDATE sync_jobs
       SET status = ${status}::job_status, last_error_code = ${errorCode}, lease_until = NULL,
           finished_at = now(), updated_at = now()
     WHERE id = ${job.id} AND status = 'running' AND locked_by = ${workerId}`;
  return n === 1;
}

/**
 * Puts a running job back in the queue. If another job for the same Item and
 * kind is already queued, that job covers the work and this one becomes
 * `superseded` (the coalescing index would reject a second queued row).
 *
 * `consumeAttempt: false` is used when the failure is not the job's fault,
 * e.g. the Item needs re-authentication (ADR 0005).
 */
export async function requeueJob(
  db: Db,
  job: ClaimedJob,
  workerId: string,
  opts: { delayMs: number; consumeAttempt: boolean; errorCode: string | null },
): Promise<"queued" | "superseded" | "lost"> {
  try {
    const n = await db.$executeRaw`
      UPDATE sync_jobs
         SET status = 'queued', lease_until = NULL, locked_by = NULL,
             run_at = now() + make_interval(secs => ${opts.delayMs / 1000}),
             attempts = attempts - ${opts.consumeAttempt ? 0 : 1},
             last_error_code = ${opts.errorCode}, updated_at = now()
       WHERE id = ${job.id} AND status = 'running' AND locked_by = ${workerId}`;
    return n === 1 ? "queued" : "lost";
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    return (await finishJob(db, job, workerId, "superseded", opts.errorCode)) ? "superseded" : "lost";
  }
}

/**
 * Recovers jobs whose worker died (ADR 0004, layer 2). A crashed attempt has
 * already been counted at claim time.
 */
export async function reapExpired(db: Db, policy: RetryPolicy, rand: () => number = Math.random): Promise<number> {
  // No row locks are held between this read and the updates below: every
  // update re-checks `status = 'running' AND lease_until < now()`, so two
  // reapers racing on the same job cannot both apply.
  const expired = await db.$queryRaw<{ id: bigint; attempts: number }[]>`
    SELECT id, attempts FROM sync_jobs
     WHERE status = 'running' AND lease_until < now()
     ORDER BY id`;
  let reaped = 0;
  for (const job of expired) {
    if (job.attempts >= policy.maxAttempts) {
      reaped += await db.$executeRaw`
        UPDATE sync_jobs SET status = 'dead', last_error_code = 'LEASE_EXPIRED', lease_until = NULL,
               finished_at = now(), updated_at = now()
         WHERE id = ${job.id} AND status = 'running' AND lease_until < now()`;
      continue;
    }
    const delayMs = backoffMs(job.attempts, policy, rand);
    try {
      reaped += await db.$executeRaw`
        UPDATE sync_jobs SET status = 'queued', lease_until = NULL, locked_by = NULL,
               run_at = now() + make_interval(secs => ${delayMs / 1000}),
               last_error_code = 'LEASE_EXPIRED', updated_at = now()
         WHERE id = ${job.id} AND status = 'running' AND lease_until < now()`;
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      reaped += await db.$executeRaw`
        UPDATE sync_jobs SET status = 'superseded', last_error_code = 'LEASE_EXPIRED', lease_until = NULL,
               finished_at = now(), updated_at = now()
         WHERE id = ${job.id} AND status = 'running' AND lease_until < now()`;
    }
  }
  return reaped;
}

/**
 * Safety net for lost webhooks: enqueue a sync for every active Item that has
 * not synced successfully within `staleAfterSeconds`. Coalescing makes it
 * impossible for this to pile up jobs.
 */
export async function enqueueStaleItems(db: Db, staleAfterSeconds: number): Promise<number> {
  return db.$executeRaw`
    INSERT INTO sync_jobs (item_id, kind)
    SELECT id, 'transactions_sync' FROM items
     WHERE status = 'active'
       AND (last_synced_at IS NULL OR last_synced_at < now() - make_interval(secs => ${staleAfterSeconds}))
    ON CONFLICT (item_id, kind) WHERE status = 'queued' DO NOTHING`;
}
