import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { connectItem } from "@psl/core";
import { Keyring, newMasterKey } from "@psl/crypto";
import { createDb } from "@psl/db";
import { createTestDatabase } from "@psl/db/testing";
import { parsePlaidJson, PlaidHttpClient } from "@psl/plaid";
import { HarnessTimeout, openLog, sleep, startProc, waitFor, type Proc } from "./procs.ts";

/**
 * pnpm chaos (ADR 0010).
 *
 * Every scenario runs the real system: Plaid fake, `wrangler dev` (the real
 * webhook Worker), and worker processes, against a fresh database cloned from
 * a migrated template. Each scenario must converge to the same ledger hash as
 * the clean run, and the clean run must match the hash of the fake's own
 * ground truth (the "oracle"), computed by the same SQL.
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const OUT = `${ROOT}.chaos/`;
const FAKE_PORT = 4010;
const WORKER_PORT = 8787;
const FAKE_URL = `http://127.0.0.1:${FAKE_PORT}`;
const WEBHOOK_URL = `http://127.0.0.1:${WORKER_PORT}/plaid/webhook`;
const SEED = 2026;
const LATER_BATCHES = 3;
const SCENARIO_TIMEOUT_MS = 180_000;

try {
  process.loadEnvFile(`${ROOT}.env`);
} catch {}

interface Scenario {
  name: string;
  fault: string;
  workers: number;
  chaos?: Record<string, unknown>;
  /** SIGKILL the worker this many times (via `killEnv`) before letting it finish. */
  kills?: number;
  /** Failpoint env for the killed workers. */
  killEnv?: Record<string, string>;
  /**
   * Evidence that the fault really happened, read from the scenario's process
   * output. A green row where nothing was injected proves nothing.
   */
  evidence?: { what: string; pattern: RegExp; min: number };
  workerEnv?: Record<string, string>;
}

