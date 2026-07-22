-- 059 — Référentiel MONDIAL des lieux (Lot 1, correctif création de lignes).
-- Idempotent, non destructif. Corrige le bug : le formulaire Ligne n'acceptait
-- que 10 villes du Mali seedées dans travel_cities. On introduit un référentiel
-- géographique mondial générique (tous pays, toutes villes) alimenté par
-- géocodage (Nominatim par défaut) et réutilisable par tous les modules.

CREATE TABLE IF NOT EXISTS geo_locations (
  id SERIAL PRIMARY KEY,
  public_id TEXT UNIQUE NOT NULL,            -- id public stable (GEO-xxxx)
  name TEXT NOT NULL,                        -- libellé affiché
  normalized_name TEXT NOT NULL,             -- minuscules sans accents (recherche/dédup)
  country_code TEXT DEFAULT '',              -- ISO2 (ML, FR, GH…)
  country_name TEXT DEFAULT '',
  region TEXT DEFAULT '',
  city TEXT DEFAULT '',
  postal_code TEXT DEFAULT '',
  latitude NUMERIC(9,6),
  longitude NUMERIC(9,6),
  timezone TEXT DEFAULT '',
  location_type TEXT NOT NULL DEFAULT 'city',-- country|city|airport|train_station|bus_station|port|hotel|address|pickup_point|dropoff_point
  external_provider TEXT DEFAULT '',         -- nominatim|google|mapbox|manual
  external_place_id TEXT DEFAULT '',         -- id chez le fournisseur (dédup)
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_geo_search ON geo_locations (normalized_name text_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_geo_country ON geo_locations (country_code, location_type);
-- Anti-doublon : un même lieu fournisseur n'est stocké qu'une fois.
CREATE UNIQUE INDEX IF NOT EXISTS uq_geo_external
  ON geo_locations (external_provider, external_place_id)
  WHERE external_place_id <> '';
-- Anti-doublon local (nom normalisé + pays + type).
CREATE UNIQUE INDEX IF NOT EXISTS uq_geo_local
  ON geo_locations (normalized_name, country_code, location_type);

-- travel_routes : références vers geo_locations (le référentiel mondial devient
-- la source des lieux). On garde les anciennes colonnes ville (compat) mais on
-- lève leur contrainte NOT NULL.
ALTER TABLE travel_routes ADD COLUMN IF NOT EXISTS origin_location_id INTEGER REFERENCES geo_locations(id) ON DELETE SET NULL;
ALTER TABLE travel_routes ADD COLUMN IF NOT EXISTS destination_location_id INTEGER REFERENCES geo_locations(id) ON DELETE SET NULL;
ALTER TABLE travel_routes ALTER COLUMN origin_city_id DROP NOT NULL;
ALTER TABLE travel_routes ALTER COLUMN destination_city_id DROP NOT NULL;
ALTER TABLE travel_routes ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
ALTER TABLE travel_routes ADD COLUMN IF NOT EXISTS cancellation_policy TEXT NOT NULL DEFAULT '';
ALTER TABLE travel_routes ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'XOF';
CREATE INDEX IF NOT EXISTS idx_travel_routes_geo
  ON travel_routes (origin_location_id, destination_location_id, status);

-- Amorçage : villes du Mali (reprises de travel_cities) + grandes villes
-- internationales, avec coordonnées, afin que le référentiel fonctionne même
-- sans appel réseau (Nominatim enrichit ensuite à la demande).
INSERT INTO geo_locations (public_id, name, normalized_name, country_code, country_name, region, city, latitude, longitude, location_type, external_provider)
VALUES
  ('GEO-ML-BKO', 'Bamako',     'bamako',     'ML', 'Mali',          'District de Bamako', 'Bamako',     12.6392, -8.0029, 'city', 'seed'),
  ('GEO-ML-KYS', 'Kayes',      'kayes',      'ML', 'Mali',          'Kayes',      'Kayes',      14.4469, -11.4456, 'city', 'seed'),
  ('GEO-ML-SIK', 'Sikasso',    'sikasso',    'ML', 'Mali',          'Sikasso',    'Sikasso',    11.3176, -5.6665, 'city', 'seed'),
  ('GEO-ML-SEG', 'Ségou',      'segou',      'ML', 'Mali',          'Ségou',      'Ségou',      13.4317, -6.2158, 'city', 'seed'),
  ('GEO-ML-MOP', 'Mopti',      'mopti',      'ML', 'Mali',          'Mopti',      'Mopti',      14.4843, -4.1960, 'city', 'seed'),
  ('GEO-ML-GAO', 'Gao',        'gao',        'ML', 'Mali',          'Gao',        'Gao',        16.2716, -0.0446, 'city', 'seed'),
  ('GEO-ML-TOM', 'Tombouctou', 'tombouctou', 'ML', 'Mali',          'Tombouctou', 'Tombouctou', 16.7735, -3.0074, 'city', 'seed'),
  ('GEO-ML-KOU', 'Koulikoro',  'koulikoro',  'ML', 'Mali',          'Koulikoro',  'Koulikoro',  12.8629, -7.5599, 'city', 'seed'),
  ('GEO-ML-KID', 'Kidal',      'kidal',      'ML', 'Mali',          'Kidal',      'Kidal',      18.4411, 1.4078, 'city', 'seed'),
  ('GEO-ML-MEN', 'Ménaka',     'menaka',     'ML', 'Mali',          'Ménaka',     'Ménaka',     15.9182, 2.4022, 'city', 'seed'),
  ('GEO-FR-PAR', 'Paris',      'paris',      'FR', 'France',        'Île-de-France', 'Paris',   48.8566, 2.3522, 'city', 'seed'),
  ('GEO-GH-ACC', 'Accra',      'accra',      'GH', 'Ghana',         'Greater Accra', 'Accra',   5.6037, -0.1870, 'city', 'seed'),
  ('GEO-SN-DKR', 'Dakar',      'dakar',      'SN', 'Sénégal',       'Dakar',      'Dakar',      14.7167, -17.4677, 'city', 'seed'),
  ('GEO-CI-ABJ', 'Abidjan',    'abidjan',    'CI', 'Côte d''Ivoire','Abidjan',    'Abidjan',    5.3600, -4.0083, 'city', 'seed'),
  ('GEO-GN-CKY', 'Conakry',    'conakry',    'GN', 'Guinée',        'Conakry',    'Conakry',    9.6412, -13.5784, 'city', 'seed'),
  ('GEO-BF-OUA', 'Ouagadougou','ouagadougou','BF', 'Burkina Faso',  'Centre',     'Ouagadougou',12.3714, -1.5197, 'city', 'seed'),
  ('GEO-NE-NIA', 'Niamey',     'niamey',     'NE', 'Niger',         'Niamey',     'Niamey',     13.5127, 2.1126, 'city', 'seed'),
  ('GEO-FR-CDG', 'Aéroport de Paris-Charles-de-Gaulle', 'aeroport de paris charles de gaulle', 'FR', 'France', 'Île-de-France', 'Roissy', 49.0097, 2.5479, 'airport', 'seed'),
  ('GEO-ML-BKO-SENOU', 'Aéroport de Bamako-Sénou', 'aeroport de bamako senou', 'ML', 'Mali', 'District de Bamako', 'Bamako', 12.5335, -7.9499, 'airport', 'seed')
ON CONFLICT (normalized_name, country_code, location_type) DO NOTHING;
