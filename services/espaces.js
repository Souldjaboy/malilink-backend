"use strict";

/**
 * Espaces (tenants) des comptes.
 *
 *   tenant_id  : l'espace produit (malilink, hafiya, triangle) ;
 *   company_id : l'organisation (société, école) À L'INTÉRIEUR d'un espace.
 *
 * Espace d'une REQUÊTE, établi par le serveur :
 *   1. domaine reconnu (liste exacte ci-dessous, frontières de sous-domaine
 *      respectées) — seul l'en-tête Host compte : X-Forwarded-Host est
 *      transmis tel quel par un proxy et n'est donc jamais une preuve ;
 *   2. sinon l'espace fixé par le déploiement (DEFAULT_TENANT_ID) ;
 *   3. sinon « défaut » (triangle).
 *   Un en-tête ou paramètre client (x-tenant-id…) ne remplace JAMAIS un espace
 *   établi par le domaine ou le déploiement : s'il diffère, la requête est
 *   invalide. Il n'est retenu que lorsque rien n'est établi.
 *
 * Espace d'un COMPTE, établi en base :
 *   - compte d'une société → l'espace de cette société ;
 *   - compte sans société → users.account_tenant_id, posé à l'inscription ou
 *     par une ATTRIBUTION ADMINISTRATIVE explicite et journalisée
 *     (scripts/comptes/attribuer-espace.js). Jamais déduit du site utilisé.
 *   Sans appartenance établie : aucune session (ESPACE_NON_ETABLI).
 */

const ESPACES = new Set(["triangle", "malilink", "hafiya"]);

// Domaines reconnus : domaine exact ou sous-domaine (« www. »…), jamais par inclusion.
const DOMAINES = [
  ["malilinkglobal.com", "malilink"],
  ["malilink.trianglewmspro.com", "malilink"],
  ["hafiyalab.com", "hafiya"],
  ["afia.trianglewmspro.com", "hafiya"],
];

const MESSAGE_NON_ETABLI =
  "Ce compte n'est rattaché à aucun espace. Pour votre sécurité, l'administration MaliLink doit confirmer votre espace "
  + "avant toute connexion : contactez le support en indiquant l'email ou le téléphone du compte.";

function normaliser(valeur) {
  const v = String(valeur || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return ESPACES.has(v) ? v : "";
}

/* Nom d'hôte de l'en-tête Host, sans port ni point final. */
function hoteDe(req) {
  const brut = String(req?.headers?.host || "").trim().toLowerCase();
  const v6 = /^\[([^\]]+)\](?::\d+)?$/.exec(brut);
  return (v6 ? v6[1] : brut.replace(/:\d+$/, "")).replace(/\.$/, "");
}

function espaceDuDomaine(hote) {
  for (const [domaine, tenant] of DOMAINES) {
    if (hote === domaine || hote.endsWith(`.${domaine}`)) return tenant;
  }
  return "";
}

/* Espace établi par le serveur : domaine, sinon déploiement, sinon « défaut ». */
function espaceServeur(req) {
  const parDomaine = espaceDuDomaine(hoteDe(req));
  if (parDomaine) return { tenant: parDomaine, source: "domaine" };
  const deploiement = normaliser(process.env.DEFAULT_TENANT_ID);
  if (deploiement) return { tenant: deploiement, source: "deploiement" };
  return { tenant: "triangle", source: "defaut" };
}

/* Espace de la requête : celui du serveur ; un en-tête client ne peut que le confirmer. */
function espaceDeRequete(req) {
  const serveur = espaceServeur(req);
  const brut = req?.headers?.["x-tenant-id"] || req?.headers?.["x-app-product"] || req?.headers?.["x-product-id"] || req?.query?.tenant_id;
  if (!brut) return serveur;
  const demande = normaliser(brut);
  if (!demande) return { tenant: "__invalid__", source: "invalide" };
  if (serveur.source !== "defaut") return demande === serveur.tenant ? serveur : { tenant: "__invalid__", source: "conflit" };
  return { tenant: demande, source: "entete" };
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
  return t ? { tenant: t, source: compte.account_tenant_source || "compte" } : { tenant: null, source: "non_etabli" };
}

/**
 * Espace d'une connexion : celui du compte, qui doit être celui de la requête.
 * demande (facultatif) : espace déjà établi par le serveur (état OAuth signé).
 * → { tenant, source } ou { status, error, code }.
 */