const SCENARIOS: Scenario[] = [
  { name: "clean", fault: "none (baseline)", workers: 1 },
  {
    name: "kill-mid-pagination",
    fault: "SIGKILL after fetching page 2, before anything is written, 3 times, restart",
    workers: 1,
    kills: 3,
    killEnv: { FAIL_AFTER_N_PAGES: "2" },
    evidence: { what: "kills during pagination", pattern: /"event":"chaos\.failpoint_kill".*"reason":"FAIL_AFTER_N_PAGES"/, min: 3 },
  },
  {
    name: "kill-mid-commit",
    fault: "SIGKILL after 60 upserts inside the commit (FAIL_AFTER_N_UPSERTS), 3 times, restart",
    workers: 1,
    kills: 3,
    killEnv: { FAIL_AFTER_N_UPSERTS: "60" },
    evidence: { what: "orphaned jobs reaped", pattern: /"event":"queue\.reaped"/, min: 1 },
  },
  {
    name: "webhook-x10",
    fault: "every webhook delivered 10 times",
    workers: 1,
    chaos: { webhookCopies: 10 },
    evidence: { what: "deliveries coalesced", pattern: /"outcome":"coalesced"/, min: 50 },
  },
  {
    name: "two-workers",
    fault: "2 worker processes + every webhook 3 times",
    workers: 2,
    chaos: { webhookCopies: 3 },
    evidence: { what: "syncs committed by the second worker", pattern: /"event":"job\.succeeded".*"worker_id":"two-workers-w1-/, min: 1 },
  },
  {
    name: "mutation-page-2",
    fault: "MUTATION_DURING_PAGINATION on page 2 of every update",
    workers: 1,
    chaos: { mutationOnPage: 2 },
    evidence: { what: "pagination restarts", pattern: /"restarts":[1-9]/, min: 1 },
  },
  {
    name: "plaid-500",
    fault: "30% of Plaid calls answer 500",
    workers: 1,
    chaos: { fail500Rate: 0.3 },
    evidence: { what: "retries after 500", pattern: /"job\.retry_scheduled".*"INTERNAL_SERVER_ERROR"/, min: 1 },
  },
  {
    name: "plaid-timeout",
    fault: "30% of Plaid calls stall past the 1s client timeout",
    workers: 1,
    chaos: { timeoutRate: 0.3, timeoutMs: 1_500 },
    workerEnv: { PLAID_TIMEOUT_MS: "1000" },
    evidence: { what: "retries after timeout", pattern: /"job\.retry_scheduled".*"error_kind":"transient"/, min: 1 },
  },
];

interface Result {
  scenario: Scenario;
  pass: boolean;
  hash: string;
  syncRuns: number;
  superseded: number;
  dead: number;
  webhookEvents: number;
  kills: number;
  checks: string[];
  seconds: number;
}

// ------------------------------------------------------------------ setup

const only = process.argv.slice(2).filter((a) => a !== "--");
const selected = only.length ? SCENARIOS.filter((s) => s.name === "clean" || only.includes(s.name)) : SCENARIOS;
mkdirSync(OUT, { recursive: true });

const MASTER_KEYS = JSON.stringify({ 1: newMasterKey() });
const keyring = await Keyring.fromEnv({ MASTER_KEYS, MASTER_KEY_CURRENT: "1" });
const plaid = new PlaidHttpClient({ baseUrl: FAKE_URL, clientId: "fake-client-id", secret: "fake-secret" });

const harnessLog = openLog(`${OUT}harness.log`);
const say = (line: string) => process.stdout.write(`${line}\n`);

say("chaos: migrating template database");
const template = await createTestDatabase("chaos_template");
const fakeLog = openLog(`${OUT}fake.log`);
const fake = startProc("fake", process.execPath, ["src/main.ts"], {
  cwd: `${ROOT}packages/plaid-fake`,
  env: { ...process.env, FAKE_PLAID_PORT: String(FAKE_PORT), FAKE_PLAID_SEED: String(SEED), FAKE_PLAID_BATCHES: String(LATER_BATCHES) },
  log: fakeLog,
});
await waitFor("plaid fake", async () => (await control("state")) !== null, 15_000);

const results: Result[] = [];
let baseline: string | null = null;
let oracle: string | null = null;
try {
  for (const s of selected) {
    say(`chaos: ${s.name} ...`);
    const r = await runScenario(s);
    if (s.name === "clean") baseline = r.hash;
    results.push(r);
    say(`chaos: ${s.name} ${r.pass ? "PASS" : "FAIL"} ${r.hash.slice(0, 12)}${r.checks.length ? ` (${r.checks.join("; ")})` : ""}`);
  }
} finally {
  await fake.stop();
}

// ------------------------------------------------------------------ report

const table = renderTable(results, oracle);
say("");
say(table);
writeFileSync(
  `${ROOT}docs/chaos-results.md`,
  `# Chaos results\n\nGenerated by \`pnpm chaos\` on ${new Date().toISOString().slice(0, 10)}. Seed ${SEED}, 3 Items (2 users), ` +
    `initial pull + ${LATER_BATCHES} later batches per Item.\n\n${table}\n`,
);
process.exitCode = results.every((r) => r.pass) ? 0 : 1;

// ------------------------------------------------------------------ scenario

async function runScenario(s: Scenario): Promise<Result> {
  const started = Date.now();
  const log = openLog(`${OUT}${s.name}.log`);
  const urls = await cloneDatabase(`chaos_${s.name.replace(/-/g, "_")}`);
  const checks: string[] = [];
  const procs: Proc[] = [];
  let kills = 0;
  let stopping = false;

  await control("reset", { seed: SEED });
  if (s.chaos) await control("chaos", s.chaos);

  const owner = new pg.Client({ connectionString: urls.owner });
  await owner.connect();
  const web = createDb(urls.web);
  try {
    // The real webhook Worker, pointed at this scenario's database.
    const wrangler = startProc("wrangler", "pnpm", ["exec", "wrangler", "dev", "--port", String(WORKER_PORT), "--ip", "127.0.0.1",
      "--var", "PLAID_TARGET:fake", "--var", `FAKE_PLAID_URL:${FAKE_URL}`], {
      cwd: `${ROOT}apps/webhooks`,
      env: {
        ...process.env,
        CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: urls.system,
        WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE: urls.system,
        WRANGLER_SEND_METRICS: "false",
      },
      log,
      shell: process.platform === "win32",
    });
    procs.push(wrangler);
    await waitFor("wrangler dev", async () => (await fetch(`http://127.0.0.1:${WORKER_PORT}/healthz`)).ok, 90_000, 500);

    const ALICE = "00000000-0000-4000-8000-00000000000a";
    const BOB = "00000000-0000-4000-8000-00000000000b";
    await owner.query(`INSERT INTO users (id, name) VALUES ($1, 'Alice'), ($2, 'Bob')`, [ALICE, BOB]);

    // Connect Items through the real path (app_web + RLS + encryption).
    for (const userId of [ALICE, ALICE, BOB]) {
      const publicToken = await plaid.createPublicToken({ institutionId: "ins_109508", webhook: WEBHOOK_URL });
      await connectItem({ webDb: web, keyring, plaid }, { userId, publicToken });
    }

    const startWorker = (i: number): void => {
      const killNow = s.kills !== undefined && kills < s.kills;
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        DATABASE_URL_SYSTEM: urls.system,
        // Forced: chaos must never reach real Plaid, whatever .env says.
        PLAID_TARGET: "fake",
        FAKE_PLAID_URL: FAKE_URL,
        MASTER_KEYS,
        MASTER_KEY_CURRENT: "1",
        WORKER_ID: `${s.name}-w${i}-${Date.now()}`,
        LEASE_SECONDS: "3",
        SYNC_PAGE_SIZE: "50",
        MAX_ATTEMPTS: "20",
        BACKOFF_BASE_MS: "50",
        BACKOFF_MAX_MS: "1000",
        POLL_MS: "100",
        ...(killNow ? s.killEnv : {}),
        ...s.workerEnv,
      };
      const p = startProc(`worker${i}`, process.execPath, ["src/main.ts"], { cwd: `${ROOT}apps/worker`, env, log });
      procs.push(p);
      void p.exited.then(() => {
        if (stopping) return;
        if (killNow) kills++;
        startWorker(i); // a crashed worker is replaced, like a process supervisor would
      });
    };
    for (let i = 0; i < s.workers; i++) startWorker(i);

    // New bank activity lands while syncs are in flight.
    for (let b = 0; b < LATER_BATCHES; b++) {
      await sleep(1_500);
      await control("advance");
    }

    await waitFor("convergence", () => converged(owner), SCENARIO_TIMEOUT_MS, 500);
    await sleep(1_500); // settle: nothing new must start
    if (!(await converged(owner))) checks.push("did not stay converged");
  } catch (e) {
    // Never print an error message: it can carry request data (ADR 0013).
    checks.push(e instanceof HarnessTimeout ? `timed out waiting for ${e.label}` : "scenario_error");
  } finally {
    stopping = true;
    for (const p of procs.reverse()) await p.stop();
    await web.$disconnect();
  }

  const m = await metrics(owner);
  await owner.end();
  log.end();

  // Oracle: the fake's ground truth, hashed by the same SQL, once.
  if (oracle === null) oracle = await oracleHash();

  if (m.dead > 0) checks.push(`${m.dead} dead jobs`);
  if (m.expiredRunning > 0) checks.push(`${m.expiredRunning} running jobs with expired lease`);
  if (m.webhookEvents === 0) checks.push("no webhook reached the Worker");
  if (m.cursorMismatches > 0) checks.push(`${m.cursorMismatches} cursors differ from the fake's final cursor`);
  if (s.kills && kills < s.kills) checks.push(`only ${kills}/${s.kills} kills happened`);
  const reference = s.name === "clean" ? oracle : baseline;
  if (m.hash !== reference) checks.push(s.name === "clean" ? "hash != oracle" : "hash != clean run");
  const output = readFileSync(`${OUT}${s.name}.log`, "utf8").split("\n");
  if (s.evidence) {
    const seen = output.filter((l) => s.evidence!.pattern.test(l)).length;
    if (seen < s.evidence.min) checks.push(`fault not observed: ${s.evidence.what} = ${seen}`);
  }
  // ADR 0013: no access token, public token or PII canary may appear in any process output.
  const leaked = output.filter((l) => l.includes("CANARY")).length;
  if (leaked > 0) checks.push(`${leaked} log lines contain CANARY values`);

  return {
    scenario: s,
    pass: checks.length === 0,
    hash: m.hash,
    syncRuns: m.syncRuns,
    superseded: m.superseded,
    dead: m.dead,
    webhookEvents: m.webhookEvents,
    kills,
    checks,
    seconds: Math.round((Date.now() - started) / 1000),
  };
}

