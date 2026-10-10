#!/usr/bin/env node
"use strict";

/**
 * Diagnostic des emails MaliLink (aucun secret affiché).
 * À lancer dans le dossier backend de la release active ; le script de
 * déploiement lui transmet les variables SMTP_* du processus PM2.
 *
 *   node scripts/comptes/diagnostic-email.js                 configuration + connexion + authentification
 *   node scripts/comptes/diagnostic-email.js --envoyer a@b.c  + envoi d'un email de test réel
 */

const path = require("path");
const dns = require("dns").promises;
require("dotenv").config({ path: path.join(process.cwd(), ".env") });
const courriel = require(path.join(__dirname, "..", "..", "services", "courriel"));

const args = process.argv.slice(2);
const destinataire = args.includes("--envoyer") ? args[args.indexOf("--envoyer") + 1] : null;

(async () => {
  const v = await courriel.verifierSmtp();
  console.log("Configuration SMTP effective :");
  for (const [k, val] of Object.entries(v.resume)) console.log(`  ${k.padEnd(13)} ${val}`);
  console.log(`  expéditeur affiché  ${courriel.identite("malilink").nom}`);
  console.log(`  URL publique        ${courriel.identite("malilink").url}`);
  if (v.resume.host && v.resume.host !== "(absent)") {
    try { console.log(`  résolution DNS      ${(await dns.lookup(v.resume.host)).address}`); }
    catch { console.log("  résolution DNS      ÉCHEC (nom d'hôte SMTP introuvable)"); }
  }
  console.log(v.ok ? "\nCONNEXION_ET_AUTHENTIFICATION_SMTP_OK" : `\nSMTP_EN_ECHEC : ${v.raison}${v.detail ? ` — ${v.detail}` : ""}`);

  if (process.env.DATABASE_URL) {
    const { Pool } = require("pg");
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const { rows } = await pool.query(`SELECT created_at, purpose, recipient_masked, status, error FROM email_delivery_log ORDER BY id DESC LIMIT 8`);
      console.log("\nDerniers envois journalisés :");
      if (!rows.length) console.log("  (aucun)");
      for (const r of rows) console.log(`  ${new Date(r.created_at).toISOString()} ${r.purpose} ${r.recipient_masked} ${r.status}${r.error ? ` — ${r.error}` : ""}`);
      if (destinataire) {
        const r = await courriel.envoyerCourriel(pool, {
          to: destinataire, tenant: "malilink", but: "diagnostic",
          sujet: "MaliLink Global — test d'envoi",
          texte: "Ceci est un email de test envoyé depuis le serveur MaliLink. Aucune action n'est requise.",
          html: "<p>Ceci est un email de test envoyé depuis le serveur <strong>MaliLink Global</strong>. Aucune action n'est requise.</p>",
        });
        console.log(`\nEnvoi de test à ${courriel.masquer(destinataire)} : ${r.statut}${r.message_id ? ` · id ${r.message_id}` : ""}${r.reponse ? ` · réponse « ${r.reponse} »` : ""}${r.raison ? ` · ${r.raison}` : ""}`);
        console.log(r.accepte
          ? "Le serveur SMTP a ACCEPTÉ le message. La réception n'est prouvée que si l'email arrive dans la boîte (vérifier aussi les indésirables)."
          : "Le message n'a PAS été accepté.");
      }
    } catch (e) {
      console.log(`\n(journal indisponible : ${e.message})`);
    } finally {
      await pool.end();
    }
  }
  process.exit(v.ok ? 0 : 1);
})();
