-- 082 — Socle biométrique : profils, consentements, appareils, défis,
-- événements, réglages ; passkeys et validation renforcée (step-up).
--
-- Additive et idempotente. Aucune donnée existante n'est touchée.
--
-- Garde-fous portés PAR LA BASE, pas seulement par le code :
--   • un gabarit ne peut être stocké que chiffré (préfixe « bv1. ») ;
--   • un profil biométrique ne vise que le PERSONNEL de SA société : un
--     déclencheur refuse un compte client (customer/client/patient) ou un
--     compte d'une autre société ;
--   • un seul profil actif par personne, modalité et doigt ;
--   • un défi ne sert qu'une fois (nonce unique, used_at).
-- Aucun événement ne porte de gabarit, d'image ou de secret.

BEGIN;

-- ── Réglages par société ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS biometric_settings (
  company_id              INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  tenant_id               TEXT,
  face_enabled            BOOLEAN NOT NULL DEFAULT FALSE,
  fingerprint_enabled     BOOLEAN NOT NULL DEFAULT FALSE,
  face_provider           TEXT NOT NULL DEFAULT '',
  fingerprint_provider    TEXT NOT NULL DEFAULT '',
  face_threshold          NUMERIC(5,4) NOT NULL DEFAULT 0.8500,
  fingerprint_threshold   NUMERIC(5,4) NOT NULL DEFAULT 0.8500,
  require_liveness        BOOLEAN NOT NULL DEFAULT TRUE,
  require_known_device    BOOLEAN NOT NULL DEFAULT TRUE,
  require_challenge       BOOLEAN NOT NULL DEFAULT TRUE,
  allow_identification    BOOLEAN NOT NULL DEFAULT FALSE,
  self_enrollment         BOOLEAN NOT NULL DEFAULT FALSE,
  stepup_required         BOOLEAN NOT NULL DEFAULT FALSE,
  challenge_ttl_seconds   INTEGER NOT NULL DEFAULT 120 CHECK (challenge_ttl_seconds BETWEEN 15 AND 900),
  profile_validity_days   INTEGER NOT NULL DEFAULT 730 CHECK (profile_validity_days BETWEEN 1 AND 3650),
  event_retention_days    INTEGER NOT NULL DEFAULT 365 CHECK (event_retention_days BETWEEN 30 AND 3650),
  consent_text_version    TEXT NOT NULL DEFAULT 'v1',
  updated_by              INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (face_threshold BETWEEN 0.5 AND 0.9999),
  CHECK (fingerprint_threshold BETWEEN 0.5 AND 0.9999)
);

-- ── Consentements ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS biometric_consents (
  id                 SERIAL PRIMARY KEY,
  company_id         INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tenant_id          TEXT,
  subject_type       TEXT NOT NULL CHECK (subject_type IN ('user', 'employee')),
  user_id            INTEGER REFERENCES users(id) ON DELETE CASCADE,
  employee_id        INTEGER,
  modalities         TEXT[] NOT NULL,
  purposes           TEXT[] NOT NULL,
  text_version       TEXT NOT NULL,
  text_hash          TEXT NOT NULL,
  method             TEXT NOT NULL CHECK (method IN ('ecran', 'papier')),
  paper_reference    TEXT NOT NULL DEFAULT '',
  given_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  withdrawn_at       TIMESTAMPTZ,
  withdrawn_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  withdrawal_reason  TEXT NOT NULL DEFAULT '',
  CHECK ((subject_type = 'user' AND user_id IS NOT NULL) OR (subject_type = 'employee' AND employee_id IS NOT NULL)),
  CHECK (modalities <@ ARRAY['face', 'fingerprint']::TEXT[] AND cardinality(modalities) > 0),
  CHECK (purposes <@ ARRAY['pointage', 'controle_acces', 'connexion', 'action_sensible', 'identification']::TEXT[]
         AND cardinality(purposes) > 0)
);
CREATE INDEX IF NOT EXISTS idx_biometric_consents_sujet ON biometric_consents (company_id, subject_type, user_id, employee_id);

-- ── Appareils ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS biometric_devices (
  id                SERIAL PRIMARY KEY,
  company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tenant_id         TEXT,
  site_id           INTEGER,
  name              TEXT NOT NULL,
  provider          TEXT NOT NULL DEFAULT '',
  device_type       TEXT NOT NULL CHECK (device_type IN ('terminal_visage', 'terminal_empreinte', 'kiosque', 'pc_local', 'mobile')),
  serial            TEXT NOT NULL,
  auth_method       TEXT NOT NULL DEFAULT 'hmac' CHECK (auth_method IN ('hmac')),
  secret_encrypted  TEXT NOT NULL CHECK (secret_encrypted LIKE 'bv1.%'),
  public_key        TEXT NOT NULL DEFAULT '',
  enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_at      TIMESTAMPTZ,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, serial)
);

