"use strict";

/**
 * LiveKit côté serveur, partagé par les appels et les directs.
 *
 * - jetonAcces : JWT HS256 signé avec le secret de l'API, limité à UNE
 *   salle, durée courte, droits minimaux (publier ou seulement regarder).
 * - api : service serveur de LiveKit (Twirp) — liste des participants,
 *   exclusion, fermeture de salle — avec un jeton d'administration de salle.
 * - sante : vérification RÉELLE que le serveur média répond (pas seulement
 *   que la configuration existe). Résultat gardé 60 s.
 *
 * Aucun secret n'est jamais renvoyé au navigateur : seulement l'URL wss et
 * des jetons d'accès éphémères.
 */

const crypto = require("crypto");
const jwt = require("jsonwebtoken");

function configuration() {
  const url = String(process.env.LIVEKIT_URL || "").trim();
  const cle = String(process.env.LIVEKIT_API_KEY || "").trim();
  const secret = String(process.env.LIVEKIT_API_SECRET || "").trim();
  if (!/^wss?:\/\//.test(url) || !cle || secret.length < 32) return null;
  // API serveur : adresse interne si fournie (ex. http://127.0.0.1:7880), sinon l'URL publique en http(s).
  const http = String(process.env.LIVEKIT_API_URL || url.replace(/^ws/, "http")).replace(/\/$/, "");
  return { url, cle, secret, http };
}

function jetonAcces(config, { salle, identite, nom, publier = false, sources, ttl = 600, metadonnees }) {
  return jwt.sign(
    {
      name: nom,
      ...(metadonnees ? { metadata: JSON.stringify(metadonnees) } : {}),
      video: {
        room: salle, roomJoin: true, canSubscribe: true, canPublish: Boolean(publier), canPublishData: false,
        ...(publier ? { canPublishSources: sources || ["camera", "microphone"] } : {}),
      },
    },
    config.secret,
    { algorithm: "HS256", issuer: config.cle, subject: identite, jwtid: crypto.randomUUID(), expiresIn: ttl, notBefore: 0 }
  );
}

function jetonAdmin(config, salle) {
  return jwt.sign({ video: { room: salle, roomAdmin: true, roomList: true } }, config.secret,
    { algorithm: "HS256", issuer: config.cle, expiresIn: 60, notBefore: 0 });
}

async function api(config, methode, salle, corps) {
  const r = await fetch(`${config.http}/twirp/livekit.RoomService/${methode}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${jetonAdmin(config, salle)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ room: salle, ...corps }),
    signal: AbortSignal.timeout(5000),
  });
  const texte = await r.text();
  if (!r.ok) {
    const e = new Error(`LiveKit ${methode} : ${r.status} ${texte.slice(0, 120)}`);
    e.status = r.status;
    throw e;
  }
  return texte ? JSON.parse(texte) : {};
}

let santeCache = { at: 0, ok: false, detail: "" };
async function sante(config) {
  if (!config) return { ok: false, detail: "non_configure" };
  if (Date.now() - santeCache.at < 60000) return santeCache;
  let ok = false;
  let detail = "";
  try {
    const r = await fetch(`${config.http}/`, { signal: AbortSignal.timeout(4000) });
    ok = r.ok && /OK/i.test(await r.text());
    detail = ok ? "serveur_joignable" : `reponse_${r.status}`;
  } catch (e) {
    detail = e?.cause?.code === "ENOTFOUND" ? "dns_introuvable" : "serveur_injoignable";
  }
  santeCache = { at: Date.now(), ok, detail };
  return santeCache;
}
const oublierSante = () => { santeCache = { at: 0, ok: false, detail: "" }; };

module.exports = { configuration, jetonAcces, api, sante, oublierSante };
