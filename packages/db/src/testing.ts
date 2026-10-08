import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";

const pkgRoot = fileURLToPath(new URL("..", import.meta.url));

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export interface TestDbUrls {
  owner: string;
  web: string;
  system: string;
}

/**
 * Creates a fresh database and applies the real migrations to it. Integration
 * tests run against real Postgres (roles, RLS, partial indexes), never a mock.
 */
export async function createTestDatabase(name: string): Promise<TestDbUrls> {
  const ownerBase = requiredEnv("DATABASE_URL_OWNER");
  const admin = new pg.Client({ connectionString: withDatabase(ownerBase, "postgres") });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const urls: TestDbUrls = {
    owner: withDatabase(ownerBase, name),
    web: withDatabase(requiredEnv("DATABASE_URL_WEB"), name),
    system: withDatabase(requiredEnv("DATABASE_URL_SYSTEM"), name),
  };
  execSync("npx prisma migrate deploy", {
    cwd: pkgRoot,
    env: { ...process.env, DATABASE_URL_OWNER: urls.owner },
    stdio: "pipe",
  });
  return urls;
}

/** Empties every application table. Faster than recreating the database per test. */
export async function truncateAll(ownerUrl: string): Promise<void> {
  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  try {
    await c.query(
      "TRUNCATE users, user_keys, items, accounts, transactions, webhook_events, sync_jobs RESTART IDENTITY CASCADE",
    );
  } finally {
    await c.end();
  }
}

export function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}
