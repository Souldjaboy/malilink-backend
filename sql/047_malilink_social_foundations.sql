-- 047 — MaliLink Social : fondations (profils, préférences, confidentialité),
-- découverte (follow/amis/swipe/match/blocage/signalement) et publications.
-- Idempotent : uniquement des créations, aucune suppression.
-- users.id reste l'identité centrale (aucune duplication de users).

-- ---------- Profils sociaux ----------
CREATE TABLE IF NOT EXISTS social_profiles (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'malilink',
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  username TEXT,
  display_name TEXT NOT NULL DEFAULT '',
  bio TEXT DEFAULT '',
  photo_url TEXT DEFAULT '',
  cover_url TEXT DEFAULT '',
  birth_date DATE,
  gender TEXT DEFAULT '',                -- déclaré volontairement, jamais déduit
  city TEXT DEFAULT '',
  country TEXT DEFAULT 'Mali',
  languages JSONB DEFAULT '["fr"]'::jsonb,
  profession TEXT DEFAULT '',
  company_name TEXT DEFAULT '',
  goals JSONB DEFAULT '[]'::jsonb,       -- amitié, discussion, réseau pro, etc.
  interests JSONB DEFAULT '[]'::jsonb,
  is_public BOOLEAN NOT NULL DEFAULT true,
  is_active BOOLEAN NOT NULL DEFAULT true,
  dating_opt_in BOOLEAN NOT NULL DEFAULT false,  -- opt-in explicite, 18+ contrôlé backend
  verified_level TEXT NOT NULL DEFAULT 'none',   -- none|phone|email|identity|business|driver|creator
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_social_profiles_username
  ON social_profiles (LOWER(username)) WHERE username IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_social_profiles_tenant_active
  ON social_profiles (tenant_id, is_active, is_public);
CREATE INDEX IF NOT EXISTS idx_social_profiles_city ON social_profiles (city);

-- ---------- Préférences de découverte ----------
CREATE TABLE IF NOT EXISTS social_preferences (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  discover_genders JSONB DEFAULT '[]'::jsonb,    -- [] = tous
  age_min INTEGER DEFAULT 18,
  age_max INTEGER DEFAULT 99,
  city TEXT DEFAULT '',
  country TEXT DEFAULT '',
  languages JSONB DEFAULT '[]'::jsonb,
  goals JSONB DEFAULT '[]'::jsonb,
  verified_only BOOLEAN DEFAULT false,
  online_only BOOLEAN DEFAULT false,
  profile_types JSONB DEFAULT '[]'::jsonb,       -- particuliers, professionnels, créateurs, entreprises
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------- Confidentialité (contrôlée côté backend) ----------
CREATE TABLE IF NOT EXISTS social_privacy_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  who_can_follow TEXT NOT NULL DEFAULT 'everyone',       -- everyone|approval
  who_can_friend TEXT NOT NULL DEFAULT 'everyone',       -- everyone|friends_of_friends|nobody
  who_can_message TEXT NOT NULL DEFAULT 'friends',       -- everyone|friends|nobody
  who_can_call TEXT NOT NULL DEFAULT 'friends',
  who_can_comment TEXT NOT NULL DEFAULT 'everyone',
  show_age BOOLEAN NOT NULL DEFAULT false,
  show_city BOOLEAN NOT NULL DEFAULT true,
  show_friends BOOLEAN NOT NULL DEFAULT true,
  show_online BOOLEAN NOT NULL DEFAULT true,
  show_last_seen BOOLEAN NOT NULL DEFAULT false,
  allow_suggestions BOOLEAN NOT NULL DEFAULT true,
  dating_enabled BOOLEAN NOT NULL DEFAULT false,
  random_video_enabled BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------- Suivre / Amitié / Swipe / Match ----------
CREATE TABLE IF NOT EXISTS social_follows (
  id SERIAL PRIMARY KEY,
  follower_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followed_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'active',                 -- active|pending (profil privé)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (follower_user_id, followed_user_id),
  CHECK (follower_user_id <> followed_user_id)
);
CREATE INDEX IF NOT EXISTS idx_social_follows_followed ON social_follows (followed_user_id, status);

CREATE TABLE IF NOT EXISTS social_friend_requests (
  id SERIAL PRIMARY KEY,
  from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',                -- pending|accepted|refused|cancelled
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at TIMESTAMPTZ,
  UNIQUE (from_user_id, to_user_id),
  CHECK (from_user_id <> to_user_id)
);
CREATE INDEX IF NOT EXISTS idx_social_friend_requests_to ON social_friend_requests (to_user_id, status);

CREATE TABLE IF NOT EXISTS social_friendships (
  id SERIAL PRIMARY KEY,
  user_a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_a, user_b),
  CHECK (user_a < user_b)
);
CREATE INDEX IF NOT EXISTS idx_social_friendships_b ON social_friendships (user_b);

CREATE TABLE IF NOT EXISTS social_swipes (
  id SERIAL PRIMARY KEY,
  swiper_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,                               -- right|left
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (swiper_user_id, target_user_id),
  CHECK (swiper_user_id <> target_user_id)
);

CREATE TABLE IF NOT EXISTS social_matches (
  id SERIAL PRIMARY KEY,
  user_a INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_b INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_a, user_b),
  CHECK (user_a < user_b)
);

