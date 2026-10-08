import { z } from "zod";
import { classifyPlaidError, PlaidCallError } from "./errors.ts";
import { parsePlaidJson } from "./json.ts";
import type {
  ItemStatus,
  PlaidAccount,
  PlaidGateway,
  PlaidSandbox,
  PlaidTransaction,
  SyncPage,
  VerificationKey,
} from "./types.ts";

export interface PlaidHttpConfig {
  /** https://sandbox.plaid.com or the fake (ADR 0008). Switching is config only. */
  baseUrl: string;
  clientId: string;
  secret: string;
  /** Per-request timeout. A timeout is classified as transient. */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const transactionSchema = z.object({
  transaction_id: z.string(),
  account_id: z.string(),
  amount: z.string(), // already exact text, see parsePlaidJson
  iso_currency_code: z.string().nullable(),
  date: z.string(),
  authorized_date: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  merchant_name: z.string().nullable().optional(),
  pending: z.boolean(),
  pending_transaction_id: z.string().nullable().optional(),
});

const accountSchema = z.object({
  account_id: z.string(),
  name: z.string(),
  mask: z.string().nullable().optional(),
  type: z.string(),
  subtype: z.string().nullable().optional(),
});

const syncSchema = z.object({
  added: z.array(transactionSchema),
  modified: z.array(transactionSchema),
  removed: z.array(z.object({ transaction_id: z.string(), account_id: z.string().nullable().optional() })),
  accounts: z.array(accountSchema).optional().default([]),
  next_cursor: z.string(),
  has_more: z.boolean(),
  transactions_update_status: z.string().optional(),
});

const itemGetSchema = z.object({
  item: z.object({
    item_id: z.string(),
    error: z.object({ error_code: z.string() }).nullable().optional(),
    consent_expiration_time: z.string().nullable().optional(),
  }),
});

const keySchema = z.object({
  key: z
    .object({
      kid: z.string(),
      kty: z.string(),
      crv: z.string(),
      x: z.string(),
      y: z.string(),
      alg: z.string().optional(),
      use: z.string().optional(),
      expired_at: z.number().nullable().optional(),
    })
    .loose(),
});

function toTransaction(t: z.infer<typeof transactionSchema>): PlaidTransaction {
  return {
    transactionId: t.transaction_id,
    accountId: t.account_id,
    amount: t.amount,
    isoCurrencyCode: t.iso_currency_code,
    date: t.date,
    authorizedDate: t.authorized_date ?? null,
    name: t.name ?? "",
    merchantName: t.merchant_name ?? null,
    pending: t.pending,
    pendingTransactionId: t.pending_transaction_id ?? null,
  };
}

function toAccount(a: z.infer<typeof accountSchema>): PlaidAccount {
  return { accountId: a.account_id, name: a.name, mask: a.mask ?? null, type: a.type, subtype: a.subtype ?? null };
}

export class PlaidHttpClient implements PlaidGateway, PlaidSandbox {
  readonly #baseUrl: string;
  readonly #clientId: string;
  readonly #secret: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(cfg: PlaidHttpConfig) {
    this.#baseUrl = cfg.baseUrl.replace(/\/$/, "");
    this.#clientId = cfg.clientId;
    this.#secret = cfg.secret;
    this.#timeoutMs = cfg.timeoutMs ?? 10_000;
    this.#fetch = cfg.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async #post(path: string, body: Record<string, unknown>): Promise<unknown> {
    let res: Response;
    let text: string;
    try {
      // The timeout covers the whole exchange, body included: a server that
      // sends headers and then stalls must not hang the worker.
      const signal = AbortSignal.timeout(this.#timeoutMs);
      res = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "PLAID-CLIENT-ID": this.#clientId,
          "PLAID-SECRET": this.#secret,
        },
        body: JSON.stringify(body),
        signal,
      });
      text = await res.text();
    } catch {
      // Timeout, connection refused, reset. The cause is dropped on purpose:
      // fetch errors can embed the request, and the request carries secrets.
      throw new PlaidCallError("transient");
    }

    let parsed: unknown = null;
    try {
      parsed = parsePlaidJson(text);
    } catch {
      parsed = null;
    }

    if (!res.ok) {
      throw classifyPlaidError(res.status, (parsed as Record<string, unknown> | null) ?? null);
    }
    if (parsed === null) throw new PlaidCallError("transient", { httpStatus: res.status });
    return parsed;
  }

  #validate<T>(schema: z.ZodType<T>, data: unknown, errorCode: string): T {
    const r = schema.safeParse(data);
    // A 200 with an unexpected shape is a contract violation, not a retryable blip.
    if (!r.success) throw new PlaidCallError("fatal", { errorCode });
    return r.data;
  }

  async exchangePublicToken(publicToken: string) {
    const data = this.#validate(
      z.object({ access_token: z.string(), item_id: z.string() }),
      await this.#post("/item/public_token/exchange", { public_token: publicToken }),
      "UNEXPECTED_EXCHANGE_RESPONSE",
    );
    return { itemId: data.item_id, accessToken: data.access_token };
  }

  async syncTransactions(input: { accessToken: string; cursor: string | null; count: number }): Promise<SyncPage> {
    const body: Record<string, unknown> = { access_token: input.accessToken, count: input.count };
    if (input.cursor !== null) body.cursor = input.cursor;
    const data = this.#validate(syncSchema, await this.#post("/transactions/sync", body), "UNEXPECTED_SYNC_RESPONSE");
    return {
      added: data.added.map(toTransaction),
      modified: data.modified.map(toTransaction),
      removed: data.removed.map((r) => ({ transactionId: r.transaction_id, accountId: r.account_id ?? null })),
      accounts: data.accounts.map(toAccount),
      nextCursor: data.next_cursor,
      hasMore: data.has_more,
      updateStatus: data.transactions_update_status ?? null,
    };
  }

  async getItem(accessToken: string): Promise<ItemStatus> {
    const data = this.#validate(
      itemGetSchema,
      await this.#post("/item/get", { access_token: accessToken }),
      "UNEXPECTED_ITEM_RESPONSE",
    );
    return {
      itemId: data.item.item_id,
      errorCode: data.item.error?.error_code ?? null,
      consentExpirationTime: data.item.consent_expiration_time ?? null,
    };
  }

  async getWebhookVerificationKey(kid: string): Promise<VerificationKey | null> {
    let raw: unknown;
    try {
      raw = await this.#post("/webhook_verification_key/get", { key_id: kid });
    } catch (e) {
      // A non-retryable error for a key lookup means "no such key". Transient
      // failures propagate so the webhook gets a 5xx and Plaid retries it.
      if (e instanceof PlaidCallError && e.kind === "fatal") return null;
      throw e;
    }
    const { key } = this.#validate(keySchema, raw, "UNEXPECTED_KEY_RESPONSE");
    const { kty, crv, x, y, alg, use, expired_at } = key;
    // Never accept a key for a different id than the one the JWT named.
    if (key.kid !== kid) throw new PlaidCallError("fatal", { errorCode: "KEY_ID_MISMATCH" });
    const ec: VerificationKey["jwk"] = { kid, kty, crv, x, y };
    if (alg !== undefined) ec.alg = alg;
    if (use !== undefined) ec.use = use;
    return { jwk: ec, expiredAt: expired_at ?? null };
  }

  async createLinkToken(input: { userId: string; webhook: string | null; accessToken?: string }): Promise<string> {
    const body: Record<string, unknown> = {
      client_name: "plaid-sync-ledger",
      language: "en",
      country_codes: ["US"],
      user: { client_user_id: input.userId },
    };
    if (input.webhook) body.webhook = input.webhook;
    // Update mode: pass the access token and no products (ADR 0005).
    if (input.accessToken) body.access_token = input.accessToken;
    else body.products = ["transactions"];
    const data = this.#validate(
      z.object({ link_token: z.string() }),
      await this.#post("/link/token/create", body),
      "UNEXPECTED_LINK_RESPONSE",
    );
    return data.link_token;
  }

  async createPublicToken(input: { institutionId: string; webhook: string | null }): Promise<string> {
    const options: Record<string, unknown> = {};
    if (input.webhook) options.webhook = input.webhook;
    const data = this.#validate(
      z.object({ public_token: z.string() }),
      await this.#post("/sandbox/public_token/create", {
        institution_id: input.institutionId,
        initial_products: ["transactions"],
        options,
      }),
      "UNEXPECTED_PUBLIC_TOKEN_RESPONSE",
    );
    return data.public_token;
  }

  async resetLogin(accessToken: string): Promise<void> {
    await this.#post("/sandbox/item/reset_login", { access_token: accessToken });
  }

  async fireWebhook(accessToken: string, webhookCode: string): Promise<void> {
    await this.#post("/sandbox/item/fire_webhook", { access_token: accessToken, webhook_code: webhookCode });
  }
}
