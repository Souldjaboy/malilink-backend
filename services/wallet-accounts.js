"use strict";

/**
 * Provisioning des portefeuilles — helper partagé (réutilisé par le module
 * Voyage et réutilisable par le Wallet). Évite la duplication de la logique
 * de création/lecture de wallet. Le grand livre (wallet-ledger) reste la seule
 * source des mouvements.
 */

/** Wallet d'un propriétaire (créé au 1er accès). `db` peut être un client tx. */
async function ensureWallet(db, { userId = null, companyId = null }) {
  const ownerType = companyId ? "company" : "user";
  const sel = companyId
    ? `SELECT * FROM wallets WHERE owner_type='company' AND company_id=$1`
    : `SELECT * FROM wallets WHERE owner_type='user' AND user_id=$1`;
  const found = await db.query(sel, [companyId || userId]);
  if (found.rows[0]) return found.rows[0];
  const inserted = await db.query(
    `INSERT INTO wallets (owner_type, user_id, company_id)
     VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING *`,
    [ownerType, companyId ? null : userId, companyId]
  );
  if (inserted.rows[0]) return inserted.rows[0];
  const retry = await db.query(sel, [companyId || userId]);
  return retry.rows[0];
}

/** Solde disponible (solde courant - fonds gelés). */
async function available(db, walletId) {
  const [last, holds] = await Promise.all([
    db.query(`SELECT balance_after FROM wallet_entries WHERE wallet_id=$1 ORDER BY id DESC LIMIT 1`, [walletId]),
    db.query(`SELECT COALESCE(SUM(amount),0)::numeric AS held FROM wallet_holds WHERE wallet_id=$1 AND status='held'`, [walletId]),
  ]);
  const balance = Number(last.rows[0]?.balance_after || 0);
  const held = Number(holds.rows[0]?.held || 0);
  return { balance, held, available: Math.max(balance - held, 0) };
}

module.exports = { ensureWallet, available };
