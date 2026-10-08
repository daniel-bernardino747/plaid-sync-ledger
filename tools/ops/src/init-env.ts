import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { newMasterKey } from "@psl/crypto";

/**
 * pnpm init:env
 *
 * Creates `.env` from `.env.example` with a fresh master key and session
 * secret, and `apps/webhooks/.dev.vars` from its example. Never overwrites an
 * existing file, and prints file names only, never the generated values.
 */
const root = fileURLToPath(new URL("../../../", import.meta.url));

function create(target: string, build: () => string): void {
  if (existsSync(root + target)) {
    process.stdout.write(`kept existing ${target}\n`);
    return;
  }
  writeFileSync(root + target, build());
  process.stdout.write(`created ${target}\n`);
}

create(".env", () =>
  readFileSync(`${root}.env.example`, "utf8")
    .replace(/^MASTER_KEYS=.*$/m, `MASTER_KEYS={"1":"${newMasterKey()}"}`)
    .replace(/^SESSION_SECRET=.*$/m, `SESSION_SECRET=${randomBytes(32).toString("hex")}`),
);

if (existsSync(`${root}apps/webhooks/.dev.vars`)) {
  process.stdout.write("kept existing apps/webhooks/.dev.vars\n");
} else {
  copyFileSync(`${root}apps/webhooks/.dev.vars.example`, `${root}apps/webhooks/.dev.vars`);
  process.stdout.write("created apps/webhooks/.dev.vars\n");
}
