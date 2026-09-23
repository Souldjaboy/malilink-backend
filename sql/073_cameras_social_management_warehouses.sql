-- 073 — Modules génériques « Caméras & Sécurité » et « Réseaux sociaux »,
--       enrichissement des entrepôts, dérogations de limites par société.
--
-- Additive et idempotente : rejouable sans perte. Aucune donnée supprimée.
--
-- Ces deux modules sont GÉNÉRIQUES : toute société MaliLink pourra les
-- activer via company_modules. Ils sont posés DÉSACTIVÉS pour toutes les
-- sociétés existantes, car le moteur de permissions autorise par défaut :
-- sans ligne explicite à false, ils apparaîtraient chez Triangle et HAFIYA,
-- qui partagent ce dépôt.

BEGIN;

-- ════════════════════════════════════════════════════════════════════
-- 1. DÉROGATIONS DE LIMITES PAR SOCIÉTÉ
-- ════════════════════════════════════════════════════════════════════
-- Le plan porte les limites de l'offre ; une société peut avoir négocié
-- autrement. Sans ce mécanisme, servir un client qui a besoin de 5
-- entrepôts sur une offre à 3 obligerait à changer l'offre pour TOUS les
-- clients qui y sont abonnés. NULL = pas de dérogation, le plan s'applique.

CREATE TABLE IF NOT EXISTS company_limit_overrides (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  max_users INTEGER,
  max_warehouses INTEGER,
  max_products INTEGER,
  max_cash_registers INTEGER,
  reason TEXT DEFAULT '',
  granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (company_id)
);

COMMENT ON TABLE company_limit_overrides IS
  'Dérogations négociées aux limites du plan, par société. NULL sur une colonne = la limite du plan s''applique.';

-- ════════════════════════════════════════════════════════════════════
-- 2. ENTREPÔTS : type, adresse, visibilité
-- ════════════════════════════════════════════════════════════════════
-- La table ne distinguait ni le type de site ni sa visibilité dans le POS.

ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS type VARCHAR(50) NOT NULL DEFAULT 'entrepot';
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS address TEXT DEFAULT '';
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS is_pos_visible BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS is_stock_visible BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS capacity_note TEXT DEFAULT '';
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT '';

COMMENT ON COLUMN warehouses.type IS
  'entrepot | magasin | depot | point_de_vente — le type de site.';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'warehouses_type_valide') THEN
    ALTER TABLE warehouses ADD CONSTRAINT warehouses_type_valide
      CHECK (type IN ('entrepot', 'magasin', 'depot', 'point_de_vente'));
  END IF;
EXCEPTION WHEN others THEN
  RAISE WARNING '073 : contrainte warehouses_type_valide non posée (%), on continue.', SQLERRM;
END $$;

-- Un code d'entrepôt doit être unique DANS une société, jamais globalement.
CREATE UNIQUE INDEX IF NOT EXISTS uidx_warehouses_company_code
  ON warehouses (company_id, code) WHERE code IS NOT NULL AND code <> '';

-- ════════════════════════════════════════════════════════════════════
-- 3. MODULE « CAMÉRAS & SÉCURITÉ »
-- ════════════════════════════════════════════════════════════════════
-- V1 : inventaire, état, organisation, rattachement au site. Aucun secret
-- en clair : les identifiants passent par services/secret-vault.js
-- (AES-256-GCM), et ne ressortent JAMAIS par l'API.

