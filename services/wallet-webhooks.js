"use strict";

/**
 * Webhooks Wallet (#7) — événements sortants vers Orange Money, Wave,
 * banques, ERP, API partenaires.
 *
 * SÉCURITÉ : rien n'est envoyé à l'extérieur par défaut. Un webhook doit
 * être explicitement créé ET activé (enabled=true) ET le flag global
 * wallet_webhooks_enabled actif. Chaque livraison est signée en HMAC-SHA256
 * (en-tête X-MaliLink-Signature) et journalisée (wallet_webhook_deliveries).
 * Ici on ENFILE et on SIGNE ; l'émetteur réseau réel reste branché plus
 * tard (aucune requête sortante non maîtrisée depuis le moteur financier).
 */

const crypto = require("crypto");
const vault = require("./secret-vault");

function sign(secret, payload) {
  return crypto.createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
}

async function globalEnabled(db) {
  try {
    const { rows } = await db.query(
      `SELECT enabled FROM wallet_feature_flags WHERE flag_key='wallet_webhooks_enabled'`
    );
    return rows[0]?.enabled === true;
  } catch {
    return false;
  }
}

/**
 * Enfile un événement pour tous les webhooks actifs abonnés.
 * Best-effort, jamais bloquant pour l'opération financière.
 * @param event  ex "transaction.completed" | "payment.received"
 */
async function enqueueEvent(db, event, payload = {}, financialOperationId = null) {
  try {
    if (!(await globalEnabled(db))) return { queued: 0, reason: "webhooks_disabled" };
    const { rows: hooks } = await db.query(
      `SELECT id, secret, secret_enc, secret_format FROM wallet_webhooks
        WHERE enabled=true AND $1 = ANY(events)`,
      [event]
    );
    let queued = 0;
    for (const h of hooks) {
      // Récupère le secret : chiffré au repos → déchiffré à la volée pour signer.
      const secret =
        h.secret_format && h.secret_format !== "plain"
          ? vault.decrypt(h.secret_enc, h.secret_format)
          : h.secret;
      const body = { event, data: payload, financial_operation_id: financialOperationId, ts: Date.now() };
      const signature = sign(secret, body);
      await db.query(
        `INSERT INTO wallet_webhook_deliveries
           (webhook_id, event, payload, signature, status, financial_operation_id)
         VALUES ($1,$2,$3,$4,'queued',$5)`,
        [h.id, event, JSON.stringify(body), signature, financialOperationId]
      );
      queued += 1;
    }
    return { queued };
  } catch (e) {
    return { queued: 0, error: e.message };
  }
}

module.exports = { sign, enqueueEvent, globalEnabled };
