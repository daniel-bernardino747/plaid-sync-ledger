import { hostname } from "node:os";
import { runWorker, workerDefaults } from "@psl/core";
import { Keyring } from "@psl/crypto";
import { createDb } from "@psl/db";
import { log, serializeError } from "@psl/log";
import { PlaidHttpClient, plaidConfigFromEnv } from "@psl/plaid";

/**
 * Queue consumer. Connects as app_system (ADR 0007): it processes every
 * user's Items and never serves a user request.
 */

function env(name: string, fallback?: string): string {
  const v = process.env[name] || fallback;
  if (v === undefined || v === "") throw new Error(`missing env ${name}`);
  return v;
}
const num = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

const workerId = process.env.WORKER_ID ?? `${hostname()}:${process.pid}`;
const db = createDb(env("DATABASE_URL_SYSTEM"));
const keyring = await Keyring.fromEnv({
  MASTER_KEYS: process.env.MASTER_KEYS,
  MASTER_KEY_CURRENT: process.env.MASTER_KEY_CURRENT,
});
const plaid = new PlaidHttpClient({ ...plaidConfigFromEnv(process.env), timeoutMs: num("PLAID_TIMEOUT_MS", 10_000) });

/**
 * Chaos failpoints (ADR 0010). The process dies with SIGKILL: nothing runs
 * after it (no finally blocks, no rollback from our side, no exit handlers).
 *   FAIL_AFTER_N_UPSERTS: inside the commit transaction; Postgres rolls it back
 *                         when the connection drops.
 *   FAIL_AFTER_N_PAGES:   during pagination, with pages held only in memory.
 */
function failpoint(name: string): ((n: number) => void) | undefined {
  const limit = Number(process.env[name] ?? 0);
  if (limit <= 0) return undefined;
  return (n) => {
    if (n >= limit) {
      log.warn("chaos.failpoint_kill", { count: n, reason: name, worker_id: workerId });
      process.kill(process.pid, "SIGKILL");
    }
  };
}
const afterUpsert = failpoint("FAIL_AFTER_N_UPSERTS");
const afterPage = failpoint("FAIL_AFTER_N_PAGES");

const controller = new AbortController();
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log.info("worker.shutdown_requested", { worker_id: workerId, reason: sig });
    controller.abort();
  });
}

try {
  await runWorker(
    {
      db,
      plaid,
      keyring,
      workerId,
      leaseSeconds: num("LEASE_SECONDS", workerDefaults.leaseSeconds),
      pageSize: num("SYNC_PAGE_SIZE", workerDefaults.pageSize),
      retry: {
        maxAttempts: num("MAX_ATTEMPTS", workerDefaults.retry.maxAttempts),
        baseDelayMs: num("BACKOFF_BASE_MS", workerDefaults.retry.baseDelayMs),
        maxDelayMs: num("BACKOFF_MAX_MS", workerDefaults.retry.maxDelayMs),
      },
      pollMs: num("POLL_MS", workerDefaults.pollMs),
      safetyNetEveryMs: num("SAFETY_NET_EVERY_MS", workerDefaults.safetyNetEveryMs),
      staleAfterSeconds: num("STALE_AFTER_SECONDS", workerDefaults.staleAfterSeconds),
      hooks: { ...(afterUpsert ? { afterUpsert } : {}), ...(afterPage ? { afterPage } : {}) },
    },
    controller.signal,
  );
} catch (e) {
  log.error("worker.crashed", serializeError(e));
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
