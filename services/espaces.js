"use strict";

/**
 * Espaces (tenants) des comptes.
 *
 *   tenant_id  : l'espace produit (malilink, hafiya, triangle) ;
 *   company_id : l'organisation (société, école) À L'INTÉRIEUR d'un espace.
 *
 * L'espace d'un compte est établi côté serveur, jamais par le client :
 *   - compte rattaché à une société → l'espace de cette société ;
 *   - compte sans société → users.account_tenant_id, posé à l'inscription,
 *     ou au premier login d'un ancien compte sur le site d'un espace
 *     (rattachement journalisé, et seulement si l'espace de la requête vient
 *     du serveur : domaine ou configuration du déploiement, jamais d'un
 *     en-tête ni d'une valeur par défaut).
 * Le jeton porte cet espace ; chaque requête doit venir du même espace.
 */

const ESPACES = new Set(["triangle", "malilink", "hafiya"]);

function normaliser(valeur) {
  const v = String(valeur || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return ESPACES.has(v) ? v : "";
}

/* Espace déduit du domaine ou de la configuration du déploiement. */
function espaceServeur(req) {
  const hote = String(req?.headers?.host || req?.headers?.["x-forwarded-host"] || req?.hostname || "")
    .split(",")[0].split(":")[0].toLowerCase();
  if (hote.includes("malilinkglobal.com") || hote.includes("malilink.trianglewmspro.com")) return { tenant: "malilink", source: "domaine" };
  if (hote.includes("hafiyalab.com") || hote.includes("afia.trianglewmspro.com")) return { tenant: "hafiya", source: "domaine" };
  const deploiement = normaliser(process.env.DEFAULT_TENANT_ID);
  if (deploiement) return { tenant: deploiement, source: "deploiement" };
  return { tenant: "triangle", source: "defaut" };
}

/* Espace de la requête : un en-tête explicite prime (clients API), sinon le
   serveur. Un en-tête invalide rend la requête invalide. */
function espaceDeRequete(req) {
  const brut = req?.headers?.["x-tenant-id"] || req?.headers?.["x-app-product"] || req?.headers?.["x-product-id"] || req?.query?.tenant_id;
  if (brut) {
    const t = normaliser(brut);
    return t ? { tenant: t, source: "entete" } : { tenant: "__invalid__", source: "invalide" };
  }
  return espaceServeur(req);
}

/* Espace d'un compte d'après la base (user : id, company_id, account_tenant_id). */
async function espaceDuCompte(db, user) {
  if (user.company_id) {
    const { rows } = await db.query("SELECT tenant_id FROM companies WHERE id=$1", [user.company_id]);
    const t = normaliser(rows[0]?.tenant_id);
    if (!t) return { refus: "L'espace de votre société n'est pas défini : contactez l'administration.", code: "ESPACE_SOCIETE_INDEFINI" };
    return { tenant: t, source: "societe" };
  }
  let compte = user;
  if (!("account_tenant_id" in user)) {
    compte = (await db.query("SELECT account_tenant_id, account_tenant_source FROM users WHERE id=$1", [user.id])).rows[0] || {};
  }
  const t = normaliser(compte.account_tenant_id);
  return t ? { tenant: t, source: compte.account_tenant_source || "compte" } : { tenant: null, source: "non_rattache" };
}

/* Rattache un compte sans société à un espace (une seule fois). */
async function rattacher(db, userId, tenant, source) {
  const { rows } = await db.query(
    `UPDATE users SET account_tenant_id=$2, account_tenant_source=$3, account_tenant_set_at=NOW()
      WHERE id=$1 AND company_id IS NULL AND account_tenant_id IS NULL RETURNING id`,
    [userId, tenant, source]);
  return Boolean(rows[0]);
}

/**
 * Espace d'une connexion : celui du compte, qui doit être celui de la requête.
 * demande (facultatif) : { tenant, source } déjà établi par le serveur
 * (ex. espace signé dans l'état OAuth) ; sinon l'espace de la requête.
 * → { tenant, source, rattache } ou { status, error, code }.
 */
async function etablirEspaceConnexion(db, req, user, demande = espaceDeRequete(req)) {
  if (!ESPACES.has(demande.tenant)) return { status: 400, error: "Espace de la requête invalide.", code: "ESPACE_INVALIDE" };
  const espace = await espaceDuCompte(db, user);
  if (espace.refus) return { status: 403, error: espace.refus, code: espace.code };
  if (!espace.tenant) {
    // Ancien compte sans société : rattachement explicite à l'espace du site
    // utilisé, uniquement si cet espace est établi par le serveur.
    const serveur = demande.source === "entete" ? espaceServeur(req) : demande;
    if (!["domaine", "deploiement"].includes(serveur.source) || serveur.tenant !== demande.tenant) {
      return { status: 403, error: "Connectez-vous depuis le site de votre espace pour rattacher ce compte.", code: "ESPACE_A_CONFIRMER" };
    }
    await rattacher(db, user.id, demande.tenant, "premiere_connexion");
    const relu = await espaceDuCompte(db, { id: user.id, company_id: null });
    if (relu.tenant !== demande.tenant) return { status: 403, error: "Ce compte appartient à un autre espace.", code: "AUTRE_ESPACE" };
    return { tenant: relu.tenant, source: "premiere_connexion", rattache: true };
  }
  if (espace.tenant !== demande.tenant) return { status: 403, error: "Ce compte appartient à un autre espace.", code: "AUTRE_ESPACE" };
  return { tenant: espace.tenant, source: espace.source, rattache: false };
}

/* Société existante dans cet espace ? */
async function societeDansEspace(db, companyId, tenant) {
  const { rows } = await db.query("SELECT tenant_id FROM companies WHERE id=$1", [companyId]);
  return Boolean(rows[0]) && normaliser(rows[0].tenant_id) === tenant;
}

/* Utilisateur : « oui » (même espace), « non » (autre espace),
   « non_rattache » (ancien compte sans société jamais rattaché), « introuvable ». */
async function utilisateurDansEspace(db, userId, tenant) {
  const { rows } = await db.query("SELECT id, company_id, account_tenant_id, account_tenant_source FROM users WHERE id=$1", [userId]);
  if (!rows[0]) return "introuvable";
  const espace = await espaceDuCompte(db, rows[0]);
  if (espace.refus) return "non";
  if (!espace.tenant) return "non_rattache";
  return espace.tenant === tenant ? "oui" : "non";
}

module.exports = { ESPACES, normaliser, espaceServeur, espaceDeRequete, espaceDuCompte, rattacher, etablirEspaceConnexion, societeDansEspace, utilisateurDansEspace };
