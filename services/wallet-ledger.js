"use strict";

/**
 * Service grand livre Wallet — SOURCE DE VÉRITÉ UNIQUE des mouvements
 * financiers internes MaliLink. Réutilisé par : transfert, paiement QR,
 * paiement marketplace, crédit admin. Aucune logique dupliquée ailleurs.
 *
 * Règles :
 * - à appeler DANS une transaction PostgreSQL (le caller gère BEGIN/COMMIT
 *   et les verrous FOR UPDATE + vérifications de solde) ;
 * - les écritures (wallet_entries) sont immuables : le solde en découle ;
 * - chaque opération porte un financial_operation_id commun qui relie
 *   Wallet ↔ Comptabilité ↔ Finance ;
 * - toute jambe rattachée à une entreprise génère AUTOMATIQUEMENT une
 *   écriture comptable (accounting_transactions).
 */

const crypto = require("crypto");

function newReference() {
  return `MLW-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}
function newFinancialOperationId() {
  return `FINOP-${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
}

async function currentBalance(client, walletId) {
  const { rows } = await client.query(
    `SELECT balance_after FROM wallet_entries WHERE wallet_id=$1 ORDER BY id DESC LIMIT 1`,
    [walletId]
  );
  return Number(rows[0]?.balance_after || 0);
}

/**
 * Enregistre une opération équilibrée (somme débits = somme crédits).
 * @param client  client PG dans une transaction ouverte
 * @param legs    [{ walletId, direction: 'debit'|'credit', amount, companyId? }]
 */
async function postLedgerTransaction(client, {
  tenantId = "malilink",
  kind,
  status = "completed",
  description = "",
  relatedModule = "",
  relatedId = null,
  initiatedBy = null,
  idempotencyKey = null,
  commission = 0,
  legs
}) {
  const totalDebit = legs.filter((l) => l.direction === "debit").reduce((s, l) => s + Number(l.amount), 0);
  const totalCredit = legs.filter((l) => l.direction === "credit").reduce((s, l) => s + Number(l.amount), 0);
  // Sécurité comptable : l'opération DOIT être équilibrée.
  if (Math.round(totalDebit * 100) !== Math.round(totalCredit * 100)) {
    throw new Error(`Opération déséquilibrée (débit ${totalDebit} ≠ crédit ${totalCredit})`);
  }

  const reference = newReference();
  const financialOperationId = newFinancialOperationId();

  const tx = await client.query(
    `INSERT INTO wallet_transactions
       (tenant_id, reference, idempotency_key, kind, status, description,
        related_module, related_id, initiated_by, financial_operation_id,
        commission_amount, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, CASE WHEN $5='completed' THEN NOW() ELSE NULL END)
     RETURNING id`,
    [
      tenantId, reference, idempotencyKey, kind, status, description,
      relatedModule, relatedId, initiatedBy, financialOperationId, commission
    ]
  );
  const transactionId = tx.rows[0].id;

  for (const leg of legs) {
    const balance = await currentBalance(client, leg.walletId);
    const after = leg.direction === "credit" ? balance + Number(leg.amount) : balance - Number(leg.amount);
    await client.query(
      `INSERT INTO wallet_entries (transaction_id, wallet_id, direction, amount, balance_after)
       VALUES ($1,$2,$3,$4,$5)`,
      [transactionId, leg.walletId, leg.direction, Number(leg.amount), after]
    );

    // Écriture comptable automatique pour toute jambe rattachée à une entreprise.
    if (leg.companyId) {
      await client.query(
        `INSERT INTO accounting_transactions
           (company_id, transaction_type, source_type, amount, direction, category,
            financial_operation_id, created_at)
         VALUES ($1,$2,'wallet',$3,$4,$5,$6,NOW())`,
        [
          leg.companyId,
          kind,
          Number(leg.amount),
          leg.direction === "credit" ? "entree" : "sortie",
          relatedModule || kind,
          financialOperationId
        ]
      ).catch(() => {}); // la compta ne doit jamais faire échouer le paiement
    }
  }

  return { reference, financial_operation_id: financialOperationId, transactionId };
}

/* Wallet plateforme MaliLink (commissions) — créé par migration 054. */
async function getPlatformWalletId(client) {
  const { rows } = await client.query(`SELECT id FROM wallets WHERE owner_type='platform' LIMIT 1`);
  return rows[0]?.id || null;
}

module.exports = {
  newReference,
  newFinancialOperationId,
  currentBalance,
  postLedgerTransaction,
  getPlatformWalletId
};
