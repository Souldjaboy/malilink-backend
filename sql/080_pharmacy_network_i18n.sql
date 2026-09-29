-- 080 — Pharmacie, Réseau & Infrastructure et préférence linguistique.
-- Migration additive, idempotente et non destructive.

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_language VARCHAR(10);

INSERT INTO modules (module_key, module_name, description, is_active)
VALUES
  ('pharmacie', 'Pharmacie', 'Médicaments, lots, FEFO, ordonnances, patients et stock pharmacie', TRUE),
  ('reseau', 'Réseau & Infrastructure', 'Équipements, adressage, incidents, maintenance et supervision réseau', TRUE)
ON CONFLICT (module_key) DO UPDATE SET
  module_name=EXCLUDED.module_name,
  description=EXCLUDED.description,
  is_active=TRUE,
  updated_at=CURRENT_TIMESTAMP;

-- Fermés par défaut pour toutes les sociétés déjà présentes. L'inscription
-- Pharmacie et le Super Admin peuvent ensuite les activer explicitement.
INSERT INTO company_modules (company_id, module_key, is_enabled, enabled, source)
SELECT id, key, FALSE, FALSE, 'migration'
FROM companies CROSS JOIN (VALUES ('pharmacie'), ('reseau')) AS m(key)
ON CONFLICT (company_id, module_key) DO NOTHING;

ALTER TABLE products ADD COLUMN IF NOT EXISTS product_kind VARCHAR(40);
ALTER TABLE products ADD COLUMN IF NOT EXISTS generic_name TEXT DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS active_ingredient TEXT DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS dosage TEXT DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS dosage_form TEXT DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS packaging TEXT DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS manufacturer TEXT DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS therapeutic_family TEXT DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS supplier_reference TEXT DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS prescription_required BOOLEAN DEFAULT FALSE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS sensitive_product BOOLEAN DEFAULT FALSE;
ALTER TABLE products ADD COLUMN IF NOT EXISTS storage_temperature TEXT DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS leaflet_url TEXT DEFAULT '';

ALTER TABLE product_batches ADD COLUMN IF NOT EXISTS manufacturing_date DATE;
ALTER TABLE product_batches ADD COLUMN IF NOT EXISTS pharmacy_site_id INTEGER;
ALTER TABLE product_batches ADD COLUMN IF NOT EXISTS quarantine_reason TEXT DEFAULT '';
ALTER TABLE product_batches ADD COLUMN IF NOT EXISTS disposition VARCHAR(40) DEFAULT '';

CREATE TABLE IF NOT EXISTS pharmacy_settings (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tenant_id INTEGER,
  expiry_thresholds JSONB NOT NULL DEFAULT '[180,90,60,30,15]'::jsonb,
  allow_credit BOOLEAN DEFAULT FALSE,
  allow_expired_sale BOOLEAN DEFAULT FALSE,
  safety_provider VARCHAR(120) DEFAULT '',
  safety_integration_enabled BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company_id)
);

CREATE TABLE IF NOT EXISTS pharmacy_sites (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tenant_id INTEGER,
  warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE SET NULL,
  code VARCHAR(80) NOT NULL,
  name VARCHAR(255) NOT NULL,
  site_type VARCHAR(40) DEFAULT 'pharmacy',
  address TEXT DEFAULT '',
  phone VARCHAR(100) DEFAULT '',
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company_id, code)
);

CREATE TABLE IF NOT EXISTS pharmacy_patients (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tenant_id INTEGER,
  patient_number VARCHAR(100) NOT NULL,
  fullname VARCHAR(255) NOT NULL,
  birth_date DATE,
  sex VARCHAR(30) DEFAULT '',
  phone VARCHAR(100) DEFAULT '',
  address TEXT DEFAULT '',
  declared_allergies TEXT DEFAULT '',
  professional_notes TEXT DEFAULT '',
  communication_preferences JSONB DEFAULT '{}'::jsonb,
  consent_data JSONB DEFAULT '{}'::jsonb,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company_id, patient_number)
);

CREATE TABLE IF NOT EXISTS pharmacy_prescribers (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tenant_id INTEGER,
  fullname VARCHAR(255) NOT NULL,
  specialty VARCHAR(180) DEFAULT '',
  facility VARCHAR(255) DEFAULT '',
  phone VARCHAR(100) DEFAULT '',
  professional_reference VARCHAR(180) DEFAULT '',
  address TEXT DEFAULT '',
  status VARCHAR(40) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pharmacy_prescriptions (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tenant_id INTEGER,
  site_id INTEGER REFERENCES pharmacy_sites(id) ON DELETE SET NULL,
  patient_id INTEGER REFERENCES pharmacy_patients(id) ON DELETE SET NULL,
  prescriber_id INTEGER REFERENCES pharmacy_prescribers(id) ON DELETE SET NULL,
  prescription_date DATE NOT NULL DEFAULT CURRENT_DATE,
  reference VARCHAR(150) NOT NULL,
  private_file_key TEXT DEFAULT '',
  status VARCHAR(40) DEFAULT 'received',
  notes TEXT DEFAULT '',
  sale_id INTEGER,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  validated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company_id, reference)
);

