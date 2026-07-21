"use strict";

/**
 * Coffre à secrets — chiffrement au repos (#4).
 *
 * Protège les secrets applicatifs (secrets de webhooks notamment) stockés
 * en base. Utilise AES-256-GCM avec une clé maître fournie par
 * l'environnement (WALLET_SECRET_ENC_KEY : 32 octets en hex ou base64).
 *
 * Comportement :
 *  - clé présente  → chiffrement réel, format "aes-256-gcm" (iv:tag:data) ;
 *  - clé absente   → dégradation contrôlée : renvoie le secret en clair avec
 *                    le format "plain" (aucune perte de fonctionnalité en
 *                    dev), tout en signalant qu'il faut configurer la clé.
 *
 * Le secret déchiffré ne sort JAMAIS via l'API (voir routes/wallet.js).
 */

const crypto = require("crypto");

const ALGO = "aes-256-gcm";

function loadKey() {
  const raw = process.env.WALLET_SECRET_ENC_KEY;
  if (!raw) return null;
  // Accepte hex (64 chars) ou base64.
  let key;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, "hex");
  else key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error("WALLET_SECRET_ENC_KEY doit faire 32 octets (hex 64 ou base64).");
  }
  return key;
}

function isEnabled() {
  return !!process.env.WALLET_SECRET_ENC_KEY;
}

/**
 * Chiffre une valeur. Renvoie { format, value }.
 *  - avec clé : format "aes-256-gcm", value = "ivHex:tagHex:cipherHex"
 *  - sans clé : format "plain", value = secret en clair
 */
function encrypt(plaintext) {
  const key = loadKey();
  if (!key) return { format: "plain", value: String(plaintext) };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    format: ALGO,
    value: `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`
  };
}

/**
 * Déchiffre une valeur selon son format déclaré.
 * @param format "plain" | "aes-256-gcm"
 */
function decrypt(value, format) {
  if (!value) return null;
  if (format !== ALGO) return String(value); // "plain" ou héritage
  const key = loadKey();
  if (!key) throw new Error("Secret chiffré mais WALLET_SECRET_ENC_KEY absente : impossible à déchiffrer.");
  const [ivHex, tagHex, dataHex] = String(value).split(":");
  if (!ivHex || !tagHex || !dataHex) throw new Error("Format de secret chiffré invalide.");
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  const dec = Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]);
  return dec.toString("utf8");
}

module.exports = { encrypt, decrypt, isEnabled, ALGO };
