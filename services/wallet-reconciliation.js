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

/**
 * Réconciliation INCRÉMENTALE (#5).
 *
 * Ne scanne QUE les écritures apparues depuis le dernier passage (curseur
 * `wallet_reconciliation_state.last_entry_id`). Maintient des totaux
 * débit/crédit cumulés persistés : l'équilibre global reste vérifiable en
 * O(nouvelles écritures) au lieu de O(tout le grand livre). Conçue pour
 * une exécution planifiée (cron / job) — voir scripts/reconcile.js.
 *
 * Verrou applicatif via SELECT ... FOR UPDATE sur la ligne d'état : deux
 * exécutions concurrentes ne peuvent pas avancer le curseur en double.
 */
async function reconcileIncremental(dbOrPool, { tenantId = "malilink" } = {}) {
  // Le curseur exige UNE seule connexion (BEGIN + FOR UPDATE). Si on reçoit
  // un pool, on acquiert un client dédié ; sinon (client/mock) on l'utilise
  // directement. `managed` = on gère BEGIN/COMMIT/release nous-mêmes.
  const isPool = typeof dbOrPool.connect === "function";
  const db = isPool ? await dbOrPool.connect() : dbOrPool;
  const managed = true;
  try {
    if (managed) await db.query("BEGIN").catch(() => {});
    const st = await db.query(
      `SELECT last_entry_id, running_debit_total, running_credit_total
         FROM wallet_reconciliation_state
        WHERE scope='ledger_incremental' FOR UPDATE`
    );
    const state = st.rows[0] || { last_entry_id: 0, running_debit_total: 0, running_credit_total: 0 };
    const fromId = Number(state.last_entry_id);

    // Deltas sur les nouvelles écritures uniquement.
    const delta = await db.query(
      `SELECT
          COALESCE(SUM(amount) FILTER (WHERE direction='debit'),0)  AS debit,
          COALESCE(SUM(amount) FILTER (WHERE direction='credit'),0) AS credit,
          COALESCE(MAX(id), $1) AS max_id,
          COUNT(*) AS n
         FROM wallet_entries
        WHERE id > $1`,
      [fromId]
    );
    const dDebit = Number(delta.rows[0].debit);
    const dCredit = Number(delta.rows[0].credit);
    const toId = Number(delta.rows[0].max_id);
    const processed = Number(delta.rows[0].n);

    const newDebit = Number(state.running_debit_total) + dDebit;
    const newCredit = Number(state.running_credit_total) + dCredit;

    const details = [];
    let mismatch = 0;
    if (Math.round(newDebit * 100) !== Math.round(newCredit * 100)) {
      mismatch += 1;
      details.push({
        type: "ledger_imbalance",
        debit_total: newDebit,
        credit_total: newCredit,
        difference: Number((newCredit - newDebit).toFixed(2)),
        note: "Cumul incrémental déséquilibré : à corriger par écriture compensatoire (grand livre immuable)."
      });
    }

    // Cohérence Wallet ↔ Comptabilité sur les seules transactions nouvelles.
    if (processed > 0) {
      const linked = await db.query(
        `SELECT w.financial_operation_id AS finop,
                COALESCE(SUM(e.amount),0) AS wallet_amount,
                (SELECT COALESCE(SUM(a.amount),0) FROM accounting_transactions a
                  WHERE a.financial_operation_id = w.financial_operation_id) AS acc_amount
           FROM wallet_transactions w
           JOIN wallet_entries e ON e.transaction_id = w.id
          WHERE w.financial_operation_id IS NOT NULL
            AND e.id > $1 AND e.id <= $2
            AND EXISTS (SELECT 1 FROM accounting_transactions a
                         WHERE a.financial_operation_id = w.financial_operation_id)
          GROUP BY w.financial_operation_id`,
        [fromId, toId]
      );
      for (const row of linked.rows) {
        const acc = Number(row.acc_amount);
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
    }

    // Avance le curseur et persiste les totaux.
    await db.query(
      `UPDATE wallet_reconciliation_state
          SET last_entry_id=$1, running_debit_total=$2, running_credit_total=$3,
              last_run_at=NOW(), updated_at=NOW()
        WHERE scope='ledger_incremental'`,
      [toId, newDebit, newCredit]
    );

    const status = mismatch > 0 ? "mismatch" : "ok";
    const saved = await db.query(
      `INSERT INTO wallet_reconciliation_reports
         (tenant_id, scope, mode, from_entry_id, to_entry_id, checked_count,
          mismatch_count, ledger_debit_total, ledger_credit_total, details, status)
       VALUES ($1,'ledger_incremental','incremental',$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, created_at`,
      [tenantId, fromId, toId, processed, mismatch, newDebit, newCredit, JSON.stringify(details), status]
    );

    if (managed) await db.query("COMMIT").catch(() => {});
    return {
      report_id: saved.rows[0].id,
      created_at: saved.rows[0].created_at,
      mode: "incremental",
      from_entry_id: fromId,
      to_entry_id: toId,
      processed,
      mismatch,
      status,
      ledger_debit_total: newDebit,
      ledger_credit_total: newCredit,
      details
    };
  } catch (e) {
    if (managed) await db.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    if (isPool && db.release) db.release();
  }
}

module.exports = { reconcile, reconcileIncremental };
