-- 058 — Catalogue central MaliLink (Lot A).
-- Idempotent, non destructif, additif. Agrège les offres PUBLIÉES de tous les
-- modules (Voyage d'abord, puis hôtel/restaurant/etc.) pour les rendre visibles
-- dans Marketplace SANS dupliquer la donnée source : chaque ligne référence son
-- module d'origine (related_module + related_id). La donnée métier (prix,
-- disponibilité, réservation) reste la propriété du module source ; le catalogue
-- est la couche de publication/visibilité.

CREATE TABLE IF NOT EXISTS catalog_offers (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'malilink',

  -- Référence vers la source (anti-duplication)
  related_module TEXT NOT NULL,            -- travel | hotel | restaurant | marketplace | automobile | immobilier | laboratoire | service
  related_id INTEGER NOT NULL,             -- id dans la table source
  related_subtype TEXT NOT NULL DEFAULT '',-- ex: 'route', 'room', 'dish', 'vehicle'

  -- Propriétaire (entreprise partenaire)
  company_module TEXT NOT NULL DEFAULT '', -- 'travel_companies' | 'companies'
  company_id INTEGER,
  company_name TEXT NOT NULL DEFAULT '',

  -- Classement Marketplace
  category TEXT NOT NULL,                   -- voyage | hotel | restaurant | marketplace | automobile | immobilier | laboratoire | service | livraison
  subcategory TEXT NOT NULL DEFAULT '',     -- bus | plane | train | taxi | moto | boat | helico | hotel | rental | ...

  -- Affichage
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price NUMERIC(14,2),                      -- « à partir de » (indicatif) ; le prix ferme reste au module source
  currency TEXT NOT NULL DEFAULT 'XOF',
  availability INTEGER,                     -- places / stock disponibles (nullable)
  location TEXT NOT NULL DEFAULT '',
  photos JSONB NOT NULL DEFAULT '[]',

  -- Cycle de vie (§2)
  status TEXT NOT NULL DEFAULT 'draft',     -- draft | pending | published | suspended | archived

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  published_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Une offre source = une entrée catalogue au plus
  UNIQUE (related_module, related_id, related_subtype)
);

CREATE INDEX IF NOT EXISTS idx_catalog_browse
  ON catalog_offers (category, subcategory, status, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_catalog_company
  ON catalog_offers (company_module, company_id);
CREATE INDEX IF NOT EXISTS idx_catalog_status
  ON catalog_offers (status);

-- Arbre des catégories Marketplace (référentiel affichable). Amorçage §3.
CREATE TABLE IF NOT EXISTS catalog_categories (
  code TEXT PRIMARY KEY,
  parent_code TEXT,                         -- NULL = catégorie racine
  label TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 100,
  enabled BOOLEAN NOT NULL DEFAULT true
);

INSERT INTO catalog_categories (code, parent_code, label, emoji, sort_order) VALUES
  ('voyage',      NULL,     'Voyages et réservations', '🧳', 10),
  ('plane',       'voyage', 'Avion',                   '✈️', 11),
  ('bus',         'voyage', 'Bus',                     '🚌', 12),
  ('train',       'voyage', 'Train',                   '🚆', 13),
  ('taxi',        'voyage', 'Taxi',                    '🚖', 14),
  ('moto',        'voyage', 'Moto-taxi',               '🏍️', 15),
  ('boat',        'voyage', 'Bateau',                  '🚤', 16),
  ('helico',      'voyage', 'Hélicoptère',             '🚁', 17),
  ('hotel',       'voyage', 'Hôtel',                   '🏨', 18),
  ('rental',      'voyage', 'Location de voiture',     '🚗', 19),
  ('restaurant',  NULL,     'Restaurants',             '🍽️', 20),
  ('hotels',      NULL,     'Hôtels',                  '🏨', 30),
  ('immobilier',  NULL,     'Immobilier',              '🏠', 40),
  ('automobile',  NULL,     'Automobile',              '🚙', 50),
  ('laboratoire', NULL,     'Laboratoire',             '🔬', 60),
  ('service',     NULL,     'Services',                '🛠️', 70),
  ('livraison',   NULL,     'Livraison',               '📦', 80)
ON CONFLICT (code) DO NOTHING;
