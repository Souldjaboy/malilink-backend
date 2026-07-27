-- 065 — Éducation : plans de mensualités (échéanciers de scolarité) + reçus (tranche 5).
-- Idempotent, additif, préfixe edu_feeplan_* (distinct de l'ancien edu_fee_payments).
-- Isolation school_id (company_id).

-- Plan de scolarité : montant total réparti en N échéances mensuelles.
CREATE TABLE IF NOT EXISTS edu_feeplans (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  student_id INTEGER NOT NULL REFERENCES edu_students(id) ON DELETE CASCADE,
  school_year_id INTEGER REFERENCES edu_school_years(id) ON DELETE SET NULL,
  class_id INTEGER REFERENCES edu_classes(id) ON DELETE SET NULL,
  label TEXT NOT NULL DEFAULT 'Scolarité',
  total_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  installments_count INTEGER NOT NULL DEFAULT 1,
  currency TEXT NOT NULL DEFAULT 'FCFA',
  status TEXT NOT NULL DEFAULT 'active',            -- active | completed | cancelled
  notes TEXT DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_edu_feeplan_school ON edu_feeplans (company_id, status);
CREATE INDEX IF NOT EXISTS idx_edu_feeplan_student ON edu_feeplans (student_id);

-- Échéances individuelles (mensualités).
CREATE TABLE IF NOT EXISTS edu_feeplan_installments (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL REFERENCES edu_feeplans(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,                              -- 1..N
  label TEXT NOT NULL DEFAULT '',
  due_date DATE,
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',            -- pending | partial | paid
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_edu_feeplan_inst_plan ON edu_feeplan_installments (plan_id, seq);

-- Versements rattachés à un plan (et éventuellement à une échéance précise).
CREATE TABLE IF NOT EXISTS edu_feeplan_payments (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL REFERENCES edu_feeplans(id) ON DELETE CASCADE,
  installment_id INTEGER REFERENCES edu_feeplan_installments(id) ON DELETE SET NULL,
  receipt_number TEXT,
  amount NUMERIC(12,2) NOT NULL,
  method TEXT DEFAULT '',
  reference TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'paid',               -- paid | cancelled
  signature TEXT NOT NULL DEFAULT '',
  notes TEXT DEFAULT '',
  recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_edu_feeplan_pay_plan ON edu_feeplan_payments (plan_id);
CREATE UNIQUE INDEX IF NOT EXISTS uidx_edu_feeplan_receipt
  ON edu_feeplan_payments (company_id, receipt_number)
  WHERE receipt_number IS NOT NULL;
