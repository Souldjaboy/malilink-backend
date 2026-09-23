-- 078 — Marketing & Réseaux sociaux : campagnes, publication tracée, plateformes.
--
-- Additive et idempotente.
--
-- Aucune API officielle (Meta, Google, TikTok, LinkedIn, X, Snapchat) n'est
-- connectée : rien n'est publié ni lancé automatiquement. Ce module prépare,
-- planifie et TRACE. Quand un utilisateur publie à la main sur le réseau, ou
-- lance une campagne sur la plateforme officielle (et y paie), il l'enregistre
-- ici — explicitement marqué « manuel », avec le lien qui le prouve.
-- MaliLink ne prétend jamais avoir publié ou lancé ce qu'il n'a pas fait, et
-- ne contourne aucun système de paiement publicitaire.

BEGIN;

-- ── Plateformes des comptes ─────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'smm_accounts_network_valide') THEN
    ALTER TABLE smm_accounts ADD CONSTRAINT smm_accounts_network_valide
      CHECK (network IN ('facebook', 'instagram', 'tiktok', 'whatsapp', 'linkedin', 'x', 'snapchat', 'google_business'));
  END IF;
EXCEPTION WHEN check_violation THEN
  RAISE WARNING '078 : des comptes portent un réseau inconnu — contrainte non posée, à revoir.';
END $$;

-- ── Heures programmées : avec fuseau ────────────────────────────────
-- En TIMESTAMP sans fuseau, PostgreSQL ignorait le « Z » de l'heure envoyée
-- par le navigateur et Node la relisait comme une heure locale : 09:30
-- programmé s'affichait 07:30 dès que serveur et navigateur n'étaient pas
-- sur le même fuseau. Les valeurs existantes sont lues comme de l'UTC.
-- Conversion faite UNIQUEMENT si la colonne est encore sans fuseau : sur une
-- colonne déjà en TIMESTAMPTZ, « AT TIME ZONE 'UTC' » la décalerait du
-- fuseau de la session à chaque rejeu.
DO $$
DECLARE
  col TEXT;
BEGIN
  FOREACH col IN ARRAY ARRAY['scheduled_for', 'published_at'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name = 'smm_posts' AND column_name = col
                  AND data_type = 'timestamp without time zone') THEN
      EXECUTE format('ALTER TABLE smm_posts ALTER COLUMN %I TYPE TIMESTAMPTZ USING %I AT TIME ZONE ''UTC''', col, col);
    END IF;
  END LOOP;
END $$;

-- ── Publications : publication manuelle tracée ──────────────────────
ALTER TABLE smm_posts ADD COLUMN IF NOT EXISTS published_url TEXT NOT NULL DEFAULT '';
ALTER TABLE smm_posts ADD COLUMN IF NOT EXISTS published_manually BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE smm_posts ADD COLUMN IF NOT EXISTS published_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

COMMENT ON COLUMN smm_posts.published_manually IS
  'TRUE : publiée à la main sur le réseau par un utilisateur autorisé, puis déclarée ici avec son lien. Aucune publication automatique sans connecteur officiel.';

-- ── Campagnes publicitaires ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS smm_campaigns (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name VARCHAR(180) NOT NULL,
  platform VARCHAR(30) NOT NULL,
  objective VARCHAR(30) NOT NULL DEFAULT 'notoriete',
  post_id INTEGER REFERENCES smm_posts(id) ON DELETE SET NULL,
  content TEXT NOT NULL DEFAULT '',
  audience TEXT NOT NULL DEFAULT '',
  zone TEXT NOT NULL DEFAULT '',
  budget_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency VARCHAR(10) NOT NULL DEFAULT 'FCFA',
  start_date DATE,
  end_date DATE,
  destination_url TEXT NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'brouillon',
  external_ref TEXT NOT NULL DEFAULT '',
  status_note TEXT NOT NULL DEFAULT '',
  declared_manually BOOLEAN NOT NULL DEFAULT FALSE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT smm_campaigns_platform_valide CHECK (platform IN ('meta_ads', 'google_ads', 'tiktok_ads', 'linkedin_ads', 'snapchat_ads')),
  CONSTRAINT smm_campaigns_objectif_valide CHECK (objective IN ('notoriete', 'trafic', 'engagement', 'prospects', 'ventes', 'messages')),
  CONSTRAINT smm_campaigns_statut_valide CHECK (status IN ('brouillon', 'pret', 'en_attente', 'actif', 'termine', 'erreur')),
  CONSTRAINT smm_campaigns_budget_positif CHECK (budget_total >= 0),
  CONSTRAINT smm_campaigns_dates CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);

COMMENT ON COLUMN smm_campaigns.status IS
  'brouillon → pret (complète) → en_attente (lancée sur la plateforme officielle) → actif / termine / erreur. Sans API connectée, chaque étape au-delà de « prêt » est une déclaration manuelle (declared_manually).';
COMMENT ON COLUMN smm_campaigns.external_ref IS
  'Référence ou lien de la campagne sur la plateforme officielle, fourni par l''utilisateur qui l''y a créée et payée.';

CREATE INDEX IF NOT EXISTS idx_smm_campaigns_company ON smm_campaigns (company_id, status);
CREATE INDEX IF NOT EXISTS idx_smm_media_post ON smm_media (company_id, post_id);

COMMIT;
