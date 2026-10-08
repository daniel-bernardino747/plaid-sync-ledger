import type { Sql } from "postgres";
import { hex } from "./verify.ts";

/**
 * Persists a verified webhook and enqueues the work it implies, in one
 * transaction (ADR 0002). Raw SQL on purpose: the Worker does not ship Prisma.
 * Drift against the Prisma schema is caught by test/ingest.test.ts, which runs
 * this exact code against a database built from the Prisma migrations.
 *
 * DEDUPLICATION IS AN OPTIMIZATION, NOT THE CORRECTNESS MECHANISM.
 * Plaid webhooks carry no event id, and two legitimate SYNC_UPDATES_AVAILABLE
 * for one Item can have byte-identical bodies, so a permanent unique key on the
 * body would drop real updates (ADR 0001). Instead:
 *   - webhook_events keeps every delivery (dedup_key is indexed, not unique);
 *   - enqueue coalesces on "one queued job per (item, kind)".
 * Correctness comes from the sync being idempotent and cursor-fenced
 * (ADR 0003, ADR 0004): running it more often than necessary is harmless.
 */

export interface PlaidWebhookBody {
  webhook_type?: unknown;
  webhook_code?: unknown;
  item_id?: unknown;
}

export type IngestResult = {
  eventId: string;
  job: "enqueued" | "coalesced" | "unknown_item" | "none";
  kind: "transactions_sync" | "refresh_item_status" | null;
};

/**
 * Which job a webhook implies. Item webhooks are only hints: they trigger a
 * fresh /item/get rather than changing state directly (ADR 0005).
 */
export function jobKindFor(type: string, code: string): IngestResult["kind"] {
  if (type === "TRANSACTIONS" && code === "SYNC_UPDATES_AVAILABLE") return "transactions_sync";
  if (type === "ITEM") {
    switch (code) {
      case "ERROR":
      case "LOGIN_REPAIRED":
      case "USER_PERMISSION_REVOKED":
      case "PENDING_DISCONNECT": // US/CA
      case "PENDING_EXPIRATION": // Europe/UK only
        return "refresh_item_status";
    }
  }
  return null;
}

export async function dedupKey(itemId: string, code: string, bodySha256: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${itemId}\u0000${code}\u0000${bodySha256}`);
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

export async function ingestWebhook(sql: Sql, body: PlaidWebhookBody, bodySha256: string): Promise<IngestResult> {
  const type = typeof body.webhook_type === "string" ? body.webhook_type : "UNKNOWN";
  const code = typeof body.webhook_code === "string" ? body.webhook_code : "UNKNOWN";
  const plaidItemId = typeof body.item_id === "string" ? body.item_id : null;
  const key = await dedupKey(plaidItemId ?? "", code, bodySha256);
  const kind = jobKindFor(type, code);

  return sql.begin(async (tx) => {
    const [event] = await tx<{ id: string }[]>`
      INSERT INTO webhook_events (plaid_item_id, webhook_type, webhook_code, dedup_key, body_sha256)
      VALUES (${plaidItemId}, ${type}, ${code}, ${key}, ${bodySha256})
      RETURNING id::text`;
    const eventId = event!.id;
    if (!kind || !plaidItemId) return { eventId, job: "none", kind };

    // Plaid can notify before the app has stored the Item (the initial pull is
    // announced while Link is still finishing). The connect flow enqueues its
    // own initial sync, so recording the event and enqueueing nothing is safe.
    const [item] = await tx<{ id: string }[]>`SELECT id::text FROM items WHERE plaid_item_id = ${plaidItemId}`;
    if (!item) return { eventId, job: "unknown_item", kind };

    const inserted = await tx`
      INSERT INTO sync_jobs (item_id, kind) VALUES (${item.id}::uuid, ${kind}::job_kind)
      ON CONFLICT (item_id, kind) WHERE status = 'queued' DO NOTHING`;
    return { eventId, job: inserted.count === 1 ? "enqueued" : "coalesced", kind };
  }) as Promise<IngestResult>;
}
