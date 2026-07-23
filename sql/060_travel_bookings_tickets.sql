-- 060 — Réservations, paiement Wallet, e-billets QR (finalisation Voyage).
-- Idempotent, additif. Réutilise le grand livre Wallet comme moteur financier
-- unique ; aucune duplication de logique de paiement.

-- Billet : code alphanumérique de secours + horodatage d'utilisation.
ALTER TABLE travel_tickets ADD COLUMN IF NOT EXISTS verification_code TEXT;
ALTER TABLE travel_tickets ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ;
ALTER TABLE travel_tickets ADD COLUMN IF NOT EXISTS used_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_travel_ticket_code
  ON travel_tickets (verification_code) WHERE verification_code IS NOT NULL;

-- Réservation : horodatage de paiement + canal (en_ligne | comptoir/POS).
ALTER TABLE travel_bookings ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
ALTER TABLE travel_bookings ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'online'; -- online | pos
ALTER TABLE travel_bookings ADD COLUMN IF NOT EXISTS sold_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_travel_bookings_company ON travel_bookings (travel_company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_travel_bookings_status ON travel_bookings (status, payment_status);

-- Connecteurs de paiement (architecture prête ; seul Wallet est actif).
-- Les prestataires d'argent réel restent DÉSACTIVÉS tant qu'aucun contrat
-- agréé n'est configuré : aucun paiement réel n'est jamais simulé.
CREATE TABLE IF NOT EXISTS travel_payment_connectors (
  code TEXT PRIMARY KEY,                 -- wallet | orange_money | wave | card | apple_pay | google_pay
  label TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  is_real_money BOOLEAN NOT NULL DEFAULT true, -- true = nécessite un prestataire agréé
  sort_order INTEGER NOT NULL DEFAULT 100
);
INSERT INTO travel_payment_connectors (code, label, enabled, is_real_money, sort_order) VALUES
  ('wallet',       'Wallet MaliLink',  true,  false, 10),  -- circuit interne : actif
  ('orange_money', 'Orange Money',     false, true,  20),
  ('wave',         'Wave',             false, true,  30),
  ('card',         'Carte bancaire',   false, true,  40),
  ('apple_pay',    'Apple Pay',        false, true,  50),
  ('google_pay',   'Google Pay',       false, true,  60)
ON CONFLICT (code) DO NOTHING;

-- Ouvre la vente : réservation + paiement Wallet actifs (flags Lot 4A → ON).
UPDATE travel_feature_flags SET enabled=true WHERE flag_key IN ('travel_bookings_enabled','travel_payments_enabled');
INSERT INTO travel_feature_flags (flag_key, enabled) VALUES ('travel_bookings_enabled', true), ('travel_payments_enabled', true)
ON CONFLICT (flag_key) DO UPDATE SET enabled=true;
