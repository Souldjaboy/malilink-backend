"use strict";

/**
 * Moteur anti-fraude Wallet (#6) — SCORE + ALERTE UNIQUEMENT.
 *
 * RÈGLE ABSOLUE : ne bloque JAMAIS automatiquement une opération. Il
 * produit un score de risque (0..100) et, au-delà d'un seuil, enregistre
 * une alerte pour revue humaine. L'opération financière suit son cours ;
 * seule une décision manuelle (admin) peut agir ensuite.
 *
 * Signaux évalués : montant inhabituel vs historique, transferts anormaux,
 * rapidité (rafale de transactions), tentatives répétées (échecs récents),
 * wallet destinataire suspect (neuf / bloqué).
 */

const MEDIUM = 40;
const HIGH = 70;

/**
 * Calcule un score sans écrire. Réutilisable et testable.
 * @param ctx { amount, avgAmount, maxAmount, recentCount, failedCount,
 *              recipientAgeDays, recipientBlocked }
 */
function scoreOperation(ctx = {}) {
  const reasons = [];
  let score = 0;
  const amount = Number(ctx.amount || 0);
  const avg = Number(ctx.avgAmount || 0);
  const max = Number(ctx.maxAmount || 0);

  // Montant inhabituel : nettement au-dessus de la moyenne historique.
  if (avg > 0 && amount > avg * 5) {
    score += 30;
    reasons.push("montant_tres_superieur_a_la_moyenne");
  } else if (max > 0 && amount > max) {
    score += 15;
    reasons.push("montant_record_pour_ce_compte");
  }

  // Rafale : beaucoup de transactions sur une courte fenêtre.
  if (Number(ctx.recentCount || 0) >= 10) {
    score += 25;
    reasons.push("transactions_rapides_en_rafale");
  } else if (Number(ctx.recentCount || 0) >= 5) {
    score += 12;
    reasons.push("frequence_elevee");
  }

  // Tentatives répétées ayant échoué (bruteforce de solde / destinataire).
  if (Number(ctx.failedCount || 0) >= 3) {
    score += 20;
    reasons.push("tentatives_echouees_repetees");
  }

  // Destinataire nouvellement créé (mule potentielle).
  if (ctx.recipientAgeDays != null && Number(ctx.recipientAgeDays) < 1) {
    score += 15;
    reasons.push("wallet_destinataire_tres_recent");
  }
  // Destinataire déjà bloqué / suspect.
  if (ctx.recipientBlocked) {
    score += 25;
    reasons.push("wallet_destinataire_suspect");
  }

  score = Math.min(100, score);
  const level = score >= HIGH ? "high" : score >= MEDIUM ? "medium" : "low";
  return { score, level, reasons };
}

/** Collecte le contexte en base pour un utilisateur/opération donnés. */
async function buildContext(db, { userId, amount, recipientWalletId }) {
  const hist = await db.query(
    `SELECT COALESCE(AVG(e.amount),0) AS avg, COALESCE(MAX(e.amount),0) AS max,
            COUNT(*) FILTER (WHERE e.created_at >= NOW() - INTERVAL '2 minutes') AS recent
       FROM wallet_entries e
       JOIN wallets w ON w.id=e.wallet_id
      WHERE w.user_id=$1 AND e.direction='debit'`,
    [userId]
  );
  const failed = await db.query(
    `SELECT COUNT(*) AS c FROM wallet_transactions
      WHERE initiated_by=$1 AND status IN ('failed','cancelled')
        AND created_at >= NOW() - INTERVAL '10 minutes'`,
    [userId]
  );
  let recipientAgeDays = null;
  let recipientBlocked = false;
  if (recipientWalletId) {
    const r = await db.query(
      `SELECT status, EXTRACT(EPOCH FROM (NOW()-created_at))/86400 AS age_days
         FROM wallets WHERE id=$1`,
      [recipientWalletId]
    );
    if (r.rows[0]) {
      recipientAgeDays = Number(r.rows[0].age_days);
      recipientBlocked = r.rows[0].status !== "active";
    }
  }
  return {
    amount,
    avgAmount: Number(hist.rows[0].avg),
    maxAmount: Number(hist.rows[0].max),
    recentCount: Number(hist.rows[0].recent),
    failedCount: Number(failed.rows[0].c),
    recipientAgeDays,
    recipientBlocked
  };
}

/**
 * Évalue et, si le risque est notable (>= MEDIUM), enregistre une alerte.
 * NE BLOQUE PAS. Renvoie le score pour information/journalisation.
 * Best-effort : toute erreur est avalée pour ne jamais casser un paiement.
 */
async function evaluateAndRecord(db, { userId, walletId, amount, recipientWalletId, transactionId, financialOperationId }) {
  try {
    const ctx = await buildContext(db, { userId, amount, recipientWalletId });
    const verdict = scoreOperation(ctx);
    if (verdict.score >= MEDIUM) {
      await db.query(
        `INSERT INTO wallet_fraud_alerts
           (user_id, wallet_id, transaction_id, financial_operation_id,
            risk_score, risk_level, reasons, amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          userId, walletId || null, transactionId || null, financialOperationId || null,
          verdict.score, verdict.level, JSON.stringify(verdict.reasons), amount
        ]
      );
    }
    return verdict;
  } catch (e) {
    return { score: 0, level: "low", reasons: [], error: e.message };
  }
}

module.exports = { scoreOperation, buildContext, evaluateAndRecord, MEDIUM, HIGH };
