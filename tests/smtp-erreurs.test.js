"use strict";

/**
 * Erreurs SMTP : un serveur qui REFUSE l'authentification (Mailpit exigeant
 * un mot de passe, le serveur MaliLink en présente un mauvais).
 * Vérifie : message compréhensible, rien d'annoncé comme « envoyé », code
 * annulé, journal d'envoi exact, AUCUN secret ni code dans les journaux,
 * diagnostic VPS explicite.
 *
 *   docker run -d --rm --name mailpit-auth -p 1026:1025 -v <fichier>:/auth axllent/mailpit \
 *     --smtp-auth-file /auth --smtp-auth-allow-insecure          (fichier : « essai:bon-secret-2026 »)
 *   SMTP_HOST=127.0.0.1 SMTP_PORT=1026 SMTP_USER=essai SMTP_PASS=mauvais-secret-XYZ-2026 SMTP_FROM=noreply@malilink.test \
 *     scripts/test-integration.sh tests/smtp-erreurs.test.js
 */

const fs = require("fs");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { q, appel, verifier, section, terminer } = require("./_outils");

const SECRET = process.env.SMTP_PASS || "";
const JOURNAL = "/tmp/malilink_smtp_erreurs-serveur.log";
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  section("SMTP : AUTHENTIFICATION REFUSÉE PAR LE SERVEUR D'ENVOI");
  const email = `smtp-${crypto.randomBytes(3).toString("hex")}@essai.test`;
  const r = await appel("POST", "/marketplace/customers/register", null, { fullname: "Client SMTP", email, password: "Essai-2026-ok" });
  const d = r.data?.verification?.delivery || {};
  verifier("inscription : envoi NON annoncé comme réussi", r.status === 201 && d.sent !== true && d.statut !== "accepte", JSON.stringify(d));
  verifier("message compréhensible (authentification refusée)", /authentification/i.test(`${d.message || ""} ${d.raison || ""}`), JSON.stringify(d));
  await attendre(65000); // délai anti-renvoi : 60 s
  const renvoi = await appel("POST", "/verification/resend", null, { target_type: "email", target_value: email });
  verifier("renvoi : 503 explicite, success false", renvoi.status === 503 && renvoi.data?.success === false && /authentification|envoi/i.test(renvoi.data?.error || renvoi.data?.message || ""), JSON.stringify(renvoi.data));
  const codes = await q(`SELECT used_at FROM verification_codes WHERE LOWER(target_value)=LOWER($1) ORDER BY id DESC`, [email]);
  verifier("aucun code non envoyé ne reste utilisable", codes.length > 0 && codes.every((c) => c.used_at), JSON.stringify(codes));
  const log = await q(`SELECT status, error, recipient_masked FROM email_delivery_log ORDER BY id DESC LIMIT 2`);
  verifier("journal d'envoi : statut « echec », raison exacte, adresse masquée", log.length > 0 && log.every((l) => l.status === "echec" && /authentification/.test(l.error || "") && !String(l.recipient_masked).includes(email)), JSON.stringify(log));

  const journal = fs.readFileSync(JOURNAL, "utf8");
  verifier("journaux du serveur : ni mot de passe SMTP, ni code à 6 chiffres", SECRET.length > 8 && !journal.includes(SECRET) && !/\b\d{6}\b/.test(journal.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "")), journal.split("\n").filter((l) => /SMTP|EMAIL/i.test(l)).slice(-3).join(" | "));

  let sortie = "";
  try { sortie = execFileSync("node", ["scripts/comptes/diagnostic-email.js"], { env: process.env, encoding: "utf8" }); } catch (e) { sortie = `${e.stdout || ""}${e.stderr || ""}`; }
  verifier("diagnostic VPS : SMTP_EN_ECHEC, raison claire, aucun secret affiché", /SMTP_EN_ECHEC/.test(sortie) && /authentification/i.test(sortie) && !sortie.includes(SECRET), sortie.slice(0, 400));
  await terminer();
}

main().catch(async (e) => { console.error(e); await terminer(); });
