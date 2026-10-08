import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { createTestDatabase } from "@psl/db/testing";

/**
 * Bonus: an expand/contract schema change on ~5M live rows (roadmap block 12).
 *
 * Change: add `transactions.merchant_key` (normalized merchant, for
 * cross-user merchant analytics), backfill it, index it, and make it NOT NULL,
 * while a concurrent writer keeps inserting and updating transactions. For
 * every step we record the statement duration and the worst write latency the
 * writer saw while the step ran, which is the user-visible cost of its locks.
 *
 * For contrast, the last steps run the naive versions (plain CREATE INDEX,
 * SET NOT NULL without a validated CHECK) and measure the same thing.
 */

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
try {
  process.loadEnvFile(`${ROOT}.env`);
} catch {}

const ROWS = Number(process.env.ROWS ?? 5_000_000);
const USERS = 1_000;
const BATCH = Number(process.env.BATCH ?? 5_000);
const PAUSE_MS = Number(process.env.PAUSE_MS ?? 10);
const MERCHANTS = ["Blue Bottle Coffee", "Whole Foods Market", "Uber", "Shell", "Netflix", "Delta Air Lines", "Trader Joe's", "Bar | Grill"];
const say = (s: string) => process.stdout.write(`${s}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ setup

say(`migration-demo: creating database with ${ROWS.toLocaleString("en-US")} transactions`);
const urls = await createTestDatabase("psl_bulk");
const db = new pg.Client({ connectionString: urls.owner });
await db.connect();

const t0 = Date.now();
await db.query(`
  INSERT INTO users (id, name)
  SELECT ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'user ' || g FROM generate_series(1, ${USERS}) g;
  INSERT INTO items (id, user_id, plaid_item_id, access_token_ct)
  SELECT ('10000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
         ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'item-' || g, 'n/a'
    FROM generate_series(1, ${USERS}) g;
  INSERT INTO accounts (plaid_account_id, user_id, item_id, name, type)
  SELECT 'acc-' || g, ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid,
         ('10000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'Checking', 'depository'
    FROM generate_series(1, ${USERS}) g;`);
const CHUNK = 1_000_000;
for (let start = 1; start <= ROWS; start += CHUNK) {
  const end = Math.min(ROWS, start + CHUNK - 1);
  await db.query(`
    INSERT INTO transactions (plaid_transaction_id, user_id, item_id, plaid_account_id, amount, iso_currency_code,
                              date, name, merchant_name, pending)
    SELECT 'tx-' || lpad(g::text, 9, '0'),
           ('00000000-0000-4000-8000-' || lpad((g % ${USERS} + 1)::text, 12, '0'))::uuid,
           ('10000000-0000-4000-8000-' || lpad((g % ${USERS} + 1)::text, 12, '0'))::uuid,
           'acc-' || (g % ${USERS} + 1),
           ((g::bigint * 7919) % 100000) / 100.0, 'USD',
           DATE '2026-06-30' - (g % 730),
           upper((ARRAY${pgArray(MERCHANTS)})[g % ${MERCHANTS.length} + 1]),
           CASE WHEN g % 7 = 0 THEN NULL ELSE (ARRAY${pgArray(MERCHANTS)})[g % ${MERCHANTS.length} + 1] END,
           g % 50 = 0
      FROM generate_series(${start}, ${end}) g`);
  say(`  inserted ${end.toLocaleString("en-US")}`);
}
await db.query("VACUUM ANALYZE transactions");
const { rows: size } = await db.query(`SELECT pg_size_pretty(pg_total_relation_size('transactions')) AS s`);
say(`  done in ${Math.round((Date.now() - t0) / 1000)}s, table + indexes = ${size[0].s}`);

// ------------------------------------------------------------------ concurrent writer

/**
 * Simulates live traffic: inserts a new transaction and updates an existing
 * one, back to back. Once the column exists it also writes merchant_key,
 * which is what the "expand" deploy of the application would do.
 */
const writer = {
  client: new pg.Client({ connectionString: urls.owner }),
  dualWrite: false,
  stop: false,
  seq: 0,
  samples: [] as { at: number; ms: number }[],
  async run() {
    await this.client.connect();
    await this.client.query("SET statement_timeout = '60s'");
    while (!this.stop) {
      const n = ++this.seq;
      const id = `live-${String(n).padStart(9, "0")}`;
      const user = (n % USERS) + 1;
      const pad = String(user).padStart(12, "0");
      const merchant = MERCHANTS[n % MERCHANTS.length]!;
      const started = performance.now();
      await this.client.query(
        this.dualWrite
          ? `INSERT INTO transactions (plaid_transaction_id, user_id, item_id, plaid_account_id, amount, date, name, merchant_name, pending, merchant_key)
             VALUES ($1, $2, $3, $4, 1.23, DATE '2026-07-01', upper($5), $5, false, lower($5))`
          : `INSERT INTO transactions (plaid_transaction_id, user_id, item_id, plaid_account_id, amount, date, name, merchant_name, pending)
             VALUES ($1, $2, $3, $4, 1.23, DATE '2026-07-01', upper($5), $5, false)`,
        [id, `00000000-0000-4000-8000-${pad}`, `10000000-0000-4000-8000-${pad}`, `acc-${user}`, merchant],
      );
      const target = `tx-${String(((n * 104729) % ROWS) + 1).padStart(9, "0")}`;
      await this.client.query(
        this.dualWrite
          ? `UPDATE transactions SET merchant_name = $2, merchant_key = lower(coalesce($2, name)) WHERE plaid_transaction_id = $1`
          : `UPDATE transactions SET merchant_name = $2 WHERE plaid_transaction_id = $1`,
        [target, merchant],
      );
      this.samples.push({ at: Date.now(), ms: performance.now() - started });
      await sleep(5);
    }
    await this.client.end();
  },
};
const writerDone = writer.run();
await sleep(1_000);

// ------------------------------------------------------------------ steps

interface Step {
  name: string;
  lock: string;
  seconds: number;
  maxWriteMs: number;
  p50WriteMs: number;
  writes: number;
}
const steps: Step[] = [];

async function step(name: string, lock: string, fn: () => Promise<void>): Promise<void> {
  say(`step: ${name}`);
  const start = Date.now();
  await fn();
  const end = Date.now();
  await sleep(300); // let a write that was blocked by this step finish and be measured
  const during = writer.samples.filter((s) => s.at >= start && s.at <= end + 300).map((s) => s.ms).sort((a, b) => a - b);
  steps.push({
    name,
    lock,
    seconds: (end - start) / 1000,
    maxWriteMs: during.at(-1) ?? 0,
    p50WriteMs: during[Math.floor(during.length / 2)] ?? 0,
    writes: during.length,
  });
}

const QUERY_BEFORE = `SELECT count(*), sum(amount) FROM transactions
  WHERE lower(coalesce(merchant_name, name)) = 'blue bottle coffee' AND date >= DATE '2026-06-01'`;
const QUERY_AFTER = `SELECT count(*), sum(amount) FROM transactions
  WHERE merchant_key = 'blue bottle coffee' AND date >= DATE '2026-06-01'`;
const explainBefore = await explain(QUERY_BEFORE);

// 1. Expand: nullable column, no default. Catalog-only change, but it still
//    needs ACCESS EXCLUSIVE for an instant; lock_timeout makes it give up
//    instead of queueing behind a long transaction and blocking everyone.
await step("ADD COLUMN merchant_key text (nullable)", "ACCESS EXCLUSIVE, catalog only", async () => {
  await db.query("SET lock_timeout = '2s'");
  await db.query("ALTER TABLE transactions ADD COLUMN merchant_key text");
  await db.query("RESET lock_timeout");
});
writer.dualWrite = true; // the application starts writing the new column

// 2. Backfill in small batches, each its own short transaction, with a pause.
let batches = 0;
await step(`Backfill in batches of ${BATCH.toLocaleString("en-US")} with ${PAUSE_MS}ms pauses`, "ROW EXCLUSIVE, row locks per batch", async () => {
  // Keyset batches on the primary key: each batch is one short transaction,
  // so row locks are held only for that batch. The writer's worst wait is
  // roughly one batch's duration, which is what BATCH tunes.
  let last = "";
  for (;;) {
    const { rows } = await db.query(
      `SELECT max(plaid_transaction_id) AS upper FROM (
         SELECT plaid_transaction_id FROM transactions WHERE plaid_transaction_id > $1
          ORDER BY plaid_transaction_id LIMIT ${BATCH}) s`,
      [last],
    );
    const upper = rows[0].upper as string | null;
    if (!upper) break;
    await db.query(
      `UPDATE transactions SET merchant_key = lower(coalesce(merchant_name, name))
        WHERE plaid_transaction_id > $1 AND plaid_transaction_id <= $2 AND merchant_key IS NULL`,
      [last, upper],
    );
    last = upper;
    batches++;
    if (batches % 200 === 0) say(`  ${batches} batches`);
    await sleep(PAUSE_MS);
  }
});

// 3. Index without blocking writes.
await step("CREATE INDEX CONCURRENTLY (merchant_key, date)", "SHARE UPDATE EXCLUSIVE (writes continue)", async () => {
  await db.query("CREATE INDEX CONCURRENTLY transactions_merchant_key_date_idx ON transactions (merchant_key, date)");
});

// 4-5. NOT NULL in two steps: an unvalidated CHECK is instant, validation
//      scans the table under a lock that does not block writes.
await step("ADD CONSTRAINT ... CHECK (merchant_key IS NOT NULL) NOT VALID", "ACCESS EXCLUSIVE, catalog only", async () => {
  await db.query("SET lock_timeout = '2s'");
  await db.query("ALTER TABLE transactions ADD CONSTRAINT transactions_merchant_key_not_null CHECK (merchant_key IS NOT NULL) NOT VALID");
  await db.query("RESET lock_timeout");
});
await step("VALIDATE CONSTRAINT (full scan)", "SHARE UPDATE EXCLUSIVE (writes continue)", async () => {
  await db.query("ALTER TABLE transactions VALIDATE CONSTRAINT transactions_merchant_key_not_null");
});
// 6. Contract: with a valid CHECK, Postgres (12+) skips the scan for SET NOT NULL.
await step("SET NOT NULL (uses the validated CHECK, no scan) + DROP CHECK", "ACCESS EXCLUSIVE, catalog only", async () => {
  await db.query("SET lock_timeout = '2s'");
  await db.query("ALTER TABLE transactions ALTER COLUMN merchant_key SET NOT NULL");
  await db.query("ALTER TABLE transactions DROP CONSTRAINT transactions_merchant_key_not_null");
  await db.query("RESET lock_timeout");
});
await db.query("ANALYZE transactions");
const explainAfter = await explain(QUERY_AFTER);

// Contrast: what the naive versions cost while traffic is running.
await step("CONTRAST: plain CREATE INDEX (name)", "SHARE (blocks writes for the whole build)", async () => {
  await db.query("CREATE INDEX transactions_name_naive_idx ON transactions (name)");
});
await step("CONTRAST: SET NOT NULL with no CHECK (full scan under ACCESS EXCLUSIVE)", "ACCESS EXCLUSIVE (blocks reads and writes)", async () => {
  await db.query("ALTER TABLE transactions ALTER COLUMN merchant_key DROP NOT NULL");
  await db.query("ALTER TABLE transactions ALTER COLUMN merchant_key SET NOT NULL");
});

writer.stop = true;
await writerDone;
const { rows: nulls } = await db.query(`SELECT count(*)::int AS n FROM transactions WHERE merchant_key IS NULL`);
const { rows: total } = await db.query(`SELECT count(*)::int AS n FROM transactions`);
await db.end();

// ------------------------------------------------------------------ report

const fmt = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`);
const table =
  "| Step | Lock taken | Duration | Writes during step | p50 write | **Worst write** |\n| --- | --- | ---: | ---: | ---: | ---: |\n" +
  steps.map((s) => `| ${s.name} | ${s.lock} | ${s.seconds.toFixed(2)} s | ${s.writes} | ${fmt(s.p50WriteMs)} | **${fmt(s.maxWriteMs)}** |`).join("\n");

const report = `# Expand/contract on ${ROWS.toLocaleString("en-US")} live rows

Generated by \`pnpm --filter @psl/migration-demo start\` on ${new Date().toISOString().slice(0, 10)}
(PostgreSQL in Docker on a developer laptop; absolute numbers are machine-specific, the contrast between rows is the point).

The change adds \`transactions.merchant_key\` (normalized merchant name), backfills it, indexes it and makes it
\`NOT NULL\`, while a concurrent writer inserts and updates transactions in a loop. "Worst write" is the slowest
insert+update pair the writer completed while the step ran: the user-visible cost of that step's locks.
Table size before the change: ${size[0].s}. Backfill: ${batches} batches.
After the change: ${total[0].n.toLocaleString("en-US")} rows, ${nulls[0].n} with a NULL merchant_key.

${table}

The last two rows are the naive versions, run on purpose for contrast: a plain \`CREATE INDEX\` holds a lock that
blocks every write until the build finishes, and \`SET NOT NULL\` without a validated \`CHECK\` scans the whole table
under \`ACCESS EXCLUSIVE\`, which blocks reads too.

## Query plan before

\`\`\`sql
${QUERY_BEFORE}
\`\`\`

\`\`\`
${explainBefore}
\`\`\`

## Query plan after

\`\`\`sql
${QUERY_AFTER}
\`\`\`

\`\`\`
${explainAfter}
\`\`\`
`;
writeFileSync(`${ROOT}docs/migration-5m-results.md`, report);
say("");
say(table);

async function explain(sql: string): Promise<string> {
  const { rows } = await db.query(`EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) ${sql}`);
  return rows.map((r) => r["QUERY PLAN"] as string).join("\n");
}

function pgArray(xs: string[]): string {
  return `[${xs.map((x) => `'${x.replace(/'/g, "''")}'`).join(", ")}]`;
}
