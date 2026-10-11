-- 091 — Espace (tenant) vérifié des comptes sans société.
--
-- Additive. users.tenant_id (DEFAULT 'triangle' depuis 043, jamais renseigné
-- à l'inscription) n'est pas une preuve d'espace : on ne s'en sert pas.
-- account_tenant_id est posé côté serveur : à l'inscription, ou par une
-- ATTRIBUTION ADMINISTRATIVE explicite (scripts/comptes/attribuer-espace.js),
-- journalisée dans account_tenant_assignments et audit_logs.
-- Aucun remplissage automatique ici : pas d'espace attribué par défaut, ni
-- d'après le site utilisé. Les comptes d'une société prennent son espace.

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS account_tenant_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_tenant_source TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_tenant_set_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_tenant_set_by INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_account_tenant_valide') THEN
    ALTER TABLE users ADD CONSTRAINT users_account_tenant_valide
      CHECK (account_tenant_id IS NULL OR account_tenant_id IN ('malilink', 'hafiya', 'triangle'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_account_tenant ON users (account_tenant_id) WHERE account_tenant_id IS NOT NULL;

-- Journal des attributions administratives (qui, quand, pourquoi, sur quelle preuve).
CREATE TABLE IF NOT EXISTS account_tenant_assignments (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id          TEXT NOT NULL CHECK (tenant_id IN ('malilink', 'hafiya', 'triangle')),
  previous_tenant_id TEXT,
  assigned_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason             TEXT NOT NULL,
  evidence           TEXT NOT NULL DEFAULT '',
  source             TEXT NOT NULL DEFAULT 'script_vps',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_account_tenant_assignments_user ON account_tenant_assignments (user_id);

COMMIT;
