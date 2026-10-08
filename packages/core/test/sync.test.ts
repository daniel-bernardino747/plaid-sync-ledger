import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { syncItem } from "../src/sync.ts";
import { enqueue } from "../src/queue.ts";
import { createHarness, expectedLedger, recordingGateway, type Harness } from "./harness.ts";

// Sync engine guarantees (ADR 0003, ADR 0004), against real Postgres and the
// fake over HTTP. The oracle is the fake's own ground truth, not a hash.

let h: Harness;
beforeAll(async () => {
  h = await createHarness("psl_test_core_sync");
});
afterAll(() => h.close());
beforeEach(() => h.reset());

const syncDeps = (extra: Partial<Parameters<typeof syncItem>[0]> = {}) => ({
  db: h.system,
  plaid: h.plaid,
  keyring: h.keyring,
  pageSize: 40,
  ...extra,
});

describe("sync by cursor", () => {
  it("produces exactly the ledger Plaid describes, across batches", async () => {
    const { itemId, plaidItemId } = await h.connect();
    await h.drain();
    expect(await h.liveLedger(itemId)).toEqual(expectedLedger(h.fake, plaidItemId));

    // Later batches: pending -> posted, edits and removals.
    for (let i = 0; i < 3; i++) {
      h.fake.advance();
      await enqueue(h.system, itemId, "transactions_sync");
      await h.drain();
      expect(await h.liveLedger(itemId)).toEqual(expectedLedger(h.fake, plaidItemId));
    }
  });

  it("is idempotent: replaying the same update from the same cursor changes nothing", async () => {
    const { itemId } = await h.connect();
    await h.drain();
    const hash = await h.ledgerHash();

    // Rewind the cursor and apply every page again.
    await h.owner.query(`UPDATE items SET cursor = NULL WHERE id = $1`, [itemId]);
    const r = await syncItem(syncDeps(), itemId);
    expect(r.outcome).toBe("committed");
    expect(await h.ledgerHash()).toBe(hash);
  });

  it("stores the new cursor in the same transaction as the changes: a crash mid-commit leaves both untouched", async () => {
    const { itemId, plaidItemId } = await h.connect();
    const crash = new Error("simulated crash");
    await expect(
      syncItem(
        syncDeps({
          hooks: {
            afterUpsert: (n) => {
              if (n === 50) throw crash;
            },
          },
        }),
        itemId,
      ),
    ).rejects.toBe(crash);

    const { rows } = await h.owner.query(
      `SELECT (SELECT cursor FROM items WHERE id = $1) AS cursor, (SELECT count(*)::int FROM transactions) AS n`,
      [itemId],
    );
    expect(rows[0]).toEqual({ cursor: null, n: 0 });

    // The retry starts from the untouched cursor and converges.
    await expect(syncItem(syncDeps(), itemId)).resolves.toMatchObject({ outcome: "committed" });
    expect(await h.liveLedger(itemId)).toEqual(expectedLedger(h.fake, plaidItemId));
  });

  it("restarts the whole loop from the start cursor on MUTATION_DURING_PAGINATION", async () => {
    const { itemId, plaidItemId } = await h.connect();
    h.fake.setChaos({ mutationOnPage: 2 });
    const r = await syncItem(syncDeps(), itemId);
    expect(r).toMatchObject({ outcome: "committed", restarts: 1 });
    expect(await h.liveLedger(itemId)).toEqual(expectedLedger(h.fake, plaidItemId));
  });

  it("restarts when the data really changes between pages, and ends with the newer data", async () => {
    const { itemId, plaidItemId } = await h.connect();
    let page = 0;
    const r = await syncItem(
      syncDeps({
        hooks: {
          onPage: async () => {
            if (++page === 1) h.fake.releaseSilently(plaidItemId);
            return true;
          },
        },
      }),
      itemId,
    );
    expect(r).toMatchObject({ outcome: "committed", restarts: 1 });
    expect(await h.liveLedger(itemId)).toEqual(expectedLedger(h.fake, plaidItemId));
  });

  it("fences out a concurrent run: two syncs of one item, exactly one commits", async () => {
    const { itemId, plaidItemId } = await h.connect();
    const results = await Promise.all([syncItem(syncDeps(), itemId), syncItem(syncDeps(), itemId)]);
    const outcomes = results.map((r) => r.outcome).sort();
    expect(outcomes).toEqual(["committed", "cursor_moved"]);
    expect(await h.liveLedger(itemId)).toEqual(expectedLedger(h.fake, plaidItemId));
  });

  it("fences out a zombie: stale pages cannot overwrite newer data or move the cursor back", async () => {
    const { itemId, plaidItemId } = await h.connect();
    await h.drain();
    h.fake.advance(); // batch 1 is available: the zombie will read it

    let pagesSeen = 0;
    const zombie = await syncItem(
      syncDeps({
        hooks: {
          onPage: async () => {
            pagesSeen++;
            // The zombie holds batch 1 in memory (paused, lost its lease...).
            // Meanwhile batch 2 lands and a healthy worker commits batches 1+2.
            h.fake.releaseSilently(plaidItemId);
            await syncItem(syncDeps(), itemId);
            return true;
          },
        },
      }),
      itemId,
    );
    expect(pagesSeen).toBe(1);
    expect(zombie.outcome).toBe("cursor_moved");
    // Without the fence, the zombie's batch-1 view would revert batch-2 edits
    // and resurrect batch-2 removals.
    expect(await h.liveLedger(itemId)).toEqual(expectedLedger(h.fake, plaidItemId));
    const { rows } = await h.owner.query(`SELECT cursor FROM items WHERE id = $1`, [itemId]);
    expect(rows[0].cursor).toBe(h.fake.state().items[0]!.final_cursor);
  });

  it("cannot resurrect a transaction a newer sync already removed", async () => {
    // ADR 0003 (amended): upserts clear removed_at, because Plaid saying
    // added/modified means the row is live. What stops a stale upsert from
    // bringing a removed row back is the cursor fence, and this proves it.
    const { itemId, plaidItemId } = await h.connect();
    await h.drain();
    h.fake.advance(); // batch 1 adds pending transactions; batch 3 settles them (pending removed)

    const zombieAdded: string[] = [];
    const recording = recordingGateway(h.plaid, (_input, page) => zombieAdded.push(...page.added.map((t) => t.transactionId)));

    let once = true;
    const zombie = await syncItem(
      syncDeps({
        plaid: recording,
        hooks: {
          onPage: async () => {
            if (!once) return true;
            once = false;
            // The zombie now holds batch 1 in memory. Batches 2 and 3 land and
            // a healthy worker commits all of it, removing batch 1's pendings.
            h.fake.releaseSilently(plaidItemId);
            h.fake.releaseSilently(plaidItemId);
            await syncItem(syncDeps(), itemId);
            return true;
          },
        },
      }),
      itemId,
    );

    const live = new Set(expectedLedger(h.fake, plaidItemId).map((t) => t.transaction_id));
    const resurrectable = zombieAdded.filter((id) => !live.has(id));
    expect(resurrectable.length).toBeGreaterThan(0); // the scenario really contains the hazard
    expect(zombie.outcome).toBe("cursor_moved");
    const { rows } = await h.owner.query(
      `SELECT plaid_transaction_id FROM transactions WHERE plaid_transaction_id = ANY($1) AND removed_at IS NULL`,
      [resurrectable],
    );
    expect(rows).toEqual([]);
    expect(await h.liveLedger(itemId)).toEqual(expectedLedger(h.fake, plaidItemId));
  });

  it("stores amounts exactly, with no float rounding", async () => {
    await h.connect();
    await h.drain();
    const { rows } = await h.owner.query(
      `SELECT amount::text AS a FROM transactions WHERE amount IN (0.1, 0.3, 0.7, 1234567.89, -45.6) GROUP BY amount`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.a).toMatch(/^-?\d+\.\d{2}00$/);
  });
});
