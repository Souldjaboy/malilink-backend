-- Academy: additive, opt-in. No existing school is activated.
CREATE TABLE IF NOT EXISTS edu_learning_programs (
 id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
 tenant_id TEXT NOT NULL, class_id INTEGER NOT NULL REFERENCES edu_classes(id),
 title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 threshold INTEGER NOT NULL DEFAULT 70 CHECK(threshold BETWEEN 1 AND 100),
 max_attempts INTEGER NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 20),
 units JSONB NOT NULL DEFAULT '[]', published BOOLEAN NOT NULL DEFAULT FALSE,
 created_by INTEGER NOT NULL REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS edu_learning_programs_scope ON edu_learning_programs(company_id,tenant_id,class_id);
CREATE TABLE IF NOT EXISTS edu_learning_attempts (
 id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), tenant_id TEXT NOT NULL,
 program_id INTEGER NOT NULL REFERENCES edu_learning_programs(id), student_id INTEGER NOT NULL REFERENCES edu_students(id),
 unit_index INTEGER NOT NULL CHECK(unit_index>=0),
 started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), submitted_at TIMESTAMPTZ,
 answers JSONB, score INTEGER, passed BOOLEAN NOT NULL DEFAULT FALSE,
 UNIQUE(program_id,student_id,unit_index,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS edu_learning_one_open_attempt ON edu_learning_attempts(program_id,student_id,unit_index) WHERE submitted_at IS NULL;
CREATE INDEX IF NOT EXISTS edu_learning_attempts_scope ON edu_learning_attempts(company_id,tenant_id,program_id,student_id);
CREATE TABLE IF NOT EXISTS edu_learning_allowances (
 company_id INTEGER NOT NULL REFERENCES companies(id), tenant_id TEXT NOT NULL,
 program_id INTEGER NOT NULL REFERENCES edu_learning_programs(id),
 student_id INTEGER NOT NULL REFERENCES edu_students(id), unit_index INTEGER NOT NULL CHECK(unit_index>=0),
 attempt_limit INTEGER NOT NULL CHECK(attempt_limit BETWEEN 1 AND 20),
 reason TEXT NOT NULL, granted_by INTEGER NOT NULL REFERENCES users(id),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(program_id,student_id,unit_index)
);
CREATE TABLE IF NOT EXISTS edu_learning_audit (
 id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), tenant_id TEXT NOT NULL,
 user_id INTEGER NOT NULL REFERENCES users(id), program_id INTEGER REFERENCES edu_learning_programs(id),
 action TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO modules(module_key,module_name,description)
SELECT 'education.learning','MaliLink Academy','Parcours, quiz et progression pédagogique.'
WHERE NOT EXISTS(SELECT 1 FROM modules WHERE module_key='education.learning');
INSERT INTO company_modules(company_id,module_key,is_enabled,enabled)
SELECT id,'education.learning',FALSE,FALSE FROM companies c
WHERE NOT EXISTS(SELECT 1 FROM company_modules m WHERE m.company_id=c.id AND m.module_key='education.learning');
