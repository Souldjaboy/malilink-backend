-- 053 — MaliLink Wallet : identifiant public + carte virtuelle interne.
-- Idempotent. Étend le Wallet existant (051) SANS toucher au grand livre.
-- La carte est une carte INTERNE MaliLink en circuit fermé : le numéro
-- n'est PAS un vrai numéro bancaire (pas Visa/Mastercard). Aucun CVV
-- bancaire réel. Le code de sécurité interne est dynamique et n'est jamais
-- stocké en clair ni renvoyé dans les réponses ordinaires.

-- Identifiant public du wallet (jamais la clé primaire, ne révèle pas user_id)
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS wallet_number TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallets_number
  ON wallets (wallet_number) WHERE wallet_number IS NOT NULL;
ALTER TABLE wallets ADD COLUMN IF NOT EXISTS pin_hash TEXT;

CREATE TABLE IF NOT EXISTS wallet_cards (
  id SERIAL PRIMARY KEY,
  wallet_id INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  card_number TEXT NOT NULL,                    -- numéro interne MLK, format lisible avec somme de contrôle
  card_type TEXT NOT NULL DEFAULT 'personnelle',-- personnelle | professionnelle | entreprise
  template TEXT NOT NULL DEFAULT 'navy_gold',   -- navy_gold | black_gold | bogolan | entreprise
  holder_name TEXT NOT NULL DEFAULT '',
  company_name TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',         -- active | blocked | expired
  valid_until DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (wallet_id),
  UNIQUE (card_number)
);
CREATE INDEX IF NOT EXISTS idx_wallet_cards_status ON wallet_cards (status);

-- Workflow de demande de carte physique (service non activé par défaut)
CREATE TABLE IF NOT EXISTS wallet_card_requests (
  id SERIAL PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES wallet_cards(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'soumise',
    -- soumise | identite_a_verifier | approuvee | en_production | prete | livree | rejetee | suspendue
  reason TEXT DEFAULT '',
  handled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Journal des accès sensibles à la carte (qui a révélé le numéro, imprimé…)
CREATE TABLE IF NOT EXISTS wallet_card_audit_logs (
  id SERIAL PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES wallet_cards(id) ON DELETE CASCADE,
  action TEXT NOT NULL,                          -- created | number_revealed | blocked | unblocked | print_requested | approved | printed
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  details TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
