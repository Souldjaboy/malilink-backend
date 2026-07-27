-- 063 — Éducation : inscriptions (§10) + base des paiements d'inscription (§12).
-- Idempotent, additif, préfixe edu_*, isolation school_id (company_id).

CREATE TABLE IF NOT EXISTS edu_enrollments (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  reference TEXT NOT NULL,                          -- MLK-INS-AAAA-NNNNN
  student_id INTEGER NOT NULL REFERENCES edu_students(id) ON DELETE CASCADE,
  school_year_id INTEGER REFERENCES edu_school_years(id) ON DELETE SET NULL,
  class_id INTEGER REFERENCES edu_classes(id) ON DELETE SET NULL,
  enrollment_fee NUMERIC(12,2) NOT NULL DEFAULT 0,
  amount_paid NUMERIC(12,2) NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'FCFA',
  payment_method TEXT DEFAULT '',                   -- especes | wallet | orange_money | wave | virement | cheque | autre
  status TEXT NOT NULL DEFAULT 'pending',           -- pending | partially_paid | paid | cancelled | refunded
  signature TEXT NOT NULL DEFAULT '',               -- HMAC de la référence (QR)
  notes TEXT DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (company_id, reference)
);
CREATE INDEX IF NOT EXISTS idx_edu_enroll_school ON edu_enrollments (company_id, status);
CREATE INDEX IF NOT EXISTS idx_edu_enroll_student ON edu_enrollments (student_id);

CREATE TABLE IF NOT EXISTS edu_enrollment_counters (
  company_id INTEGER NOT NULL,
  year INTEGER NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, year)
);

-- Paiements rattachés à une inscription (reçus au Lot suivant).
CREATE TABLE IF NOT EXISTS edu_enrollment_payments (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL,
  enrollment_id INTEGER NOT NULL REFERENCES edu_enrollments(id) ON DELETE CASCADE,
  receipt_number TEXT,
  amount NUMERIC(12,2) NOT NULL,
  method TEXT DEFAULT '',
  reference TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'paid',              -- paid | cancelled
  recorded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_edu_enroll_pay ON edu_enrollment_payments (enrollment_id);
