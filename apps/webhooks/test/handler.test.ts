import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { FakePlaid } from "@psl/plaid-fake";
import { createTestDatabase, type TestDbUrls } from "@psl/db/testing";
import worker, { type Env } from "../src/index.ts";

// ADR 0002: the Worker answers 200 only after the event is committed, and a
// failed write becomes a 5xx so Plaid redelivers instead of losing the event.

let fake: FakePlaid;
let urls: TestDbUrls;
let owner: postgres.Sql;
const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };

beforeAll(async () => {
  urls = await createTestDatabase("psl_test_webhooks_handler");
  owner = postgres(urls.owner, { max: 1, onnotice: () => {} });
  fake = new FakePlaid();
  await fake.listen();
});
afterAll(async () => {
  await Promise.allSettled(pending);
  await owner.end();
  await fake.close();
});

const env = (connectionString: string): Env => ({
  HYPERDRIVE: { connectionString },
  PLAID_TARGET: "fake",
  FAKE_PLAID_URL: fake.url,
});

function signed(itemId: string) {
  const body = JSON.stringify({ webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: itemId }, null, 2);
  return new Request("http://worker/plaid/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "plaid-verification": fake.signForTest(body) },
    body,
  });
}

describe("webhook handler", () => {
  it("answers 200 only once the event is in the database", async () => {
    const res = await worker.fetch(signed("handler-item-1"), env(urls.system), ctx);
    expect(res.status).toBe(200);
    const rows = await owner`SELECT plaid_item_id FROM webhook_events WHERE plaid_item_id = 'handler-item-1'`;
    expect(rows).toHaveLength(1);
  });

  it("answers 503 when the write fails, so Plaid retries instead of the event being lost", async () => {
    const res = await worker.fetch(signed("handler-item-2"), env("postgresql://app_system:wrong@127.0.0.1:1/none"), ctx);
    expect(res.status).toBe(503);
  });

  it("rejects an unsigned request without touching the database", async () => {
    const req = new Request("http://worker/plaid/webhook", { method: "POST", body: "{}" });
    const res = await worker.fetch(req, env("postgresql://never-used:x@127.0.0.1:1/none"), ctx);
    expect(res.status).toBe(400);
  });

  it("only accepts POST on the webhook path", async () => {
    expect((await worker.fetch(new Request("http://worker/plaid/webhook"), env(urls.system), ctx)).status).toBe(405);
    expect((await worker.fetch(new Request("http://worker/other", { method: "POST" }), env(urls.system), ctx)).status).toBe(404);
  });
});
