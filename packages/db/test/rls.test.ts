import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { createDb, forUser, type Db } from "../src/index.ts";
import { createTestDatabase, truncateAll, type TestDbUrls } from "../src/testing.ts";

// ADR 0007: per-user scoping is enforced by Postgres, so these tests use the
// app_web role and deliberately issue UNFILTERED queries.

let urls: TestDbUrls;
let web: Db;
let owner: pg.Client;
const ALICE = "00000000-0000-4000-8000-00000000000a";
const BOB = "00000000-0000-4000-8000-00000000000b";

beforeAll(async () => {
  urls = await createTestDatabase("psl_test_db");
  // max: 1 forces every transaction onto the same pooled connection, which is
  // what the "context does not leak" test needs.
  web = createDb(urls.web, { max: 1 });
  owner = new pg.Client({ connectionString: urls.owner });
  await owner.connect();
});

afterAll(async () => {
  await web?.$disconnect();
  await owner?.end();
});

beforeEach(async () => {
  await truncateAll(urls.owner);
  await owner.query(`INSERT INTO users (id, name) VALUES ($1, 'Alice'), ($2, 'Bob')`, [ALICE, BOB]);
  for (const [user, tag] of [[ALICE, "a"], [BOB, "b"]] as const) {
    await owner.query(
      `INSERT INTO items (id, user_id, plaid_item_id, access_token_ct)
       VALUES ($1, $2, $3, 'ct')`,
      [itemId(tag), user, `plaid-item-${tag}`],
    );
    await owner.query(
      `INSERT INTO accounts (plaid_account_id, user_id, item_id, name, type)
       VALUES ($1, $2, $3, 'Checking', 'depository')`,
      [`acc-${tag}`, user, itemId(tag)],
    );
    await owner.query(
      `INSERT INTO transactions (plaid_transaction_id, user_id, item_id, plaid_account_id,
         amount, date, name, pending)
       VALUES ($1, $2, $3, $4, 10, '2026-01-01', 'Coffee', false)`,
      [`tx-${tag}`, user, itemId(tag), `acc-${tag}`],
    );
  }
});

function itemId(tag: "a" | "b") {
  return tag === "a" ? "10000000-0000-4000-8000-00000000000a" : "10000000-0000-4000-8000-00000000000b";
}

describe("row-level security (app_web)", () => {
  it("returns no rows from any scoped table without a user context", async () => {
    expect(await web.item.findMany()).toEqual([]);
    expect(await web.account.findMany()).toEqual([]);
    expect(await web.transaction.findMany()).toEqual([]);
    expect(await web.userKey.findMany()).toEqual([]);
  });

  it("never returns another user's rows, even for an unfiltered query", async () => {
    const rows = await forUser(web, ALICE, async (tx) => ({
      items: await tx.item.findMany(),
      txs: await tx.transaction.findMany(),
    }));
    expect(rows.items.map((i) => i.userId)).toEqual([ALICE]);
    expect(rows.txs.map((t) => t.plaidTransactionId)).toEqual(["tx-a"]);
  });

  it("rejects writing a row that belongs to another user", async () => {
    await expect(
      forUser(web, ALICE, (tx) =>
        tx.item.create({ data: { userId: BOB, plaidItemId: "sneaky", accessTokenCt: "ct" } }),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("cannot move a visible row to another user", async () => {
    await expect(
      forUser(web, ALICE, (tx) => tx.item.update({ where: { id: itemId("a") }, data: { userId: BOB } })),
    ).rejects.toThrow(/row-level security/i);
  });

  it("does not leak the user context to the next transaction on the same connection", async () => {
    await forUser(web, ALICE, (tx) => tx.item.findMany());
    const [row] = await web.$queryRaw<{ v: string | null }[]>`SELECT current_setting('app.user_id', true) AS v`;
    expect(row?.v ?? "").toBe("");
    expect(await web.item.findMany()).toEqual([]);
  });

  it("only lets a user enqueue jobs for their own items", async () => {
    await forUser(web, ALICE, (tx) => tx.$executeRaw`SELECT enqueue_job(${itemId("a")}::uuid, 'transactions_sync')`);
    await expect(
      forUser(web, ALICE, (tx) => tx.$executeRaw`SELECT enqueue_job(${itemId("b")}::uuid, 'transactions_sync')`),
    ).rejects.toThrow(/item not found/);
    const { rows } = await owner.query(`SELECT item_id FROM sync_jobs`);
    expect(rows).toEqual([{ item_id: itemId("a") }]);
  });

  it("has no direct access to the queue tables", async () => {
    await expect(web.syncJob.findMany()).rejects.toThrow(/permission denied/i);
    await expect(web.webhookEvent.findMany()).rejects.toThrow(/permission denied/i);
  });
});
