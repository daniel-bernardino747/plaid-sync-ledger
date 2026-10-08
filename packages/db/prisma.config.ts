import { defineConfig } from "prisma/config";

// Prisma 7 no longer loads .env on its own.
try {
  process.loadEnvFile(new URL("../../.env", import.meta.url));
} catch {
  // Fall back to the process environment (CI, chaos harness).
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    // Migrations run as the schema owner (ADR 0007).
    url: process.env.DATABASE_URL_OWNER ?? "",
  },
});