async function etablirEspaceConnexion(db, req, user, demande = espaceDeRequete(req)) {
  if (!ESPACES.has(demande.tenant)) return { status: 400, error: "Espace de la requête invalide.", code: "ESPACE_INVALIDE" };
  const espace = await espaceDuCompte(db, user);
  if (espace.refus) return { status: 403, error: espace.refus, code: espace.code };
  if (!espace.tenant) return { status: 403, error: MESSAGE_NON_ETABLI, code: "ESPACE_NON_ETABLI" };
  if (espace.tenant !== demande.tenant) return { status: 403, error: "Ce compte appartient à un autre espace.", code: "AUTRE_ESPACE" };
  return { tenant: espace.tenant, source: espace.source };
}

/**
 * Attribution administrative d'un espace à un compte sans société, jamais
 * rattaché : transaction, verrou, journal (account_tenant_assignments +
 * audit_logs). Refuse un compte d'une société ou déjà rattaché.
 * → { ok, assignmentId } ou { ok:false, raison }.
 */
async function attribuer(pool, { userId, tenant, parId, motif, preuve = "attestation_administrateur", source = "script_vps" }) {
  if (!ESPACES.has(tenant)) return { ok: false, raison: "espace invalide" };
  if (String(motif || "").trim().length < 10) return { ok: false, raison: "motif obligatoire (10 caractères au moins)" };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const u = (await client.query("SELECT id, company_id, account_tenant_id FROM users WHERE id=$1 FOR UPDATE", [userId])).rows[0];
    if (!u) { await client.query("ROLLBACK"); return { ok: false, raison: "compte introuvable" }; }
    if (u.company_id) { await client.query("ROLLBACK"); return { ok: false, raison: "compte rattaché à une société (espace de la société)" }; }
    if (u.account_tenant_id) { await client.query("ROLLBACK"); return { ok: false, raison: `déjà rattaché à l'espace ${u.account_tenant_id}` }; }
    await client.query(
      `UPDATE users SET account_tenant_id=$2, account_tenant_source='attribution_admin', account_tenant_set_at=NOW(), account_tenant_set_by=$3
        WHERE id=$1`, [userId, tenant, parId || null]);
    const a = (await client.query(
      `INSERT INTO account_tenant_assignments (user_id, tenant_id, previous_tenant_id, assigned_by, reason, evidence, source)
       VALUES ($1,$2,NULL,$3,$4,$5,$6) RETURNING id`, [userId, tenant, parId || null, String(motif).trim().slice(0, 500), String(preuve).slice(0, 200), source])).rows[0];
    await client.query(
      `INSERT INTO audit_logs (user_id, company_id, action, entity_type, entity_id, details)
       VALUES ($1, NULL, 'attribution_espace_compte', 'user', $2, $3)`,
      [parId || null, String(userId), JSON.stringify({ tenant_id: tenant, assignment_id: a.id, preuve, source })]);
    await client.query("COMMIT");
    return { ok: true, assignmentId: a.id };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/* Société existante dans cet espace ? */
async function societeDansEspace(db, companyId, tenant) {
  const { rows } = await db.query("SELECT tenant_id FROM companies WHERE id=$1", [companyId]);
  return Boolean(rows[0]) && normaliser(rows[0].tenant_id) === tenant;
}

/* Utilisateur : « oui » (appartenance PROUVÉE à cet espace), « non » (autre
   espace), « non_etabli » (compte sans société jamais rattaché), « introuvable ».
   Toute action d'un administrateur exige « oui ». */
async function utilisateurDansEspace(db, userId, tenant) {
  const { rows } = await db.query("SELECT id, company_id, account_tenant_id, account_tenant_source FROM users WHERE id=$1", [userId]);
  if (!rows[0]) return "introuvable";
  const espace = await espaceDuCompte(db, rows[0]);
  if (espace.refus) return "non";
  if (!espace.tenant) return "non_etabli";
  return espace.tenant === tenant ? "oui" : "non";
}

module.exports = {
  ESPACES, DOMAINES, MESSAGE_NON_ETABLI, normaliser, hoteDe, espaceDuDomaine, espaceServeur, espaceDeRequete,
  espaceDuCompte, etablirEspaceConnexion, attribuer, societeDansEspace, utilisateurDansEspace,
};
