-- ADR 0009 (amended): the ledger is the set of LIVE transactions.
-- Soft-deleted rows are excluded because whether a removed row exists at all
-- depends on sync timing: a transaction added and removed between two syncs
-- is never seen if the webhooks were coalesced into one sync. A removal that
-- was NOT applied still shows up, as a live row that should not be there.
CREATE OR REPLACE VIEW ledger_lines AS
SELECT
  t.plaid_transaction_id AS transaction_id,
  json_build_array(
    t.plaid_transaction_id,
    t.plaid_account_id,
    t.amount::text,
    t.iso_currency_code,
    to_char(t.date, 'YYYY-MM-DD'),
    to_char(t.authorized_date, 'YYYY-MM-DD'),
    t.name,
    t.merchant_name,
    t.pending,
    t.pending_transaction_id
  )::text AS line
FROM transactions t
WHERE t.removed_at IS NULL;
