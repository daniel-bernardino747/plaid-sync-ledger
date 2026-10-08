import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakePlaid } from "@psl/plaid-fake";
import { PlaidCallError, PlaidHttpClient, parsePlaidJson, type PlaidTransaction } from "../src/index.ts";

// Behaviour only the fake can produce on demand (ADR 0008): injected faults,
// mutation during pagination, exact amounts. These also pin the adapter's
// error classification.

let fake: FakePlaid;
let client: PlaidHttpClient;

beforeAll(async () => {
  fake = new FakePlaid({ seed: 11, initialSize: 120, batches: 2 });
  const url = await fake.listen();
  client = new PlaidHttpClient({ baseUrl: url, clientId: "fake-client-id", secret: "fake-secret", timeoutMs: 300 });
});
afterAll(() => fake.close());
beforeEach(() => fake.reset(11));

async function connected() {
  const pt = await client.createPublicToken({ institutionId: "ins_109508", webhook: null });
  const { accessToken, itemId } = await client.exchangePublicToken(pt);
  await new Promise((r) => setTimeout(r, 80)); // initial batch release
  return { accessToken, itemId };
}

async function drain(accessToken: string, cursor: string | null) {
  const added: PlaidTransaction[] = [];
  let c = cursor;
  for (;;) {
    const p = await client.syncTransactions({ accessToken, cursor: c, count: 40 });
    added.push(...p.added);
    c = p.nextCursor;
    if (!p.hasMore) return { added, cursor: c };
  }
}

describe("amount parsing", () => {
  it("keeps the exact digits Plaid sent, never a float", () => {
    const parsed = parsePlaidJson('{"amount":0.30000000000000004,"other":0.1,"nested":{"amount":-19.9}}') as Record<string, unknown>;
    expect(parsed.amount).toBe("0.30000000000000004");
    expect(parsed.other).toBe(0.1); // only `amount` fields are special
    expect((parsed.nested as Record<string, unknown>).amount).toBe("-19.9");
  });

  it("delivers the fake's tricky amounts as exact text", async () => {
    const { accessToken } = await connected();
    const { added } = await drain(accessToken, null);
    const amounts = new Set(added.map((t) => t.amount));
    // 0.1 and 1234567.89 are not representable as doubles
    expect([...amounts].some((a) => a === "0.1" || a === "0.3" || a === "1234567.89")).toBe(true);
  });
});

describe("pagination under mutation", () => {
  it("fails the next page with MUTATION_DURING_PAGINATION when data changes mid-update", async () => {
    const { accessToken, itemId } = await connected();
    const first = await client.syncTransactions({ accessToken, cursor: null, count: 40 });
    expect(first.hasMore).toBe(true);
    fake.releaseSilently(itemId);
    const err = await client
      .syncTransactions({ accessToken, cursor: first.nextCursor, count: 40 })
      .catch((e: unknown) => e);
    expect((err as PlaidCallError).kind).toBe("mutation_during_pagination");
    expect((err as PlaidCallError).errorType).toBe("TRANSACTIONS_ERROR");
  });

  it("succeeds when the whole loop restarts from the update's first cursor", async () => {
    const { accessToken, itemId } = await connected();
    const first = await client.syncTransactions({ accessToken, cursor: null, count: 40 });
    fake.releaseSilently(itemId);
    await expect(client.syncTransactions({ accessToken, cursor: first.nextCursor, count: 40 })).rejects.toThrow();
    const { added } = await drain(accessToken, null);
    const expectedIds = fake.expectedLedger(itemId).map((t) => t.transaction_id);
    expect(added.map((t) => t.transactionId).sort()).toEqual(expectedIds);
  });

  it("injects the mutation once per update on the configured page", async () => {
    const { accessToken } = await connected();
    fake.setChaos({ mutationOnPage: 2 });
    const first = await client.syncTransactions({ accessToken, cursor: null, count: 40 });
    await expect(client.syncTransactions({ accessToken, cursor: first.nextCursor, count: 40 })).rejects.toMatchObject({
      kind: "mutation_during_pagination",
    });
    await expect(drain(accessToken, null)).resolves.toBeDefined();
  });
});

describe("error classification", () => {
  it("classifies a 500 INTERNAL_SERVER_ERROR as transient (retryable)", async () => {
    const { accessToken } = await connected();
    fake.setChaos({ fail500Rate: 1 });
    const err = (await client.syncTransactions({ accessToken, cursor: null, count: 10 }).catch((e: unknown) => e)) as PlaidCallError;
    expect(err.kind).toBe("transient");
    expect(err.retryable).toBe(true);
    expect(err.httpStatus).toBe(500);
  });

  it("classifies a timeout as transient", async () => {
    const { accessToken } = await connected();
    fake.setChaos({ timeoutRate: 1, timeoutMs: 1_000 });
    const err = (await client.syncTransactions({ accessToken, cursor: null, count: 10 }).catch((e: unknown) => e)) as PlaidCallError;
    expect(err.kind).toBe("transient");
  });

  it("never puts the access token in the error message", async () => {
    const err = (await client
      .syncTransactions({ accessToken: "access-sandbox-CANARY-leak-check", cursor: null, count: 10 })
      .catch((e: unknown) => e)) as Error;
    expect(String(err.message)).not.toContain("CANARY");
    expect(JSON.stringify(err)).not.toContain("CANARY");
  });
});
