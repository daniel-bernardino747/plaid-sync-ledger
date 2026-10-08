import { sqlState, type Db, type JobKind } from "@psl/db";
import { ITEM_LOGIN_REQUIRED } from "@psl/plaid";

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
const isUniqueViolation = (e: unknown) => sqlState(e) === UNIQUE_VIOLATION;

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
 */
export async function requeueJob(
  db: Db,
  job: ClaimedJob,
  workerId: string,
  opts: { delayMs: number; errorCode: string | null },
): Promise<"queued" | "superseded" | "lost"> {
  try {
    const n = await db.$executeRaw`
      UPDATE sync_jobs
         SET status = 'queued', lease_until = NULL, locked_by = NULL,
             run_at = now() + make_interval(secs => ${opts.delayMs / 1000}),
             last_error_code = ${opts.errorCode}, updated_at = now()
       WHERE id = ${job.id} AND status = 'running' AND locked_by = ${workerId}`;
    return n === 1 ? "queued" : "lost";
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
    return (await finishJob(db, job, workerId, "superseded", opts.errorCode)) ? "superseded" : "lost";
  }
}

/**
 * ITEM_LOGIN_REQUIRED from Plaid (ADR 0005): in ONE transaction, park the Item
 * in needs_reauth and give the job back to the queue without consuming the
 * attempt (it was not the job's fault). If another job for the Item is already
 * queued, this one becomes `superseded` instead.
 *
 * A webhook can insert a queued job between our existence check and our
 * update; the coalescing index then rejects the update (23505). Re-running the
 * whole transaction once sees that job and takes the superseded branch.
 *
 * `afterItemUpdate` is a test seam: it runs between the two writes on the
 * first attempt only.
 */
export async function parkForReauth(
  db: Db,
  job: ClaimedJob,
  workerId: string,
  opts: { errorCode?: string; afterItemUpdate?: () => Promise<void> } = {},
): Promise<"queued" | "superseded" | "lost"> {
  const errorCode = opts.errorCode ?? ITEM_LOGIN_REQUIRED;
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(async (tx) => {
        await tx.$executeRaw`
          UPDATE items SET status = 'needs_reauth', updated_at = now()
           WHERE id = ${job.itemId}::uuid AND status = 'active'`;
        if (attempt === 0) await opts.afterItemUpdate?.();
        const rows = await tx.$queryRaw<{ status: "queued" | "superseded" }[]>`
          WITH decision AS (
            SELECT EXISTS (
              SELECT 1 FROM sync_jobs q
               WHERE q.item_id = ${job.itemId}::uuid AND q.kind = ${job.kind}::job_kind AND q.status = 'queued'
            ) AS covered)
          UPDATE sync_jobs j
             SET status = CASE WHEN d.covered THEN 'superseded'::job_status ELSE 'queued'::job_status END,
                 finished_at = CASE WHEN d.covered THEN now() END,
                 locked_by = CASE WHEN d.covered THEN j.locked_by END,
                 attempts = j.attempts - 1,
                 lease_until = NULL, run_at = now(), last_error_code = ${errorCode}, updated_at = now()
            FROM decision d
           WHERE j.id = ${job.id} AND j.status = 'running' AND j.locked_by = ${workerId}
          RETURNING j.status::text AS status`;
        return rows[0]?.status ?? "lost";
      });
    } catch (e) {
      if (attempt === 0 && isUniqueViolation(e)) continue;
      throw e;
    }
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
