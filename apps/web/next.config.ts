import type { NextConfig } from "next";

// One .env at the repository root serves every app.
try {
  process.loadEnvFile(new URL("../../.env", import.meta.url));
} catch {}

const config: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ["@psl/core", "@psl/crypto", "@psl/db", "@psl/log", "@psl/plaid"],
  serverExternalPackages: ["pg", "@prisma/adapter-pg"],
  poweredByHeader: false,
};

export default config;
