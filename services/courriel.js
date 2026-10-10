"use strict";

/**
 * Envoi des emails transactionnels (codes de vérification, réinitialisation,
 * changement d'adresse) avec l'identité du produit de la requête.
 *
 * Trois états bien distincts, jamais confondus :
 *   - le code est GÉNÉRÉ (base de données) ;
 *   - l'email est ACCEPTÉ par le serveur SMTP (statut « accepte ») — c'est
 *     tout ce qu'un serveur d'envoi peut confirmer ;
 *   - la RÉCEPTION n'est prouvée que lorsque le destinataire saisit le code
 *     ou clique le lien (route de vérification).
 *
 * Aucun code ni contenu de message n'est journalisé : le journal
 * email_delivery_log ne garde que l'objet de l'envoi, l'adresse masquée et
 * la réponse du serveur.
 */

const nodemailer = require("nodemailer");

const IDENTITES = {
  malilink: () => ({
    nom: "MaliLink Global",
    url: (process.env.PUBLIC_BASE_URL || process.env.FRONTEND_URL || "https://malilinkglobal.com").replace(/\/$/, ""),
    couleur: "#0f1b3d",
    accent: "#d4a23c",
  }),
  triangle: () => ({
    nom: "Triangle WMS Pro",
    url: (process.env.APP_URL || "https://trianglewmspro.com").replace(/\/$/, ""),
    couleur: "#111827",
    accent: "#eab308",
  }),
  hafiya: () => ({
    nom: "HAFIYA Laboratoire",
    url: "https://hafiyalab.com",
    couleur: "#0b3d5c",
    accent: "#0ea5e9",
  }),
};

/** Identité du produit (nom, URL publique, couleurs) d'après le tenant. */
function identite(tenant) {
  const t = String(tenant || process.env.DEFAULT_TENANT_ID || "malilink").toLowerCase();
  return (IDENTITES[t] || IDENTITES.malilink)();
}

/** a***@g***.com — jamais l'adresse complète dans un journal ou une réponse. */
function masquer(adresse) {
  const s = String(adresse || "").trim();
  const [local, domaine] = s.split("@");
  if (!domaine) return s ? `${s.slice(0, 2)}***` : "";
  const [nomDomaine, ...ext] = domaine.split(".");
  return `${local.slice(0, 1)}***@${nomDomaine.slice(0, 1)}***.${ext.join(".") || "?"}`;
}

function configurationSmtp() {
  const host = String(process.env.SMTP_HOST || "").trim();
  const user = String(process.env.SMTP_USER || "").trim();
  const pass = String(process.env.SMTP_PASS || "");
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "true" : port === 465;
  return { host, user, pass, port, secure, from: String(process.env.SMTP_FROM || user).trim(), complete: Boolean(host && user && pass) };
}

let transportEnCache = null;
let cleTransport = "";
function transport(config) {
  const cle = `${config.host}|${config.port}|${config.secure}|${config.user}`;
  if (!transportEnCache || cle !== cleTransport) {
    transportEnCache = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.pass },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
    });
    cleTransport = cle;
  }
  return transportEnCache;
}

/* Raison lisible d'un échec SMTP (sans secret). */
function raisonEchec(e) {
  const code = String(e?.code || "");
  const reponse = String(e?.response || e?.message || "").slice(0, 200);
  if (code === "EAUTH") return { raison: "authentification SMTP refusée (identifiant ou mot de passe)", detail: reponse };
  if (["ECONNECTION", "ETIMEDOUT", "ESOCKET", "ECONNREFUSED", "EDNS"].includes(code)) return { raison: "serveur SMTP injoignable", detail: reponse };
  if (code === "EENVELOPE") return { raison: "adresse refusée par le serveur SMTP", detail: reponse };
  if (code === "EMESSAGE") return { raison: "message refusé par le serveur SMTP", detail: reponse };
  return { raison: "échec d'envoi SMTP", detail: reponse };
}

/* Expéditeur : on ajoute le nom du produit si SMTP_FROM n'en porte pas. */
function expediteur(config, id) {
  if (/<.+>/.test(config.from)) return config.from;
  return { name: id.nom, address: config.from };
}

async function journaliser(pool, entree) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO email_delivery_log (purpose, user_id, company_id, recipient_masked, status, provider_message_id, smtp_response, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [entree.but, entree.userId || null, entree.companyId || null, masquer(entree.to), entree.statut,
       entree.messageId || null, entree.reponse || null, entree.erreur || null]
    );
  } catch { /* le journal ne bloque jamais un envoi */ }
}

