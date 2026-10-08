import postgres from "postgres";
import { log, serializeError } from "@psl/log";
import { PlaidHttpClient } from "@psl/plaid";
import { ingestWebhook, type PlaidWebhookBody } from "./ingest.ts";
import { KeyCache, verifyPlaidWebhook } from "./verify.ts";

export interface Env {
  /** Hyperdrive in production; `localConnectionString` under wrangler dev (ADR 0002). */
  HYPERDRIVE: { connectionString: string };
  PLAID_BASE_URL: string;
  PLAID_CLIENT_ID: string;
  PLAID_SECRET: string;
}

// Module scope = per isolate. Reused across requests the isolate serves.
const cache = new KeyCache();

export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/healthz") return new Response("ok");
    if (url.pathname !== "/plaid/webhook") return new Response("not found", { status: 404 });
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

    const plaid = new PlaidHttpClient({
      baseUrl: env.PLAID_BASE_URL,
      clientId: env.PLAID_CLIENT_ID,
      secret: env.PLAID_SECRET,
      timeoutMs: 5_000,
    });
    const verified = await verifyPlaidWebhook(request, { plaid, cache });
    if (!verified.ok) {
      log.warn("webhook.rejected", { http_status: verified.status, reason: verified.reason });
      return new Response(null, { status: verified.status });
    }

    let body: PlaidWebhookBody;
    try {
      body = JSON.parse(new TextDecoder().decode(verified.body)) as PlaidWebhookBody;
    } catch {
      return new Response(null, { status: 400 });
    }

    // One short-lived client per request; Hyperdrive pools the real connections.
    const sql = postgres(env.HYPERDRIVE.connectionString, { max: 1, fetch_types: false, prepare: false });
    try {
      // Persist BEFORE answering. Answering 200 first and writing in
      // waitUntil() would turn a failed write into a silently lost event;
      // a 5xx makes Plaid retry instead. Nothing is processed here.
      const r = await ingestWebhook(sql, body, verified.bodySha256);
      log.info("webhook.accepted", {
        webhook_type: String(body.webhook_type),
        webhook_code: String(body.webhook_code),
        plaid_item_id: typeof body.item_id === "string" ? body.item_id : null,
        outcome: r.job,
        job_kind: r.kind,
      });
      return new Response(null, { status: 200 });
    } catch (e) {
      log.error("webhook.persist_failed", serializeError(e));
      return new Response(null, { status: 503 });
    } finally {
      ctx.waitUntil(sql.end({ timeout: 5 }));
    }
  },
};
