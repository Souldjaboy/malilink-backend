-- 068 — RBAC : extension de la matrice de permissions (tranche RBAC).
-- Additif et idempotent. Ne casse aucune donnée existante.

-- Actions manquantes dans user_permissions (défaut NULL = non contraint).
ALTER TABLE user_permissions ADD COLUMN IF NOT EXISTS can_import  BOOLEAN;
ALTER TABLE user_permissions ADD COLUMN IF NOT EXISTS can_export  BOOLEAN;
ALTER TABLE user_permissions ADD COLUMN IF NOT EXISTS can_print   BOOLEAN;
ALTER TABLE user_permissions ADD COLUMN IF NOT EXISTS can_cancel  BOOLEAN;
ALTER TABLE user_permissions ADD COLUMN IF NOT EXISTS can_share   BOOLEAN;

-- Unicité (user_id, module_key) pour permettre les upserts ON CONFLICT.
CREATE UNIQUE INDEX IF NOT EXISTS uidx_user_permissions_user_module
  ON user_permissions (user_id, module_key);

CREATE UNIQUE INDEX IF NOT EXISTS uidx_user_modules_user_module
  ON user_modules (user_id, module_key);

-- Les sous-modules réutilisent company_modules avec des clés `parent.enfant`
-- (ex. restaurant.cuisine). Aucun schéma nouveau requis : la colonne module_key
-- est déjà en VARCHAR et supporte les clés pointées.