/**
 * Envoie un email. Résultat :
 *   { statut: "accepte" | "refuse" | "non_configure" | "echec", accepte: bool,
 *     message_id, reponse, raison }
 */
async function envoyerCourriel(pool, { to, sujet, texte, html, tenant, but = "transactionnel", userId, companyId }) {
  const config = configurationSmtp();
  const id = identite(tenant);
  if (!config.complete) {
    const r = { statut: "non_configure", accepte: false, raison: "SMTP non configuré sur le serveur (SMTP_HOST, SMTP_USER, SMTP_PASS)" };
    await journaliser(pool, { but, to, userId, companyId, statut: r.statut, erreur: r.raison });
    return r;
  }
  try {
    const info = await transport(config).sendMail({ from: expediteur(config, id), to, subject: sujet, text: texte, html });
    const acceptes = (info.accepted || []).map((a) => String(a).toLowerCase());
    const accepte = acceptes.includes(String(to).toLowerCase());
    const r = {
      statut: accepte ? "accepte" : "refuse",
      accepte,
      message_id: info.messageId || null,
      reponse: String(info.response || "").slice(0, 200),
      raison: accepte ? "" : "destinataire refusé par le serveur SMTP",
    };
    await journaliser(pool, { but, to, userId, companyId, statut: r.statut, messageId: r.message_id, reponse: r.reponse, erreur: r.raison });
    return r;
  } catch (e) {
    const { raison, detail } = raisonEchec(e);
    console.error(`EMAIL ${but} : échec (${raison}) vers ${masquer(to)}`);
    await journaliser(pool, { but, to, userId, companyId, statut: "echec", reponse: detail, erreur: raison });
    return { statut: "echec", accepte: false, raison };
  }
}

/** Vérifie connexion + authentification SMTP sans rien envoyer. */
async function verifierSmtp() {
  const config = configurationSmtp();
  const resume = { host: config.host || "(absent)", port: config.port, secure: config.secure, user: config.user ? masquer(config.user) : "(absent)",
    from: config.from ? masquer(config.from) : "(absent)", mot_de_passe: config.pass ? "présent" : "(absent)" };
  if (!config.complete) return { ok: false, resume, raison: "configuration incomplète" };
  try {
    await transport(config).verify();
    return { ok: true, resume };
  } catch (e) {
    return { ok: false, resume, ...raisonEchec(e) };
  }
}

const echapper = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Message « code à usage unique » à l'identité du produit (texte + HTML). */
function modeleCode({ tenant, titre, intro, code, minutes, lien, libelleLien, piedDePage }) {
  const id = identite(tenant);
  const texte = [
    `${id.nom} — ${titre}`, "", intro, "", `Code : ${code}`, `Ce code expire dans ${minutes} minutes et ne peut servir qu'une fois.`,
    lien ? `\nLien sécurisé : ${lien}` : "",
    "", piedDePage || "Si vous n'êtes pas à l'origine de cette demande, ignorez ce message.", "", id.url,
  ].join("\n");
  const html = `<!doctype html><html lang="fr"><body style="margin:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827">
  <div style="max-width:520px;margin:24px auto;background:#ffffff;border-radius:14px;overflow:hidden">
    <div style="background:${id.couleur};padding:18px 24px;color:#ffffff;font-size:18px;font-weight:700">${echapper(id.nom)}</div>
    <div style="padding:24px">
      <h1 style="margin:0 0 12px;font-size:20px">${echapper(titre)}</h1>
      <p style="margin:0 0 16px;line-height:1.5">${echapper(intro)}</p>
      <p style="margin:0 0 8px;font-size:30px;font-weight:700;letter-spacing:6px">${echapper(code)}</p>
      <p style="margin:0 0 20px;color:#6b7280;font-size:13px">Ce code expire dans ${Number(minutes)} minutes et ne peut servir qu'une fois.</p>
      ${lien ? `<p style="margin:0 0 20px"><a href="${echapper(lien)}" style="display:inline-block;background:${id.accent};color:#111827;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:10px">${echapper(libelleLien || "Ouvrir le lien sécurisé")}</a></p>` : ""}
      <p style="margin:0;color:#6b7280;font-size:12px">${echapper(piedDePage || "Si vous n'êtes pas à l'origine de cette demande, ignorez ce message.")}</p>
    </div>
    <div style="padding:12px 24px;background:#f9fafb;color:#9ca3af;font-size:12px">${echapper(id.url)}</div>
  </div></body></html>`;
  return { texte, html };
}

module.exports = { identite, masquer, envoyerCourriel, verifierSmtp, modeleCode, configurationSmtp };