-- ── Profils biométriques ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS biometric_profiles (
  id                  SERIAL PRIMARY KEY,
  company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tenant_id           TEXT,
  subject_type        TEXT NOT NULL CHECK (subject_type IN ('user', 'employee')),
  user_id             INTEGER REFERENCES users(id) ON DELETE CASCADE,
  employee_id         INTEGER,
  biometric_type      TEXT NOT NULL CHECK (biometric_type IN ('face', 'fingerprint')),
  provider            TEXT NOT NULL,
  finger_index        SMALLINT CHECK (finger_index IS NULL OR finger_index BETWEEN 0 AND 9),
  template_format     TEXT NOT NULL DEFAULT '',
  template_encrypted  TEXT CHECK (template_encrypted IS NULL OR template_encrypted LIKE 'bv1.%'),
  template_key_id     TEXT,
  external_reference  TEXT NOT NULL DEFAULT '',
  device_id           INTEGER REFERENCES biometric_devices(id) ON DELETE SET NULL,
  quality             NUMERIC(5,4),
  status              TEXT NOT NULL DEFAULT 'actif' CHECK (status IN ('actif', 'inactif', 'revoque')),
  consent_id          INTEGER NOT NULL REFERENCES biometric_consents(id) ON DELETE RESTRICT,
  enrolled_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  enrolled_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ,
  last_verified_at    TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ,
  revoked_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  revoke_reason       TEXT NOT NULL DEFAULT '',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((subject_type = 'user' AND user_id IS NOT NULL) OR (subject_type = 'employee' AND employee_id IS NOT NULL)),
  CHECK ((biometric_type = 'face' AND finger_index IS NULL) OR biometric_type = 'fingerprint'),
  -- Gabarit côté serveur OU référence dans un appareil : jamais ni l'un ni l'autre.
  CHECK (template_encrypted IS NOT NULL OR external_reference <> '' OR status <> 'actif'),
  -- Un profil révoqué ne garde aucun gabarit.
  CHECK (status <> 'revoque' OR template_encrypted IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_biometric_profile_actif
  ON biometric_profiles (company_id, subject_type, COALESCE(user_id, 0), COALESCE(employee_id, 0),
                         biometric_type, COALESCE(finger_index, -1))
  WHERE status = 'actif';
CREATE INDEX IF NOT EXISTS idx_biometric_profiles_reference
  ON biometric_profiles (company_id, biometric_type, external_reference) WHERE external_reference <> '';

/* Le personnel de LA société, et lui seul. Un compte client ou patient —
   présent dans la même table `users` — ne peut jamais recevoir de profil. */
CREATE OR REPLACE FUNCTION biometrie_personnel_seulement() RETURNS trigger AS $$
DECLARE
  r_role TEXT;
  r_societe INTEGER;
BEGIN
  IF NEW.subject_type = 'user' THEN
    SELECT lower(COALESCE(role, '')), company_id INTO r_role, r_societe FROM users WHERE id = NEW.user_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'biometrie: utilisateur introuvable' USING ERRCODE = 'check_violation';
    END IF;
    IF r_role IN ('customer', 'client', 'patient') THEN
      RAISE EXCEPTION 'biometrie: un compte client ou patient ne peut pas recevoir de donnée biométrique'
        USING ERRCODE = 'check_violation';
    END IF;
    IF r_societe IS DISTINCT FROM NEW.company_id THEN
      RAISE EXCEPTION 'biometrie: la personne n''appartient pas à cette société' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_biometric_profiles_personnel ON biometric_profiles;
CREATE TRIGGER trg_biometric_profiles_personnel BEFORE INSERT OR UPDATE ON biometric_profiles
  FOR EACH ROW EXECUTE FUNCTION biometrie_personnel_seulement();
DROP TRIGGER IF EXISTS trg_biometric_consents_personnel ON biometric_consents;
CREATE TRIGGER trg_biometric_consents_personnel BEFORE INSERT OR UPDATE ON biometric_consents
  FOR EACH ROW EXECUTE FUNCTION biometrie_personnel_seulement();

-- ── Défis à usage unique (anti-rejeu) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS biometric_challenges (
  id                SERIAL PRIMARY KEY,
  company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tenant_id         TEXT,
  requested_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  subject_type      TEXT CHECK (subject_type IN ('user', 'employee')),
  subject_user_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
  subject_employee_id INTEGER,
  device_id         INTEGER REFERENCES biometric_devices(id) ON DELETE CASCADE,
  biometric_type    TEXT NOT NULL CHECK (biometric_type IN ('face', 'fingerprint')),
  purpose           TEXT NOT NULL,
  action            TEXT NOT NULL DEFAULT '',
  nonce_hash        TEXT NOT NULL UNIQUE,
  expires_at        TIMESTAMPTZ NOT NULL,
  used_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_biometric_challenges_expiration ON biometric_challenges (expires_at);

-- ── Événements (journal biométrique) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS biometric_events (
  id                BIGSERIAL PRIMARY KEY,
  company_id        INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  tenant_id         TEXT,
  subject_type      TEXT,
  user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  employee_id       INTEGER,
  profile_id        INTEGER REFERENCES biometric_profiles(id) ON DELETE SET NULL,
  biometric_type    TEXT,
  action            TEXT NOT NULL,
  purpose           TEXT NOT NULL DEFAULT '',
  result            TEXT NOT NULL CHECK (result IN ('accepte', 'refuse', 'erreur')),
  reason_code       TEXT NOT NULL DEFAULT '',
  confidence        NUMERIC(5,4),
  threshold         NUMERIC(5,4),
  provider          TEXT NOT NULL DEFAULT '',
  device_id         INTEGER REFERENCES biometric_devices(id) ON DELETE SET NULL,
  challenge_id      INTEGER REFERENCES biometric_challenges(id) ON DELETE SET NULL,
  device_event_ref  TEXT,
  performed_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ip_address        TEXT NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (action IN ('enrolement', 'verification', 'identification', 'revocation', 'desactivation',
                    'reactivation', 'renouvellement', 'consentement', 'retrait_consentement',
                    'appareil', 'evenement_appareil', 'reglages', 'purge'))
);
CREATE INDEX IF NOT EXISTS idx_biometric_events_company ON biometric_events (company_id, created_at DESC);
-- Un événement d'appareil ne se rejoue pas : référence unique par appareil.
CREATE UNIQUE INDEX IF NOT EXISTS uq_biometric_events_appareil
  ON biometric_events (device_id, device_event_ref) WHERE device_event_ref IS NOT NULL;

-- ── Passkeys (WebAuthn) : AUCUNE donnée biométrique ────────────────────
-- Face ID, Touch ID, Windows Hello, empreinte Android : la biométrie reste
-- dans l'appareil. Le serveur ne garde qu'une clé publique.
CREATE TABLE IF NOT EXISTS auth_passkeys (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id      INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  tenant_id       TEXT,
  credential_id   TEXT NOT NULL UNIQUE,
  public_key      TEXT NOT NULL,
  counter         BIGINT NOT NULL DEFAULT 0,
  transports      TEXT[] NOT NULL DEFAULT '{}',
  device_type     TEXT NOT NULL DEFAULT '',
  backed_up       BOOLEAN NOT NULL DEFAULT FALSE,
  aaguid          TEXT NOT NULL DEFAULT '',
  name            TEXT NOT NULL DEFAULT 'Appareil',
  rp_id           TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at    TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_auth_passkeys_user ON auth_passkeys (user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS auth_passkey_challenges (
  id          SERIAL PRIMARY KEY,
  purpose     TEXT NOT NULL CHECK (purpose IN ('enregistrement', 'connexion', 'step_up')),
  user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
  tenant_id   TEXT,
  challenge   TEXT NOT NULL UNIQUE,
  rp_id       TEXT NOT NULL,
  scope       TEXT NOT NULL DEFAULT '',
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Validation renforcée (step-up) : 5 minutes après une preuve forte ──
CREATE TABLE IF NOT EXISTS auth_stepup_grants (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id  INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  method      TEXT NOT NULL CHECK (method IN ('passkey', 'visage', 'empreinte')),
  scope       TEXT NOT NULL DEFAULT '',
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auth_stepup_user ON auth_stepup_grants (user_id, expires_at DESC);

-- Le pointage biométrique référence l'appareil déclaré (081).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_history_device_fk') THEN
    ALTER TABLE attendance_history ADD CONSTRAINT attendance_history_device_fk
      FOREIGN KEY (device_id) REFERENCES biometric_devices(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Module « Biométrie » : fermé par défaut pour toutes les sociétés, comme
-- les caméras. Il ne s'ouvre que par une décision explicite.
INSERT INTO company_modules (company_id, module_key, is_enabled, enabled, source)
SELECT c.id, 'biometrie', FALSE, FALSE, 'registre' FROM companies c
ON CONFLICT (company_id, module_key) DO NOTHING;

COMMIT;
