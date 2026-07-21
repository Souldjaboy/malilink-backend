"use strict";

/**
 * Référentiel multi-devises Wallet (préparation).
 *
 * Aujourd'hui MaliLink fonctionne en FCFA (XOF) uniquement. Ce service
 * prépare EUR/USD SANS changer l'architecture : les montants restent
 * stockés dans la devise du wallet ; la conversion est une lecture pure
 * (aucune écriture au grand livre, aucun arrondi silencieux du solde).
 */

const DEFAULT_CURRENCY = "XOF";

async function listCurrencies(db) {
  const { rows } = await db.query(
    `SELECT code, name, symbol, decimals, rate_to_xof, enabled
       FROM wallet_currencies ORDER BY code`
  );
  return rows;
}

async function getCurrency(db, code) {
  const { rows } = await db.query(
    `SELECT code, name, symbol, decimals, rate_to_xof, enabled
       FROM wallet_currencies WHERE code=$1`,
    [String(code || DEFAULT_CURRENCY).toUpperCase()]
  );
  return rows[0] || null;
}

/**
 * Convertit un montant d'une devise vers une autre via le pivot XOF.
 * Lecture seule : ne modifie aucun solde. Renvoie null si devise inconnue.
 */
async function convert(db, amount, from, to) {
  const src = await getCurrency(db, from);
  const dst = await getCurrency(db, to);
  if (!src || !dst) return null;
  const inXof = Number(amount) * Number(src.rate_to_xof);
  const converted = inXof / Number(dst.rate_to_xof);
  return Number(converted.toFixed(dst.decimals));
}

function format(amount, currency) {
  const c = currency || { symbol: "FCFA", decimals: 0 };
  const n = Number(amount).toLocaleString("fr-FR", {
    minimumFractionDigits: c.decimals,
    maximumFractionDigits: c.decimals
  });
  return `${n} ${c.symbol}`;
}

module.exports = { DEFAULT_CURRENCY, listCurrencies, getCurrency, convert, format };
