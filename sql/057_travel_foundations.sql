-- 057 — MaliLink Voyage (Travel) : fondations Lot 4A.
-- Idempotent, non destructif, entièrement préfixé `travel_` (n'affecte aucun
-- module existant). MaliLink est un AGRÉGATEUR : les compagnies partenaires
-- publient leurs trajets. Tout paiement passera par le moteur Wallet (Lot 4B) :
-- aucune de ces tables ne tient de solde.

-- ───────────────────────── Modes de transport ─────────────────────────
-- Extensible : actifs aujourd'hui, d'autres préparés (enabled=false).
CREATE TABLE IF NOT EXISTS travel_modes (
  code TEXT PRIMARY KEY,                    -- bus | car | minibus | taxi | private | plane | train | boat | moto | helico
  label TEXT NOT NULL,
  category TEXT NOT NULL,                   -- land | air | rail | water
  enabled BOOLEAN NOT NULL DEFAULT false,
  sort_order INTEGER NOT NULL DEFAULT 100
);
INSERT INTO travel_modes (code, label, category, enabled, sort_order) VALUES
  ('bus',     'Bus',                    'land', true,  10),
  ('car',     'Car',                    'land', true,  20),
  ('minibus', 'Minibus',                'land', true,  30),
  ('taxi',    'Taxi interurbain',       'land', true,  40),
  ('private', 'Véhicule privé partenaire','land',true, 50),
  ('plane',   'Avion',                  'air',  true,  60),
  ('train',   'Train',                  'rail', false, 70),  -- préparé
  ('boat',    'Bateau',                 'water',false, 80),  -- préparé
  ('moto',    'Moto-taxi',              'land', false, 90),  -- préparé
  ('helico',  'Hélicoptère',            'air',  false, 100)  -- préparé
ON CONFLICT (code) DO NOTHING;

