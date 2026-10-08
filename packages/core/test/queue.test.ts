import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { backoffMs, claimJob, enqueue, enqueueStaleItems, parkForReauth, reapExpired } from "../src/queue.ts";
import { processOne } from "../src/worker.ts";
import { createHarness, expectedLedger, type Harness } from "./harness.ts";

// Queue guarantees (ADR 0001, ADR 0004, ADR 0005).

let h: Harness;
beforeAll(async () => {
  h = await createHarness("psl_test_core_queue");
});
afterAll(() => h.close());
beforeEach(() => h.reset());

describe("coalescing (ADR 0001)", () => {
  it("keeps at most one queued job per item and kind, however many triggers arrive", async () => {
    const { itemId } = await h.connect(); // connect enqueues one
    const results = await Promise.all(Array.from({ length: 10 }, () => enqueue(h.system, itemId, "transactions_sync")));
    expect(results.filter(Boolean)).toHaveLength(0);
    expect(await h.jobs()).toHaveLength(1);
    // A different kind is a different queue slot.
    expect(await enqueue(h.system, itemId, "refresh_item_status")).toBe(true);
  });

  it("never absorbs a trigger into a job that is already running", async () => {
    const { itemId } = await h.connect();
    const running = await claimJob(h.system, "w1", 30);
    expect(running).not.toBeNull();
    // Data may have changed after the running job read Plaid: a new job is needed.
    expect(await enqueue(h.system, itemId, "transactions_sync")).toBe(true);
    expect((await h.jobs()).map((j) => j.status)).toEqual(["running", "queued"]);
  });
});

describe("claiming (ADR 0004)", () => {
  it("does not hand out a second job for an item whose sync is running with a live lease", async () => {
    const { itemId } = await h.connect();
    expect(await claimJob(h.system, "w1", 30)).not.toBeNull();
    await enqueue(h.system, itemId, "transactions_sync");
    expect(await claimJob(h.system, "w2", 30)).toBeNull();
  });

  it("lets concurrent claimers take different jobs, never the same one", async () => {
    for (let i = 0; i < 4; i++) await h.connect();
    const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => claimJob(h.system, `w${i}`, 30)));
    const ids = claims.filter((c) => c !== null).map((c) => String(c!.id));
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });
});

