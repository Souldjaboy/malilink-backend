"use strict";

/**
 * Test de joignabilité d'une caméra ou d'un enregistreur.
 *
 * Ce que fait le test : ouvrir une connexion TCP vers l'adresse et le port
 * déclarés, puis la refermer. Aucune authentification, aucun échange : il dit
 * « le port répond » ou « ne répond pas », rien de plus. Il ne prétend pas
 * que l'équipement est une caméra, ni que le flux vidéo fonctionne.
 *
 * Pourquoi autant de gardes : c'est le serveur qui se connecte, vers une
 * adresse fournie par un client. Sans garde, un client pourrait faire sonder
 * par le serveur SON réseau interne (base de données, métadonnées du cloud,
 * services locaux). Donc :
 *   - adresses privées, locales, de lien et réservées : refusées ;
 *   - le nom est résolu UNE fois, on vérifie TOUTES ses adresses, puis on se
 *     connecte à l'adresse vérifiée (pas de second DNS : pas de rebinding) ;
 *   - seuls les ports usuels des caméras et enregistreurs sont sondés ;
 *   - délai court, débit limité par société.
 *
 * Conséquence assumée : une caméra sur le réseau local d'une boutique
 * (192.168.x.x) n'est pas joignable depuis le serveur, et l'outil le dit au
 * lieu de faire semblant.
 */

const net = require("net");
const dns = require("dns").promises;

const PORTS_AUTORISES = new Set([80, 443, 554, 8000, 8080, 8443, 8554, 8899, 34567, 37777]);
const DELAI_MS = 4000;

const CONNECTEURS = {
  onvif: { label: "ONVIF", port: 80 },
  rtsp: { label: "RTSP", port: 554 },
  hikvision: { label: "Hikvision", port: 8000 },
  dahua: { label: "Dahua", port: 37777 },
  other: { label: "Autre", port: null },
};

function ipv4EnEntier(ip) {
  return ip.split(".").reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function dansPlage(ip, base, bits) {
  const masque = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4EnEntier(ip) & masque) === (ipv4EnEntier(base) & masque);
}

const PLAGES_V4_INTERDITES = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
];

/** L'adresse est-elle privée, locale ou réservée ? */
function adresseInterdite(ip) {
  if (net.isIPv4(ip)) return PLAGES_V4_INTERDITES.some(([base, bits]) => dansPlage(ip, base, bits));
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    const mappee = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mappee) return adresseInterdite(mappee[1]);
    return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd")
      || v.startsWith("fe8") || v.startsWith("fe9") || v.startsWith("fea") || v.startsWith("feb")
      || v.startsWith("ff") || v.startsWith("2001:db8");
  }
  return true;
}

/** Nom d'hôte ou adresse IP syntaxiquement acceptable. */
function hoteValide(hote) {
  const h = String(hote || "").trim();
  if (!h || h.length > 253) return false;
  if (net.isIP(h)) return true;
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(h);
}

/**
 * Vérifie hôte et port sans se connecter. Renvoie { ok, adresse } ou
 * { ok: false, code, message }.
 */
async function verifierCible(hote, port, { resoudre = (h) => dns.lookup(h, { all: true }) } = {}) {
  const h = String(hote || "").trim();
  const p = Number(port);
  if (!hoteValide(h)) {
    return { ok: false, code: "ADRESSE_INVALIDE", message: "Adresse invalide : indiquez une IP publique ou un nom de domaine." };
  }
  if (!Number.isInteger(p) || !PORTS_AUTORISES.has(p)) {
    return {
      ok: false, code: "PORT_NON_AUTORISE",
      message: `Port ${port || "absent"} non sondé. Ports acceptés : ${[...PORTS_AUTORISES].join(", ")}.`,
    };
  }
  let adresses;
  try {
    adresses = net.isIP(h) ? [h] : (await resoudre(h)).map((a) => a.address);
  } catch {
    return { ok: false, code: "NOM_INTROUVABLE", message: "Ce nom de domaine ne se résout pas." };
  }
  if (!adresses.length) return { ok: false, code: "NOM_INTROUVABLE", message: "Ce nom de domaine ne se résout pas." };
  if (adresses.some(adresseInterdite)) {
    return {
      ok: false, code: "ADRESSE_PRIVEE",
      message: "Adresse privée ou locale : le serveur MaliLink ne peut pas joindre le réseau interne d'un site. "
        + "Pour un suivi à distance, exposez l'enregistreur via une adresse publique ou un nom DDNS, protégé par ses identifiants.",
    };
  }
  return { ok: true, adresse: adresses[0], port: p };
}

/** Connexion TCP brute (aucun échange), avec délai. */
function connexionTcp(adresse, port, delaiMs = DELAI_MS) {
  return new Promise((resolve) => {
    const debut = Date.now();
    const socket = net.connect({ host: adresse, port });
    const fin = (joignable, erreur = "") => {
      socket.destroy();
      resolve({ joignable, duree_ms: Date.now() - debut, erreur });
    };
    socket.setTimeout(delaiMs, () => fin(false, "Délai dépassé"));
    socket.once("connect", () => fin(true));
    socket.once("error", (e) => fin(false, e.code || e.message));
  });
}

// Débit : 30 tests par société et par période de 10 minutes.
const FENETRE_MS = 10 * 60 * 1000;
const MAX_PAR_FENETRE = 30;
const compteurs = new Map();
function debitAutorise(companyId) {
  const maintenant = Date.now();
  const c = compteurs.get(companyId);
  if (!c || c.debut + FENETRE_MS < maintenant) {
    compteurs.set(companyId, { debut: maintenant, n: 1 });
    return true;
  }
  if (c.n >= MAX_PAR_FENETRE) return false;
  c.n += 1;
  return true;
}

module.exports = {
  CONNECTEURS,
  PORTS_AUTORISES,
  adresseInterdite,
  hoteValide,
  verifierCible,
  connexionTcp,
  debitAutorise,
};
