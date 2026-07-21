"use strict";

/**
 * Moteur de notifications financières (#3).
 *
 * Point d'entrée unique pour toute notification liée au Wallet. Canaux :
 *  - in_app : toujours (via createNotification du monolithe) ;
 *  - email  : si flag wallet_notifications_email actif ET SMTP configuré ;
 *  - sms    : architecture prête (enregistré « queued », aucun envoi tant
 *             qu'un fournisseur n'est branché) ;
 *  - push   : idem SMS.
 *
 * Chaque envoi est journalisé dans wallet_notifications (traçabilité +
 * base d'une file de reprise). Best-effort : n'échoue jamais l'opération.
 */

async function isFlag(db, key) {
  try {
    const { rows } = await db.query(
      `SELECT enabled FROM wallet_feature_flags WHERE flag_key=$1`,
      [key]
    );
    return rows[0]?.enabled === true;
  } catch {
    return false;
  }
}

async function logChannel(db, { userId, event, channel, status, title, message, financialOperationId }) {
  await db
    .query(
      `INSERT INTO wallet_notifications
         (user_id, event, channel, status, title, message, financial_operation_id, sent_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $4='sent' THEN NOW() ELSE NULL END)`,
      [userId, event, channel, status, title || "", message || "", financialOperationId || null]
    )
    .catch(() => {});
}

/**
 * Émet une notification financière multi-canal.
 * @param deps { db, createNotification, sendEmail? }
 * @param n    { userId, companyId?, event, title, message, financialOperationId?, email? }
 */
async function emit(deps, n) {
  const { db, createNotification, sendEmail } = deps;
  const { userId, event, title, message, financialOperationId } = n;

  // 1) In-app — canal garanti.
  if (createNotification && userId) {
    await createNotification({
      user_id: userId,
      title,
      message,
      type: `wallet_${event}`,
      company_id: n.companyId || null
    }).catch(() => {});
    await logChannel(db, { userId, event, channel: "in_app", status: "sent", title, message, financialOperationId });
  }

  // 2) Email — seulement si activé et transport disponible.
  const emailOn = await isFlag(db, "wallet_notifications_email");
  if (emailOn && n.email && typeof sendEmail === "function") {
    try {
      await sendEmail({ to: n.email, subject: title, text: message });
      await logChannel(db, { userId, event, channel: "email", status: "sent", title, message, financialOperationId });
    } catch (e) {
      await logChannel(db, { userId, event, channel: "email", status: "failed", title, message, financialOperationId });
    }
  } else if (n.email) {
    await logChannel(db, { userId, event, channel: "email", status: "skipped", title, message, financialOperationId });
  }

  // 3) SMS — architecture prête, aucun fournisseur branché → queued/skipped.
  const smsOn = await isFlag(db, "wallet_notifications_sms");
  await logChannel(db, {
    userId, event, channel: "sms", status: smsOn ? "queued" : "skipped", title, message, financialOperationId
  });

  // 4) Push — idem.
  const pushOn = await isFlag(db, "wallet_notifications_push");
  await logChannel(db, {
    userId, event, channel: "push", status: pushOn ? "queued" : "skipped", title, message, financialOperationId
  });
}

module.exports = { emit, isFlag };
