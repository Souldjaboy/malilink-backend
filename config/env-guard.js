"use strict";

/**
 * Vérification des variables d'environnement sensibles (#4).
 *
 * Au démarrage, contrôle la présence et la cohérence des secrets critiques.
 * En PRODUCTION : bloque le démarrage si un secret indispensable manque ou
 * est laissé à sa valeur de développement. En DEV : émet des avertissements
 * lisibles sans bloquer.
 *
 * N'IMPRIME JAMAIS la valeur d'un secret — seulement son statut.
 */

const WEAK_DEFAULTS = new Set([
  "triangle_wms_secret_key",
  "malilink_wallet_receipts",
  "changeme",
  "secret",
  ""
]);

// Déclaration centralisée des secrets. `critical` = requis en production.
const CHECKS = [
  { key: "JWT_SECRET", critical: true, minLen: 16,
    hint: "Signature des JWT. Générer : openssl rand -hex 32" },
  { key: "DATABASE_URL", critical: true, minLen: 10,
    hint: "Chaîne de connexion PostgreSQL." },
  { key: "WALLET_RECEIPT_SECRET", critical: true, minLen: 16,
    hint: "Signature des reçus Wallet — DOIT être distinct de JWT_SECRET.",
    distinctFrom: "JWT_SECRET" },
  { key: "WALLET_SECRET_ENC_KEY", critical: false, exactBytes: 32,
    hint: "Chiffrement au repos des secrets webhooks (hex 64 ou base64, 32 octets)." }
];

function byteLen(raw) {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex").length;
  const b = Buffer.from(raw, "base64");
  // base64 valide si round-trip cohérent
  return b.toString("base64").replace(/=+$/, "") === raw.replace(/=+$/, "") ? b.length : raw.length;
}

/**
 * @returns {{ ok:boolean, errors:string[], warnings:string[] }}
 */
function checkEnv(env = process.env) {
  const isProd = env.NODE_ENV === "production";
  const errors = [];
  const warnings = [];

  for (const c of CHECKS) {
    const val = env[c.key];

    if (!val) {
      const msg = `${c.key} absent — ${c.hint}`;
      if (c.critical && isProd) errors.push(msg);
      else warnings.push(msg);
      continue;
    }
    if (WEAK_DEFAULTS.has(val)) {
      const msg = `${c.key} utilise une valeur par défaut faible — ${c.hint}`;
      if (c.critical && isProd) errors.push(msg);
      else warnings.push(msg);
    }
    if (c.minLen && val.length < c.minLen) {
      const msg = `${c.key} est trop court (< ${c.minLen} caractères).`;
      if (c.critical && isProd) errors.push(msg);
      else warnings.push(msg);
    }
    if (c.exactBytes && byteLen(val) !== c.exactBytes) {
      warnings.push(`${c.key} devrait faire ${c.exactBytes} octets — ${c.hint}`);
    }
    if (c.distinctFrom && env[c.distinctFrom] && val === env[c.distinctFrom]) {
      const msg = `${c.key} est identique à ${c.distinctFrom} — ils DOIVENT être distincts.`;
      if (c.critical && isProd) errors.push(msg);
      else warnings.push(msg);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Applique la vérification au démarrage : logue, et en production sort du
 * process si un secret critique est invalide.
 */
function enforceEnv(env = process.env, { exit = true } = {}) {
  const { ok, errors, warnings } = checkEnv(env);
  for (const w of warnings) console.warn(`⚠️  [env] ${w}`);
  for (const e of errors) console.error(`❌ [env] ${e}`);
  if (!ok && env.NODE_ENV === "production" && exit) {
    console.error("Démarrage refusé : secrets critiques invalides en production.");
    process.exit(1);
  }
  return { ok, errors, warnings };
}

module.exports = { checkEnv, enforceEnv, CHECKS };
