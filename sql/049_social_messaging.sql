-- 049 — MaliLink Social : messagerie temps réel.
-- Idempotent. users.id reste l'identité centrale.
-- Tables préfixées social_ (les tables conversations/messages historiques
-- du chat interne entreprise restent intactes).

CREATE TABLE IF NOT EXISTS social_conversations (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'malilink',
  kind TEXT NOT NULL DEFAULT 'direct',            -- direct | group (groupes: phase suivante)
  title TEXT DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_social_conversations_last
  ON social_conversations (tenant_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS social_conversation_members (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES social_conversations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_message_id INTEGER,
  last_read_at TIMESTAMPTZ,
  muted BOOLEAN NOT NULL DEFAULT false,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_social_conv_members_user
  ON social_conversation_members (user_id);

CREATE TABLE IF NOT EXISTS social_messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES social_conversations(id) ON DELETE CASCADE,
  sender_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_type TEXT NOT NULL DEFAULT 'text',      -- text | image | video | document | voice
  content TEXT DEFAULT '',
  media_url TEXT DEFAULT '',
  reply_to_id INTEGER REFERENCES social_messages(id) ON DELETE SET NULL,
  deleted_at TIMESTAMPTZ,                          -- suppression pour tous (logique)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_social_messages_conv
  ON social_messages (conversation_id, id DESC);

CREATE TABLE IF NOT EXISTS social_user_presence (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- La messagerie sociale est maintenant livrée : flag activé.
UPDATE social_feature_flags SET enabled=true, updated_at=NOW()
WHERE flag_key='social_messages_enabled';
