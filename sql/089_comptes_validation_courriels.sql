-- 089 — Comptes : validation administrative, révocation des sessions,
-- changement d'email vérifié, journal des envois d'email.
--
-- Additive. La validation administrative (Super Admin, journalisée) est
-- DISTINCTE de la preuve de possession de l'email : email_verified n'est
-- jamais modifié par elle.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS admin_validated_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS admin_validated_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS admin_validation_reason  TEXT NOT NULL DEFAULT '',
  -- Tout jeton émis avant cette date est refusé (réinitialisation, changement d'email).
  ADD COLUMN IF NOT EXISTS tokens_valid_after       TIMESTAMPTZ;

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS admin_validated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS admin_validated_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

-- États avant/après de chaque validation manuelle.
CREATE TABLE IF NOT EXISTS account_admin_validations (
  id            BIGSERIAL PRIMARY KEY,
  company_id    INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  validated_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason        TEXT NOT NULL,
  state_before  JSONB NOT NULL,
  state_after   JSONB NOT NULL,
  source        TEXT NOT NULL DEFAULT 'interface',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_account_admin_validations_company ON account_admin_validations (company_id, created_at DESC);

-- Changement d'adresse email : appliqué seulement après confirmation par la nouvelle adresse.
CREATE TABLE IF NOT EXISTS account_email_changes (
  id            BIGSERIAL PRIMARY KEY,
  subject_type  TEXT NOT NULL CHECK (subject_type IN ('user', 'company')),
  subject_id    INTEGER NOT NULL,
  old_email     TEXT NOT NULL DEFAULT '',
  new_email     TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  code_hash     TEXT NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  requested_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  confirmed_at  TIMESTAMPTZ,
  cancelled_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_account_email_changes_sujet ON account_email_changes (subject_type, subject_id) WHERE confirmed_at IS NULL AND cancelled_at IS NULL;

-- Journal des envois : objet, adresse masquée, réponse du serveur. Jamais de code ni de contenu.
CREATE TABLE IF NOT EXISTS email_delivery_log (
  id                   BIGSERIAL PRIMARY KEY,
  purpose              TEXT NOT NULL,
  user_id              INTEGER,
  company_id           INTEGER,
  recipient_masked     TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('accepte', 'refuse', 'non_configure', 'echec')),
  provider_message_id  TEXT,
  smtp_response        TEXT,
  error                TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_delivery_log_date ON email_delivery_log (created_at DESC);

COMMIT;
