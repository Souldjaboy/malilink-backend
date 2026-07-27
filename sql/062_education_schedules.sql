-- 062 — Éducation : emplois du temps (§7) + base de la détection de conflits (§8).
-- Idempotent, additif, préfixe edu_*, isolation school_id (company_id).

CREATE TABLE IF NOT EXISTS edu_schedules (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  assignment_id INTEGER REFERENCES edu_teacher_assignments(id) ON DELETE SET NULL,
  teacher_id INTEGER REFERENCES edu_teachers(id) ON DELETE SET NULL,
  class_id INTEGER NOT NULL REFERENCES edu_classes(id) ON DELETE CASCADE,
  subject_id INTEGER REFERENCES edu_subjects(id) ON DELETE SET NULL,
  school_year_id INTEGER REFERENCES edu_school_years(id) ON DELETE SET NULL,
  day_of_week INTEGER NOT NULL,            -- 1=lundi … 7=dimanche
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  room TEXT DEFAULT '',
  frequency TEXT NOT NULL DEFAULT 'weekly',-- weekly | once | biweekly
  session_type TEXT NOT NULL DEFAULT 'cours', -- cours | td | tp | revision | examen | online | individuel
  mode TEXT NOT NULL DEFAULT 'presentiel', -- presentiel | online
  meeting_link TEXT DEFAULT '',
  valid_from DATE,
  valid_to DATE,
  status TEXT NOT NULL DEFAULT 'actif',     -- actif | annule | suspendu
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (end_time > start_time)
);
CREATE INDEX IF NOT EXISTS idx_edu_sched_class ON edu_schedules (company_id, class_id, day_of_week, status);
CREATE INDEX IF NOT EXISTS idx_edu_sched_teacher ON edu_schedules (company_id, teacher_id, day_of_week, status);
CREATE INDEX IF NOT EXISTS idx_edu_sched_room ON edu_schedules (company_id, day_of_week, status);
