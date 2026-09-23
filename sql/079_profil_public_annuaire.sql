-- 079 — Profil public MaliLink : réseaux, services, produits, annuaire.
--
-- Additive et idempotente. Rien ne devient public : « is_public » reste à
-- FALSE par défaut (072) et chaque nouvel affichage est un choix explicite de
-- l'entreprise. Aucune valeur existante n'est réécrite.
--
--   social_links         liens https vers les pages OFFICIELLES de l'entreprise
--   services             services proposés, saisis par l'entreprise
--   show_products        la page publique liste les produits publiés (opt-in)
--   listed_in_directory  un profil public peut rester hors de l'annuaire
--                        /entreprises (lien partageable uniquement)

BEGIN;

ALTER TABLE company_public_profile ADD COLUMN IF NOT EXISTS social_links JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE company_public_profile ADD COLUMN IF NOT EXISTS services JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE company_public_profile ADD COLUMN IF NOT EXISTS show_products BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE company_public_profile ADD COLUMN IF NOT EXISTS listed_in_directory BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE company_public_profile ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;
ALTER TABLE company_public_profile ADD COLUMN IF NOT EXISTS updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_public_profile_social_objet') THEN
    ALTER TABLE company_public_profile ADD CONSTRAINT company_public_profile_social_objet
      CHECK (jsonb_typeof(social_links) = 'object');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'company_public_profile_services_liste') THEN
    ALTER TABLE company_public_profile ADD CONSTRAINT company_public_profile_services_liste
      CHECK (jsonb_typeof(services) = 'array');
  END IF;
END $$;

COMMENT ON COLUMN company_public_profile.is_public IS
  'Opt-in explicite de l''entreprise. FALSE : ni page /boutique, ni annuaire, ni sitemap, et aucune donnée du profil ne sort sur les fiches produit.';
COMMENT ON COLUMN company_public_profile.listed_in_directory IS
  'Sans effet tant que is_public est FALSE. Un profil public peut rester hors de l''annuaire /entreprises.';

CREATE INDEX IF NOT EXISTS company_public_profile_annuaire_idx
  ON company_public_profile (lower(city)) WHERE is_public AND listed_in_directory;

COMMIT;
