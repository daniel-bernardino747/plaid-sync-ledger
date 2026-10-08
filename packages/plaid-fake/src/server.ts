import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { buildDataset, centsToJsonNumber, prng, type FakeEvent, type FakeTransaction, type ItemDataset } from "./dataset.ts";
import { newSigningKey, signWebhook, type SigningKey } from "./jwt.ts";

/**
 * A fake Plaid that speaks the same HTTP contract as the subset of the real API
 * this system uses (ADR 0008), plus a /__control API for the chaos harness.
 *
 * Contract details mirrored from Plaid's docs:
 * - /transactions/sync pages with next_cursor / has_more; removed entries carry
 *   transaction_id and account_id.
 * - If the underlying data changes while a client is paginating, the next page
 *   fails with TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION.
 * - Errors are { error_type, error_code, error_message, display_message, request_id }.
 * - Webhooks are signed with an ES256 JWT in Plaid-Verification and the body is
 *   pretty-printed with 2-space indentation.
 */

export interface ChaosConfig {
  /** Probability that a data endpoint answers 500 INTERNAL_SERVER_ERROR. */
  fail500Rate: number;
  /** Probability that a data endpoint stalls for `timeoutMs` before answering. */
  timeoutRate: number;
  timeoutMs: number;
  /** 1-based page index that fails once per update with MUTATION_DURING_PAGINATION. */
  mutationOnPage: number | null;
  /** How many times every webhook is delivered. */
  webhookCopies: number;
}

const NO_CHAOS: ChaosConfig = { fail500Rate: 0, timeoutRate: 0, timeoutMs: 0, mutationOnPage: null, webhookCopies: 1 };

interface FakeItem {
  itemId: string;
  accessToken: string;
  dataset: ItemDataset;
  released: number;
  events: FakeEvent[];
  loginRequired: boolean;
  webhook: string | null;
  mutationsInjected: Set<string>;
}

interface Cursor {
  i: string; // item id
  o: number; // offset the update started from
  h?: number; // head the update is paginating towards
  p?: number; // next page index within the update
}

export interface FakePlaidOptions {
  port?: number;
  seed?: number;
  clientId?: string;
  secret?: string;
  initialSize?: number;
  batches?: number;
  /** Used when an Item was created without options.webhook. */
  defaultWebhook?: string | null;
}

class PlaidError extends Error {
  readonly status: number;
  readonly type: string;
  readonly code: string;
  constructor(status: number, type: string, code: string, message: string) {
    super(message);
    this.status = status;
    this.type = type;
    this.code = code;
  }
}

const enc = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString("base64url");
function dec(raw: string, itemId: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Cursor;
    if (c.i === itemId && Number.isInteger(c.o)) return c;
  } catch {}
  throw new PlaidError(400, "INVALID_REQUEST", "INVALID_FIELD", "cursor is invalid");
}

/** JSON with amounts rendered as raw numbers from integer cents (no float math). */
function toJson(value: unknown, indent?: number): string {
  return JSON.stringify(
    value,
    (k, v) => (k === "amount" && typeof v === "object" && v && "cents" in v ? `__AMT__${centsToJsonNumber((v as { cents: number }).cents)}` : v),
    indent,
  ).replace(/"__AMT__(-?[0-9.]+)"/g, "$1");
}

function txOut(t: FakeTransaction) {
  return {
    transaction_id: t.transaction_id,
    account_id: t.account_id,
    amount: { cents: t.cents },
    iso_currency_code: t.iso_currency_code,
    unofficial_currency_code: null,
    date: t.date,
    authorized_date: t.authorized_date,
    name: t.name,
    merchant_name: t.merchant_name,
    pending: t.pending,
    pending_transaction_id: t.pending_transaction_id,
  };
}

export class FakePlaid {
  #server: Server | null = null;
  #items = new Map<string, FakeItem>();
  #byToken = new Map<string, FakeItem>();
  #publicTokens = new Map<string, string>(); // public_token -> item id
  #keys: SigningKey[] = [];
  #chaos: ChaosConfig = { ...NO_CHAOS };
  #chaosRand: () => number;
  #pendingDeliveries = 0;
  #deliveries = 0;
  #seed: number;
  readonly #opts: Required<FakePlaidOptions>;

