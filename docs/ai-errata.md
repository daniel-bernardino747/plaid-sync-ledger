# Where the AI got it wrong (running log)

Concrete mistakes the AI assistant introduced while building this repository,
and how each one was caught. Entries are appended as they happen and never
invented. The README's section of the same name is built from this file.

| # | What the assistant got wrong | Impact if shipped | How it was caught | Fix |
| --- | --- | --- | --- | --- |
| 1 | ADR 0009 defined the canonical ledger line as fields joined with `\|` and NULL rendered as `∅`. | Ambiguous encoding: a merchant name containing `\|` or `∅` lets two different ledgers produce the same hash, so the chaos suite could report a false PASS. | Assistant, while writing the SQL view: the separator choice could not survive a value containing the separator. | The line is now a `json_build_array(...)` per row (escaping, explicit `null`), ordered with `COLLATE "C"`. The ADR was amended in place. |
| 2 | ADRs 0003 and 0009 put soft-deleted rows in the ledger hash. | The hash depended on sync timing: a transaction added in one batch and removed in the next leaves a removed row only if a sync ran in between. Coalesced webhooks (ADR 0001) would make a correct ledger hash differently from the clean run, so the chaos suite would fail spuriously exactly in the scenarios it exists for. | Assistant, while writing the commit SQL and walking through the coalescing scenario against the fake's net-change semantics. | New migration: `ledger_lines` only covers `removed_at IS NULL`. ADRs 0003 and 0009 amended. |
| 3 | The first `serializeError()` accepted any string matching `[A-Za-z0-9_.:-]{1,80}` for `name`, `kind`, `errorCode` and `code`. | A string shaped like `access-sandbox-…` matches that pattern, so a token sitting in an error's `code` property would have been logged under `pg_code`. | Assistant, re-reading the logger right after its tests passed: the test only used a value with spaces, which the pattern rejected for the wrong reason. | Each field now has the exact shape of what it classifies (SQLSTATE is 5 uppercase alphanumerics, Plaid codes are `UPPER_SNAKE`). The test uses token-shaped values under every key. |
