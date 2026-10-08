import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakePlaid } from "@psl/plaid-fake";
import { PlaidCallError, PlaidHttpClient, type SyncPage } from "../src/index.ts";

/**
 * One contract suite, two targets (ADR 0008):
 *   pnpm test                    -> against packages/plaid-fake
 *   CONTRACT_TARGET=sandbox ...  -> against https://sandbox.plaid.com
 * The suite only asserts what both must agree on. Fault-injection tests that
 * only the fake can run live in fake-behaviour.test.ts.
 */
const target = process.env.CONTRACT_TARGET === "sandbox" ? "sandbox" : "fake";
const SANDBOX_INSTITUTION = "ins_109508"; // First Platypus Bank

let fake: FakePlaid | null = null;
let client: PlaidHttpClient;

beforeAll(async () => {
  if (target === "sandbox") {
    const clientId = process.env.PLAID_CLIENT_ID;
    const secret = process.env.PLAID_SECRET;
    if (!clientId || !secret) throw new Error("CONTRACT_TARGET=sandbox needs PLAID_CLIENT_ID and PLAID_SECRET");
    client = new PlaidHttpClient({ baseUrl: "https://sandbox.plaid.com", clientId, secret, timeoutMs: 30_000 });
  } else {
    fake = new FakePlaid({ seed: 7, initialSize: 120, batches: 2 });
    const url = await fake.listen();
    client = new PlaidHttpClient({ baseUrl: url, clientId: "fake-client-id", secret: "fake-secret" });
  }
});

afterAll(async () => {
  await fake?.close();
});

async function connect() {
  const publicToken = await client.createPublicToken({ institutionId: SANDBOX_INSTITUTION, webhook: null });
  return client.exchangePublicToken(publicToken);
}

/** Paginates one full update; waits while the initial pull is not ready yet. */
async function syncAll(accessToken: string, cursor: string | null, count = 50) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const pages: SyncPage[] = [];
    let c = cursor;
    let page: SyncPage;
    do {
      page = await client.syncTransactions({ accessToken, cursor: c, count });
      pages.push(page);
      c = page.nextCursor;
    } while (page.hasMore);
    // A first sync is only complete once Plaid reports the historical pull as
    // done. Before that, Sandbox can return only the initial (30-day) slice,
    // which may fit in one page.
    const ready = pages.at(-1)!.updateStatus === "HISTORICAL_UPDATE_COMPLETE";
    if (cursor !== null || ready || Date.now() > deadline) return { pages, cursor: c! };
    await new Promise((r) => setTimeout(r, 2_000));
  }
}

describe(`Plaid contract (${target})`, () => {
  it("exchanges a public token for an item id and access token", async () => {
    const { itemId, accessToken } = await connect();
    expect(itemId).toEqual(expect.any(String));
    expect(accessToken).toMatch(/^access-sandbox-/);
  });

  it("paginates /transactions/sync until has_more is false, with exact decimal amounts", async () => {
    const { accessToken } = await connect();
    // Small pages: the default Sandbox Item has exactly 50 transactions, so a
    // page size of 50 would never paginate.
    const { pages, cursor } = await syncAll(accessToken, null, 10);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.at(-1)!.hasMore).toBe(false);
    expect(cursor).toEqual(expect.any(String));
    const added = pages.flatMap((p) => p.added);
    expect(added.length).toBeGreaterThan(0);
    for (const t of added) {
      expect(t.amount).toMatch(/^-?\d+(\.\d+)?$/);
      expect(t.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof t.pending).toBe("boolean");
    }
    expect(pages[0]!.accounts.length).toBeGreaterThan(0);
    // transaction_id is unique within one full update
    expect(new Set(added.map((t) => t.transactionId)).size).toBe(added.length);
  });

  it("returns no further changes when called again with the final cursor", async () => {
    const { accessToken } = await connect();
    const first = await syncAll(accessToken, null);
    const again = await client.syncTransactions({ accessToken, cursor: first.cursor, count: 50 });
    expect(again.added).toEqual([]);
    expect(again.removed).toEqual([]);
    expect(again.hasMore).toBe(false);
  });

  it("classifies an invalid access token as fatal", async () => {
    const err = await client
      .syncTransactions({ accessToken: "access-sandbox-00000000-0000-0000-0000-000000000000", cursor: null, count: 10 })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlaidCallError);
    expect((err as PlaidCallError).kind).toBe("fatal");
    expect((err as PlaidCallError).errorCode).toBe("INVALID_ACCESS_TOKEN");
  });

  it("reports ITEM_LOGIN_REQUIRED after /sandbox/item/reset_login, on sync and on /item/get", async () => {
    const { accessToken, itemId } = await connect();
    await syncAll(accessToken, null);
    await client.resetLogin(accessToken);
    const err = await client.syncTransactions({ accessToken, cursor: null, count: 10 }).catch((e: unknown) => e);
    expect((err as PlaidCallError).kind).toBe("item_login_required");
    const status = await client.getItem(accessToken);
    expect(status).toMatchObject({ itemId, errorCode: "ITEM_LOGIN_REQUIRED" });
  });

  it("answers an unknown webhook verification key id with null", async () => {
    expect(await client.getWebhookVerificationKey("no-such-kid")).toBeNull();
  });
});
