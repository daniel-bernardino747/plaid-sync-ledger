import pg from "pg";
import { Keyring, newMasterKey } from "@psl/crypto";
import { createDb, type Db } from "@psl/db";
import { createTestDatabase, truncateAll, type TestDbUrls } from "@psl/db/testing";
import { setLogSink } from "@psl/log";
import { PlaidHttpClient, type PlaidGateway } from "@psl/plaid";
import { FakePlaid } from "@psl/plaid-fake";
import { connectItem } from "../src/connect.ts";
import { processOne, type WorkerConfig } from "../src/worker.ts";

export const ALICE = "00000000-0000-4000-8000-00000000000a";
export const BOB = "00000000-0000-4000-8000-00000000000b";

export interface Harness {
  urls: TestDbUrls;
  system: Db;
  web: Db;
  owner: pg.Client;
  fake: FakePlaid;
  plaid: PlaidHttpClient;
  keyring: Keyring;
  logs: string[];
  worker(overrides?: Partial<WorkerConfig>): WorkerConfig;
  reset(): Promise<void>;
  connect(userId?: string): Promise<{ itemId: string; plaidItemId: string }>;
  drain(cfg?: WorkerConfig, maxSteps?: number): Promise<number>;
  ledgerHash(): Promise<string>;
  liveLedger(itemId: string): Promise<LedgerRow[]>;
  jobs(): Promise<{ id: string; status: string; kind: string; attempts: number; last_error_code: string | null }[]>;
  close(): Promise<void>;
}

export interface LedgerRow {
  transaction_id: string;
  account_id: string;
  amount: string;
  date: string;
  name: string;
  merchant_name: string | null;
  pending: boolean;
  pending_transaction_id: string | null;
}

export async function createHarness(dbName: string): Promise<Harness> {
  const urls = await createTestDatabase(dbName);
  const system = createDb(urls.system);
  const web = createDb(urls.web);
  const owner = new pg.Client({ connectionString: urls.owner });
  await owner.connect();
  const fake = new FakePlaid({ seed: 3, initialSize: 120, batches: 3 });
  const fakeUrl = await fake.listen();
  const plaid = new PlaidHttpClient({ baseUrl: fakeUrl, clientId: "fake-client-id", secret: "fake-secret", timeoutMs: 500 });
  const keyring = await Keyring.fromEnv({ MASTER_KEYS: JSON.stringify({ 1: newMasterKey() }), MASTER_KEY_CURRENT: "1" });
  const logs: string[] = [];
  setLogSink((l) => logs.push(l));

  const h: Harness = {
    urls,
    system,
    web,
    owner,
    fake,
    plaid,
    keyring,
    logs,
    worker: (o = {}) => ({
      db: system,
      plaid,
      keyring,
      workerId: "test-worker",
      leaseSeconds: 30,
      pageSize: 40,
      retry: { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 5 },
      pollMs: 10,
      safetyNetEveryMs: 3_600_000,
      staleAfterSeconds: 86_400,
      ...o,
    }),
    async reset() {
      await truncateAll(urls.owner);
      fake.reset(3);
      logs.length = 0;
      await owner.query(`INSERT INTO users (id, name) VALUES ($1, 'Alice'), ($2, 'Bob')`, [ALICE, BOB]);
    },
    async connect(userId = ALICE) {
      const publicToken = await plaid.createPublicToken({ institutionId: "ins_109508", webhook: null });
      const r = await connectItem({ webDb: web, keyring, plaid }, { userId, publicToken });
      await new Promise((res) => setTimeout(res, 80)); // fake releases the initial pull
      return r;
    },
    /** Runs jobs until nothing is queued or running. Waits out short backoffs. */
    async drain(cfg = h.worker(), maxSteps = 200) {
      let steps = 0;
      for (; steps < maxSteps; steps++) {
        if (await processOne(cfg)) continue;
        const { rows } = await owner.query(
          `SELECT count(*)::int AS n FROM sync_jobs s JOIN items i ON i.id = s.item_id
            WHERE s.status = 'running'
               OR (s.status = 'queued' AND (s.kind = 'refresh_item_status' OR i.status = 'active'))`,
        );
        if (rows[0].n === 0) return steps;
        await new Promise((res) => setTimeout(res, 20));
      }
      throw new Error("drain did not converge");
    },
    async ledgerHash() {
      const { rows } = await owner.query(`SELECT ledger_hash() AS h`);
      return rows[0].h as string;
    },
    async liveLedger(itemId) {
      const { rows } = await owner.query(
        `SELECT plaid_transaction_id AS transaction_id, plaid_account_id AS account_id, amount::text AS amount,
                to_char(date, 'YYYY-MM-DD') AS date, name, merchant_name, pending, pending_transaction_id
           FROM transactions WHERE item_id = $1 AND removed_at IS NULL ORDER BY plaid_transaction_id COLLATE "C"`,
        [itemId],
      );
      return rows;
    },
    async jobs() {
      const { rows } = await owner.query(
        `SELECT id::text, status::text, kind::text, attempts, last_error_code FROM sync_jobs ORDER BY id`,
      );
      return rows;
    },
    async close() {
      await system.$disconnect();
      await web.$disconnect();
      await owner.end();
      await fake.close();
    },
  };
  return h;
}

/** Integer cents -> NUMERIC(19,4) text, with integer math only (no floats in the oracle either). */
function centsToNumeric4(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}00`;
}

/** What the fake says the ledger must be, in the same shape as liveLedger(). */
export function expectedLedger(fake: FakePlaid, plaidItemId: string): LedgerRow[] {
  return fake
    .expectedLedger(plaidItemId)
    .map((t) => ({
      transaction_id: t.transaction_id,
      account_id: t.account_id,
      amount: centsToNumeric4(t.cents),
      date: t.date,
      name: t.name,
      merchant_name: t.merchant_name,
      pending: t.pending,
      pending_transaction_id: t.pending_transaction_id,
    }))
    .sort((a, b) => (a.transaction_id < b.transaction_id ? -1 : a.transaction_id > b.transaction_id ? 1 : 0));
}

/**
 * Wraps a gateway so tests can observe /transactions/sync calls. Delegates
 * explicitly: the HTTP client uses private fields, so prototype tricks break.
 */
export function recordingGateway(
  base: PlaidHttpClient,
  onSync: (input: { cursor: string | null }, page: Awaited<ReturnType<PlaidHttpClient["syncTransactions"]>>) => void,
): PlaidGateway {
  return {
    exchangePublicToken: (t) => base.exchangePublicToken(t),
    getItem: (t) => base.getItem(t),
    getWebhookVerificationKey: (k) => base.getWebhookVerificationKey(k),
    createLinkToken: (i) => base.createLinkToken(i),
    syncTransactions: async (input) => {
      const page = await base.syncTransactions(input);
      onSync(input, page);
      return page;
    },
  };
}
