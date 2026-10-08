# Where the AI got it wrong (running log)

Concrete mistakes the AI assistant introduced while building this repository,
and how each one was caught. Entries are appended as they happen and never
invented. The README's section of the same name is built from this file.

| # | What the assistant got wrong | Impact if shipped | How it was caught | Fix |
| --- | --- | --- | --- | --- |
| 1 | ADR 0009 defined the canonical ledger line as fields joined with `\|` and NULL rendered as `∅`. | Ambiguous encoding: a merchant name containing `\|` or `∅` lets two different ledgers produce the same hash, so the chaos suite could report a false PASS. | Assistant, while writing the SQL view: the separator choice could not survive a value containing the separator. | The line is now a `json_build_array(...)` per row (escaping, explicit `null`), ordered with `COLLATE "C"`. The ADR was amended in place. |