  constructor(opts: FakePlaidOptions = {}) {
    this.#opts = {
      port: opts.port ?? 0,
      seed: opts.seed ?? 42,
      clientId: opts.clientId ?? "fake-client-id",
      secret: opts.secret ?? "fake-secret",
      initialSize: opts.initialSize ?? 230,
      batches: opts.batches ?? 4,
      defaultWebhook: opts.defaultWebhook ?? null,
    };
    this.#seed = this.#opts.seed;
    this.#chaosRand = prng(this.#seed ^ 0x5eed);
    this.#keys.push(newSigningKey("fake-key-1", nowSec()));
  }

  get url(): string {
    const addr = this.#server?.address() as AddressInfo | null;
    if (!addr) throw new Error("fake plaid is not listening");
    return `http://127.0.0.1:${addr.port}`;
  }

  async listen(): Promise<string> {
    this.#server = createServer((req, res) => void this.#handle(req, res));
    await new Promise<void>((resolve) => this.#server!.listen(this.#opts.port, "127.0.0.1", resolve));
    return this.url;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
    this.#server?.closeAllConnections();
  }

  // ---------------------------------------------------------------- control

  reset(seed = this.#opts.seed): void {
    this.#seed = seed;
    this.#items.clear();
    this.#byToken.clear();
    this.#publicTokens.clear();
    this.#chaos = { ...NO_CHAOS };
    this.#chaosRand = prng(seed ^ 0x5eed);
  }

  setChaos(c: Partial<ChaosConfig>): void {
    this.#chaos = { ...this.#chaos, ...c };
  }

  /** Releases the next batch of every Item and notifies via webhook. */
  advance(): number {
    let n = 0;
    for (const item of this.#items.values()) if (this.#release(item)) n++;
    return n;
  }

  /** Releases the next batch for one Item without a webhook (silent mutation). */
  releaseSilently(itemId: string): boolean {
    const item = this.#items.get(itemId);
    return item ? this.#release(item, false) : false;
  }

  repair(itemId: string): void {
    const item = this.#mustItem(itemId);
    item.loginRequired = false;
    this.#sendWebhook(item, { webhook_type: "ITEM", webhook_code: "LOGIN_REPAIRED", item_id: item.itemId });
  }

  rotateKey(): void {
    const current = this.#keys[this.#keys.length - 1]!;
    current.expiredAt = nowSec();
    this.#keys.push(newSigningKey(`fake-key-${this.#keys.length + 1}`, nowSec()));
  }

  state() {
    return {
      pendingDeliveries: this.#pendingDeliveries,
      deliveries: this.#deliveries,
      items: [...this.#items.values()].map((i) => ({
        item_id: i.itemId,
        released: i.released,
        total_batches: i.dataset.batches.length,
        head: i.events.length,
        final_cursor: enc({ i: i.itemId, o: i.events.length }),
        login_required: i.loginRequired,
      })),
    };
  }

  /** Ground truth used by tests: what the ledger must look like after a full sync. */
  expectedLedger(itemId: string) {
    const item = this.#mustItem(itemId);
    return [...stateAt(item.events, item.events.length).values()].sort((a, b) =>
      a.transaction_id < b.transaction_id ? -1 : 1,
    );
  }

  /** Signs and returns a webhook without delivering it (verification tests). */
  signForTest(body: string, opts: { iat?: number; kid?: string } = {}) {
    const key = opts.kid ? this.#keys.find((k) => k.kid === opts.kid)! : this.#keys[this.#keys.length - 1]!;
    return signWebhook(body, key, opts.iat ?? nowSec());
  }

  // ---------------------------------------------------------------- http

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = randomUUID().slice(0, 15);
    try {
      const raw = await readBody(req);
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const path = (req.url ?? "/").split("?")[0]!;

      if (path.startsWith("/__control/")) return send(res, 200, this.#control(path, body));

      this.#auth(req, body);
      const result = await this.#route(path, body);
      send(res, 200, { ...result, request_id: requestId });
    } catch (e) {
      if (e instanceof PlaidError) {
        send(res, e.status, {
          error_type: e.type,
          error_code: e.code,
          error_message: e.message,
          display_message: null,
          request_id: requestId,
        });
      } else {
        send(res, 500, {
          error_type: "API_ERROR",
          error_code: "INTERNAL_SERVER_ERROR",
          error_message: "fake internal error",
          display_message: null,
          request_id: requestId,
        });
      }
    }
  }

  #control(path: string, body: Record<string, unknown>): unknown {
    switch (path) {
      case "/__control/reset":
        this.reset(typeof body.seed === "number" ? body.seed : undefined);
        return { ok: true };
      case "/__control/chaos":
        this.setChaos(body as Partial<ChaosConfig>);
        return { ok: true, chaos: this.#chaos };
      case "/__control/advance":
        return { released: this.advance() };
      case "/__control/repair":
        this.repair(String(body.item_id));
        return { ok: true };
      case "/__control/rotate-key":
        this.rotateKey();
        return { ok: true };
      case "/__control/state":
        return this.state();
      default:
        throw new PlaidError(404, "INVALID_REQUEST", "NOT_FOUND", "unknown control path");
    }
  }

  #auth(req: IncomingMessage, body: Record<string, unknown>): void {
    const clientId = req.headers["plaid-client-id"] ?? body.client_id;
    const secret = req.headers["plaid-secret"] ?? body.secret;
    if (clientId !== this.#opts.clientId || secret !== this.#opts.secret) {
      throw new PlaidError(400, "INVALID_INPUT", "INVALID_API_KEYS", "invalid client_id or secret provided");
    }
  }

  async #route(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (path) {
      case "/sandbox/public_token/create": {
        const options = (body.options ?? {}) as { webhook?: string };
        const item = this.#createItem(options.webhook ?? this.#opts.defaultWebhook);
        const publicToken = `public-sandbox-CANARY-${randomUUID()}`;
        this.#publicTokens.set(publicToken, item.itemId);
        return { public_token: publicToken };
      }
      case "/item/public_token/exchange": {
        const itemId = this.#publicTokens.get(String(body.public_token));
        if (!itemId) throw new PlaidError(400, "INVALID_INPUT", "INVALID_PUBLIC_TOKEN", "provided public token is invalid");
        this.#publicTokens.delete(String(body.public_token)); // single use
        const item = this.#mustItem(itemId);
        return { access_token: item.accessToken, item_id: item.itemId };
      }
      case "/transactions/sync":
        await this.#maybeChaos();
        return this.#sync(body);
      case "/item/get": {
        await this.#maybeChaos();
        const item = this.#byAccessToken(body.access_token);
        return {
          item: {
            item_id: item.itemId,
            webhook: item.webhook,
            error: item.loginRequired
              ? { error_type: "ITEM_ERROR", error_code: "ITEM_LOGIN_REQUIRED", error_message: "login required", display_message: null }
              : null,
            consent_expiration_time: null,
          },
        };
      }
      case "/webhook_verification_key/get": {
        const key = this.#keys.find((k) => k.kid === body.key_id);
        // The exact error code Plaid uses for an unknown key id is not
        // documented; the client only relies on it being non-retryable.
        if (!key) throw new PlaidError(400, "INVALID_INPUT", "INVALID_WEBHOOK_VERIFICATION_KEY_ID", "unknown key_id");
        return { key: { ...key.publicJwk, created_at: key.createdAt, expired_at: key.expiredAt } };
      }
      case "/link/token/create":
        return { link_token: `link-sandbox-${randomUUID()}`, expiration: new Date(Date.now() + 4 * 3600_000).toISOString() };
      case "/sandbox/item/reset_login": {
        const item = this.#byAccessToken(body.access_token);
        item.loginRequired = true;
        this.#sendWebhook(item, {
          webhook_type: "ITEM",
          webhook_code: "ERROR",
          item_id: item.itemId,
          error: {
            error_type: "ITEM_ERROR",
            error_code: "ITEM_LOGIN_REQUIRED",
            error_message: "the login details of this item have changed",
            display_message: null,
            status: 400,
          },
        });
        return { reset_login: true };
      }
      case "/sandbox/item/fire_webhook": {
        const item = this.#byAccessToken(body.access_token);
        const code = String(body.webhook_code);
        const type = code === "SYNC_UPDATES_AVAILABLE" ? "TRANSACTIONS" : "ITEM";
        this.#sendWebhook(item, this.#payloadFor(item, type, code));
        return { webhook_fired: true };
      }
      default:
        throw new PlaidError(404, "INVALID_REQUEST", "UNKNOWN_FIELDS", `unknown endpoint ${path}`);
    }
  }

  #sync(body: Record<string, unknown>): Record<string, unknown> {
    const item = this.#byAccessToken(body.access_token);
    if (item.loginRequired) {
      throw new PlaidError(400, "ITEM_ERROR", "ITEM_LOGIN_REQUIRED", "the login details of this item have changed");
    }
    const count = Math.min(Math.max(Number(body.count ?? 100), 1), 500);
    const head = item.events.length;
    const cur: Cursor =
      typeof body.cursor === "string" && body.cursor !== "" ? dec(body.cursor, item.itemId) : { i: item.itemId, o: 0 };

    const target = cur.h ?? head;
    const page = cur.p ?? 0;

    // Data changed since this update's first page was served.
    if (cur.h !== undefined && cur.h !== head) {
      throw new PlaidError(
        400,
        "TRANSACTIONS_ERROR",
        "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
        "Underlying transaction data changed since last page was fetched. Please restart pagination from last update.",
      );
    }
    const mutationKey = `${cur.o}:${target}`;
    if (
      this.#chaos.mutationOnPage !== null &&
      page + 1 === this.#chaos.mutationOnPage &&
      !item.mutationsInjected.has(mutationKey)
    ) {
      item.mutationsInjected.add(mutationKey);
      throw new PlaidError(
        400,
        "TRANSACTIONS_ERROR",
        "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION",
        "Underlying transaction data changed since last page was fetched. Please restart pagination from last update.",
      );
    }

    const changes = netChanges(item.events, cur.o, target);
    const slice = changes.slice(page * count, (page + 1) * count);
    const hasMore = (page + 1) * count < changes.length;
    return {
      added: slice.filter((c) => c.kind === "added").map((c) => txOut(c.tx!)),
      modified: slice.filter((c) => c.kind === "modified").map((c) => txOut(c.tx!)),
      removed: slice
        .filter((c) => c.kind === "removed")
        .map((c) => ({ transaction_id: c.id, account_id: c.accountId })),
      accounts: item.dataset.accounts.map((a) => ({ ...a, balances: { available: null, current: null, iso_currency_code: "USD" } })),
      next_cursor: hasMore ? enc({ i: item.itemId, o: cur.o, h: target, p: page + 1 }) : enc({ i: item.itemId, o: target }),
      has_more: hasMore,
      transactions_update_status: "HISTORICAL_UPDATE_COMPLETE",
    };
  }

  async #maybeChaos(): Promise<void> {
    const c = this.#chaos;
    if (c.timeoutRate > 0 && this.#chaosRand() < c.timeoutRate) {
      await new Promise((r) => setTimeout(r, c.timeoutMs));
    }
    if (c.fail500Rate > 0 && this.#chaosRand() < c.fail500Rate) {
      throw new PlaidError(500, "API_ERROR", "INTERNAL_SERVER_ERROR", "an unexpected error occurred");
    }
  }

  #createItem(webhook: string | null): FakeItem {
    const index = this.#items.size;
    const itemId = `fake-item-${this.#seed}-${index}`;
    const item: FakeItem = {
      itemId,
      accessToken: `access-sandbox-CANARY-${randomUUID()}`,
      dataset: buildDataset(`s${this.#seed}i${index}`, this.#seed * 1000 + index, {
        initialSize: this.#opts.initialSize,
        batches: this.#opts.batches,
      }),
      released: 0,
      events: [],
      loginRequired: false,
      webhook,
      mutationsInjected: new Set(),
    };
    this.#items.set(itemId, item);
    this.#byToken.set(item.accessToken, item);
    // Like Plaid, the initial pull becomes available on its own and is
    // announced by webhook, possibly before the client finished the token
    // exchange. The app must not depend on winning that race.
    setTimeout(() => this.#release(item), 50);
    return item;
  }

  #release(item: FakeItem, notify = true): boolean {
    const batch = item.dataset.batches[item.released];
    if (!batch) return false;
    item.events.push(...batch);
    item.released += 1;
    if (notify) this.#sendWebhook(item, this.#payloadFor(item, "TRANSACTIONS", "SYNC_UPDATES_AVAILABLE"));
    return true;
  }

  #payloadFor(item: FakeItem, type: string, code: string): Record<string, unknown> {
    if (code === "SYNC_UPDATES_AVAILABLE") {
      return {
        webhook_type: "TRANSACTIONS",
        webhook_code: code,
        item_id: item.itemId,
        initial_update_complete: true,
        historical_update_complete: true,
      };
    }
    return { webhook_type: type, webhook_code: code, item_id: item.itemId };
  }

  #sendWebhook(item: FakeItem, payload: Record<string, unknown>): void {
    if (!item.webhook) return;
    const body = toJson({ ...payload, environment: "sandbox" }, 2);
    for (let i = 0; i < Math.max(1, this.#chaos.webhookCopies); i++) {
      void this.#deliver(item.webhook, body);
    }
  }

  async #deliver(url: string, body: string): Promise<void> {
    this.#pendingDeliveries += 1;
    try {
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          const key = this.#keys[this.#keys.length - 1]!;
          const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json", "plaid-verification": signWebhook(body, key, nowSec()) },
            body,
            signal: AbortSignal.timeout(10_000),
          });
          await res.arrayBuffer();
          if (res.ok) {
            this.#deliveries += 1;
            return;
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 200 * 2 ** attempt));
      }
    } finally {
      this.#pendingDeliveries -= 1;
    }
  }

  #byAccessToken(token: unknown): FakeItem {
    const item = typeof token === "string" ? this.#byToken.get(token) : undefined;
    if (!item) throw new PlaidError(400, "INVALID_INPUT", "INVALID_ACCESS_TOKEN", "provided access token is invalid");
    return item;
  }

  #mustItem(itemId: string): FakeItem {
    const item = this.#items.get(itemId);
    if (!item) throw new PlaidError(400, "INVALID_INPUT", "INVALID_ITEM_ID", "unknown item");
    return item;
  }
}

