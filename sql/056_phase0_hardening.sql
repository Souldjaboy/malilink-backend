-- 056 — Phase 0 : durcissement avant Lot 3.
-- Idempotent, non destructif. Index de performance manquants + support de la
-- réconciliation incrémentale + protection au repos des secrets webhooks.

-- ───────────────────────── Index de performance ─────────────────────────
-- #1 CRITIQUE : wallet_entries est joint par transaction_id (reçu, vérif
-- publique, réconciliation). Sans cet index → seq scan à chaque JOIN/SUM.
CREATE INDEX IF NOT EXISTS idx_wallet_entries_transaction
  ON wallet_entries (transaction_id);

-- Contexte anti-fraude (buildContext) + historique par initiateur.
CREATE INDEX IF NOT EXISTS idx_wallet_tx_initiated
  ON wallet_transactions (initiated_by, created_at DESC);

-- Recherche d'alertes de fraude par utilisateur.
CREATE INDEX IF NOT EXISTS idx_wallet_fraud_user
  ON wallet_fraud_alerts (user_id, created_at DESC);

-- Filtre webhooks « event = ANY(events) » (recherche dans un tableau).
CREATE INDEX IF NOT EXISTS idx_wallet_webhooks_events
  ON wallet_webhooks USING GIN (events);

-- ─────────────────── Réconciliation incrémentale (#5) ───────────────────
-- Curseur d'état : mémorise le dernier wallet_entries.id traité et les
-- totaux cumulés, pour ne JAMAIS re-scanner tout le grand livre.
CREATE TABLE IF NOT EXISTS wallet_reconciliation_state (
  scope TEXT PRIMARY KEY,                        -- 'ledger_incremental'
  last_entry_id BIGINT NOT NULL DEFAULT 0,       -- dernier wallet_entries.id vu
  running_debit_total NUMERIC(20,2) NOT NULL DEFAULT 0,
  running_credit_total NUMERIC(20,2) NOT NULL DEFAULT 0,
  last_run_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO wallet_reconciliation_state (scope)
  VALUES ('ledger_incremental')
  ON CONFLICT (scope) DO NOTHING;

-- Traçabilité : distinguer les rapports incrémentaux des rapports complets.
ALTER TABLE wallet_reconciliation_reports
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'full';   -- full | incremental
ALTER TABLE wallet_reconciliation_reports
  ADD COLUMN IF NOT EXISTS from_entry_id BIGINT;
ALTER TABLE wallet_reconciliation_reports
  ADD COLUMN IF NOT EXISTS to_entry_id BIGINT;

-- ─────────────── Protection au repos des secrets webhooks (#4) ───────────
-- Le secret peut désormais être stocké chiffré (AES-256-GCM) si
-- WALLET_SECRET_ENC_KEY est configurée. La colonne marque le format.
ALTER TABLE wallet_webhooks
  ADD COLUMN IF NOT EXISTS secret_enc TEXT;               -- payload chiffré (iv:tag:data)
ALTER TABLE wallet_webhooks
  ADD COLUMN IF NOT EXISTS secret_format TEXT NOT NULL DEFAULT 'plain';  -- plain | aes-256-gcm
-- Quand le secret est chiffré, il vit dans secret_enc et la colonne clair
-- reste NULL : on retire donc la contrainte NOT NULL héritée de la 055.
ALTER TABLE wallet_webhooks ALTER COLUMN secret DROP NOT NULL;
