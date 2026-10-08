import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createTestDatabase, truncateAll, type TestDbUrls } from "@psl/db/testing";
import { dedupKey, ingestWebhook, jobKindFor } from "../src/ingest.ts";

// ADR 0002: the Worker's raw SQL runs against a database built by the Prisma
// migrations, connected as app_system exactly like the Worker. If the schema
// drifts, this fails.

let urls: TestDbUrls;
let sql: postgres.Sql;
let owner: postgres.Sql;
const ITEM = "20000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-00000000000a";

beforeAll(async () => {
  urls = await createTestDatabase("psl_test_webhooks");
  sql = postgres(urls.system, { max: 4, onnotice: () => {} });
  owner = postgres(urls.owner, { max: 1, onnotice: () => {} });
});
afterAll(async () => {
  await sql.end();
  await owner.end();
});
beforeEach(async () => {
  await truncateAll(urls.owner);
  await owner`INSERT INTO users (id, name) VALUES (${USER}, 'Alice')`;
  await owner`INSERT INTO items (id, user_id, plaid_item_id, access_token_ct) VALUES (${ITEM}, ${USER}, 'plaid-item-1', 'ct')`;
});

const sync = { webhook_type: "TRANSACTIONS", webhook_code: "SYNC_UPDATES_AVAILABLE", item_id: "plaid-item-1" };

describe("webhook ingestion", () => {
  it("records the event and enqueues a sync in one transaction", async () => {
    const r = await ingestWebhook(sql, sync, "a".repeat(64));
    expect(r).toMatchObject({ job: "enqueued", kind: "transactions_sync" });
    const [row] = await owner<{ n: number }[]>`SELECT count(*)::int AS n FROM webhook_events`;
    expect(row!.n).toBe(1);
  });

  it("keeps every redelivery in the audit log but coalesces them into one queued job", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => ingestWebhook(sql, sync, "b".repeat(64))));
    expect(results.filter((r) => r.job === "enqueued")).toHaveLength(1);
    expect(results.filter((r) => r.job === "coalesced")).toHaveLength(9);
    const events = await owner<{ dedup_key: string }[]>`SELECT dedup_key FROM webhook_events`;
    expect(events).toHaveLength(10);
    expect(new Set(events.map((e) => e.dedup_key)).size).toBe(1); // same derived key, no UNIQUE
    const jobs = await owner`SELECT status FROM sync_jobs`;
    expect(jobs).toHaveLength(1);
  });

  it("does not drop a byte-identical webhook that arrives after the previous sync started (ADR 0001)", async () => {
    await ingestWebhook(sql, sync, "c".repeat(64));
    await owner`UPDATE sync_jobs SET status = 'running', lease_until = now() + interval '1 minute'`;
    const r = await ingestWebhook(sql, sync, "c".repeat(64)); // same body, same dedup key
    expect(r.job).toBe("enqueued");
  });

  it("records a webhook for an item the app does not know yet without failing", async () => {
    const r = await ingestWebhook(sql, { ...sync, item_id: "not-stored-yet" }, "d".repeat(64));
    expect(r.job).toBe("unknown_item");
  });

  it("turns item webhooks into a status refresh, never a direct state change (ADR 0005)", async () => {
    const r = await ingestWebhook(sql, { webhook_type: "ITEM", webhook_code: "ERROR", item_id: "plaid-item-1" }, "e".repeat(64));
    expect(r).toMatchObject({ job: "enqueued", kind: "refresh_item_status" });
    const [item] = await owner<{ status: string }[]>`SELECT status::text FROM items`;
    expect(item!.status).toBe("active");
  });

  it("maps webhook codes to job kinds", () => {
    expect(jobKindFor("TRANSACTIONS", "SYNC_UPDATES_AVAILABLE")).toBe("transactions_sync");
    for (const code of ["ERROR", "LOGIN_REPAIRED", "USER_PERMISSION_REVOKED", "PENDING_DISCONNECT", "PENDING_EXPIRATION"]) {
      expect(jobKindFor("ITEM", code)).toBe("refresh_item_status");
    }
    expect(jobKindFor("TRANSACTIONS", "DEFAULT_UPDATE")).toBeNull();
  });

  it("derives a stable dedup key from item, code and body hash", async () => {
    expect(await dedupKey("i", "C", "h")).toBe(await dedupKey("i", "C", "h"));
    expect(await dedupKey("i", "C", "h")).not.toBe(await dedupKey("i", "C", "h2"));
    // separator prevents ("ab","c") colliding with ("a","bc")
    expect(await dedupKey("ab", "c", "h")).not.toBe(await dedupKey("a", "bc", "h"));
  });
});
