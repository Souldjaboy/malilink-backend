-- 072 — SOCLE SEO PUBLIC : profil public d'entreprise + slug produit
--
-- Strictement additif et idempotent. Aucune colonne supprimée, aucune valeur
-- réécrite, aucun défaut qui rendrait public ce qui ne l'est pas aujourd'hui.
--
-- Pourquoi une table séparée plutôt que des colonnes sur « companies » :
-- « companies » porte le compte client (plan, abonnement, vérification). Ce
-- qu'une entreprise accepte de montrer à internet est une autre décision, qui
-- se révoque d'un seul champ. Les garder distincts évite qu'une donnée
-- administrative devienne publique par accident.

BEGIN;

CREATE TABLE IF NOT EXISTS company_public_profile (
  company_id      integer PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  slug            text,
  description     text,

  -- Localisation. Tout est facultatif : le JSON-LD n'émettra que ce qui est
  -- réellement renseigné. Aucune valeur n'est devinée.
  country         text,
  region          text,
  city            text,
  quartier        text,
  address_line    text,
  latitude        numeric(9,6),
  longitude       numeric(9,6),

  -- Contact public, distinct du contact administratif de « companies ».
  public_phone    text,
  public_email    text,
  website         text,
  logo_url        text,
  opening_hours   jsonb,

  -- Rien n'est publié tant que l'entreprise ne l'a pas demandé.
  is_public       boolean NOT NULL DEFAULT false,
  show_email      boolean NOT NULL DEFAULT false,
  show_phone      boolean NOT NULL DEFAULT false,

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Un slug ne vaut que s'il est unique ; les lignes sans slug ne s'opposent pas
-- entre elles.
CREATE UNIQUE INDEX IF NOT EXISTS company_public_profile_slug_key
  ON company_public_profile (lower(slug)) WHERE slug IS NOT NULL AND slug <> '';

CREATE INDEX IF NOT EXISTS company_public_profile_public_idx
  ON company_public_profile (is_public) WHERE is_public;

-- Slug produit. L'identifiant numérique reste la source de vérité et le seul
-- critère de lecture : le slug est un libellé d'URL, jamais un secret ni un
-- contrôle d'accès.
ALTER TABLE marketplace_products ADD COLUMN IF NOT EXISTS slug text;

CREATE INDEX IF NOT EXISTS marketplace_products_slug_idx
  ON marketplace_products (slug) WHERE slug IS NOT NULL AND slug <> '';

COMMIT;
