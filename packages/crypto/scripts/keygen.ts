import { newMasterKey } from "../src/index.ts";

// Prints a fresh 256-bit master key for MASTER_KEYS. Never commit the output.
process.stdout.write(`${newMasterKey()}\n`);
