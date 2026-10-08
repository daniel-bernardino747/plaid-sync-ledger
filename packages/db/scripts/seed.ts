import pg from "pg";

// Two demo users (ADR 0011). Two, so per-user isolation is visible in the UI.
try {
  process.loadEnvFile(new URL("../../../.env", import.meta.url));
} catch {}

const c = new pg.Client({ connectionString: process.env.DATABASE_URL_SYSTEM });
await c.connect();
await c.query(
  `INSERT INTO users (id, name) VALUES
     ('00000000-0000-4000-8000-00000000000a', 'Alice'),
     ('00000000-0000-4000-8000-00000000000b', 'Bob')
   ON CONFLICT (id) DO NOTHING`,
);
await c.end();
process.stdout.write("seeded demo users\n");