-- ───────────────────────── Base des destinations ─────────────────────────
CREATE TABLE IF NOT EXISTS travel_countries (
  id SERIAL PRIMARY KEY,
  iso2 TEXT UNIQUE NOT NULL,                -- ML, SN, CI...
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS travel_cities (
  id SERIAL PRIMARY KEY,
  country_id INTEGER NOT NULL REFERENCES travel_countries(id) ON DELETE CASCADE,
  region TEXT DEFAULT '',                   -- région / district
  name TEXT NOT NULL,
  latitude NUMERIC(9,6),
  longitude NUMERIC(9,6),
  UNIQUE (country_id, name, region)
);
CREATE INDEX IF NOT EXISTS idx_travel_cities_name ON travel_cities (lower(name));

-- Points d'embarquement : gares routières, aéroports, arrêts, embarcadères.
-- Un partenaire peut créer ses propres points (created_by_company).
CREATE TABLE IF NOT EXISTS travel_points (
  id SERIAL PRIMARY KEY,
  city_id INTEGER NOT NULL REFERENCES travel_cities(id) ON DELETE CASCADE,
  point_type TEXT NOT NULL DEFAULT 'gare_routiere', -- gare_routiere | aeroport | arret | embarcadere
  name TEXT NOT NULL,
  address TEXT DEFAULT '',
  latitude NUMERIC(9,6),
  longitude NUMERIC(9,6),
  created_by_company INTEGER,               -- travel_companies.id (NULL = officiel)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_travel_points_city ON travel_points (city_id, point_type);

-- ───────────────────────── Partenaires ─────────────────────────
-- Une compagnie de transport. Reliée éventuellement à une `companies`
-- existante (espace entreprise MaliLink) pour réutiliser wallet/compta.
CREATE TABLE IF NOT EXISTS travel_companies (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'malilink',
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  slug TEXT UNIQUE,
  logo_url TEXT DEFAULT '',
  description TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  rating NUMERIC(3,2) NOT NULL DEFAULT 0,        -- moyenne des avis
  rating_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',          -- active | suspended
  verified BOOLEAN NOT NULL DEFAULT false,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS travel_agencies (
  id SERIAL PRIMARY KEY,
  travel_company_id INTEGER NOT NULL REFERENCES travel_companies(id) ON DELETE CASCADE,
  city_id INTEGER REFERENCES travel_cities(id) ON DELETE SET NULL,
  point_id INTEGER REFERENCES travel_points(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  address TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_travel_agencies_company ON travel_agencies (travel_company_id);

-- Employés d'une compagnie (contrôleurs, agents) — rattachés à un user.
CREATE TABLE IF NOT EXISTS travel_company_staff (
  id SERIAL PRIMARY KEY,
  travel_company_id INTEGER NOT NULL REFERENCES travel_companies(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'agent',            -- agent | controleur | manager
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (travel_company_id, user_id)
);

-- ───────────────────────── Véhicules ─────────────────────────
CREATE TABLE IF NOT EXISTS travel_vehicles (
  id SERIAL PRIMARY KEY,
  travel_company_id INTEGER NOT NULL REFERENCES travel_companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  registration TEXT DEFAULT '',
  mode_code TEXT NOT NULL REFERENCES travel_modes(code),
  capacity INTEGER NOT NULL DEFAULT 0,
  photos JSONB NOT NULL DEFAULT '[]',
  has_ac BOOLEAN NOT NULL DEFAULT false,
  has_wifi BOOLEAN NOT NULL DEFAULT false,
  has_usb BOOLEAN NOT NULL DEFAULT false,
  has_tv BOOLEAN NOT NULL DEFAULT false,
  has_toilet BOOLEAN NOT NULL DEFAULT false,
  state TEXT DEFAULT 'bon',                       -- bon | moyen | maintenance
  status TEXT NOT NULL DEFAULT 'active',          -- active | inactive
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_travel_vehicles_company ON travel_vehicles (travel_company_id);

-- Plan de sièges (numérotation + classe) — support du choix de siège.
CREATE TABLE IF NOT EXISTS travel_vehicle_seats (
  id SERIAL PRIMARY KEY,
  vehicle_id INTEGER NOT NULL REFERENCES travel_vehicles(id) ON DELETE CASCADE,
  seat_number TEXT NOT NULL,
  seat_class TEXT NOT NULL DEFAULT 'standard',    -- standard | vip | business | economy
  position TEXT DEFAULT '',                        -- ex "1A"
  UNIQUE (vehicle_id, seat_number)
);

-- ───────────────────────── Lignes & horaires ─────────────────────────
CREATE TABLE IF NOT EXISTS travel_routes (
  id SERIAL PRIMARY KEY,
  travel_company_id INTEGER NOT NULL REFERENCES travel_companies(id) ON DELETE CASCADE,
  mode_code TEXT NOT NULL REFERENCES travel_modes(code),
  origin_city_id INTEGER NOT NULL REFERENCES travel_cities(id),
  destination_city_id INTEGER NOT NULL REFERENCES travel_cities(id),
  origin_point_id INTEGER REFERENCES travel_points(id) ON DELETE SET NULL,
  destination_point_id INTEGER REFERENCES travel_points(id) ON DELETE SET NULL,
  distance_km NUMERIC(8,1),
  duration_minutes INTEGER,
  baggage_policy TEXT DEFAULT '',
  services JSONB NOT NULL DEFAULT '[]',           -- ["clim","wifi","repas"]
  status TEXT NOT NULL DEFAULT 'active',          -- active | inactive
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_travel_routes_search
  ON travel_routes (origin_city_id, destination_city_id, status);
CREATE INDEX IF NOT EXISTS idx_travel_routes_company ON travel_routes (travel_company_id);

CREATE TABLE IF NOT EXISTS travel_route_stops (
  id SERIAL PRIMARY KEY,
  route_id INTEGER NOT NULL REFERENCES travel_routes(id) ON DELETE CASCADE,
  city_id INTEGER REFERENCES travel_cities(id) ON DELETE SET NULL,
  point_id INTEGER REFERENCES travel_points(id) ON DELETE SET NULL,
  stop_order INTEGER NOT NULL DEFAULT 0,
  arrival_offset_min INTEGER DEFAULT 0            -- minutes après le départ
);
CREATE INDEX IF NOT EXISTS idx_travel_route_stops_route ON travel_route_stops (route_id, stop_order);

CREATE TABLE IF NOT EXISTS travel_schedules (
  id SERIAL PRIMARY KEY,
  route_id INTEGER NOT NULL REFERENCES travel_routes(id) ON DELETE CASCADE,
  vehicle_id INTEGER REFERENCES travel_vehicles(id) ON DELETE SET NULL,
  departure_time TIME NOT NULL,
  arrival_time TIME,
  days_of_week INTEGER[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}', -- 0=dim … 6=sam
  valid_from DATE,
  valid_to DATE,
  seats_total INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_travel_schedules_route ON travel_schedules (route_id, status);

CREATE TABLE IF NOT EXISTS travel_prices (
  id SERIAL PRIMARY KEY,
  route_id INTEGER NOT NULL REFERENCES travel_routes(id) ON DELETE CASCADE,
  schedule_id INTEGER REFERENCES travel_schedules(id) ON DELETE CASCADE,
  seat_class TEXT NOT NULL DEFAULT 'standard',
  base_price NUMERIC(12,2) NOT NULL,
  child_price NUMERIC(12,2),
  currency TEXT NOT NULL DEFAULT 'XOF',
  baggage_included_kg INTEGER DEFAULT 0,
  extra_baggage_price NUMERIC(10,2) DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_travel_prices_route ON travel_prices (route_id, seat_class);

CREATE TABLE IF NOT EXISTS travel_promotions (
  id SERIAL PRIMARY KEY,
  travel_company_id INTEGER NOT NULL REFERENCES travel_companies(id) ON DELETE CASCADE,
  route_id INTEGER REFERENCES travel_routes(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  discount_type TEXT NOT NULL DEFAULT 'percent',  -- percent | amount
  discount_value NUMERIC(12,2) NOT NULL,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ───────────────────────── Réservations & billets ─────────────────────────
-- (Schéma créé en 4A ; endpoints de réservation/paiement au Lot 4B.)
CREATE TABLE IF NOT EXISTS travel_bookings (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'malilink',
  reference TEXT UNIQUE NOT NULL,                 -- MLV-...
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  travel_company_id INTEGER REFERENCES travel_companies(id) ON DELETE SET NULL,
  route_id INTEGER REFERENCES travel_routes(id) ON DELETE SET NULL,
  schedule_id INTEGER REFERENCES travel_schedules(id) ON DELETE SET NULL,
  travel_date DATE NOT NULL,
  seat_class TEXT DEFAULT 'standard',
  seats_count INTEGER NOT NULL DEFAULT 1,
  adults INTEGER NOT NULL DEFAULT 1,
  children INTEGER NOT NULL DEFAULT 0,
  subtotal NUMERIC(14,2) NOT NULL DEFAULT 0,
  discount NUMERIC(14,2) NOT NULL DEFAULT 0,
  taxes NUMERIC(14,2) NOT NULL DEFAULT 0,
  commission NUMERIC(14,2) NOT NULL DEFAULT 0,
  total NUMERIC(14,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'XOF',
  coupon_id INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',         -- pending | confirmed | cancelled | completed
  payment_status TEXT NOT NULL DEFAULT 'pending', -- pending | paid | refunded | failed
  payment_method TEXT DEFAULT '',
  financial_operation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_travel_bookings_user ON travel_bookings (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_travel_bookings_finop ON travel_bookings (financial_operation_id);

CREATE TABLE IF NOT EXISTS travel_booking_passengers (
  id SERIAL PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES travel_bookings(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  id_document TEXT DEFAULT '',
  seat_number TEXT DEFAULT '',
  passenger_type TEXT NOT NULL DEFAULT 'adult'    -- adult | child
);
CREATE INDEX IF NOT EXISTS idx_travel_passengers_booking ON travel_booking_passengers (booking_id);

CREATE TABLE IF NOT EXISTS travel_tickets (
  id SERIAL PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES travel_bookings(id) ON DELETE CASCADE,
  passenger_id INTEGER REFERENCES travel_booking_passengers(id) ON DELETE SET NULL,
  ticket_number TEXT UNIQUE NOT NULL,            -- MLV-TKT-...
  qr_payload TEXT NOT NULL,
  barcode TEXT DEFAULT '',
  seat_number TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'issued',          -- issued | used | cancelled | refunded
  signature TEXT NOT NULL,                        -- HMAC (authenticité)
  financial_operation_id TEXT,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_travel_tickets_booking ON travel_tickets (booking_id);

CREATE TABLE IF NOT EXISTS travel_scans (
  id SERIAL PRIMARY KEY,
  ticket_id INTEGER REFERENCES travel_tickets(id) ON DELETE SET NULL,
  scanned_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  agency_id INTEGER REFERENCES travel_agencies(id) ON DELETE SET NULL,
  result TEXT NOT NULL,                           -- valid | invalid | already_used | expired
  status_set TEXT DEFAULT '',                     -- embarque | absent | annule | termine
  device TEXT DEFAULT '',
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_travel_scans_ticket ON travel_scans (ticket_id);

-- ───────────────────────── Avis, paiements, remboursements ─────────────────
CREATE TABLE IF NOT EXISTS travel_reviews (
  id SERIAL PRIMARY KEY,
  travel_company_id INTEGER NOT NULL REFERENCES travel_companies(id) ON DELETE CASCADE,
  route_id INTEGER REFERENCES travel_routes(id) ON DELETE SET NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  booking_id INTEGER REFERENCES travel_bookings(id) ON DELETE SET NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  punctuality INTEGER CHECK (punctuality BETWEEN 1 AND 5),
  comfort INTEGER CHECK (comfort BETWEEN 1 AND 5),
  comment TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_travel_reviews_company ON travel_reviews (travel_company_id);

-- Journal des paiements (méthodes/tentatives). Le GRAND LIVRE Wallet reste la
-- source de vérité ; cette table trace les tentatives et connecteurs.
CREATE TABLE IF NOT EXISTS travel_payments (
  id SERIAL PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES travel_bookings(id) ON DELETE CASCADE,
  method TEXT NOT NULL,                           -- wallet | orange_money | wave | card | bank | partner
  amount NUMERIC(14,2) NOT NULL,
  currency TEXT NOT NULL DEFAULT 'XOF',
  status TEXT NOT NULL DEFAULT 'pending',         -- pending | completed | failed
  financial_operation_id TEXT,
  provider_ref TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_travel_payments_booking ON travel_payments (booking_id);

CREATE TABLE IF NOT EXISTS travel_refunds (
  id SERIAL PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES travel_bookings(id) ON DELETE CASCADE,
  ticket_id INTEGER REFERENCES travel_tickets(id) ON DELETE SET NULL,
  amount NUMERIC(14,2) NOT NULL,
  reason TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',         -- pending | processed | rejected
  financial_operation_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS travel_coupons (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  travel_company_id INTEGER REFERENCES travel_companies(id) ON DELETE CASCADE,
  discount_type TEXT NOT NULL DEFAULT 'percent',  -- percent | amount
  discount_value NUMERIC(12,2) NOT NULL,
  max_uses INTEGER,
  used_count INTEGER NOT NULL DEFAULT 0,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Journal d'audit Travel + notifications Travel (miroir du moteur Wallet).
CREATE TABLE IF NOT EXISTS travel_logs (
  id SERIAL PRIMARY KEY,
  entity_type TEXT NOT NULL,                      -- booking | ticket | route | company...
  entity_id INTEGER,
  action TEXT NOT NULL,
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  details TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_travel_logs_entity ON travel_logs (entity_type, entity_id);

CREATE TABLE IF NOT EXISTS travel_notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  booking_id INTEGER REFERENCES travel_bookings(id) ON DELETE SET NULL,
  event TEXT NOT NULL,                            -- booking_confirmed | departure_reminder | delay | cancellation
  channel TEXT NOT NULL,                          -- in_app | email | sms | push
  status TEXT NOT NULL DEFAULT 'queued',
  title TEXT DEFAULT '',
  message TEXT DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);

-- ───────────────────────── Réglages & flags ─────────────────────────
CREATE TABLE IF NOT EXISTS travel_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO travel_settings (key, value) VALUES
  ('commission_rate', '0.08'),                   -- 8 % commission MaliLink par défaut
  ('tax_rate', '0')                              -- taxes désactivées par défaut
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS travel_feature_flags (
  flag_key TEXT PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO travel_feature_flags (flag_key, enabled) VALUES
  ('travel_enabled', true),                      -- module actif
  ('travel_search_enabled', true),               -- recherche publique
  ('travel_bookings_enabled', false),            -- réservation : ouverte au Lot 4B
  ('travel_payments_enabled', false)             -- paiement : ouvert au Lot 4B
ON CONFLICT (flag_key) DO NOTHING;

-- ───────────────────────── Amorçage destinations Mali ─────────────────────
INSERT INTO travel_countries (iso2, name) VALUES ('ML', 'Mali')
ON CONFLICT (iso2) DO NOTHING;

INSERT INTO travel_cities (country_id, region, name)
SELECT c.id, v.region, v.name
FROM travel_countries c,
  (VALUES
    ('District de Bamako', 'Bamako'),
    ('Koulikoro', 'Koulikoro'),
    ('Sikasso', 'Sikasso'),
    ('Ségou', 'Ségou'),
    ('Mopti', 'Mopti'),
    ('Kayes', 'Kayes'),
    ('Gao', 'Gao'),
    ('Tombouctou', 'Tombouctou'),
    ('Kidal', 'Kidal'),
    ('Ménaka', 'Ménaka')
  ) AS v(region, name)
WHERE c.iso2='ML'
ON CONFLICT (country_id, name, region) DO NOTHING;
