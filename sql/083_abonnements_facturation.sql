-- 083 — Abonnements, paiements d'abonnement et facturation de la plateforme.
--
-- Factures émises PAR MaliLink À ses entreprises clientes (installation,
-- abonnement). À ne pas confondre avec `factures` (factures métier des
-- clients) ni avec `payments` (paiements de caisse POS).
--
-- Additive et idempotente. Aucune donnée existante n'est supprimée.
--
-- Garde-fous portés par la base :
--   • une facture émise ne change plus de montants (déclencheur) ; toute
--     correction passe par annulation, avoir ou paiement remboursé, tracés ;
--   • une référence de transaction ne sert qu'une fois par moyen de paiement ;
--   • une clé d'idempotence ne sert qu'une fois ;
--   • un paiement confirmé ne se supprime pas (déclencheur).

BEGIN;

-- ── Abonnement : échéances, solde, dérogation ──────────────────────────
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS monthly_fee NUMERIC(14,2);
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS grace_period_days INTEGER NOT NULL DEFAULT 5
  CHECK (grace_period_days BETWEEN 0 AND 60);
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS next_due_date DATE;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS last_payment_at TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS balance_due NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS manual_override TEXT NOT NULL DEFAULT ''
  CHECK (manual_override IN ('', 'deverrouillage_force'));
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS manual_override_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS manual_override_until TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS manual_override_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS suspension_reason TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN subscriptions.start_date IS 'Début de la période d''abonnement en cours (subscription_start).';
COMMENT ON COLUMN subscriptions.end_date IS 'Fin de la période payée (subscription_end) ; au-delà + délai de grâce : verrouillage.';
COMMENT ON COLUMN subscriptions.manual_override IS
  'deverrouillage_force : le super-admin lève le verrouillage (motif obligatoire, durée facultative). Audité.';

-- Mensualité figée sur l'abonnement : un changement de grille ne modifie pas
-- un abonnement en cours.
UPDATE subscriptions s SET monthly_fee = p.price_monthly
  FROM subscription_plans p WHERE p.id = s.plan_id AND s.monthly_fee IS NULL;
UPDATE subscriptions SET next_due_date = end_date WHERE next_due_date IS NULL AND end_date IS NOT NULL;

-- ── Moyens de paiement affichés au client ──────────────────────────────
-- Aucun numéro n'est inventé : le super-admin les renseigne. Un moyen sans
-- numéro n'est pas affiché.
CREATE TABLE IF NOT EXISTS billing_payment_methods (
  code            TEXT PRIMARY KEY CHECK (code ~ '^[a-z_]{2,30}$'),
  label           TEXT NOT NULL,
  account_number  TEXT NOT NULL DEFAULT '',
  account_name    TEXT NOT NULL DEFAULT '',
  instructions    TEXT NOT NULL DEFAULT '',
  qr_payload      TEXT NOT NULL DEFAULT '',
  enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  updated_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO billing_payment_methods (code, label, sort_order) VALUES
  ('orange_money', 'Orange Money', 10),
  ('wave', 'Wave', 20),
  ('moov_money', 'Moov Money', 30),
  ('virement', 'Virement bancaire', 40),
  ('especes', 'Espèces (au bureau)', 50)
ON CONFLICT (code) DO NOTHING;

-- ── Factures ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoice_sequences (
  year      INTEGER PRIMARY KEY,
  last      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS invoices (
  id                  SERIAL PRIMARY KEY,
  company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  subscription_id     INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL,
  number              TEXT NOT NULL UNIQUE,
  kind                TEXT NOT NULL CHECK (kind IN ('installation', 'abonnement', 'mixte', 'personnalisee', 'avoir')),
  status              TEXT NOT NULL DEFAULT 'emise'
                        CHECK (status IN ('brouillon', 'emise', 'partielle', 'payee', 'annulee')),
  issue_date          DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date            DATE,
  period_from         DATE,
  period_to           DATE,
  currency            TEXT NOT NULL DEFAULT 'FCFA',
  subtotal_standard   NUMERIC(14,2) NOT NULL DEFAULT 0,
  discount_total      NUMERIC(14,2) NOT NULL DEFAULT 0,
  total               NUMERIC(14,2) NOT NULL DEFAULT 0,
  amount_paid         NUMERIC(14,2) NOT NULL DEFAULT 0,
  subscription_included BOOLEAN NOT NULL DEFAULT FALSE,
  monthly_fee_info    NUMERIC(14,2),
  reference           TEXT NOT NULL DEFAULT '',
  notes               TEXT NOT NULL DEFAULT '',
  credited_invoice_id INTEGER REFERENCES invoices(id) ON DELETE RESTRICT,
  plan_snapshot       JSONB NOT NULL DEFAULT '{}'::jsonb,
  client_snapshot     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at        TIMESTAMPTZ,
  cancelled_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cancel_reason       TEXT NOT NULL DEFAULT '',
  sent_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (kind = 'avoir' OR (total >= 0 AND amount_paid >= 0 AND amount_paid <= total)),
  CHECK (kind <> 'avoir' OR (total <= 0 AND credited_invoice_id IS NOT NULL)),
  CHECK (discount_total >= 0),
  CHECK (status <> 'annulee' OR cancel_reason <> '')
);
CREATE INDEX IF NOT EXISTS idx_invoices_company ON invoices (company_id, issue_date DESC);

CREATE TABLE IF NOT EXISTS invoice_items (
  id                    SERIAL PRIMARY KEY,
  invoice_id            INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  kind                  TEXT NOT NULL CHECK (kind IN ('installation', 'abonnement', 'personnalise', 'avoir')),
  label                 TEXT NOT NULL,
  description           TEXT NOT NULL DEFAULT '',
  quantity              NUMERIC(10,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_standard   NUMERIC(14,2) NOT NULL DEFAULT 0,
  unit_price            NUMERIC(14,2) NOT NULL DEFAULT 0,
  discount_amount       NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
  discount_label        TEXT NOT NULL DEFAULT '',
  line_total            NUMERIC(14,2) NOT NULL DEFAULT 0,
  period_months         INTEGER CHECK (period_months IS NULL OR period_months BETWEEN 1 AND 36),
  sort_order            INTEGER NOT NULL DEFAULT 0
);

-- ── Paiements d'abonnement ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscription_payments (
  id                     SERIAL PRIMARY KEY,
  company_id             INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  subscription_id        INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL,
  invoice_id             INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  amount                 NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  currency               TEXT NOT NULL DEFAULT 'FCFA',
  method                 TEXT NOT NULL,
  transaction_reference  TEXT NOT NULL DEFAULT '',
  idempotency_key        TEXT UNIQUE,
  status                 TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'confirmed', 'failed', 'cancelled', 'refunded')),
  source                 TEXT NOT NULL DEFAULT 'manuel'
                           CHECK (source IN ('manuel', 'declaration_client', 'webhook')),
  receipt_number         TEXT UNIQUE,
  period_months          INTEGER CHECK (period_months IS NULL OR period_months BETWEEN 1 AND 36),
  paid_at                TIMESTAMPTZ,
  validated_at           TIMESTAMPTZ,
  validated_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status_reason          TEXT NOT NULL DEFAULT '',
  notes                  TEXT NOT NULL DEFAULT '',
  created_by             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Une référence de transaction ne sert qu'une fois par moyen de paiement.
CREATE UNIQUE INDEX IF NOT EXISTS uq_subscription_payments_reference
  ON subscription_payments (method, lower(transaction_reference)) WHERE transaction_reference <> '';
CREATE INDEX IF NOT EXISTS idx_subscription_payments_company ON subscription_payments (company_id, created_at DESC);

CREATE TABLE IF NOT EXISTS invoice_payments (
  id                       SERIAL PRIMARY KEY,
  invoice_id               INTEGER NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  subscription_payment_id  INTEGER NOT NULL REFERENCES subscription_payments(id) ON DELETE RESTRICT,
  amount                   NUMERIC(14,2) NOT NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, subscription_payment_id)
);