CREATE TABLE IF NOT EXISTS pharmacy_prescription_items (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  prescription_id INTEGER NOT NULL REFERENCES pharmacy_prescriptions(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  medication_text TEXT DEFAULT '',
  dosage TEXT DEFAULT '',
  quantity NUMERIC(14,3) DEFAULT 0,
  quantity_dispensed NUMERIC(14,3) DEFAULT 0,
  directions TEXT DEFAULT '',
  duration TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS pharmacy_sale_lot_allocations (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tenant_id INTEGER,
  sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  sale_item_id INTEGER REFERENCES sale_items(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  batch_id INTEGER REFERENCES product_batches(id) ON DELETE SET NULL,
  lot_number VARCHAR(255) DEFAULT '',
  expiration_date DATE,
  quantity NUMERIC(14,3) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pharmacy_stock_events (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tenant_id INTEGER,
  site_id INTEGER REFERENCES pharmacy_sites(id) ON DELETE SET NULL,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  batch_id INTEGER REFERENCES product_batches(id) ON DELETE SET NULL,
  event_type VARCHAR(60) NOT NULL,
  quantity NUMERIC(14,3) NOT NULL,
  source_type VARCHAR(60) DEFAULT '',
  source_id INTEGER,
  reason TEXT DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pharmacy_sensitive_audit (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tenant_id INTEGER,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(60) NOT NULL,
  entity_type VARCHAR(60) NOT NULL,
  entity_id INTEGER,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pharmacy_accounting_links (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  sale_id INTEGER REFERENCES sales(id) ON DELETE SET NULL,
  payment_source VARCHAR(80) NOT NULL,
  amount NUMERIC(14,2) DEFAULT 0,
  bridge_status VARCHAR(40) DEFAULT 'pending',
  journal_entry_id INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company_id, sale_id, payment_source)
);

CREATE TABLE IF NOT EXISTS network_sites (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tenant_id INTEGER,
  warehouse_id INTEGER REFERENCES warehouses(id) ON DELETE SET NULL,
  code VARCHAR(80) NOT NULL,
  name VARCHAR(255) NOT NULL,
  address TEXT DEFAULT '',
  responsible_name VARCHAR(255) DEFAULT '',
  status VARCHAR(40) DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company_id, code)
);

CREATE TABLE IF NOT EXISTS network_devices (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tenant_id INTEGER,
  site_id INTEGER REFERENCES network_sites(id) ON DELETE SET NULL,
  name VARCHAR(255) NOT NULL,
  category VARCHAR(60) NOT NULL,
  manufacturer VARCHAR(160) DEFAULT '',
  model VARCHAR(160) DEFAULT '',
  serial_number VARCHAR(180) DEFAULT '',
  ip_address VARCHAR(80) DEFAULT '',
  mac_address VARCHAR(32) DEFAULT '',
  vlan VARCHAR(80) DEFAULT '',
  ssid VARCHAR(180) DEFAULT '',
  switch_port VARCHAR(80) DEFAULT '',
  rack_location VARCHAR(160) DEFAULT '',
  firmware_version VARCHAR(120) DEFAULT '',
  installed_on DATE,
  warranty_until DATE,
  supplier VARCHAR(255) DEFAULT '',
  status VARCHAR(40) DEFAULT 'unknown',
  monitoring_type VARCHAR(30) DEFAULT 'none',
  monitoring_port INTEGER,
  last_checked_at TIMESTAMP,
  last_seen_at TIMESTAMP,
  last_check_error TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS network_incidents (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tenant_id INTEGER,
  site_id INTEGER REFERENCES network_sites(id) ON DELETE SET NULL,
  device_id INTEGER REFERENCES network_devices(id) ON DELETE SET NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT DEFAULT '',
  severity VARCHAR(30) DEFAULT 'medium',
  status VARCHAR(40) DEFAULT 'open',
  assigned_to INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolution TEXT DEFAULT '',
  opened_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  opened_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  resolved_at TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS network_maintenance (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tenant_id INTEGER,
  device_id INTEGER REFERENCES network_devices(id) ON DELETE SET NULL,
  maintenance_type VARCHAR(80) DEFAULT 'preventive',
  scheduled_for TIMESTAMP,
  completed_at TIMESTAMP,
  status VARCHAR(40) DEFAULT 'planned',
  description TEXT DEFAULT '',
  parts_used TEXT DEFAULT '',
  cost NUMERIC(14,2) DEFAULT 0,
  responsible_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS network_links (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_device_id INTEGER NOT NULL REFERENCES network_devices(id) ON DELETE CASCADE,
  destination_device_id INTEGER NOT NULL REFERENCES network_devices(id) ON DELETE CASCADE,
  source_port VARCHAR(80) DEFAULT '',
  destination_port VARCHAR(80) DEFAULT '',
  link_type VARCHAR(60) DEFAULT 'ethernet',
  status VARCHAR(40) DEFAULT 'unknown',
  notes TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(company_id, source_device_id, destination_device_id, source_port, destination_port)
);

CREATE TABLE IF NOT EXISTS network_audit_logs (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  tenant_id INTEGER,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(80) NOT NULL,
  entity_type VARCHAR(60) NOT NULL,
  entity_id INTEGER,
  detail TEXT DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pharmacy_products_company ON products(company_id, product_kind);
CREATE INDEX IF NOT EXISTS idx_pharmacy_batches_expiry ON product_batches(company_id, expiration_date, status);
CREATE INDEX IF NOT EXISTS idx_pharmacy_patients_company ON pharmacy_patients(company_id);
CREATE INDEX IF NOT EXISTS idx_pharmacy_stock_events_company ON pharmacy_stock_events(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_network_devices_company ON network_devices(company_id, site_id);
CREATE INDEX IF NOT EXISTS idx_network_devices_ip ON network_devices(company_id, ip_address);
CREATE INDEX IF NOT EXISTS idx_network_devices_mac ON network_devices(company_id, mac_address);
CREATE UNIQUE INDEX IF NOT EXISTS uq_network_devices_company_serial
  ON network_devices(company_id, serial_number) WHERE serial_number <> '';
CREATE INDEX IF NOT EXISTS idx_network_incidents_company ON network_incidents(company_id, status);
CREATE INDEX IF NOT EXISTS idx_network_maintenance_company ON network_maintenance(company_id, scheduled_for);

COMMIT;