async function converged(owner: pg.Client): Promise<boolean> {
  const state = (await control("state")) as {
    pendingDeliveries: number;
    items: { released: number; total_batches: number }[];
  };
  const { rows } = await owner.query(
    `SELECT count(*)::int AS n FROM sync_jobs WHERE status IN ('queued', 'running')`,
  );
  const unreleased = state.items.filter((i) => i.released < i.total_batches).length;
  harnessLog.write(
    `${JSON.stringify({ pendingDeliveries: state.pendingDeliveries, unreleased, openJobs: rows[0].n })}
`,
  );
  return state.pendingDeliveries === 0 && unreleased === 0 && rows[0].n === 0;
}

async function metrics(owner: pg.Client) {
  const { rows } = await owner.query(`
    SELECT ledger_hash() AS hash,
      (SELECT count(*) FROM sync_jobs WHERE kind = 'transactions_sync' AND status = 'succeeded')::int AS sync_runs,
      (SELECT count(*) FROM sync_jobs WHERE status = 'superseded')::int AS superseded,
      (SELECT count(*) FROM sync_jobs WHERE status = 'dead')::int AS dead,
      (SELECT count(*) FROM sync_jobs WHERE status = 'running' AND lease_until < now())::int AS expired_running,
      (SELECT count(*) FROM webhook_events)::int AS webhook_events`);
  const state = (await control("state")) as { items: { item_id: string; final_cursor: string }[] };
  const { rows: cursors } = await owner.query(`SELECT plaid_item_id, cursor FROM items`);
  const final = new Map(state.items.map((i) => [i.item_id, i.final_cursor]));
  const cursorMismatches = cursors.filter((c) => final.get(c.plaid_item_id) !== c.cursor).length;
  const r = rows[0];
  return {
    hash: r.hash as string,
    syncRuns: r.sync_runs as number,
    superseded: r.superseded as number,
    dead: r.dead as number,
    expiredRunning: r.expired_running as number,
    webhookEvents: r.webhook_events as number,
    cursorMismatches,
  };
}