// ------------------------------------------------------------------ helpers

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function stateAt(events: FakeEvent[], upTo: number): Map<string, FakeTransaction> {
  const m = new Map<string, FakeTransaction>();
  for (let i = 0; i < upTo; i++) {
    const e = events[i]!;
    if (e.op === "upsert") m.set(e.tx.transaction_id, e.tx);
    else m.delete(e.transaction_id);
  }
  return m;
}

interface Change {
  kind: "added" | "modified" | "removed";
  id: string;
  accountId: string;
  tx?: FakeTransaction;
}

/** Net effect of events[from, to) relative to the state at `from`, in last-touch order. */
function netChanges(events: FakeEvent[], from: number, to: number): Change[] {
  const before = stateAt(events, from);
  const after = stateAt(events, to);
  const order: string[] = [];
  const accountOf = new Map<string, string>();
  for (let i = from; i < to; i++) {
    const e = events[i]!;
    const id = e.op === "upsert" ? e.tx.transaction_id : e.transaction_id;
    accountOf.set(id, e.op === "upsert" ? e.tx.account_id : e.account_id);
    const at = order.indexOf(id);
    if (at >= 0) order.splice(at, 1);
    order.push(id);
  }
  const out: Change[] = [];
  for (const id of order) {
    const b = before.get(id);
    const a = after.get(id);
    if (a && !b) out.push({ kind: "added", id, accountId: a.account_id, tx: a });
    else if (a && b) out.push({ kind: "modified", id, accountId: a.account_id, tx: a });
    else if (!a && b) out.push({ kind: "removed", id, accountId: accountOf.get(id)! });
  }
  return out;
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(res: ServerResponse, status: number, value: unknown): void {
  const text = toJson(value);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}
