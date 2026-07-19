-- 052 — Module Finance : budgets par entreprise.
-- Le reste de la Finance (revenus, dépenses, trésorerie) est agrégé à la
-- volée depuis les tables existantes (sales, marketplace_orders,
-- accounting_transactions, payroll…) — aucune duplication de données.
-- Idempotent, aucune suppression.

CREATE TABLE IF NOT EXISTS finance_budgets (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  period TEXT NOT NULL DEFAULT 'mensuel',            -- mensuel | annuel
  category TEXT NOT NULL DEFAULT 'general',
  planned_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  year INTEGER NOT NULL,
  month INTEGER,                                     -- 1-12 pour budget mensuel, NULL pour annuel
  note TEXT DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_finance_budgets_company
  ON finance_budgets (company_id, year, month);