describe("reaper (ADR 0004)", () => {
  it("returns a job whose worker died to the queue, counting the crashed attempt", async () => {
    await h.connect();
    const job = await claimJob(h.system, "dead-worker", 30);
    await h.owner.query(`UPDATE sync_jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, [job!.id]);
    expect(await reapExpired(h.system, { maxAttempts: 5, baseDelayMs: 0, maxDelayMs: 0 })).toBe(1);
    expect(await h.jobs()).toMatchObject([{ status: "queued", attempts: 1, last_error_code: "LEASE_EXPIRED" }]);
  });

  it("marks the orphan superseded when a newer job for the item is already queued", async () => {
    const { itemId } = await h.connect();
    const job = await claimJob(h.system, "dead-worker", 30);
    await enqueue(h.system, itemId, "transactions_sync");
    await h.owner.query(`UPDATE sync_jobs SET lease_until = now() - interval '1 second' WHERE id = $1`, [job!.id]);
    await reapExpired(h.system, { maxAttempts: 5, baseDelayMs: 0, maxDelayMs: 0 });
    expect((await h.jobs()).map((j) => j.status)).toEqual(["superseded", "queued"]);
  });

  it("sends a job that keeps crashing to dead after max attempts", async () => {
    await h.connect();
    const job = await claimJob(h.system, "dead-worker", 30);
    await h.owner.query(`UPDATE sync_jobs SET attempts = 5, lease_until = now() - interval '1 second' WHERE id = $1`, [job!.id]);
    await reapExpired(h.system, { maxAttempts: 5, baseDelayMs: 0, maxDelayMs: 0 });
    expect(await h.jobs()).toMatchObject([{ status: "dead", last_error_code: "LEASE_EXPIRED" }]);
  });
});

describe("retries (ADR 0004)", () => {
  it("uses full-jitter exponential backoff, capped", () => {
    const p = { maxAttempts: 5, baseDelayMs: 2_000, maxDelayMs: 300_000 };
    expect(backoffMs(1, p, () => 0.999)).toBeLessThanOrEqual(4_000);
    expect(backoffMs(3, p, () => 0.999)).toBeLessThanOrEqual(16_000);
    expect(backoffMs(30, p, () => 0.999)).toBeLessThanOrEqual(300_000);
    expect(backoffMs(3, p, () => 0)).toBe(0);
  });

  it("retries transient Plaid failures and recovers", async () => {
    const { itemId, plaidItemId } = await h.connect();
    h.fake.setChaos({ fail500Rate: 0.5 });
    await h.drain(h.worker({ retry: { maxAttempts: 50, baseDelayMs: 1, maxDelayMs: 5 } }));
    expect(await h.liveLedger(itemId)).toEqual(expectedLedger(h.fake, plaidItemId));
  });

  it("moves a job to a visible dead state after N failed attempts", async () => {
    await h.connect();
    h.fake.setChaos({ fail500Rate: 1 });
    await h.drain();
    expect(await h.jobs()).toMatchObject([{ status: "dead", attempts: 5, last_error_code: "INTERNAL_SERVER_ERROR" }]);
    expect(h.logs.some((l) => l.includes('"event":"job.dead"'))).toBe(true);
  });

  it("treats a Plaid timeout as transient", async () => {
    await h.connect();
    h.fake.setChaos({ timeoutRate: 1, timeoutMs: 800 });
    await processOne(h.worker());
    expect(await h.jobs()).toMatchObject([{ status: "queued", attempts: 1 }]);
  });
});

describe("re-authentication (ADR 0005)", () => {
  it("parks the item on ITEM_LOGIN_REQUIRED without burning attempts, then resumes from the saved cursor", async () => {
    const { itemId, plaidItemId } = await h.connect();
    await h.drain();
    const { rows: before } = await h.owner.query(`SELECT cursor FROM items WHERE id = $1`, [itemId]);

    const token = await accessTokenOf(itemId);
    await h.plaid.resetLogin(token);
    h.fake.advance();
    await enqueue(h.system, itemId, "transactions_sync");
    await h.drain();

    const { rows: parked } = await h.owner.query(`SELECT status::text, cursor FROM items WHERE id = $1`, [itemId]);
    expect(parked[0]).toEqual({ status: "needs_reauth", cursor: before[0].cursor });
    const queued = (await h.jobs()).filter((j) => j.status === "queued");
    expect(queued).toMatchObject([{ kind: "transactions_sync", attempts: 0, last_error_code: "ITEM_LOGIN_REQUIRED" }]);
    expect(await claimJob(h.system, "w", 30)).toBeNull(); // stops syncing

    // User completes Link update mode; the server enqueues a status refresh.
    h.fake.repair(plaidItemId);
    await enqueue(h.system, itemId, "refresh_item_status");
    await h.drain();

    const { rows: after } = await h.owner.query(`SELECT status::text FROM items WHERE id = $1`, [itemId]);
    expect(after[0].status).toBe("active");
    expect(await h.liveLedger(itemId)).toEqual(expectedLedger(h.fake, plaidItemId));
  });

  it("ignores webhook order: a stale ERROR after repair does not park a healthy item", async () => {
    const { itemId, plaidItemId } = await h.connect();
    await h.drain();
    // The ERROR webhook arrives late, after the item was already repaired.
    // It only enqueues a refresh, and /item/get says the item is healthy.
    await enqueue(h.system, itemId, "refresh_item_status");
    await h.drain();
    const { rows } = await h.owner.query(`SELECT status::text FROM items WHERE id = $1`, [itemId]);
    expect(rows[0].status).toBe("active");
    expect(plaidItemId).toBeTruthy();
  });
});

describe("parking for re-auth is atomic (ADR 0005)", () => {
  async function state(itemId: string) {
    const { rows } = await h.owner.query(`SELECT status::text FROM items WHERE id = $1`, [itemId]);
    return { item: rows[0].status as string, jobs: await h.jobs() };
  }

  it("applies nothing if it dies halfway: the item stays active and the job stays running", async () => {
    const { itemId } = await h.connect();
    const job = (await claimJob(h.system, "w", 30))!;
    const crash = new Error("crash between the two writes");
    await expect(
      parkForReauth(h.system, job, "w", { afterItemUpdate: () => Promise.reject(crash) }),
    ).rejects.toBe(crash);
    expect(await state(itemId)).toMatchObject({ item: "active", jobs: [{ status: "running", attempts: 1 }] });
  });

  it("parks the item and requeues the job without consuming the attempt", async () => {
    const { itemId } = await h.connect();
    const job = (await claimJob(h.system, "w", 30))!;
    expect(await parkForReauth(h.system, job, "w")).toBe("queued");
    expect(await state(itemId)).toMatchObject({
      item: "needs_reauth",
      jobs: [{ status: "queued", attempts: 0, last_error_code: "ITEM_LOGIN_REQUIRED" }],
    });
  });

  it("marks the job superseded when a webhook enqueued another one meanwhile", async () => {
    const { itemId } = await h.connect();
    const job = (await claimJob(h.system, "w", 30))!;
    const r = await parkForReauth(h.system, job, "w", {
      // A webhook lands while the park transaction is open.
      afterItemUpdate: async () => void (await h.owner.query(`INSERT INTO sync_jobs (item_id, kind) VALUES ($1, 'transactions_sync')`, [itemId])),
    });
    expect(r).toBe("superseded");
    expect(await state(itemId)).toMatchObject({ item: "needs_reauth", jobs: [{ status: "superseded" }, { status: "queued" }] });
  });
});

describe("safety net", () => {
  it("enqueues a sync for active items that have not synced recently, and only once", async () => {
    const a = await h.connect();
    const b = await h.connect();
    await h.drain();
    await h.owner.query(`UPDATE items SET last_synced_at = now() - interval '2 days' WHERE id = $1`, [a.itemId]);
    expect(await enqueueStaleItems(h.system, 86_400)).toBe(1);
    expect(await enqueueStaleItems(h.system, 86_400)).toBe(0);
    const queued = (await h.jobs()).filter((j) => j.status === "queued");
    expect(queued).toHaveLength(1);
    expect(b.itemId).not.toBe(a.itemId);
  });
});

async function accessTokenOf(itemId: string): Promise<string> {
  const { loadDataKey, decryptAccessToken } = await import("../src/keys.ts");
  const item = await h.system.item.findUniqueOrThrow({ where: { id: itemId } });
  const dk = await loadDataKey(h.system, h.keyring, item.userId);
  return decryptAccessToken(dk, item.id, item.accessTokenCt);
}
