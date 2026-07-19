-- 051 — MaliLink Wallet : portefeuille interne à GRAND LIVRE IMMUABLE.
-- Le solde n'est JAMAIS un champ modifiable : il découle des écritures
-- (wallet_entries). Idempotent, aucune suppression.
-- Argent réel (dépôt/retrait/Wave/Orange/Moov/banque) : feature flags
-- DÉSACTIVÉS tant qu'aucun fournisseur agréé n'est configuré.

CREATE TABLE IF NOT EXISTS wallets (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'malilink',
  owner_type TEXT NOT NULL DEFAULT 'user',          -- user | company
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  currency TEXT NOT NULL DEFAULT 'XOF',
  status TEXT NOT NULL DEFAULT 'active',            -- active | blocked
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (owner_type='user' AND user_id IS NOT NULL AND company_id IS NULL) OR
    (owner_type='company' AND company_id IS NOT NULL AND user_id IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallets_user
  ON wallets (user_id) WHERE owner_type='user';
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallets_company
  ON wallets (company_id) WHERE owner_type='company';

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'malilink',
  reference TEXT NOT NULL,                          -- référence unique lisible (reçu)
  idempotency_key TEXT,                             -- anti-double-paiement
  kind TEXT NOT NULL,                               -- transfer | bonus | cashback | payment | refund | adjustment
  status TEXT NOT NULL DEFAULT 'completed',         -- pending|processing|completed|failed|cancelled|reversed
  description TEXT DEFAULT '',
  related_module TEXT DEFAULT '',                   -- marketplace | delivery | restaurant | admin...
  related_id INTEGER,
  initiated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  UNIQUE (reference),
  UNIQUE (idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_wallet_tx_created ON wallet_transactions (created_at DESC);

-- Écritures du grand livre : IMMUABLES (jamais d'UPDATE/DELETE applicatif).
CREATE TABLE IF NOT EXISTS wallet_entries (
  id SERIAL PRIMARY KEY,
  transaction_id INTEGER NOT NULL REFERENCES wallet_transactions(id) ON DELETE RESTRICT,
  wallet_id INTEGER NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
  direction TEXT NOT NULL,                          -- credit | debit
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  balance_after NUMERIC(14,2) NOT NULL,             -- solde du wallet après l'écriture
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wallet_entries_wallet ON wallet_entries (wallet_id, id DESC);

CREATE TABLE IF NOT EXISTS wallet_holds (
  id SERIAL PRIMARY KEY,
  wallet_id INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  transaction_id INTEGER REFERENCES wallet_transactions(id) ON DELETE SET NULL,
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  reason TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'held',              -- held | released | captured
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_wallet_holds_wallet ON wallet_holds (wallet_id, status);

CREATE TABLE IF NOT EXISTS wallet_audit_logs (
  id SERIAL PRIMARY KEY,
  wallet_id INTEGER REFERENCES wallets(id) ON DELETE CASCADE,
  transaction_id INTEGER REFERENCES wallet_transactions(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  details TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallet_feature_flags (
  flag_key TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO wallet_feature_flags (flag_key, enabled) VALUES
  ('wallet_enabled', true),
  ('wallet_transfers_enabled', true),
  ('wallet_deposits_enabled', false),               -- argent réel : OFF
  ('wallet_withdrawals_enabled', false),            -- argent réel : OFF
  ('wallet_provider_wave', false),
  ('wallet_provider_orange_money', false),
  ('wallet_provider_moov', false),
  ('wallet_provider_bank', false)
ON CONFLICT (flag_key) DO NOTHING;
