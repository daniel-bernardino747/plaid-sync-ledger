import tseslint from "typescript-eslint";

/**
 * Deliberately small. The rule that matters is no-console (ADR 0013): the
 * only way to emit output is the allowlist logger in packages/log, whose single
 * console call carries an inline, reviewed eslint-disable.
 */
export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/generated/**", "**/.next/**", "**/.wrangler/**", ".chaos/**"] },
  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [tseslint.configs.base],
    rules: {
      "no-console": "error",
    },
  },
);
