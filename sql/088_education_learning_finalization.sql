-- MaliLink Academy finalization: additive and opt-in.
ALTER TABLE edu_learning_programs ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE edu_learning_programs ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
ALTER TABLE edu_learning_programs ADD COLUMN IF NOT EXISTS source_program_id INTEGER REFERENCES edu_learning_programs(id);

CREATE TABLE IF NOT EXISTS edu_learning_settings (
 company_id INTEGER PRIMARY KEY REFERENCES companies(id), tenant_id TEXT NOT NULL,
 brand_name VARCHAR(100) NOT NULL DEFAULT 'MaliLink Academy',
 welcome_text VARCHAR(500) NOT NULL DEFAULT 'Apprendre, pratiquer et progresser.',
 primary_color VARCHAR(7) NOT NULL DEFAULT '#0f172a', celebration_enabled BOOLEAN NOT NULL DEFAULT TRUE,
 updated_by INTEGER REFERENCES users(id), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS edu_learning_assets (
 id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), tenant_id TEXT NOT NULL,
 storage_key VARCHAR(180) NOT NULL UNIQUE, original_name VARCHAR(255) NOT NULL,
 mime_type VARCHAR(120) NOT NULL, size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 52428800),
 uploaded_by INTEGER NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS edu_learning_assets_scope ON edu_learning_assets(company_id,tenant_id,id);

CREATE TABLE IF NOT EXISTS edu_learning_achievements (
 id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), tenant_id TEXT NOT NULL,
 program_id INTEGER NOT NULL REFERENCES edu_learning_programs(id), student_id INTEGER NOT NULL REFERENCES edu_students(id),
 unit_index INTEGER NOT NULL CHECK(unit_index>=0), score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100),
 awarded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(program_id,student_id,unit_index)
);
CREATE INDEX IF NOT EXISTS edu_learning_achievements_scope ON edu_learning_achievements(company_id,tenant_id,student_id);

CREATE TABLE IF NOT EXISTS edu_learning_certificates (
 id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), tenant_id TEXT NOT NULL,
 program_id INTEGER NOT NULL REFERENCES edu_learning_programs(id), student_id INTEGER NOT NULL REFERENCES edu_students(id),
 verification_token VARCHAR(80) NOT NULL UNIQUE, issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(program_id,student_id)
);
CREATE INDEX IF NOT EXISTS edu_learning_certificates_scope ON edu_learning_certificates(company_id,tenant_id,student_id);

INSERT INTO edu_learning_settings(company_id,tenant_id)
SELECT c.id,c.tenant_id FROM companies c
WHERE EXISTS(SELECT 1 FROM company_modules cm WHERE cm.company_id=c.id AND cm.module_key='education.learning')
ON CONFLICT(company_id) DO NOTHING;
