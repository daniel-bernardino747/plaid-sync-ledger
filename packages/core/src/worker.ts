import type { Db } from "@psl/db";
import type { Keyring } from "@psl/crypto";
import { log, serializeError } from "@psl/log";
import { PlaidCallError, type PlaidGateway } from "@psl/plaid";
import {
  backoffMs,
  claimJob,
  DEFAULT_RETRY,
  enqueueStaleItems,
  finishJob,
  heartbeat,
  parkForReauth,
  reapExpired,
  requeueJob,
  type ClaimedJob,
  type RetryPolicy,
} from "./queue.ts";
import { refreshItemStatus } from "./refresh.ts";
import { LeaseLostError, syncItem, type SyncHooks } from "./sync.ts";

export interface WorkerConfig {
  db: Db; // app_system
  plaid: PlaidGateway;
  keyring: Keyring;
  workerId: string;
  leaseSeconds: number;
  pageSize: number;
  retry: RetryPolicy;
  pollMs: number;
  /** Safety-net cadence and staleness threshold (roadmap, block 3). */
  safetyNetEveryMs: number;
  staleAfterSeconds: number;
  /** Chaos failpoints (ADR 0010): after N upserts inside the commit, after N fetched pages. */
  hooks?: Pick<SyncHooks, "afterUpsert"> & { afterPage?: (pages: number) => void | Promise<void> };
  rand?: () => number;
}

export const workerDefaults = {
  leaseSeconds: 60,
  pageSize: 100,
  retry: DEFAULT_RETRY,
  pollMs: 500,
  safetyNetEveryMs: 60 * 60_000,
  staleAfterSeconds: 24 * 3600,
};

/** Claims and runs at most one job. Returns false when the queue had nothing runnable. */
export async function processOne(cfg: WorkerConfig): Promise<boolean> {
  const job = await claimJob(cfg.db, cfg.workerId, cfg.leaseSeconds);
  if (!job) return false;
  const started = Date.now();
  const base = { job_id: job.id, job_kind: job.kind, item_id: job.itemId, attempt: job.attempts, worker_id: cfg.workerId };

  try {
    if (job.kind === "refresh_item_status") {
      const r = await refreshItemStatus(cfg, job.itemId);
      await finishJob(cfg.db, job, cfg.workerId, "succeeded");
      log.info("job.succeeded", { ...base, outcome: r.outcome, duration_ms: Date.now() - started });
      return true;
    }

    let pagesFetched = 0;
    const r = await syncItem(
      {
        db: cfg.db,
        plaid: cfg.plaid,
        keyring: cfg.keyring,
        pageSize: cfg.pageSize,
        hooks: {
          ...(cfg.hooks?.afterUpsert ? { afterUpsert: cfg.hooks.afterUpsert } : {}),
          onPage: async () => {
            await cfg.hooks?.afterPage?.(++pagesFetched);
            return heartbeat(cfg.db, job, cfg.workerId, cfg.leaseSeconds);
          },
        },
      },
      job.itemId,
    );
    if (r.outcome === "committed") {
      await finishJob(cfg.db, job, cfg.workerId, "succeeded");
      log.info("job.succeeded", {
        ...base,
        outcome: r.outcome,
        pages: r.pages,
        added: r.added,
        modified: r.modified,
        removed: r.removed,
        restarts: r.restarts,
        duration_ms: Date.now() - started,
      });
    } else {
      // Fenced out, or the Item stopped being active: nothing left to do.
      await finishJob(cfg.db, job, cfg.workerId, "superseded", r.outcome.toUpperCase());
      log.info("job.superseded", { ...base, outcome: r.outcome, duration_ms: Date.now() - started });
    }
    return true;
  } catch (e) {
    await handleFailure(cfg, job, e, base);
    return true;
  }
}

async function handleFailure(cfg: WorkerConfig, job: ClaimedJob, e: unknown, base: Record<string, unknown>) {
  if (e instanceof LeaseLostError) {
    // Someone else owns the job now. Record nothing.
    log.warn("job.lease_lost", base);
    return;
  }

  if (e instanceof PlaidCallError && e.kind === "item_login_required") {
    // First-hand signal (ADR 0005): stop syncing, do not burn an attempt. The
    // claim query skips non-active Items, so the requeued job waits for repair.
    const r = await parkForReauth(cfg.db, job, cfg.workerId, { errorCode: e.errorCode ?? "ITEM_LOGIN_REQUIRED" });
    log.warn("job.item_needs_reauth", { ...base, outcome: r });
    return;
  }

  const retryable = e instanceof PlaidCallError ? e.retryable || e.kind === "mutation_during_pagination" : true;
  const errorCode = e instanceof PlaidCallError ? (e.errorCode ?? e.kind.toUpperCase()) : "INTERNAL";

  if (!retryable || job.attempts >= cfg.retry.maxAttempts) {
    await finishJob(cfg.db, job, cfg.workerId, "dead", errorCode);
    log.error("job.dead", { ...base, max_attempts: cfg.retry.maxAttempts, ...serializeError(e) });
    return;
  }
  const delayMs = backoffMs(job.attempts, cfg.retry, cfg.rand);
  const r = await requeueJob(cfg.db, job, cfg.workerId, { delayMs, errorCode });
  log.warn("job.retry_scheduled", { ...base, delay_ms: delayMs, outcome: r, ...serializeError(e) });
}

/** The worker loop: reap, claim, run, repeat. Stops after the current job on abort. */
export async function runWorker(cfg: WorkerConfig, signal: AbortSignal): Promise<void> {
  let lastSafetyNet = 0;
  log.info("worker.started", { worker_id: cfg.workerId });
  while (!signal.aborted) {
    try {
      const reaped = await reapExpired(cfg.db, cfg.retry, cfg.rand);
      if (reaped > 0) log.warn("queue.reaped", { reaped, worker_id: cfg.workerId });

      if (Date.now() - lastSafetyNet >= cfg.safetyNetEveryMs) {
        lastSafetyNet = Date.now();
        const enqueued = await enqueueStaleItems(cfg.db, cfg.staleAfterSeconds);
        if (enqueued > 0) log.info("queue.safety_net", { enqueued });
      }

      const worked = await processOne(cfg);
      if (!worked) await sleep(cfg.pollMs, signal);
    } catch (e) {
      // Database unavailable or similar: back off and keep going.
      log.error("worker.loop_error", serializeError(e));
      await sleep(Math.max(cfg.pollMs, 1_000), signal);
    }
  }
  log.info("worker.stopped", { worker_id: cfg.workerId });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });
}
