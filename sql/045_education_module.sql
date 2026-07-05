-- ============================================================
-- 045 — MaliLink Education (écoles, collèges, lycées, centres)
-- Additif : ne modifie aucune table existante.
-- Isolation : chaque table porte company_id (= établissement).
-- Rôles utilisés (colonne users.role) : school_admin, director,
-- secretary, teacher, supervisor, accountant, parent, student.
-- ============================================================

-- Paramètres de l'établissement (extension d'une company existante)
CREATE TABLE IF NOT EXISTS edu_schools (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  school_type TEXT NOT NULL DEFAULT 'ecole'
    CHECK (school_type IN ('ecole', 'college', 'lycee', 'centre_formation', 'universite')),
  grading_system TEXT NOT NULL DEFAULT 'malien'
    CHECK (grading_system IN ('malien', 'francais', 'autre')),
  grade_max NUMERIC(5,2) NOT NULL DEFAULT 20,
  logo_url TEXT,
  director_name TEXT,
  address TEXT,
  phone TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id)
);

-- Années scolaires et périodes
CREATE TABLE IF NOT EXISTS edu_school_years (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  label TEXT NOT NULL,                          -- ex: 2026-2027
  start_date DATE,
  end_date DATE,
  is_active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS edu_terms (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  school_year_id INTEGER NOT NULL REFERENCES edu_school_years(id) ON DELETE CASCADE,
  label TEXT NOT NULL,                          -- Trimestre 1, Semestre 2...
  term_order INTEGER NOT NULL DEFAULT 1,
  start_date DATE,
  end_date DATE
);

-- Classes et matières
CREATE TABLE IF NOT EXISTS edu_classes (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  school_year_id INTEGER REFERENCES edu_school_years(id) ON DELETE SET NULL,
  name TEXT NOT NULL,                           -- 6ème A, Terminale S...
  level TEXT,                                   -- 6eme, terminale...
  main_teacher_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_edu_classes_company ON edu_classes (company_id);

CREATE TABLE IF NOT EXISTS edu_subjects (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  coefficient NUMERIC(4,1) NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Affectation professeur → classe + matière
CREATE TABLE IF NOT EXISTS edu_teacher_assignments (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  teacher_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL REFERENCES edu_classes(id) ON DELETE CASCADE,
  subject_id INTEGER REFERENCES edu_subjects(id) ON DELETE SET NULL,
  UNIQUE (teacher_user_id, class_id, subject_id)
);

CREATE INDEX IF NOT EXISTS idx_edu_assign_teacher ON edu_teacher_assignments (teacher_user_id);

-- Élèves
CREATE TABLE IF NOT EXISTS edu_students (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,   -- compte élève optionnel
  matricule TEXT NOT NULL,                                    -- généré automatiquement
  qr_code TEXT NOT NULL,                                      -- code unique badge QR
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  gender TEXT CHECK (gender IN ('M', 'F')),
  birth_date DATE,
  photo_url TEXT,
  class_id INTEGER REFERENCES edu_classes(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'actif'
    CHECK (status IN ('actif', 'suspendu', 'transfere', 'diplome', 'abandonne')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, matricule),
  UNIQUE (qr_code)
);

CREATE INDEX IF NOT EXISTS idx_edu_students_class ON edu_students (class_id);
CREATE INDEX IF NOT EXISTS idx_edu_students_company ON edu_students (company_id);

-- Liaison parents ↔ élèves
CREATE TABLE IF NOT EXISTS edu_student_parents (
  id SERIAL PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES edu_students(id) ON DELETE CASCADE,
  parent_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  relation TEXT DEFAULT 'parent',
  UNIQUE (student_id, parent_user_id)
);

CREATE INDEX IF NOT EXISTS idx_edu_parents_user ON edu_student_parents (parent_user_id);

-- Présences (scan QR, appel professeur, surveillant)
CREATE TABLE IF NOT EXISTS edu_attendance (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES edu_students(id) ON DELETE CASCADE,
  class_id INTEGER REFERENCES edu_classes(id) ON DELETE SET NULL,
  attendance_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status TEXT NOT NULL DEFAULT 'present'
    CHECK (status IN ('present', 'retard', 'absent', 'absence_justifiee', 'sortie')),
  check_in_at TIMESTAMPTZ,
  check_out_at TIMESTAMPTZ,
  source TEXT NOT NULL DEFAULT 'scan'
    CHECK (source IN ('scan', 'appel', 'manuel')),
  recorded_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  justification TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (student_id, attendance_date)
);

CREATE INDEX IF NOT EXISTS idx_edu_attendance_date ON edu_attendance (company_id, attendance_date);

-- Évaluations (devoir, interrogation, examen, composition) et notes
CREATE TABLE IF NOT EXISTS edu_exams (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  term_id INTEGER REFERENCES edu_terms(id) ON DELETE SET NULL,
  class_id INTEGER NOT NULL REFERENCES edu_classes(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES edu_subjects(id) ON DELETE CASCADE,
  teacher_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  exam_type TEXT NOT NULL DEFAULT 'devoir'
    CHECK (exam_type IN ('devoir', 'interrogation', 'examen', 'composition')),
  title TEXT NOT NULL,
  exam_date DATE,
  max_score NUMERIC(5,2) NOT NULL DEFAULT 20,
  weight NUMERIC(4,2) NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS edu_grades (
  id SERIAL PRIMARY KEY,
  exam_id INTEGER NOT NULL REFERENCES edu_exams(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES edu_students(id) ON DELETE CASCADE,
  score NUMERIC(5,2) NOT NULL,
  remark TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (exam_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_edu_grades_student ON edu_grades (student_id);

-- Bulletins (générés par période)
CREATE TABLE IF NOT EXISTS edu_report_cards (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES edu_students(id) ON DELETE CASCADE,
  term_id INTEGER NOT NULL REFERENCES edu_terms(id) ON DELETE CASCADE,
  general_average NUMERIC(5,2),
  rank_in_class INTEGER,
  class_size INTEGER,
  conduct TEXT,
  appreciation TEXT,
  council_decision TEXT,
  absences_count INTEGER DEFAULT 0,
  late_count INTEGER DEFAULT 0,
  details JSONB,                       -- moyennes par matière figées
  pdf_url TEXT,
  generated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (student_id, term_id)
);

-- Frais scolaires et paiements
CREATE TABLE IF NOT EXISTS edu_fees (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  school_year_id INTEGER REFERENCES edu_school_years(id) ON DELETE SET NULL,
  label TEXT NOT NULL,                 -- Inscription, Scolarité octobre, Cantine...
  fee_type TEXT NOT NULL DEFAULT 'scolarite'
    CHECK (fee_type IN ('inscription', 'scolarite', 'cantine', 'transport',
                        'uniforme', 'bibliotheque', 'examen', 'autre')),
  amount NUMERIC(12,2) NOT NULL,
  class_id INTEGER REFERENCES edu_classes(id) ON DELETE SET NULL, -- null = toutes classes
  due_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS edu_fee_payments (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  fee_id INTEGER NOT NULL REFERENCES edu_fees(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES edu_students(id) ON DELETE CASCADE,
  amount NUMERIC(12,2) NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'especes'
    CHECK (payment_method IN ('especes', 'orange_money', 'wave', 'moov_money', 'carte')),
  reference TEXT,
  paid_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  recorded_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_edu_fee_payments_student ON edu_fee_payments (student_id);

-- Devoirs / cours en ligne
CREATE TABLE IF NOT EXISTS edu_courses (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  class_id INTEGER NOT NULL REFERENCES edu_classes(id) ON DELETE CASCADE,
  subject_id INTEGER REFERENCES edu_subjects(id) ON DELETE SET NULL,
  teacher_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  course_type TEXT NOT NULL DEFAULT 'cours'
    CHECK (course_type IN ('cours', 'devoir', 'exercice', 'document')),
  title TEXT NOT NULL,
  content TEXT,
  file_url TEXT,
  due_date DATE,                       -- pour les devoirs
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Messages école (direction/professeur → parents/élèves)
CREATE TABLE IF NOT EXISTS edu_messages (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sender_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  recipient_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE, -- null = annonce générale
  student_id INTEGER REFERENCES edu_students(id) ON DELETE CASCADE, -- contexte enfant
  class_id INTEGER REFERENCES edu_classes(id) ON DELETE SET NULL,   -- annonce de classe
  subject TEXT,
  body TEXT NOT NULL,
  is_announcement BOOLEAN NOT NULL DEFAULT false,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_edu_messages_recipient ON edu_messages (recipient_user_id, created_at);

-- Conduite / sanctions
CREATE TABLE IF NOT EXISTS edu_conduct (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES edu_students(id) ON DELETE CASCADE,
  conduct_type TEXT NOT NULL DEFAULT 'remarque'
    CHECK (conduct_type IN ('remarque', 'avertissement', 'blame', 'exclusion_temporaire', 'felicitations')),
  description TEXT,
  recorded_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  conduct_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
