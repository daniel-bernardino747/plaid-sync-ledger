-- Hand-written: things Prisma cannot model. See ADRs 0001, 0004, 0007, 0009.

-- ---------------------------------------------------------------------------
-- Queue coalescing (ADR 0001, amended by ADR 0005): at most one queued job per
-- item and kind. Enqueue is INSERT ... ON CONFLICT DO NOTHING against this.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX sync_jobs_one_queued_per_item_kind
  ON sync_jobs (item_id, kind)
  WHERE status = 'queued';

-- ---------------------------------------------------------------------------
-- Privileges (ADR 0007). app_owner owns everything and runs migrations.
-- app_system: background processes, BYPASSRLS (set at role creation).
-- app_web: user-facing requests, always subject to RLS.
-- ---------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO app_web, app_system;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_system;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_system;

-- users holds only the demo display name and is needed by the login picker
-- before any user context exists, so it is readable but not RLS-scoped.
GRANT SELECT ON users TO app_web;
GRANT SELECT, INSERT ON user_keys TO app_web;
GRANT SELECT, INSERT, UPDATE ON items TO app_web;
GRANT SELECT ON accounts, transactions TO app_web;
-- No direct access to sync_jobs or webhook_events for app_web: they carry no
-- user_id, so RLS cannot scope them. Enqueueing goes through enqueue_job().

-- ---------------------------------------------------------------------------
-- Row-level security (ADR 0007). Missing app.user_id => NULL => no rows.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app_current_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

ALTER TABLE user_keys    ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_keys    FORCE  ROW LEVEL SECURITY;
ALTER TABLE items        ENABLE ROW LEVEL SECURITY;
ALTER TABLE items        FORCE  ROW LEVEL SECURITY;
ALTER TABLE accounts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts     FORCE  ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions FORCE  ROW LEVEL SECURITY;

CREATE POLICY user_keys_owner ON user_keys TO app_web
  USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());
CREATE POLICY items_owner ON items TO app_web
  USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());
CREATE POLICY accounts_owner ON accounts TO app_web
  USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());
CREATE POLICY transactions_owner ON transactions TO app_web
  USING (user_id = app_current_user_id()) WITH CHECK (user_id = app_current_user_id());

-- The web app may enqueue work only for an item the current user owns.
-- SECURITY DEFINER runs as the owner; the ownership check is explicit.
CREATE FUNCTION enqueue_job(p_item_id uuid, p_kind job_kind) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
  AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM items WHERE id = p_item_id AND user_id = app_current_user_id()
  ) THEN
    RAISE EXCEPTION 'item not found' USING ERRCODE = 'P0002';
  END IF;
  INSERT INTO sync_jobs (item_id, kind) VALUES (p_item_id, p_kind)
  ON CONFLICT (item_id, kind) WHERE status = 'queued' DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION enqueue_job(uuid, job_kind) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enqueue_job(uuid, job_kind) TO app_web, app_system;

-- ---------------------------------------------------------------------------
-- Ledger definition (ADR 0009). One canonical line per transaction, encoded as
-- a JSON array so separators inside values cannot collide and NULL stays
-- distinct from the empty string. Wall-clock columns and the cursor are
-- excluded on purpose.
-- ---------------------------------------------------------------------------
CREATE VIEW ledger_lines AS
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
    t.pending_transaction_id,
    t.removed_at IS NOT NULL
  )::text AS line
FROM transactions t;

CREATE FUNCTION ledger_hash() RETURNS text
  LANGUAGE sql STABLE
  AS $$
    SELECT encode(sha256(convert_to(
      coalesce(string_agg(line, E'\n' ORDER BY transaction_id COLLATE "C"), ''),
      'UTF8')), 'hex')
    FROM ledger_lines
  $$;

GRANT SELECT ON ledger_lines TO app_system;
GRANT EXECUTE ON FUNCTION ledger_hash() TO app_system;