CREATE TABLE IF NOT EXISTS invoice_status_history (
  id           SERIAL PRIMARY KEY,
  invoice_id   INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  reason       TEXT NOT NULL DEFAULT '',
  changed_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  changed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Historique client (filtré par société) ─────────────────────────────
CREATE TABLE IF NOT EXISTS company_billing_events (
  id            BIGSERIAL PRIMARY KEY,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  event_type    TEXT NOT NULL CHECK (event_type IN (
                  'inscription', 'changement_plan', 'installation', 'facture', 'paiement', 'paiement_declare',
                  'paiement_refuse', 'remboursement', 'impaye', 'suspension', 'reactivation', 'verrouillage',
                  'deverrouillage', 'deverrouillage_force', 'remise', 'prolongation', 'periode_gratuite',
                  'annulation', 'avoir', 'envoi')),
  amount        NUMERIC(14,2),
  invoice_id    INTEGER REFERENCES invoices(id) ON DELETE SET NULL,
  payment_id    INTEGER REFERENCES subscription_payments(id) ON DELETE SET NULL,
  details       JSONB NOT NULL DEFAULT '{}'::jsonb,
  performed_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_company_billing_events ON company_billing_events (company_id, created_at DESC);

-- ── Garde-fous ─────────────────────────────────────────────────────────
-- Une facture émise ne change plus de montants ni de lignes.
CREATE OR REPLACE FUNCTION facture_montants_figes() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'brouillon' AND (
       NEW.total IS DISTINCT FROM OLD.total OR NEW.subtotal_standard IS DISTINCT FROM OLD.subtotal_standard
       OR NEW.discount_total IS DISTINCT FROM OLD.discount_total OR NEW.company_id IS DISTINCT FROM OLD.company_id
       OR NEW.number IS DISTINCT FROM OLD.number) THEN
    RAISE EXCEPTION 'facture % émise : montants figés (annulez ou émettez un avoir)', OLD.number
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_invoices_montants_figes ON invoices;
CREATE TRIGGER trg_invoices_montants_figes BEFORE UPDATE ON invoices
  FOR EACH ROW EXECUTE FUNCTION facture_montants_figes();

CREATE OR REPLACE FUNCTION facture_lignes_figees() RETURNS trigger AS $$
DECLARE
  s TEXT;
BEGIN
  SELECT status INTO s FROM invoices WHERE id = COALESCE(NEW.invoice_id, OLD.invoice_id);
  -- Les lignes s'écrivent sur un brouillon ; l'émission les fige (ajout compris).
  IF s IS NOT NULL AND s <> 'brouillon' THEN
    RAISE EXCEPTION 'facture émise : lignes figées' USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_invoice_items_figees ON invoice_items;
CREATE TRIGGER trg_invoice_items_figees BEFORE INSERT OR UPDATE OR DELETE ON invoice_items
  FOR EACH ROW EXECUTE FUNCTION facture_lignes_figees();

-- Un paiement confirmé ne se supprime pas : il se rembourse, tracé.
CREATE OR REPLACE FUNCTION paiement_confirme_indelebile() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('confirmed', 'refunded') THEN
    RAISE EXCEPTION 'paiement % confirmé : suppression interdite (remboursement tracé uniquement)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_subscription_payments_indelebile ON subscription_payments;
CREATE TRIGGER trg_subscription_payments_indelebile BEFORE DELETE ON subscription_payments
  FOR EACH ROW EXECUTE FUNCTION paiement_confirme_indelebile();

COMMIT;
