-- ============================================================
-- 044 — Module Livreurs / Coursiers / Taxis (MaliLink Global)
-- Additif : ne modifie aucune table existante.
-- ============================================================

-- Profils livreurs / chauffeurs
CREATE TABLE IF NOT EXISTS delivery_drivers (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'malilink',
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  driver_type TEXT NOT NULL DEFAULT 'livreur'
    CHECK (driver_type IN ('livreur', 'coursier', 'taxi', 'transporteur')),
  vehicle_type TEXT DEFAULT 'moto',
  vehicle_plate TEXT,
  license_number TEXT,
  id_document_url TEXT,
  vehicle_document_url TEXT,
  photo_url TEXT,
  phone TEXT,
  is_available BOOLEAN NOT NULL DEFAULT false,
  is_verified BOOLEAN NOT NULL DEFAULT false,
  current_lat DOUBLE PRECISION,
  current_lng DOUBLE PRECISION,
  last_position_at TIMESTAMPTZ,
  rating_avg NUMERIC(3,2) NOT NULL DEFAULT 0,
  rating_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'banned')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_delivery_drivers_available
  ON delivery_drivers (tenant_id, is_available, driver_type);

-- Missions (livraison B2C/B2B/C2C, course coursier, course taxi)
CREATE TABLE IF NOT EXISTS delivery_missions (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'malilink',
  mission_type TEXT NOT NULL DEFAULT 'livraison'
    CHECK (mission_type IN ('livraison', 'coursier', 'taxi')),
  status TEXT NOT NULL DEFAULT 'en_attente'
    CHECK (status IN ('en_attente', 'acceptee', 'recuperee', 'en_route',
                      'livree', 'terminee', 'annulee')),
  client_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  marketplace_order_id INTEGER REFERENCES marketplace_orders(id) ON DELETE SET NULL,
  driver_id INTEGER REFERENCES delivery_drivers(id) ON DELETE SET NULL,
  pickup_address TEXT NOT NULL,
  pickup_lat DOUBLE PRECISION,
  pickup_lng DOUBLE PRECISION,
  dropoff_address TEXT NOT NULL,
  dropoff_lat DOUBLE PRECISION,
  dropoff_lng DOUBLE PRECISION,
  distance_km NUMERIC(8,2),
  price_estimate NUMERIC(12,2),
  price_final NUMERIC(12,2),
  commission_amount NUMERIC(12,2),
  payment_method TEXT DEFAULT 'especes'
    CHECK (payment_method IN ('especes', 'orange_money', 'wave', 'moov_money', 'carte', 'wallet')),
  payment_status TEXT NOT NULL DEFAULT 'en_attente'
    CHECK (payment_status IN ('en_attente', 'paye', 'rembourse')),
  package_description TEXT,
  recipient_name TEXT,
  recipient_phone TEXT,
  notes TEXT,
  cancelled_reason TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at TIMESTAMPTZ,
  picked_up_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_delivery_missions_status
  ON delivery_missions (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_delivery_missions_driver
  ON delivery_missions (driver_id, status);
CREATE INDEX IF NOT EXISTS idx_delivery_missions_client
  ON delivery_missions (client_user_id);

-- Historique de suivi GPS / événements de mission
CREATE TABLE IF NOT EXISTS delivery_mission_events (
  id SERIAL PRIMARY KEY,
  mission_id INTEGER NOT NULL REFERENCES delivery_missions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  details TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_delivery_events_mission
  ON delivery_mission_events (mission_id, created_at);

-- Notes / avis sur les livreurs
CREATE TABLE IF NOT EXISTS delivery_ratings (
  id SERIAL PRIMARY KEY,
  mission_id INTEGER NOT NULL REFERENCES delivery_missions(id) ON DELETE CASCADE,
  driver_id INTEGER NOT NULL REFERENCES delivery_drivers(id) ON DELETE CASCADE,
  client_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (mission_id)
);

-- Tarification par tenant et type de mission
CREATE TABLE IF NOT EXISTS delivery_pricing_settings (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'malilink',
  mission_type TEXT NOT NULL DEFAULT 'livraison'
    CHECK (mission_type IN ('livraison', 'coursier', 'taxi')),
  base_fee NUMERIC(12,2) NOT NULL DEFAULT 500,
  per_km_fee NUMERIC(12,2) NOT NULL DEFAULT 200,
  minimum_price NUMERIC(12,2) NOT NULL DEFAULT 500,
  commission_percent NUMERIC(5,2) NOT NULL DEFAULT 15,
  currency TEXT NOT NULL DEFAULT 'XOF',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, mission_type)
);

INSERT INTO delivery_pricing_settings (tenant_id, mission_type, base_fee, per_km_fee, minimum_price, commission_percent)
VALUES
  ('malilink', 'livraison', 500, 200, 500, 15),
  ('malilink', 'coursier', 700, 250, 700, 15),
  ('malilink', 'taxi', 1000, 300, 1000, 15)
ON CONFLICT (tenant_id, mission_type) DO NOTHING;
