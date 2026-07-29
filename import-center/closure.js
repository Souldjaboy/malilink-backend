"use strict";

/**
 * Clôture comptable mensuelle. Utilise les écritures réelles
 * (accounting_transactions validées). Une période clôturée bloque toute
 * écriture ordinaire de ce mois.
 */

function ym(dateStr) {
  const d = new Date(dateStr);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

// Une date tombe-t-elle dans une période clôturée ?
async function isPeriodClosed(client, companyId, dateStr) {
  if (!dateStr) return false;
  const { year, month } = ym(dateStr);
  const { rows } = await client.query(
    `SELECT status FROM accounting_period_closures WHERE company_id=$1 AND period_year=$2 AND period_month=$3 LIMIT 1`,
    [companyId, year, month]
  );
  return rows[0]?.status === "closed";
}

// Calcule le bilan d'un mois (sans écrire).
async function computeClosure(pool, companyId, year, month) {
  // Solde initial = clôture du mois précédent, sinon 0.
  const prev = month === 1 ? { y: year - 1, m: 12 } : { y: year, m: month - 1 };
  const prevClose = (await pool.query(
    `SELECT closing_balance FROM accounting_period_closures WHERE company_id=$1 AND period_year=$2 AND period_month=$3 AND status='closed'`,
    [companyId, prev.y, prev.m]
  )).rows[0];
  const opening = prevClose ? Number(prevClose.closing_balance) : 0;

  const agg = (await pool.query(
    `SELECT
        COALESCE(SUM(amount) FILTER (WHERE direction='entrée' AND status='validé'),0) AS income,
        COALESCE(SUM(amount) FILTER (WHERE direction='sortie' AND status='validé'),0) AS expense,
        COUNT(*) FILTER (WHERE status<>'validé') AS not_validated
       FROM accounting_transactions
      WHERE company_id=$1 AND EXTRACT(YEAR FROM created_at)=$2 AND EXTRACT(MONTH FROM created_at)=$3`,
    [companyId, year, month]
  )).rows[0];

  const income = Number(agg.income), expense = Number(agg.expense);
  const closing = opening + income - expense;
  return {
    period_year: year, period_month: month,
    opening_balance: opening, total_income: income, total_expense: expense,
    result: income - expense, closing_balance: closing,
    not_validated: Number(agg.not_validated),
    anomalies: Number(agg.not_validated) > 0 ? [`${agg.not_validated} opération(s) non validée(s).`] : [],
  };
}

async function listClosures(pool, companyId, year) {
  const { rows } = await pool.query(
    `SELECT * FROM accounting_period_closures WHERE company_id=$1 AND ($2::int IS NULL OR period_year=$2) ORDER BY period_year DESC, period_month DESC`,
    [companyId, year || null]
  );
  return rows;
}

async function closePeriod(pool, companyId, userId, year, month) {
  const snap = await computeClosure(pool, companyId, year, month);
  const { rows } = await pool.query(
    `INSERT INTO accounting_period_closures
       (company_id, period_year, period_month, status, opening_balance, total_income, total_expense, closing_balance, snapshot, closed_by, closed_at)
     VALUES ($1,$2,$3,'closed',$4,$5,$6,$7,$8,$9,NOW())
     ON CONFLICT (company_id, period_year, period_month) DO UPDATE SET
       status='closed', opening_balance=EXCLUDED.opening_balance, total_income=EXCLUDED.total_income,
       total_expense=EXCLUDED.total_expense, closing_balance=EXCLUDED.closing_balance,
       snapshot=EXCLUDED.snapshot, closed_by=EXCLUDED.closed_by, closed_at=NOW()
     RETURNING *`,
    [companyId, year, month, snap.opening_balance, snap.total_income, snap.total_expense, snap.closing_balance, JSON.stringify(snap), userId]
  );
  return rows[0];
}

async function reopenPeriod(pool, companyId, userId, year, month) {
  const { rows } = await pool.query(
    `UPDATE accounting_period_closures SET status='open', reopened_by=$4, reopened_at=NOW()
      WHERE company_id=$1 AND period_year=$2 AND period_month=$3 AND status='closed' RETURNING *`,
    [companyId, year, month, userId]
  );
  return rows[0] || null;
}

module.exports = { isPeriodClosed, computeClosure, listClosures, closePeriod, reopenPeriod };
