import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { enqueue } from "../src/queue.ts";
import { processOne } from "../src/worker.ts";
import { createHarness, type Harness } from "./harness.ts";

// ADR 0013, fast version (the full version runs inside every `pnpm chaos`
// scenario over the output of every process). The fake marks every access
// token, public token and one merchant name with CANARY. We drive the worker
// through its error paths, where leaks happen, and grep everything it logged.

let h: Harness;
beforeAll(async () => {
  h = await createHarness("psl_test_core_logs");
});
afterAll(() => h.close());
beforeEach(() => h.reset());

describe("no tokens or PII in logs", () => {
  it("stays clean across success, retries, timeouts, crashes, dead jobs and re-auth", async () => {
    const { itemId, plaidItemId } = await h.connect();
    await h.drain(); // success path, includes the CANARY_MERCHANT rows

    h.fake.advance();
    h.fake.setChaos({ fail500Rate: 0.5 });
    await enqueue(h.system, itemId, "transactions_sync");
    await h.drain(h.worker({ retry: { maxAttempts: 50, baseDelayMs: 1, maxDelayMs: 2 } })); // 500s

    h.fake.setChaos({ fail500Rate: 0, timeoutRate: 1, timeoutMs: 700 });
    h.fake.advance();
    await enqueue(h.system, itemId, "transactions_sync");
    await processOne(h.worker()); // timeout
    h.fake.setChaos({ timeoutRate: 0 });

    // Crash inside the commit transaction.
    await processOne(
      h.worker({
        hooks: {
          afterUpsert: () => {
            throw Object.assign(new Error(`boom ${plaidItemId}`), { cause: { token: "access-sandbox-CANARY-x" } });
          },
        },
      }),
    );

    // Dead job.
    h.fake.setChaos({ fail500Rate: 1 });
    await h.drain(h.worker({ retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 } }));
    h.fake.setChaos({ fail500Rate: 0 });

    // Re-auth.
    await h.owner.query(`UPDATE sync_jobs SET status = 'superseded' WHERE status IN ('queued', 'dead')`);
    const item = await h.system.item.findUniqueOrThrow({ where: { id: itemId } });
    const { loadDataKey, decryptAccessToken } = await import("../src/keys.ts");
    const token = await decryptAccessToken(await loadDataKey(h.system, h.keyring, item.userId), item.id, item.accessTokenCt);
    await h.plaid.resetLogin(token);
    await enqueue(h.system, itemId, "transactions_sync");
    await h.drain();

    // The paths above really ran.
    const events = new Set(h.logs.map((l) => JSON.parse(l).event as string));
    for (const e of ["job.succeeded", "job.retry_scheduled", "job.dead", "job.item_needs_reauth"]) {
      expect(events).toContain(e);
    }

    const leaks = h.logs.filter((l) => l.includes("CANARY") || l.includes(token));
    expect(leaks).toEqual([]);
  });
});
