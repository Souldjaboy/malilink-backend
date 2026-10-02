"use strict";

/**
 * Montant en lettres (français), pour les factures en FCFA.
 * Règles : « vingt et un », « soixante et onze », « quatre-vingts » (pluriel
 * seulement en fin de nombre), « cent » / « cents », « mille » invariable,
 * « million(s) », « milliard(s) ».
 */

const UNITES = ["zéro", "un", "deux", "trois", "quatre", "cinq", "six", "sept", "huit", "neuf", "dix",
  "onze", "douze", "treize", "quatorze", "quinze", "seize", "dix-sept", "dix-huit", "dix-neuf"];
const DIZAINES = ["", "", "vingt", "trente", "quarante", "cinquante", "soixante", "soixante", "quatre-vingt", "quatre-vingt"];

function moinsDeCent(n, fin) {
  if (n < 20) return UNITES[n];
  const d = Math.floor(n / 10);
  const u = n % 10;
  if (d === 7 || d === 9) {
    const reste = 10 + u;
    const liaison = d === 7 && u === 1 ? " et " : "-";
    return `${DIZAINES[d]}${liaison}${UNITES[reste]}`;
  }
  if (u === 0) return d === 8 ? (fin ? "quatre-vingts" : "quatre-vingt") : DIZAINES[d];
  if (u === 1 && d !== 8) return `${DIZAINES[d]} et un`;
  return `${DIZAINES[d]}-${UNITES[u]}`;
}

function moinsDeMille(n, fin) {
  const c = Math.floor(n / 100);
  const r = n % 100;
  const parties = [];
  if (c === 1) parties.push("cent");
  else if (c > 1) parties.push(`${UNITES[c]} ${r === 0 && fin ? "cents" : "cent"}`);
  if (r > 0 || c === 0) parties.push(moinsDeCent(r, fin));
  return parties.join(" ");
}

function nombreEnLettres(nombre) {
  let n = Math.floor(Math.abs(Number(nombre) || 0));
  if (n === 0) return "zéro";
  const groupes = [
    [1_000_000_000, "milliard"],
    [1_000_000, "million"],
    [1000, "mille"],
  ];
  const parties = [];
  for (const [valeur, nom] of groupes) {
    const q = Math.floor(n / valeur);
    n %= valeur;
    if (!q) continue;
    if (nom === "mille") parties.push(q === 1 ? "mille" : `${moinsDeMille(q, false)} mille`);
    else parties.push(`${moinsDeMille(q, false)} ${nom}${q > 1 ? "s" : ""}`);
  }
  if (n > 0) parties.push(moinsDeMille(n, true));
  const texte = parties.join(" ");
  return Number(nombre) < 0 ? `moins ${texte}` : texte;
}

/** « Soixante-quinze mille francs CFA » */
function montantEnLettres(montant) {
  const t = nombreEnLettres(Math.round(Number(montant) || 0));
  return `${t.charAt(0).toUpperCase()}${t.slice(1)} francs CFA`;
}

module.exports = { nombreEnLettres, montantEnLettres };
