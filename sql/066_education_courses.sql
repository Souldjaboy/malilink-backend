-- 066 — Éducation : enrichissement des cours en ligne (tranche 7).
-- Idempotent, additif. Ajoute pièce jointe nommée, lien vidéo/visio et publication.

ALTER TABLE edu_courses ADD COLUMN IF NOT EXISTS file_name TEXT;
ALTER TABLE edu_courses ADD COLUMN IF NOT EXISTS video_url TEXT;
ALTER TABLE edu_courses ADD COLUMN IF NOT EXISTS is_published BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE edu_courses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_edu_courses_class_type ON edu_courses (company_id, class_id, course_type);
