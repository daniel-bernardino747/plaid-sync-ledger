import { parseArgs } from "node:util";
import { rotateMasterKey } from "@psl/core";
import { Keyring } from "@psl/crypto";
import { createDb } from "@psl/db";
import { log, serializeError } from "@psl/log";

/**
 * pnpm rotate-master-key --from 1 --to 2 [--batch 100] [--pause-ms 50]
 *
 * Step 2 of the rotation runbook in ADR 0006. MASTER_KEYS must already contain
 * both versions, and every running process must already have been deployed
 * with that keyring. Safe to re-run and safe to run concurrently.
 */
const { values } = parseArgs({
  options: {
    from: { type: "string" },
    to: { type: "string" },
    batch: { type: "string", default: "100" },
    "pause-ms": { type: "string", default: "50" },
  },
});
if (!values.from || !values.to) {
  process.stderr.write("usage: pnpm rotate-master-key --from <version> --to <version>\n");
  process.exit(2);
}

const db = createDb(process.env.DATABASE_URL_SYSTEM ?? "");
try {
  const keyring = await Keyring.fromEnv({
    MASTER_KEYS: process.env.MASTER_KEYS,
    MASTER_KEY_CURRENT: process.env.MASTER_KEY_CURRENT,
  });
  const from = Number(values.from);
  const to = Number(values.to);
  log.info("rotation.started", { from_version: from, to_version: to });
  const r = await rotateMasterKey(db, keyring, {
    from,
    to,
    batchSize: Number(values.batch),
    pauseMs: Number(values["pause-ms"]),
    onBatch: (done) => log.info("rotation.progress", { count: done }),
  });
  log.info("rotation.finished", { count: r.rewrapped, reason: r.remaining === 0 ? "complete" : "rows_remaining" });
  if (r.remaining > 0) process.exitCode = 1;
  else log.info("rotation.next_step", { reason: `remove version ${from} from MASTER_KEYS and redeploy` });
} catch (e) {
  log.error("rotation.failed", serializeError(e));
  process.exitCode = 1;
} finally {
  await db.$disconnect();
}