CREATE TABLE IF NOT EXISTS camera_recorders (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE SET NULL,
  name VARCHAR(180) NOT NULL,
  kind VARCHAR(20) NOT NULL DEFAULT 'nvr',
  brand VARCHAR(120) DEFAULT '',
  model VARCHAR(120) DEFAULT '',
  channels INTEGER DEFAULT 0,
  host VARCHAR(255) DEFAULT '',
  notes TEXT DEFAULT '',
  status VARCHAR(30) NOT NULL DEFAULT 'actif',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cameras (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE SET NULL,
  recorder_id INTEGER REFERENCES camera_recorders(id) ON DELETE SET NULL,
  code VARCHAR(80) DEFAULT '',
  name VARCHAR(180) NOT NULL,
  location TEXT DEFAULT '',
  camera_type VARCHAR(40) DEFAULT '',
  brand VARCHAR(120) DEFAULT '',
  model VARCHAR(120) DEFAULT '',
  host VARCHAR(255) DEFAULT '',
  channel_number INTEGER,
  status VARCHAR(30) NOT NULL DEFAULT 'actif',
  online_status VARCHAR(20) NOT NULL DEFAULT 'inconnu',
  installed_on DATE,
  last_checked_at TIMESTAMP,
  observations TEXT DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON COLUMN cameras.online_status IS
  'en_ligne | hors_ligne | inconnu — « inconnu » tant qu''aucune sonde réelle ne renseigne l''état. On n''affiche jamais un état inventé.';

-- Les identifiants sont séparés de l'inventaire : on peut lire la liste des
-- caméras sans jamais approcher la table des secrets.
CREATE TABLE IF NOT EXISTS camera_credentials (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  camera_id INTEGER REFERENCES cameras(id) ON DELETE CASCADE,
  recorder_id INTEGER REFERENCES camera_recorders(id) ON DELETE CASCADE,
  username VARCHAR(180) DEFAULT '',
  secret_format VARCHAR(30) NOT NULL DEFAULT 'plain',
  secret_encrypted TEXT NOT NULL DEFAULT '',
  stream_path_encrypted TEXT NOT NULL DEFAULT '',
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CHECK (camera_id IS NOT NULL OR recorder_id IS NOT NULL)
);

COMMENT ON TABLE camera_credentials IS
  'Identifiants caméra/NVR chiffrés au repos (services/secret-vault.js). Ne ressortent jamais par l''API : seul un booléen « configuré » est exposé.';

CREATE TABLE IF NOT EXISTS camera_access_logs (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  camera_id INTEGER REFERENCES cameras(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(60) NOT NULL,
  detail TEXT DEFAULT '',
  ip VARCHAR(80) DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cameras_company        ON cameras (company_id);
CREATE INDEX IF NOT EXISTS idx_cameras_warehouse      ON cameras (company_id, warehouse_id);
CREATE INDEX IF NOT EXISTS idx_camera_recorders_comp  ON camera_recorders (company_id);
CREATE INDEX IF NOT EXISTS idx_camera_creds_company   ON camera_credentials (company_id);

-- Un seul jeu d'identifiants par caméra, et un seul par enregistreur :
-- sans cette unicité, chaque enregistrement créerait une ligne de plus et
-- on ne saurait plus lequel fait foi.
CREATE UNIQUE INDEX IF NOT EXISTS uidx_camera_creds_camera
  ON camera_credentials (company_id, camera_id) WHERE camera_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uidx_camera_creds_recorder
  ON camera_credentials (company_id, recorder_id) WHERE recorder_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_camera_logs_company    ON camera_access_logs (company_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uidx_cameras_company_code
  ON cameras (company_id, code) WHERE code IS NOT NULL AND code <> '';

-- ════════════════════════════════════════════════════════════════════
-- 4. MODULE « RÉSEAUX SOCIAUX » (gestion de publications)
-- ════════════════════════════════════════════════════════════════════
-- ATTENTION : les tables social_* existantes appartiennent au réseau social
-- MaliLink (profils, amis, swipes). Ce module-ci est la GESTION DE PAGES
-- d'une entreprise : préfixe smm_ (social media management) pour qu'aucune
-- confusion ne soit possible.

CREATE TABLE IF NOT EXISTS smm_accounts (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  network VARCHAR(40) NOT NULL,
  display_name VARCHAR(180) NOT NULL,
  handle VARCHAR(180) DEFAULT '',
  profile_url TEXT DEFAULT '',
  status VARCHAR(30) NOT NULL DEFAULT 'non_connecte',
  connected_at TIMESTAMP,
  token_format VARCHAR(30) NOT NULL DEFAULT 'plain',
  token_encrypted TEXT NOT NULL DEFAULT '',
  token_expires_at TIMESTAMP,
  notes TEXT DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON COLUMN smm_accounts.status IS
  'non_connecte | connecte | expire — « non_connecte » tant qu''aucune API officielle n''est configurée. Aucune connexion n''est simulée.';
COMMENT ON COLUMN smm_accounts.token_encrypted IS
  'Jeton OAuth chiffré au repos (secret-vault). Jamais exposé par l''API.';

CREATE TABLE IF NOT EXISTS smm_posts (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  account_id INTEGER REFERENCES smm_accounts(id) ON DELETE SET NULL,
  network VARCHAR(40) NOT NULL DEFAULT '',
  title VARCHAR(255) DEFAULT '',
  body TEXT DEFAULT '',
  status VARCHAR(30) NOT NULL DEFAULT 'brouillon',
  scheduled_for TIMESTAMP,
  published_at TIMESTAMP,
  failure_reason TEXT DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON COLUMN smm_posts.status IS
  'brouillon | programme | publie | echoue — « publie » n''est posé que par une publication réelle.';

CREATE TABLE IF NOT EXISTS smm_media (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  post_id INTEGER REFERENCES smm_posts(id) ON DELETE CASCADE,
  kind VARCHAR(20) NOT NULL DEFAULT 'image',
  url TEXT DEFAULT '',
  caption TEXT DEFAULT '',
  position INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_smm_accounts_company ON smm_accounts (company_id);
CREATE INDEX IF NOT EXISTS idx_smm_posts_company    ON smm_posts (company_id, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_smm_posts_status     ON smm_posts (company_id, status);
CREATE INDEX IF NOT EXISTS idx_smm_media_company    ON smm_media (company_id);

COMMIT;
