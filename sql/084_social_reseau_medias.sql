-- 084 — MaliLink Social : médias des publications (photos, vidéos) et
-- pagination du fil. Additive : aucune table existante n'est renommée ni
-- vidée ; les anciennes publications gardent leur colonne `media`.

BEGIN;

CREATE TABLE IF NOT EXISTS social_media (
  id                BIGSERIAL PRIMARY KEY,
  tenant_id         TEXT NOT NULL DEFAULT 'malilink',
  user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Identifiant opaque (URL) : jamais l'id séquentiel, pour ne rien laisser deviner.
  public_id         TEXT NOT NULL UNIQUE,
  kind              TEXT NOT NULL CHECK (kind IN ('image', 'video')),
  -- Type lu dans la signature binaire du fichier, pas celui déclaré par le navigateur.
  mime              TEXT NOT NULL,
  size_bytes        BIGINT NOT NULL CHECK (size_bytes > 0),
  storage_key       TEXT NOT NULL,
  poster_key        TEXT,
  width             INTEGER CHECK (width IS NULL OR width > 0),
  height            INTEGER CHECK (height IS NULL OR height > 0),
  duration_seconds  NUMERIC(8,2) CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'attached', 'deleted')),
  post_id           INTEGER REFERENCES social_posts(id) ON DELETE SET NULL,
  position          SMALLINT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at        TIMESTAMPTZ,
  CHECK (status <> 'attached' OR post_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_social_media_post ON social_media (post_id, position) WHERE status = 'attached';
CREATE INDEX IF NOT EXISTS idx_social_media_user ON social_media (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_media_pending ON social_media (created_at) WHERE status = 'pending';

-- Fil paginé par curseur (id décroissant) et publications d'un profil.
CREATE INDEX IF NOT EXISTS idx_social_posts_tenant_id_desc ON social_posts (tenant_id, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_social_posts_user_id_desc ON social_posts (user_id, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_social_friend_requests_from ON social_friend_requests (from_user_id, status);
CREATE INDEX IF NOT EXISTS idx_social_follows_follower ON social_follows (follower_user_id, status);

-- Coupe-circuit propre aux médias, sans toucher aux publications texte.
INSERT INTO social_feature_flags (flag_key, enabled) VALUES
  ('social_media_uploads_enabled', true)
ON CONFLICT (flag_key) DO NOTHING;

COMMIT;
