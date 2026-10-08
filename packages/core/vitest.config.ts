import { defineConfig } from "vitest/config";

try {
  process.loadEnvFile(new URL("../../.env", import.meta.url));
} catch {}

export default defineConfig({
  test: {
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
