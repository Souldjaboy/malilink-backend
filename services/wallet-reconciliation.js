"use strict";

/**
 * Réconciliation automatique (#2).
 *
 * Vérifie la cohérence financière SANS jamais modifier le grand livre
 * (immuable). Deux contrôles :
 *
 *  A) Équilibre global du grand livre : somme de TOUS les débits =
 *     somme de TOUS les crédits (double-entrée). Toute dérive est un
 *     signal fort d'incident.
 *
 *  B) Wallet ↔ Comptabilité par financial_operation_id : pour chaque
 *     opération portant une écriture comptable, le montant comptable
 *     rattaché à une entreprise doit correspondre à la jambe Wallet
 *     de cette entreprise. Toute divergence est listée en « mismatch ».
 *
 * Le résultat est persisté dans wallet_reconciliation_reports ; un rapport
 * en mismatch tient lieu d'alerte (consultable en admin).
 */

async function reconcile(db, { tenantId = "malilink" } = {}) {
  // A) Équilibre global du grand livre.
  const totals = await db.query(
    `SELECT
        COALESCE(SUM(amount) FILTER (WHERE direction='debit'),0)  AS debit,
        COALESCE(SUM(amount) FILTER (WHERE direction='credit'),0) AS credit
       FROM wallet_entries`
  );
  const debit = Number(totals.rows[0].debit);
  const credit = Number(totals.rows[0].credit);
  const details = [];
  let mismatch = 0;

  if (Math.round(debit * 100) !== Math.round(credit * 100)) {
    mismatch += 1;
    details.push({
      type: "ledger_imbalance",
      debit_total: debit,
      credit_total: credit,
      difference: Number((credit - debit).toFixed(2)),
      note: "Écritures héritées possibles ; le grand livre étant immuable, à corriger par une écriture compensatoire."
    });
  }

  // B) Wallet ↔ Comptabilité par financial_operation_id.
  const linked = await db.query(
    `SELECT w.financial_operation_id AS finop,
            COALESCE(SUM(e.amount),0) AS wallet_amount,
            (SELECT COALESCE(SUM(a.amount),0) FROM accounting_transactions a
              WHERE a.financial_operation_id = w.financial_operation_id) AS acc_amount
       FROM wallet_transactions w
       JOIN wallet_entries e ON e.transaction_id = w.id
      WHERE w.financial_operation_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM accounting_transactions a
                     WHERE a.financial_operation_id = w.financial_operation_id)
      GROUP BY w.financial_operation_id`
  );

  let checked = linked.rows.length + 1; // +1 pour le contrôle d'équilibre global
  for (const row of linked.rows) {
    const acc = Number(row.acc_amount);
    // La compta ne reprend que les jambes rattachées à une entreprise :
    // acc_amount doit être > 0 et ≤ montant Wallet total de l'opération.
    if (acc <= 0 || Math.round(acc * 100) > Math.round(Number(row.wallet_amount) * 100)) {
      mismatch += 1;
      details.push({
        type: "wallet_vs_accounting",
        financial_operation_id: row.finop,
        wallet_amount: Number(row.wallet_amount),
        accounting_amount: acc
      });
    }
  }

  const status = mismatch > 0 ? "mismatch" : "ok";
  const saved = await db.query(
    `INSERT INTO wallet_reconciliation_reports
       (tenant_id, scope, checked_count, mismatch_count,
        ledger_debit_total, ledger_credit_total, details, status)
     VALUES ($1,'full',$2,$3,$4,$5,$6,$7)
     RETURNING id, created_at`,
    [tenantId, checked, mismatch, debit, credit, JSON.stringify(details), status]
  );

  return {
    report_id: saved.rows[0].id,
    created_at: saved.rows[0].created_at,
    checked,
    mismatch,
    status,
    ledger_debit_total: debit,
    ledger_credit_total: credit,
    details
  };
}

module.exports = { reconcile };
