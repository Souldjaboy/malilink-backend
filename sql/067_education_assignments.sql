-- 067 — Éducation : devoirs et corrections (tranche 8).
-- Les devoirs réutilisent edu_courses (course_type='devoir', due_date).
-- Cette migration ajoute les rendus (soumissions) des élèves et leur correction.

CREATE TABLE IF NOT EXISTS edu_assignment_submissions (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  course_id INTEGER NOT NULL REFERENCES edu_courses(id) ON DELETE CASCADE,  -- le devoir
  student_id INTEGER NOT NULL REFERENCES edu_students(id) ON DELETE CASCADE,
  content TEXT,                                    -- réponse texte de l'élève
  file_url TEXT,
  file_name TEXT,
  status TEXT NOT NULL DEFAULT 'submitted',        -- submitted | graded
  score NUMERIC(6,2),
  max_score NUMERIC(6,2) NOT NULL DEFAULT 20,
  feedback TEXT,                                   -- correction/appréciation du professeur
  correction_file_url TEXT,
  correction_file_name TEXT,
  submitted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  graded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  graded_at TIMESTAMPTZ,
  UNIQUE (course_id, student_id)
);
CREATE INDEX IF NOT EXISTS idx_edu_submissions_course ON edu_assignment_submissions (course_id, status);
CREATE INDEX IF NOT EXISTS idx_edu_submissions_student ON edu_assignment_submissions (student_id);
