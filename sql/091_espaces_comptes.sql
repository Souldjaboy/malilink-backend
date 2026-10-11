-- 091 — Espace (tenant) vérifié des comptes sans société.
--
-- Additive. users.tenant_id (DEFAULT 'triangle' depuis 043, jamais renseigné
-- à l'inscription) n'est pas une preuve d'espace : on ne s'en sert pas.
-- account_tenant_id est posé côté serveur (inscription, ou premier login
-- d'un ancien compte sur le site d'un espace, journalisé). Aucun
-- remplissage automatique ici : pas d'espace attribué par défaut.
-- Les comptes rattachés à une société prennent l'espace de la société.

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS account_tenant_id TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_tenant_source TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_tenant_set_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_account_tenant_valide') THEN
    ALTER TABLE users ADD CONSTRAINT users_account_tenant_valide
      CHECK (account_tenant_id IS NULL OR account_tenant_id IN ('malilink', 'hafiya', 'triangle'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_account_tenant ON users (account_tenant_id) WHERE account_tenant_id IS NOT NULL;

COMMIT;