-- ---------- Blocage / Signalement ----------
CREATE TABLE IF NOT EXISTS social_blocks (
  id SERIAL PRIMARY KEY,
  blocker_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (blocker_user_id, blocked_user_id),
  CHECK (blocker_user_id <> blocked_user_id)
);
CREATE INDEX IF NOT EXISTS idx_social_blocks_blocked ON social_blocks (blocked_user_id);

CREATE TABLE IF NOT EXISTS social_reports (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'malilink',
  reporter_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  target_type TEXT NOT NULL DEFAULT 'profile',           -- profile|post|comment|message
  target_id INTEGER,
  reason TEXT NOT NULL DEFAULT '',
  details TEXT DEFAULT '',
  evidence_url TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',                -- pending|reviewed|actioned|dismissed
  handled_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  handled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_social_reports_status ON social_reports (status, created_at);

-- ---------- Publications ----------
CREATE TABLE IF NOT EXISTS social_posts (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'malilink',
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT DEFAULT '',
  media JSONB DEFAULT '[]'::jsonb,                       -- [{type:"image",url:"..."}]
  audience TEXT NOT NULL DEFAULT 'public',               -- public|friends|followers|me
  linked_type TEXT DEFAULT '',                           -- product|shop|company|service|...
  linked_id INTEGER,
  likes_count INTEGER NOT NULL DEFAULT 0,
  comments_count INTEGER NOT NULL DEFAULT 0,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_social_posts_user ON social_posts (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_posts_feed ON social_posts (tenant_id, audience, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS social_post_likes (
  id SERIAL PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (post_id, user_id)
);

CREATE TABLE IF NOT EXISTS social_comments (
  id SERIAL PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES social_comments(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_social_comments_post ON social_comments (post_id, created_at);

CREATE TABLE IF NOT EXISTS social_saved_posts (
  id SERIAL PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (post_id, user_id)
);

-- ---------- Feature flags (fonctions sensibles désactivables) ----------
CREATE TABLE IF NOT EXISTS social_feature_flags (
  flag_key TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO social_feature_flags (flag_key, enabled) VALUES
  ('social_enabled', true),
  ('social_posts_enabled', true),
  ('social_messages_enabled', false),
  ('social_calls_enabled', false),
  ('social_video_calls_enabled', false),
  ('social_stories_enabled', false),
  ('social_dating_enabled', true),
  ('social_random_video_enabled', false),
  ('social_ai_enabled', false)
ON CONFLICT (flag_key) DO NOTHING;
