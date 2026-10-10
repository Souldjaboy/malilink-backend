-- 090 — MaliLink Social : directs (lives) via LiveKit.
--
-- Additive. Aucun enregistrement des directs (pas d'egress). Inactif tant
-- que LiveKit n'est pas configuré ET joignable ET que le drapeau
-- social_lives_enabled n'est pas activé.

BEGIN;

CREATE TABLE IF NOT EXISTS social_lives (
  id               BIGSERIAL PRIMARY KEY,
  public_id        TEXT NOT NULL UNIQUE,
  tenant_id        TEXT NOT NULL DEFAULT 'malilink',
  host_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title            TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  audience         TEXT NOT NULL DEFAULT 'public' CHECK (audience IN ('public', 'friends', 'followers')),
  status           TEXT NOT NULL DEFAULT 'live' CHECK (status IN ('live', 'ended')),
  room_name        TEXT NOT NULL UNIQUE,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  host_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at         TIMESTAMPTZ,
  ended_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  end_reason       TEXT NOT NULL DEFAULT '',
  peak_viewers     INTEGER NOT NULL DEFAULT 0,
  comments_enabled BOOLEAN NOT NULL DEFAULT TRUE
);
-- Un seul direct en cours par personne.
CREATE UNIQUE INDEX IF NOT EXISTS uq_social_lives_hote_en_cours ON social_lives (host_id) WHERE status = 'live';
CREATE INDEX IF NOT EXISTS idx_social_lives_en_cours ON social_lives (started_at DESC) WHERE status = 'live';

CREATE TABLE IF NOT EXISTS social_live_viewers (
  live_id      BIGINT NOT NULL REFERENCES social_lives(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  left_at      TIMESTAMPTZ,
  banned_at    TIMESTAMPTZ,
  banned_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ban_reason   TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (live_id, user_id)
);

CREATE TABLE IF NOT EXISTS social_live_comments (
  id          BIGSERIAL PRIMARY KEY,
  live_id     BIGINT NOT NULL REFERENCES social_lives(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content     TEXT NOT NULL CHECK (char_length(content) BETWEEN 1 AND 300),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at  TIMESTAMPTZ,
  deleted_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_social_live_comments_live ON social_live_comments (live_id, id);

INSERT INTO social_feature_flags (flag_key, enabled) VALUES ('social_lives_enabled', false)
ON CONFLICT (flag_key) DO NOTHING;

COMMIT;
