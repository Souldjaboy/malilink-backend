-- 061 — Éducation : fiches professionnelles des professeurs (§4) + enrichissement
-- des affectations (§6). Idempotent, additif, préfixe edu_*, isolation school_id
-- (company_id). Ne duplique rien : aucune table edu_teachers n'existait — les
-- professeurs n'étaient que des users reliés via edu_teacher_assignments.

CREATE TABLE IF NOT EXISTS edu_teachers (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE, -- établissement (school_id)
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,               -- compte de connexion éventuel
  matricule TEXT NOT NULL,                                               -- PROF-2026-00015
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  gender TEXT DEFAULT '',                 -- M | F | ''
  photo_url TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  address TEXT DEFAULT '',
  birth_date DATE,
  diploma TEXT DEFAULT '',
  specialty TEXT DEFAULT '',
  hire_date DATE,
  contract_type TEXT DEFAULT '',          -- CDI | CDD | vacataire | stage…
  signature_url TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'actif',    -- actif | inactif
  school_year_id INTEGER REFERENCES edu_school_years(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, matricule)
);
CREATE INDEX IF NOT EXISTS idx_edu_teachers_school ON edu_teachers (company_id, status);
CREATE INDEX IF NOT EXISTS idx_edu_teachers_name ON edu_teachers (company_id, lower(last_name), lower(first_name));

-- Compteur de matricule par établissement et par année (PROF-AAAA-NNNNN).
CREATE TABLE IF NOT EXISTS edu_teacher_counters (
  company_id INTEGER NOT NULL,
  year INTEGER NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, year)
);

-- §6 — enrichissement des affectations professeur ↔ matière ↔ classe.
ALTER TABLE edu_teacher_assignments ADD COLUMN IF NOT EXISTS teacher_id INTEGER REFERENCES edu_teachers(id) ON DELETE CASCADE;
ALTER TABLE edu_teacher_assignments ALTER COLUMN teacher_user_id DROP NOT NULL; -- l'affectation peut viser une fiche edu_teachers
ALTER TABLE edu_teacher_assignments ADD COLUMN IF NOT EXISTS school_year_id INTEGER REFERENCES edu_school_years(id) ON DELETE SET NULL;
ALTER TABLE edu_teacher_assignments ADD COLUMN IF NOT EXISTS term_id INTEGER REFERENCES edu_terms(id) ON DELETE SET NULL;
ALTER TABLE edu_teacher_assignments ADD COLUMN IF NOT EXISTS coefficient NUMERIC(5,2);
ALTER TABLE edu_teacher_assignments ADD COLUMN IF NOT EXISTS weekly_hours NUMERIC(5,1);
ALTER TABLE edu_teacher_assignments ADD COLUMN IF NOT EXISTS start_date DATE;
ALTER TABLE edu_teacher_assignments ADD COLUMN IF NOT EXISTS end_date DATE;
ALTER TABLE edu_teacher_assignments ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'actif';
ALTER TABLE edu_teacher_assignments ADD COLUMN IF NOT EXISTS is_main_teacher BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE edu_teacher_assignments ADD COLUMN IF NOT EXISTS can_enter_grades BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE edu_teacher_assignments ADD COLUMN IF NOT EXISTS can_take_attendance BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE edu_teacher_assignments ADD COLUMN IF NOT EXISTS can_publish_courses BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS idx_edu_assign_teacher_file ON edu_teacher_assignments (teacher_id);

-- Journal d'audit des changements de coefficient (§5 « conserver l'historique »).
CREATE TABLE IF NOT EXISTS edu_coefficient_history (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  assignment_id INTEGER REFERENCES edu_teacher_assignments(id) ON DELETE CASCADE,
  old_value NUMERIC(5,2),
  new_value NUMERIC(5,2),
  changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