/** Loads the fake's expected ledger into its own database and hashes it with ledger_hash(). */
async function oracleHash(): Promise<string> {
  const urls = await cloneDatabase("chaos_oracle");
  const c = new pg.Client({ connectionString: urls.owner });
  await c.connect();
  try {
    const expected = (await control("expected")) as {
      items: { item_id: string; transactions: Record<string, unknown>[] }[];
    };
    const user = "00000000-0000-4000-8000-0000000000ff";
    await c.query(`INSERT INTO users (id, name) VALUES ($1, 'oracle')`, [user]);
    for (const item of expected.items) {
      const { rows } = await c.query(
        `INSERT INTO items (user_id, plaid_item_id, access_token_ct) VALUES ($1, $2, 'n/a') RETURNING id`,
        [user, item.item_id],
      );
      const itemId = rows[0].id;
      for (const acc of new Set(item.transactions.map((t) => t.account_id as string))) {
        await c.query(
          `INSERT INTO accounts (plaid_account_id, user_id, item_id, name, type) VALUES ($1, $2, $3, 'oracle', 'depository')`,
          [acc, user, itemId],
        );
      }
      for (const t of item.transactions) {
        await c.query(
          `INSERT INTO transactions (plaid_transaction_id, user_id, item_id, plaid_account_id, amount, iso_currency_code,
             date, authorized_date, name, merchant_name, pending, pending_transaction_id)
           VALUES ($1, $2, $3, $4, $5::numeric, $6, $7::date, $8::date, $9, $10, $11, $12)`,
          [
            t.transaction_id,
            user,
            itemId,
            t.account_id,
            t.amount,
            t.iso_currency_code,
            t.date,
            t.authorized_date,
            t.name,
            t.merchant_name,
            t.pending,
            t.pending_transaction_id,
          ],
        );
      }
    }
    const { rows } = await c.query(`SELECT ledger_hash() AS h`);
    return rows[0].h as string;
  } finally {
    await c.end();
  }
}

// ------------------------------------------------------------------ helpers

async function cloneDatabase(name: string) {
  const admin = new pg.Client({ connectionString: withDb(template.owner, "postgres") });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE chaos_template`);
  } finally {
    await admin.end();
  }
  return { owner: withDb(template.owner, name), web: withDb(template.web, name), system: withDb(template.system, name) };
}

function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

async function control(path: string, body: Record<string, unknown> = {}): Promise<unknown> {
  const res = await fetch(`${FAKE_URL}/__control/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`control ${path} failed`);
  // Keep amounts as exact text (same parser as the gateway).
  return parsePlaidJson(await res.text());
}

function renderTable(rs: Result[], oracleHashValue: string | null): string {
  const head =
    "| Scenario | Fault injected | Result | Ledger hash | Sync runs | Superseded | Webhook deliveries | Kills | Time |\n" +
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |";
  const rows = rs.map(
    (r) =>
      `| \`${r.scenario.name}\` | ${r.scenario.fault} | ${r.pass ? "PASS" : `FAIL: ${r.checks.join("; ")}`} | \`${r.hash.slice(0, 12)}\` | ${r.syncRuns} | ${r.superseded} | ${r.webhookEvents} | ${r.kills} | ${r.seconds}s |`,
  );
  const footer = oracleHashValue
    ? `\nOracle (the fake's ground truth hashed by the same \`ledger_hash()\` SQL): \`${oracleHashValue.slice(0, 12)}\`. ` +
      "`clean` must equal the oracle; every other scenario must equal `clean`. Each row also asserts: no dead jobs, " +
      "no running job with an expired lease, every Item's cursor equals the fake's final cursor, at least one webhook " +
      "went through the real Worker, the injected fault was observed in the process output, and no CANARY value " +
      "appears in any process output."
    : "";
  return `${head}\n${rows.join("\n")}\n${footer}`;
}
