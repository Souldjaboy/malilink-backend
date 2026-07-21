-- 055 — Wallet renfort du moteur financier (avant Lot 3).
-- Idempotent, non destructif. Le grand livre Wallet reste la SEULE source
-- de vérité des mouvements ; ces tables ajoutent gouvernance et supervision :
-- limites, notifications, multi-devises, fraude (score+alerte, jamais de
-- blocage auto), webhooks (désactivés par défaut), réconciliation.

-- ───────────────────────── #4 Limites Wallet ─────────────────────────
-- Plafonds configurables par utilisateur (ou défaut plateforme user_id=NULL).
CREATE TABLE IF NOT EXISTS wallet_limits (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'malilink',
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,   -- NULL = défaut plateforme
  max_per_transaction NUMERIC(14,2),                        -- plafond par opération
  daily_amount_cap NUMERIC(14,2),                           -- plafond cumulé / jour
  monthly_amount_cap NUMERIC(14,2),                         -- plafond cumulé / mois
  daily_count_cap INTEGER,                                  -- nb max d'opérations / jour
  currency TEXT NOT NULL DEFAULT 'XOF',
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_limits_user
  ON wallet_limits (COALESCE(user_id, 0));

-- Limites par défaut de la plateforme (généreuses ; ajustables en admin).
INSERT INTO wallet_limits (user_id, max_per_transaction, daily_amount_cap, monthly_amount_cap, daily_count_cap)
SELECT NULL, 2000000, 5000000, 50000000, 100
WHERE NOT EXISTS (SELECT 1 FROM wallet_limits WHERE user_id IS NULL);

-- ─────────────────── #5 Multi-devises (préparation) ───────────────────
-- Aujourd'hui FCFA (XOF) uniquement. Le référentiel prépare EUR/USD sans
-- changer l'architecture : les montants restent stockés dans la devise du
-- wallet ; la conversion est un service de lecture.
CREATE TABLE IF NOT EXISTS wallet_currencies (
  code TEXT PRIMARY KEY,                 -- XOF | EUR | USD
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  decimals INTEGER NOT NULL DEFAULT 2,
  rate_to_xof NUMERIC(18,6) NOT NULL,    -- 1 unité = N XOF (indicatif)
  enabled BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO wallet_currencies (code, name, symbol, decimals, rate_to_xof, enabled) VALUES
  ('XOF', 'Franc CFA (UEMOA)', 'FCFA', 0, 1,       true),   -- devise active
  ('EUR', 'Euro',             '€',    2, 655.957,  false),  -- parité fixe historique
  ('USD', 'Dollar US',        '$',    2, 600,      false)   -- indicatif, ajustable
ON CONFLICT (code) DO NOTHING;

-- ─────────────── #3 Moteur de notifications financières ───────────────
-- Journal unifié : in-app (toujours), email si configuré, SMS/Push prêts
-- (canaux enregistrés « queued » tant qu'aucun fournisseur n'est branché).
CREATE TABLE IF NOT EXISTS wallet_notifications (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'malilink',
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  event TEXT NOT NULL,                   -- transfer_in | transfer_out | payment | limit_reached | fraud_alert...
  channel TEXT NOT NULL,                 -- in_app | email | sms | push
  status TEXT NOT NULL DEFAULT 'queued', -- queued | sent | skipped | failed
  title TEXT DEFAULT '',
  message TEXT DEFAULT '',
  financial_operation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_wallet_notif_user ON wallet_notifications (user_id, created_at DESC);

-- ─────────────────────── #6 Moteur anti-fraude ───────────────────────
-- Score de risque + alerte SEULEMENT. Ne bloque JAMAIS automatiquement.
CREATE TABLE IF NOT EXISTS wallet_fraud_alerts (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'malilink',
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  wallet_id INTEGER REFERENCES wallets(id) ON DELETE SET NULL,
  transaction_id INTEGER REFERENCES wallet_transactions(id) ON DELETE SET NULL,
  financial_operation_id TEXT,
  risk_score INTEGER NOT NULL DEFAULT 0, -- 0..100
  risk_level TEXT NOT NULL DEFAULT 'low',-- low | medium | high
  reasons JSONB NOT NULL DEFAULT '[]',   -- signaux déclencheurs
  amount NUMERIC(14,2),
  status TEXT NOT NULL DEFAULT 'open',   -- open | reviewed | dismissed
  reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_wallet_fraud_status ON wallet_fraud_alerts (status, created_at DESC);

-- ───────────────────────── #7 Webhooks Wallet ─────────────────────────
-- Abonnements sortants pour événements Wallet futurs (Orange Money, Wave,
-- banques, ERP, API partenaires). DÉSACTIVÉS par défaut : aucune requête
-- externe tant qu'un endpoint n'est pas explicitement activé et signé.
CREATE TABLE IF NOT EXISTS wallet_webhooks (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'malilink',
  name TEXT NOT NULL,
  target_url TEXT NOT NULL,
  events TEXT[] NOT NULL DEFAULT '{}',   -- ex: {transaction.completed, payment.received}
  secret TEXT NOT NULL,                  -- clé de signature HMAC (jamais renvoyée en clair)
  enabled BOOLEAN NOT NULL DEFAULT false,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallet_webhook_deliveries (
  id SERIAL PRIMARY KEY,
  webhook_id INTEGER REFERENCES wallet_webhooks(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  payload JSONB NOT NULL,
  signature TEXT,
  status TEXT NOT NULL DEFAULT 'queued', -- queued | delivered | failed | skipped
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  financial_operation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_wallet_wh_deliv ON wallet_webhook_deliveries (webhook_id, status, created_at DESC);

-- ─────────────────── #2 Réconciliation automatique ───────────────────
-- Rapports de contrôle Wallet ↔ Comptabilité ↔ Finance. Une divergence
-- génère une alerte (statut mismatch) sans jamais modifier le grand livre.
CREATE TABLE IF NOT EXISTS wallet_reconciliation_reports (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'malilink',
  scope TEXT NOT NULL DEFAULT 'ledger_balance', -- ledger_balance | wallet_vs_accounting
  checked_count INTEGER NOT NULL DEFAULT 0,
  mismatch_count INTEGER NOT NULL DEFAULT 0,
  ledger_debit_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  ledger_credit_total NUMERIC(18,2) NOT NULL DEFAULT 0,
  details JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'ok',            -- ok | mismatch
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wallet_recon_created ON wallet_reconciliation_reports (created_at DESC);

-- Flags associés au renfort (tous en mode sûr par défaut).
INSERT INTO wallet_feature_flags (flag_key, enabled) VALUES
  ('wallet_limits_enabled', true),
  ('wallet_fraud_scoring_enabled', true),
  ('wallet_notifications_email', false),   -- email OFF tant que SMTP non configuré
  ('wallet_notifications_sms', false),     -- SMS OFF (architecture prête)
  ('wallet_notifications_push', false),    -- Push OFF (architecture prête)
  ('wallet_webhooks_enabled', false),      -- aucun envoi externe par défaut
  ('wallet_multicurrency_enabled', false)  -- FCFA seul aujourd'hui
ON CONFLICT (flag_key) DO NOTHING;
