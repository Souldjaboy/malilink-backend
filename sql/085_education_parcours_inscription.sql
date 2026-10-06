-- 085 — MaliLink Éducation : un seul parcours d'inscription.
--
-- Inscription → affectation → paiement → badge → présence → notes → bulletin.
-- Additive : aucune table renommée ni vidée. Les anciennes inscriptions, les
-- anciens plans de mensualités et les anciens frais restent lisibles tels
-- quels ; seules les NOUVELLES inscriptions passent par l'échéancier unique.

BEGIN;

-- ── Élève : état civil complet, tuteur, photo privée, archivage ─────────
ALTER TABLE edu_students
  ADD COLUMN IF NOT EXISTS birth_place       TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS address           TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS phone             TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS email             TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS guardian_name     TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS guardian_relation TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS guardian_phone    TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS guardian_email    TEXT NOT NULL DEFAULT '',
  -- Photo rangée hors du dossier public, lue par la route Éducation.
  ADD COLUMN IF NOT EXISTS photo_key         TEXT,
  ADD COLUMN IF NOT EXISTS matricule_source  TEXT NOT NULL DEFAULT 'auto',
  ADD COLUMN IF NOT EXISTS archived_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Matricule unique par établissement. L'ancien calcul (COUNT + 1) a pu
-- produire des doublons : l'index n'est posé que s'il n'y en a aucun, et
-- le doublon éventuel est signalé au lieu de faire échouer la migration.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM edu_students GROUP BY company_id, matricule HAVING COUNT(*) > 1) THEN
    RAISE NOTICE '085 : matricules en double dans edu_students — index unique NON posé ; corriger puis rejouer.';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS uq_edu_students_matricule ON edu_students (company_id, matricule);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS edu_matricule_counters (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  year       INTEGER NOT NULL,
  last_seq   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, year)
);

-- ── Inscription : niveau, série, date, état, frais détaillés ───────────
ALTER TABLE edu_enrollments
  ADD COLUMN IF NOT EXISTS level              TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS section            TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS enrollment_date    DATE,
  ADD COLUMN IF NOT EXISTS enrollment_state   TEXT NOT NULL DEFAULT 'inscrit',
  ADD COLUMN IF NOT EXISTS monthly_fee        NUMERIC(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS months_count       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS other_fees         NUMERIC(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS other_fees_label   TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS discount_amount    NUMERIC(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS scholarship_amount NUMERIC(14,2) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edu_enrollments_state_check') THEN
    ALTER TABLE edu_enrollments ADD CONSTRAINT edu_enrollments_state_check
      CHECK (enrollment_state IN ('inscrit', 'preinscrit', 'abandon', 'transfere', 'termine'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edu_enrollments_montants_check') THEN
    ALTER TABLE edu_enrollments ADD CONSTRAINT edu_enrollments_montants_check
      CHECK (monthly_fee >= 0 AND months_count BETWEEN 0 AND 24 AND other_fees >= 0
             AND discount_amount >= 0 AND scholarship_amount >= 0);
  END IF;
END $$;

-- Un seul échéancier relie l'inscription, l'élève et les paiements.
ALTER TABLE edu_enrollments ADD COLUMN IF NOT EXISTS fee_plan_id INTEGER REFERENCES edu_feeplans(id) ON DELETE SET NULL;
ALTER TABLE edu_feeplans    ADD COLUMN IF NOT EXISTS enrollment_id INTEGER REFERENCES edu_enrollments(id) ON DELETE SET NULL;
ALTER TABLE edu_feeplan_installments ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'mensualite';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'edu_feeplan_installments_kind_check') THEN
    ALTER TABLE edu_feeplan_installments ADD CONSTRAINT edu_feeplan_installments_kind_check
      CHECK (kind IN ('inscription', 'mensualite', 'autre'));
  END IF;
END $$;

-- Lien comptable : chaque encaissement porte son écriture.
ALTER TABLE edu_feeplan_payments    ADD COLUMN IF NOT EXISTS accounting_transaction_id INTEGER;
ALTER TABLE edu_enrollment_payments ADD COLUMN IF NOT EXISTS accounting_transaction_id INTEGER;

-- Un élève n'a qu'une inscription active par année scolaire. Posé seulement
-- si l'existant le permet (signalé sinon, jamais bloquant).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM edu_enrollments
     WHERE school_year_id IS NOT NULL AND enrollment_state NOT IN ('abandon', 'transfere')
     GROUP BY company_id, student_id, school_year_id HAVING COUNT(*) > 1
  ) THEN
    RAISE NOTICE '085 : inscriptions en double pour une même année — index unique NON posé.';
  ELSE
    CREATE UNIQUE INDEX IF NOT EXISTS uq_edu_enrollments_eleve_annee
      ON edu_enrollments (company_id, student_id, school_year_id)
      WHERE school_year_id IS NOT NULL AND enrollment_state NOT IN ('abandon', 'transfere');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_edu_feeplan_installments_echeance
  ON edu_feeplan_installments (company_id, due_date) WHERE status <> 'paid';
CREATE INDEX IF NOT EXISTS idx_edu_feeplan_payments_jour ON edu_feeplan_payments (company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_edu_students_recherche ON edu_students (company_id, last_name, first_name);

COMMIT;
