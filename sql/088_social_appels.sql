-- 088 — MaliLink Social : appels audio et vidéo (LiveKit).
--
-- Additive. Le serveur garde la signalisation (sonnerie, accepter, refuser,
-- raccrocher) et l'historique ; le son et l'image passent par LiveKit, qui
-- n'est utilisé que si LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET
-- sont configurés ET que les drapeaux social_calls_enabled /
-- social_video_calls_enabled sont actifs. Sans cela, les messages restent
-- pleinement utilisables et aucun bouton d'appel n'apparaît.

BEGIN;

CREATE TABLE IF NOT EXISTS social_calls (
  id               BIGSERIAL PRIMARY KEY,
  public_id        TEXT NOT NULL UNIQUE,
  tenant_id        TEXT NOT NULL DEFAULT 'malilink',
  caller_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  callee_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('audio', 'video')),
  status           TEXT NOT NULL DEFAULT 'ringing'
                   CHECK (status IN ('ringing', 'accepted', 'refused', 'cancelled', 'missed', 'ended', 'failed')),
  room_name        TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at      TIMESTAMPTZ,
  ended_at         TIMESTAMPTZ,
  ended_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  end_reason       TEXT NOT NULL DEFAULT '',
  duration_seconds INTEGER NOT NULL DEFAULT 0,
  CHECK (caller_id <> callee_id)
);
CREATE INDEX IF NOT EXISTS idx_social_calls_caller ON social_calls (caller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_calls_callee ON social_calls (callee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_calls_actifs ON social_calls (status) WHERE status IN ('ringing', 'accepted');

COMMIT;
