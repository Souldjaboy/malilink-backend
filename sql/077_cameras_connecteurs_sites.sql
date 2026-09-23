-- 077 — Caméras & Sécurité : connecteurs, ports, suivi de joignabilité,
--       sites de type bureau / siège.
--
-- Additive et idempotente. Aucune donnée supprimée.
--
-- Connecteurs pris en charge PROGRESSIVEMENT, sans jamais contourner la
-- protection d'une caméra : le client fournit l'adresse, le port, le
-- protocole et des identifiants qu'il est autorisé à utiliser.
--   onvif      standard ONVIF (Profile S)
--   rtsp       flux RTSP générique
--   hikvision  équipements Hikvision (SDK / ISAPI)
--   dahua      équipements Dahua
--   other      autre, déclaré à la main

BEGIN;

-- ── Sites : un bureau ou un siège peut porter des caméras ────────────
-- Ces sites ne sont pas des lieux de stock : ils sont créés hors stock
-- (is_stock_visible = FALSE) et n'apparaissent pas dans les listes du stock.
ALTER TABLE warehouses DROP CONSTRAINT IF EXISTS warehouses_type_valide;
ALTER TABLE warehouses ADD CONSTRAINT warehouses_type_valide
  CHECK (type IN ('entrepot', 'magasin', 'depot', 'point_de_vente', 'bureau', 'siege'));

-- ── Caméras ─────────────────────────────────────────────────────────
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS connector_type VARCHAR(20) NOT NULL DEFAULT 'onvif';
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS port INTEGER;
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP;
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS last_check_error TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN cameras.last_seen_at IS
  'Dernière fois que l''adresse de la caméra a répondu à un test de joignabilité (connexion TCP, sans authentification).';

-- ── Enregistreurs NVR / DVR ─────────────────────────────────────────
ALTER TABLE camera_recorders ADD COLUMN IF NOT EXISTS connector_type VARCHAR(20) NOT NULL DEFAULT 'onvif';
ALTER TABLE camera_recorders ADD COLUMN IF NOT EXISTS port INTEGER;
ALTER TABLE camera_recorders ADD COLUMN IF NOT EXISTS online_status VARCHAR(20) NOT NULL DEFAULT 'inconnu';
ALTER TABLE camera_recorders ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMP;
ALTER TABLE camera_recorders ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMP;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cameras_connector_valide') THEN
    ALTER TABLE cameras ADD CONSTRAINT cameras_connector_valide
      CHECK (connector_type IN ('onvif', 'rtsp', 'hikvision', 'dahua', 'other'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cameras_port_valide') THEN
    ALTER TABLE cameras ADD CONSTRAINT cameras_port_valide CHECK (port IS NULL OR port BETWEEN 1 AND 65535);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'camera_recorders_connector_valide') THEN
    ALTER TABLE camera_recorders ADD CONSTRAINT camera_recorders_connector_valide
      CHECK (connector_type IN ('onvif', 'rtsp', 'hikvision', 'dahua', 'other'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'camera_recorders_port_valide') THEN
    ALTER TABLE camera_recorders ADD CONSTRAINT camera_recorders_port_valide CHECK (port IS NULL OR port BETWEEN 1 AND 65535);
  END IF;
END $$;

COMMIT;
