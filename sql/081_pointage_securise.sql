-- 081 — Pointage sécurisé : société sur chaque fiche, méthode et appareil sur
-- chaque événement, journal des scans (acceptés ET refusés).
--
-- Additive et idempotente. Aucune ligne supprimée ; les anciennes fiches sont
-- rattachées à la société de leur titulaire.

BEGIN;

-- ── Fiches du jour : la société est portée par la fiche ─────────────────
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL;
ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS tenant_id TEXT;
UPDATE attendance_records r SET company_id = u.company_id
  FROM users u WHERE u.id = r.user_id AND r.company_id IS NULL AND u.company_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_attendance_records_company_date ON attendance_records (company_id, work_date);

-- ── Événements : méthode, appareil, score, opérateur ────────────────────
ALTER TABLE attendance_history ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL;
ALTER TABLE attendance_history ADD COLUMN IF NOT EXISTS tenant_id TEXT;
ALTER TABLE attendance_history ADD COLUMN IF NOT EXISTS method TEXT NOT NULL DEFAULT 'MANUEL';
ALTER TABLE attendance_history ADD COLUMN IF NOT EXISTS device_id INTEGER;
ALTER TABLE attendance_history ADD COLUMN IF NOT EXISTS biometric_confidence NUMERIC(5,4);
ALTER TABLE attendance_history ADD COLUMN IF NOT EXISTS created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE attendance_history ADD COLUMN IF NOT EXISTS request_id TEXT;
ALTER TABLE attendance_history ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

UPDATE attendance_history h SET company_id = u.company_id
  FROM users u WHERE u.id = h.user_id AND h.company_id IS NULL AND u.company_id IS NOT NULL;
-- L'ancien scan écrivait « QR » dans device_info.
UPDATE attendance_history SET method = 'QR' WHERE device_info = 'QR' AND method = 'MANUEL';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_history_method_valide') THEN
    ALTER TABLE attendance_history ADD CONSTRAINT attendance_history_method_valide
      CHECK (method IN ('QR', 'MANUEL', 'VISAGE', 'EMPREINTE', 'PASSKEY_CONFIRMATION', 'IMPORT', 'CORRECTION'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attendance_history_confiance_bornee') THEN
    ALTER TABLE attendance_history ADD CONSTRAINT attendance_history_confiance_bornee
      CHECK (biometric_confidence IS NULL OR (biometric_confidence >= 0 AND biometric_confidence <= 1));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_attendance_history_rebond
  ON attendance_history (user_id, company_id, action_type, created_at DESC);

COMMENT ON COLUMN attendance_history.metadata IS
  'Complément de traçabilité. Ne contient JAMAIS de gabarit, d''image ni de donnée biométrique.';

-- ── Réglages GPS : séquence recalée ────────────────────────────────
-- 011 insère la ligne id = 1 sans avancer la séquence : la première
-- société qui enregistrait ses réglages heurtait « duplicate key » une fois.
SELECT setval(pg_get_serial_sequence('attendance_gps_settings', 'id'),
              GREATEST((SELECT COALESCE(max(id), 1) FROM attendance_gps_settings), 1));

-- ── Journal des scans : chaque lecture, acceptée ou refusée ─────────────
-- Un refus répété révèle un badge perdu, un essai de deviner des codes ou un
-- appareil mal configuré. Le jeton lu n'est jamais conservé : seulement ses
-- quatre derniers caractères, assez pour rapprocher, trop peu pour rejouer.
CREATE TABLE IF NOT EXISTS attendance_scan_log (
  id            BIGSERIAL PRIMARY KEY,
  company_id    INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  tenant_id     TEXT,
  scanned_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  method        TEXT NOT NULL DEFAULT 'QR',
  action_type   TEXT NOT NULL DEFAULT '',
  accepted      BOOLEAN NOT NULL,
  refusal_code  TEXT NOT NULL DEFAULT '',
  token_hint    TEXT NOT NULL DEFAULT '',
  device_id     INTEGER,
  ip_address    TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_attendance_scan_log_company ON attendance_scan_log (company_id, created_at DESC);

COMMIT;
