"use strict";

/**
 * Limites Wallet (#4) — plafonds configurables par utilisateur.
 *
 * Vérifie AVANT d'écrire au grand livre : montant par opération, cumul
 * quotidien, cumul mensuel, nombre d'opérations par jour. La config
 * spécifique d'un utilisateur prime ; à défaut, les limites plateforme
 * (user_id NULL) s'appliquent. Un champ NULL = pas de limite sur ce critère.
 */

async function getEffectiveLimits(db, userId) {
  const { rows } = await db.query(
    `SELECT user_id, max_per_transaction, daily_amount_cap, monthly_amount_cap, daily_count_cap
       FROM wallet_limits
      WHERE user_id=$1 OR user_id IS NULL
      ORDER BY user_id NULLS LAST
      LIMIT 1`,
    [userId]
  );
  return rows[0] || {};
}

/**
 * @returns {Promise<{ok:boolean, reason?:string, limit?:string}>}
 * Ne lève pas : renvoie un verdict que l'appelant transforme en 400/limite.
 */
async function checkOutgoing(db, userId, amount) {
  const limits = await getEffectiveLimits(db, userId);
  const amt = Number(amount);

  if (limits.max_per_transaction != null && amt > Number(limits.max_per_transaction)) {
    return {
      ok: false,
      limit: "max_per_transaction",
      reason: `Montant supérieur au plafond par opération (${Number(limits.max_per_transaction).toLocaleString("fr-FR")} FCFA).`
    };
  }

  // Cumul du jour (débits sortants de l'utilisateur).
  if (limits.daily_amount_cap != null || limits.daily_count_cap != null) {
    const { rows } = await db.query(
      `SELECT COALESCE(SUM(e.amount),0) AS total, COUNT(*) AS cnt
         FROM wallet_entries e
         JOIN wallets w ON w.id=e.wallet_id
        WHERE w.user_id=$1 AND e.direction='debit'
          AND e.created_at >= date_trunc('day', NOW())`,
      [userId]
    );
    const dayTotal = Number(rows[0].total);
    const dayCount = Number(rows[0].cnt);
    if (limits.daily_amount_cap != null && dayTotal + amt > Number(limits.daily_amount_cap)) {
      return {
        ok: false,
        limit: "daily_amount_cap",
        reason: `Plafond quotidien atteint (${Number(limits.daily_amount_cap).toLocaleString("fr-FR")} FCFA/jour).`
      };
    }
    if (limits.daily_count_cap != null && dayCount + 1 > Number(limits.daily_count_cap)) {
      return {
        ok: false,
        limit: "daily_count_cap",
        reason: `Nombre d'opérations quotidien atteint (${limits.daily_count_cap}/jour).`
      };
    }
  }

  // Cumul du mois.
  if (limits.monthly_amount_cap != null) {
    const { rows } = await db.query(
      `SELECT COALESCE(SUM(e.amount),0) AS total
         FROM wallet_entries e
         JOIN wallets w ON w.id=e.wallet_id
        WHERE w.user_id=$1 AND e.direction='debit'
          AND e.created_at >= date_trunc('month', NOW())`,
      [userId]
    );
    if (Number(rows[0].total) + amt > Number(limits.monthly_amount_cap)) {
      return {
        ok: false,
        limit: "monthly_amount_cap",
        reason: `Plafond mensuel atteint (${Number(limits.monthly_amount_cap).toLocaleString("fr-FR")} FCFA/mois).`
      };
    }
  }

  return { ok: true, limits };
}

module.exports = { getEffectiveLimits, checkOutgoing };
