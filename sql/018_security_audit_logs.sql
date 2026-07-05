-- Triangle WMS Pro - Journal d'audit sécurité
-- Compatible avec une table audit_logs déjà créée par 005 (structure
-- created_by/old_values/new_values) : on ALIGNE la table sur la structure
-- attendue par le backend en AJOUTANT les colonnes manquantes.
-- Aucune colonne ni donnée existante n'est supprimée.

CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  user_id INTEGER,
  user_email TEXT DEFAULT '',
  user_role TEXT DEFAULT '',
  company_id INTEGER,
  action TEXT NOT NULL,
  entity_type TEXT DEFAULT '',
  entity_id TEXT,
  ip_address TEXT DEFAULT '',
  user_agent TEXT DEFAULT '',
  details JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Alignement si la table existait déjà (créée par 005 avec created_by etc.)
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_id INTEGER;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_email TEXT DEFAULT '';
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_role TEXT DEFAULT '';
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS company_id INTEGER;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS entity_type TEXT DEFAULT '';
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS entity_id TEXT;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS ip_address TEXT DEFAULT '';
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS user_agent TEXT DEFAULT '';
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS details JSONB DEFAULT '{}'::jsonb;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- Reprise des anciennes valeurs created_by → user_id (sans perte)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'audit_logs' AND column_name = 'created_by'
  ) THEN
    UPDATE audit_logs SET user_id = created_by WHERE user_id IS NULL AND created_by IS NOT NULL;
  END IF;
END $$;

-- entity_id doit être TEXT (le backend y écrit des identifiants variés) :
-- conversion INTEGER → TEXT sans perte si l'ancienne table l'avait en INTEGER.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'audit_logs' AND column_name = 'entity_id' AND data_type = 'integer'
  ) THEN
    ALTER TABLE audit_logs ALTER COLUMN entity_id TYPE TEXT USING entity_id::text;
  END IF;
END $$;

-- action : NOT NULL attendu ; on sécurise sans casser les lignes existantes.
UPDATE audit_logs SET action = '' WHERE action IS NULL;
ALTER TABLE audit_logs ALTER COLUMN action SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_company_id ON audit_logs(company_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
