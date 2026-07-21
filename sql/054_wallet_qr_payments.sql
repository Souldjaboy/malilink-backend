-- 054 — Wallet Lot 2 : paiement QR, référence financière commune, écritures
-- comptables automatiques, abstraction émetteurs de cartes.
-- Idempotent. Le grand livre Wallet reste la seule source de vérité des
-- mouvements internes ; la comptabilité reçoit les écritures correspondantes
-- reliées par financial_operation_id.

-- Référence commune Wallet ↔ Comptabilité ↔ Finance
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS financial_operation_id TEXT;
CREATE INDEX IF NOT EXISTS idx_wallet_tx_finop
  ON wallet_transactions (financial_operation_id);
ALTER TABLE wallet_transactions ADD COLUMN IF NOT EXISTS commission_amount NUMERIC(14,2) NOT NULL DEFAULT 0;

-- Lien côté comptabilité (idempotent : la colonne peut déjà exister)
ALTER TABLE accounting_transactions ADD COLUMN IF NOT EXISTS financial_operation_id TEXT;
CREATE INDEX IF NOT EXISTS idx_acc_tx_finop
  ON accounting_transactions (financial_operation_id);

-- Demandes de paiement (QR : payer / recevoir / demander)
CREATE TABLE IF NOT EXISTS wallet_payment_requests (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'malilink',
  reference TEXT NOT NULL UNIQUE,               -- référence QR unique
  payee_wallet_id INTEGER NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  payer_wallet_id INTEGER REFERENCES wallets(id) ON DELETE SET NULL,
  amount NUMERIC(14,2),                          -- NULL = montant libre saisi par le payeur
  note TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',        -- pending | paid | expired | cancelled
  related_module TEXT DEFAULT '',
  related_id INTEGER,
  transaction_id INTEGER REFERENCES wallet_transactions(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_wallet_payreq_payee
  ON wallet_payment_requests (payee_wallet_id, status);

-- Abstraction émetteurs de cartes : la carte virtuelle interne est un
-- "issuer" par défaut ; les émetteurs agréés futurs (Visa, Mastercard…)
-- restent DÉSACTIVÉS tant qu'aucun contrat/API n'est configuré.
INSERT INTO wallet_feature_flags (flag_key, enabled) VALUES
  ('card_issuer_internal', true),
  ('card_issuer_visa', false),
  ('card_issuer_mastercard', false),
  ('marketplace_wallet_payment', true)
ON CONFLICT (flag_key) DO NOTHING;

-- Wallet plateforme MaliLink : reçoit les commissions (double-entrée
-- équilibrée dans le grand livre). On autorise owner_type='platform'.
-- Retire toute contrainte CHECK existante sur owner_type (nom auto-généré).
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'wallets'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%owner_type%'
  LOOP
    EXECUTE format('ALTER TABLE wallets DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE wallets ADD CONSTRAINT wallets_owner_type_check CHECK (
  (owner_type='user' AND user_id IS NOT NULL AND company_id IS NULL) OR
  (owner_type='company' AND company_id IS NOT NULL AND user_id IS NULL) OR
  (owner_type='platform' AND user_id IS NULL AND company_id IS NULL)
);

INSERT INTO wallets (owner_type, user_id, company_id, currency, status, wallet_number)
SELECT 'platform', NULL, NULL, 'XOF', 'active', 'MLW-PLATFORM-MALILINK'
WHERE NOT EXISTS (SELECT 1 FROM wallets WHERE owner_type='platform');
