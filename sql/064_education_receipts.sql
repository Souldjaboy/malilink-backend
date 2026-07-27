-- 064 — Éducation : compteur de reçus + renforts sur edu_enrollment_payments (tranche 4).
-- Idempotent, additif, préfixe edu_*, isolation school_id (company_id).

-- Compteur de numéros de reçus par établissement et par année : MLK-REC-AAAA-NNNNN.
CREATE TABLE IF NOT EXISTS edu_receipt_counters (
  company_id INTEGER NOT NULL,
  year INTEGER NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, year)
);

-- Colonnes complémentaires pour tracer chaque versement (idempotent).
ALTER TABLE edu_enrollment_payments ADD COLUMN IF NOT EXISTS signature TEXT NOT NULL DEFAULT '';
ALTER TABLE edu_enrollment_payments ADD COLUMN IF NOT EXISTS notes TEXT DEFAULT '';

-- Unicité du numéro de reçu au sein d'un établissement (quand renseigné).
CREATE UNIQUE INDEX IF NOT EXISTS uidx_edu_receipt_number
  ON edu_enrollment_payments (company_id, receipt_number)
  WHERE receipt_number IS NOT NULL;
