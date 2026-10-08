import { hostname } from "node:os";
import { runWorker, workerDefaults } from "@psl/core";
import { Keyring } from "@psl/crypto";
import { createDb } from "@psl/db";
import { log, serializeError } from "@psl/log";
import { PlaidHttpClient } from "@psl/plaid";

/**
 * Queue consumer. Connects as app_system (ADR 0007): it processes every
 * user's Items and never serves a user request.
 */

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`missing env ${name}`);
  return v;
}
const num = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

const workerId = process.env.WORKER_ID ?? `${hostname()}:${process.pid}`;
const db = createDb(env("DATABASE_URL_SYSTEM"));
const keyring = await Keyring.fromEnv(process.env);
const plaid = new PlaidHttpClient({
  baseUrl: env("PLAID_BASE_URL"),
  clientId: env("PLAID_CLIENT_ID", "fake-client-id"),
  secret: env("PLAID_SECRET", "fake-secret"),
  timeoutMs: num("PLAID_TIMEOUT_MS", 10_000),
});

/**
 * Chaos failpoint (ADR 0010): after N transaction upserts inside the commit
 * transaction, die with SIGKILL. Nothing runs after this: no finally blocks,
 * no rollback from our side, no exit handlers. Postgres rolls the transaction
 * back when the connection drops.
 */
const failAfter = Number(process.env.FAIL_AFTER_N_UPSERTS ?? 0);
const afterUpsert =
  failAfter > 0
    ? (n: number) => {
        if (n >= failAfter) {
          log.warn("chaos.failpoint_kill", { count: n, worker_id: workerId });
          process.kill(process.pid, "SIGKILL");
        }
      }
    : undefined;

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
      ...(afterUpsert ? { hooks: { afterUpsert } } : {}),
    },
    controller.signal,
  );
} catch (e) {
  log.error("worker.crashed", serializeError(e));
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
