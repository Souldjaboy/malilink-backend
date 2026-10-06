-- 086 — MaliLink Éducation : paramètres d'établissement, carte scolaire,
-- modèles de bulletins, vérification des documents par QR.
--
-- Les paramètres sont saisis UNE fois (Paramètres › Éducation ›
-- Établissement) et réutilisés partout : fiche, carte, bulletin, reçu.
-- Additive ; les valeurs vides retombent sur l'identité de l'entreprise
-- (company_settings) au moment de produire un document.

BEGIN;

ALTER TABLE edu_schools
  ADD COLUMN IF NOT EXISTS official_name            TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS short_name               TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS slogan                   TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS whatsapp                 TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS email                    TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS website                  TEXT NOT NULL DEFAULT '',
  -- Fichiers rangés hors du dossier public (uploads/etablissements) :
  -- un sceau, une signature ou un cachet servis librement se copient.
  ADD COLUMN IF NOT EXISTS logo_key                 TEXT,
  ADD COLUMN IF NOT EXISTS seal_key                 TEXT,
  ADD COLUMN IF NOT EXISTS signature_key            TEXT,
  ADD COLUMN IF NOT EXISTS stamp_key                TEXT,
  ADD COLUMN IF NOT EXISTS color_primary            TEXT NOT NULL DEFAULT '#0f1b3d',
  ADD COLUMN IF NOT EXISTS color_secondary          TEXT NOT NULL DEFAULT '#d4a23c',
  ADD COLUMN IF NOT EXISTS active_school_year_id    INTEGER REFERENCES edu_school_years(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS matricule_prefix         TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS matricule_manual_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS card_template            TEXT NOT NULL DEFAULT 'academique',
  ADD COLUMN IF NOT EXISTS card_options             JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS report_template          TEXT NOT NULL DEFAULT 'institutionnel',
  ADD COLUMN IF NOT EXISTS report_options           JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW();

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edu_schools_modeles_check') THEN
    ALTER TABLE edu_schools ADD CONSTRAINT edu_schools_modeles_check CHECK (
      card_template IN ('academique', 'moderne', 'premium', 'minimaliste', 'institutionnel', 'creatif')
      AND report_template IN ('institutionnel', 'academique', 'moderne', 'premium', 'compact', 'elegant'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edu_schools_couleurs_check') THEN
    ALTER TABLE edu_schools ADD CONSTRAINT edu_schools_couleurs_check CHECK (
      color_primary ~ '^#[0-9A-Fa-f]{6}$' AND color_secondary ~ '^#[0-9A-Fa-f]{6}$');
  END IF;
END $$;

-- ── Vérification publique d'un document (carte, bulletin, fiche, reçu) ──
-- Le QR ne porte qu'une URL et un jeton aléatoire : aucune donnée
-- personnelle n'y est inscrite. La page publique n'affiche que ce qui
-- prouve l'authenticité (établissement, élève, classe, année, type, statut).
CREATE TABLE IF NOT EXISTS edu_document_verifications (
  id                BIGSERIAL PRIMARY KEY,
  company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  token             TEXT NOT NULL UNIQUE,
  doc_type          TEXT NOT NULL CHECK (doc_type IN ('carte', 'bulletin', 'inscription', 'recu')),
  student_id        INTEGER REFERENCES edu_students(id) ON DELETE CASCADE,
  report_card_id    INTEGER REFERENCES edu_report_cards(id) ON DELETE CASCADE,
  reference         TEXT NOT NULL DEFAULT '',
  school_year_label TEXT NOT NULL DEFAULT '',
  class_label       TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'valide' CHECK (status IN ('valide', 'remplace', 'revoque')),
  valid_until       DATE,
  issued_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  issued_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at        TIMESTAMPTZ,
  last_checked_at   TIMESTAMPTZ,
  checks_count      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_edu_docverif_eleve ON edu_document_verifications (company_id, student_id, doc_type);
-- Une seule carte valide par élève et par année.
CREATE UNIQUE INDEX IF NOT EXISTS uq_edu_docverif_carte_valide
  ON edu_document_verifications (company_id, student_id, school_year_label)
  WHERE doc_type = 'carte' AND status = 'valide';

CREATE TABLE IF NOT EXISTS edu_card_counters (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  year       INTEGER NOT NULL,
  last_seq   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, year)
);

ALTER TABLE edu_report_cards
  ADD COLUMN IF NOT EXISTS class_average  NUMERIC(6,2),
  ADD COLUMN IF NOT EXISTS reference      TEXT;

COMMIT;
