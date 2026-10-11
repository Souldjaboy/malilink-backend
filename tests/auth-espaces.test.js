"use strict";

/**
 * Authentification et isolation des espaces (tenants).
 *
 *   connexions email, téléphone et OAuth (faux fournisseur local) ;
 *   anciens jetons sans tenant_id ; comptes sans société (inscription,
 *   anciens comptes rattachés au premier login) ; accès entre espaces,
 *   Super Admin compris ; sessions fermées après les changements de mot de
 *   passe ; codes : usage unique, expiration, tentatives.
 *
 *   SMTP_HOST=127.0.0.1 SMTP_PORT=1025 SMTP_USER=essai SMTP_PASS=essai SMTP_FROM=noreply@malilink.test \
 *   INSTAGRAM_CLIENT_ID=essai INSTAGRAM_CLIENT_SECRET=essai-secret \
 *   INSTAGRAM_AUTH_URL=http://127.0.0.1:5098/auth INSTAGRAM_TOKEN_URL=http://127.0.0.1:5098/token \
 *   INSTAGRAM_USERINFO_URL=http://127.0.0.1:5098/me \
 *     scripts/test-integration.sh tests/auth-espaces.test.js
 *
 * Le serveur de test résout les requêtes sans en-tête vers l'espace du
 * déploiement (DEFAULT_TENANT_ID=malilink), comme malilinkglobal.com.
 */

const http = require("http");
const crypto = require("crypto");
const path = require("path");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { execFileSync } = require("child_process");
const { q, appel, appelHote, jeton, verifier, section, creerSociete, terminer, BASE } = require("./_outils");

const MDP = "Essai-2026-ok";
const HACHE = bcrypt.hashSync(MDP, 4);
const A = "malilink";
const B = "hafiya";
const MAILPIT = "http://127.0.0.1:8025/api/v1";
const decoder = (t) => jwt.decode(t) || {};
const alea = () => crypto.randomBytes(3).toString("hex");

// Domaines reconnus des deux espaces éprouvés ; sans domaine, la requête prend
// l'espace du déploiement de test (DEFAULT_TENANT_ID=malilink).
const DOMAINE = { [A]: "malilinkglobal.com", [B]: "hafiyalab.com" };

/* Requête brute ; hote : en-tête Host imposé (espace établi par le domaine). */
async function brut(methode, chemin, { token, corps, entetes = {}, suivre = true, hote } = {}) {
  if (hote) return appelHote(hote, methode, chemin, token, corps, entetes);
  const r = await fetch(`${BASE}${chemin}`, {
    method: methode, redirect: suivre ? "follow" : "manual",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...entetes },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch { /* vide ou redirection */ }
  return { status: r.status, data, location: r.headers.get("location") || "" };
}
const connexion = (identifiant, espace, mdp = MDP) =>
  brut("POST", "/login", { corps: { email: identifiant, password: mdp }, hote: espace ? DOMAINE[espace] : undefined });

async function compte({ nom, companyId = null, role = "customer", espace = null, superAdmin = false, phone = null }) {
  return (await q(
    `INSERT INTO users (fullname, email, phone, password, role, company_id, is_super_admin, is_active,
                        email_verified, phone_verified, account_status, verification_required, account_tenant_id, account_tenant_source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,true,true,$8,'active',false,$9,$10) RETURNING id, email, phone, role, company_id`,
    [nom, `${nom.toLowerCase().replace(/\W/g, "")}-${alea()}@essai.test`, phone, HACHE, role, companyId, superAdmin, Boolean(phone),
      espace, espace ? "inscription" : null]))[0];
}
async function societe(nom, espace) {
  const c = (await q(`INSERT INTO companies (name, business_type, status, subscription_status, tenant_id, email_verified, account_status)
                      VALUES ($1,'ecole','active','active',$2,true,'active') RETURNING id`, [nom, espace]))[0];
  return c.id;
}
async function boite(adresse) {
  const r = await fetch(`${MAILPIT}/search?query=${encodeURIComponent(`to:${adresse}`)}`).then((x) => x.json());
  if (!(r.messages || []).length) return null;
  const m = await fetch(`${MAILPIT}/message/${r.messages[0].ID}`).then((x) => x.json());
  return { texte: m.Text, total: r.messages.length };
}
const codeDe = (texte) => (String(texte).match(/\b(\d{6})\b/) || [])[1];
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
const sansMotDePasse = (data) => !/"password"\s*:|\$2[aby]\$\d\d\$/.test(JSON.stringify(data || {}));

/* Faux fournisseur OAuth (Instagram configurable) : profil choisi par le test. */
let profilOAuth = null;
const fournisseur = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  if (req.url.startsWith("/token")) return res.end(JSON.stringify({ access_token: `jeton-${alea()}` }));
  if (req.url.startsWith("/me")) return res.end(JSON.stringify(profilOAuth || {}));
  res.statusCode = 404; res.end("{}");
});
async function parcoursOAuth(profil, espaceDepart) {
  profilOAuth = profil;
  const depart = await brut("GET", "/auth/social/instagram/start?mode=login", { suivre: false, hote: espaceDepart ? DOMAINE[espaceDepart] : undefined });
  const state = new URL(depart.location).searchParams.get("state");
  const retour = await brut("GET", `/auth/social/instagram/callback?code=essai&state=${encodeURIComponent(state)}`, { suivre: false });
  const url = new URL(retour.location);
  const payload = url.searchParams.get("payload");
  return { etat: decoder(state), url, connexion: payload ? JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) : null, erreur: url.searchParams.get("social_error") };
}

const ctx = {};
async function main() {
  await new Promise((r) => fournisseur.listen(5098, r));
  if (process.env.SMTP_HOST) await fetch(`${MAILPIT}/messages`, { method: "DELETE" }).catch(() => {});

  const ecoleA = await creerSociete({ nom: "École de l'espace A", type: "ecole" });
  await q(`UPDATE companies SET email_verified=true, account_status='active' WHERE id=$1`, [ecoleA.id]);
  await q(`UPDATE users SET password=$1, email_verified=true, account_status='active', verification_required=false WHERE id=$2`, [HACHE, ecoleA.admin.id]);
  const adminA = (await q(`SELECT id, email FROM users WHERE id=$1`, [ecoleA.admin.id]))[0];
  const societeB = await societe("Laboratoire de l'espace B", B);
  const adminB = await compte({ nom: "Admin B", companyId: societeB, role: "admin" });

  section("0. ESPACE DE LA REQUÊTE : DOMAINE EXACT, EN-TÊTES CLIENT ET PROXY");
  {
    const e = async (hote, entetes = {}, chemin = "/espace") => (await appelHote(hote, "GET", chemin, null, null, entetes));
    verifier("malilinkglobal.com et www. : espace malilink établi par le domaine",
      (await e("malilinkglobal.com")).data?.source === "domaine" && (await e("www.malilinkglobal.com")).data?.tenant_id === A);
    verifier("hafiyalab.com : espace hafiya établi par le domaine", (await e("hafiyalab.com")).data?.tenant_id === B);
    const pieges = [];
    for (const h of ["evil-malilinkglobal.com", "malilinkglobal.com.evil.net", "hafiyalab.com.attaquant.io", "xhafiyalab.com"]) {
      const r = await e(h);
      if (r.data?.source === "domaine") pieges.push(`${h} → ${JSON.stringify(r.data)}`);
    }
    verifier("domaines piégés (inclusion, suffixe) : jamais reconnus, espace du déploiement seulement", pieges.length === 0, pieges.join(" ; "));
    const xfh = await e("127.0.0.1", { "x-forwarded-host": "hafiyalab.com" });
    verifier("X-Forwarded-Host fourni par le client : ignoré", xfh.data?.tenant_id === A && xfh.data?.source === "deploiement", JSON.stringify(xfh.data));
    verifier("en-tête x-tenant-id contraire au domaine : requête refusée (400)", (await e("malilinkglobal.com", { "x-tenant-id": B })).status === 400);
    verifier("en-tête x-tenant-id contraire au déploiement : requête refusée (400)", (await e("127.0.0.1", { "x-tenant-id": B })).status === 400);
    verifier("paramètre ?tenant_id contraire : refusé (400)", (await e("malilinkglobal.com", {}, "/espace?tenant_id=hafiya")).status === 400);
    verifier("en-tête identique à l'espace établi : accepté", (await e("malilinkglobal.com", { "x-tenant-id": A })).data?.tenant_id === A);
  }

  section("1. CONNEXION EMAIL (compte d'une société)");
  {
    const c = await connexion(adminA.email, A);
    const t = decoder(c.data?.token);
    verifier("connexion dans l'espace de la société : jeton avec tenant_id ET company_id distincts", c.status === 200 && t.tenant_id === A && t.company_id === ecoleA.id && c.data.user.tenant_id === A, JSON.stringify(c.data).slice(0, 200));
    verifier("sans en-tête : espace du déploiement (comme sur malilinkglobal.com)", (await connexion(adminA.email, null)).status === 200);
    const autre = await connexion(adminA.email, B);
    verifier("même compte sur le domaine de l'espace B : refusé", autre.status === 403 && !autre.data?.token);
    const croise = await brut("GET", "/rbac/me", { token: c.data.token, hote: DOMAINE[B] });
    verifier("jeton A présenté sur le domaine de l'espace B : refusé (AUTRE_ESPACE)", croise.status === 403 && croise.data?.code === "AUTRE_ESPACE");
    const entete = await brut("GET", "/rbac/me", { token: c.data.token, entetes: { "x-tenant-id": B } });
    verifier("jeton A + en-tête « espace B » : requête refusée (400), l'en-tête ne change pas d'espace", entete.status === 400);
    verifier("réponse de connexion sans mot de passe ni empreinte", sansMotDePasse(c.data));
    const b = await connexion(adminB.email, B);
    verifier("compte d'une société de l'espace B : connexion dans B, jeton tenant_id=hafiya", b.status === 200 && decoder(b.data?.token).tenant_id === B);
    verifier("compte de l'espace B via le domaine du déploiement A : refusé", (await connexion(adminB.email, null)).status === 403);
  }

  section("2. TÉLÉPHONE (inscription et connexion, compte sans société)");
  let client;
  {
    const tel = `7${String(Date.now()).slice(-7)}`;
    const r = await brut("POST", "/marketplace/customers/register", { corps: { fullname: "Client Téléphone", phone: tel, password: MDP } });
    const t = decoder(r.data?.token);
    const enBase = (await q(`SELECT id, account_tenant_id, account_tenant_source FROM users WHERE id=$1`, [r.data?.user?.id]))[0] || {};
    verifier("inscription par téléphone : espace enregistré à la création, jeton tenant_id", r.status === 201 && t.tenant_id === A && t.company_id === null
      && enBase.account_tenant_id === A && enBase.account_tenant_source === "inscription", JSON.stringify({ s: r.status, t, enBase }));
    client = { id: enBase.id, tel };
    const c = await connexion(tel, null);
    verifier("connexion par téléphone : jeton de l'espace du compte", c.status === 200 && decoder(c.data?.token).tenant_id === A);
    const autre = await connexion(tel, B);
    verifier("connexion par téléphone via l'espace B : refusée (AUTRE_ESPACE)", autre.status === 403 && autre.data?.code === "AUTRE_ESPACE");
  }

  section("3. OAUTH (faux fournisseur local, parcours complet start → callback)");
  {
    const nouveau = await parcoursOAuth({ id: `ig-${alea()}`, email: `oauth-${alea()}@essai.test`, name: "Nouveau OAuth" }, A);
    const t = decoder(nouveau.connexion?.token);
    const soc = (await q(`SELECT c.tenant_id FROM users u JOIN companies c ON c.id=u.company_id WHERE u.id=$1`, [t.id]))[0] || {};
    verifier("état OAuth signé avec l'espace de départ", nouveau.etat.tenant === A && Boolean(nouveau.etat.source));
    verifier("inscription OAuth : société créée DANS l'espace de départ (plus de « triangle » par défaut)", soc.tenant_id === A, JSON.stringify(soc));
    verifier("connexion OAuth : jeton avec tenant_id", t.tenant_id === A && Boolean(t.company_id), nouveau.url.toString().slice(0, 160));

    const ancien = await compte({ nom: "Ancien client OAuth" });
    const lie = await parcoursOAuth({ id: `ig-${alea()}`, email: ancien.email, name: "Ancien client" }, A);
    const apres = (await q(`SELECT account_tenant_id FROM users WHERE id=$1`, [ancien.id]))[0];
    verifier("ancien compte sans société relié par OAuth : refusé (espace non établi), procédure expliquée, PAS rattaché",
      !lie.connexion && /administration MaliLink doit confirmer/.test(lie.erreur || "") && apres.account_tenant_id === null, JSON.stringify({ apres, e: lie.erreur }));
    ctx.ancienOAuth = { ...ancien, profil: lie };

    const deB = await parcoursOAuth({ id: `ig-${alea()}`, email: adminB.email, name: "Admin B" }, A);
    verifier("OAuth depuis l'espace A avec l'email d'un compte de l'espace B : refusé, aucun jeton", !deB.connexion && /autre espace/i.test(deB.erreur || ""), deB.url.toString().slice(0, 200));

    const flottant = await compte({ nom: "Ancien OAuth B" });
    const tente = await parcoursOAuth({ id: `ig-${alea()}`, email: flottant.email, name: "Ancien OAuth B" }, B);
    const reste = (await q(`SELECT account_tenant_id FROM users WHERE id=$1`, [flottant.id]))[0];
    verifier("ancien compte, OAuth démarré sur le domaine de l'espace B : refusé, PAS rattaché", !tente.connexion && reste.account_tenant_id === null, tente.erreur || "");
  }

  section("4. ANCIENS JETONS ET ANCIENS COMPTES SANS SOCIÉTÉ");
  {
    const vieux = jeton({ id: adminA.id, role: "admin", company_id: ecoleA.id, tenant_id: null });
    const r = await brut("GET", "/rbac/me", { token: vieux });
    verifier("ancien jeton sans tenant_id : 401 « session à renouveler », aucun espace par défaut", r.status === 401 && r.data?.code === "SESSION_SANS_ESPACE");
    let ioClient = null;
    try { ioClient = require(require.resolve("socket.io-client", { paths: [path.join(__dirname, "../../frontend")] })); } catch { /* facultatif */ }
    if (ioClient) {
      const refus = await new Promise((ok) => {
        const s = ioClient.io(BASE, { auth: { token: vieux }, transports: ["websocket"], reconnection: false, timeout: 5000 });
        s.on("connect", () => { s.close(); ok("connecté"); });
        s.on("connect_error", (e) => { s.close(); ok(e.message); });
      });
      verifier("temps réel : ancien jeton refusé (« Session à renouveler »)", refus === "Session à renouveler", refus);
    }

    const ancien = await compte({ nom: "Ancien client" });
    ctx.ancien = ancien;
    for (const espace of [null, A, B]) {
      const r = await connexion(ancien.email, espace);
      verifier(`ancien compte sans espace établi, connexion ${espace ? `sur ${DOMAINE[espace]}` : "sur le site"} : refusée, procédure expliquée`,
        r.status === 403 && r.data?.code === "ESPACE_NON_ETABLI" && /contactez le support/.test(r.data?.error || "") && !r.data?.token, JSON.stringify(r.data));
    }
    verifier("…et toujours pas rattaché (aucune attribution silencieuse)", (await q(`SELECT account_tenant_id FROM users WHERE id=$1`, [ancien.id]))[0].account_tenant_id === null);
    const jetonAncien = jeton({ id: ancien.id, role: "customer", company_id: null, tenant_id: A }); // émis par l'ancienne version
    const opSensible = await brut("PUT", "/me/password", { token: jetonAncien, corps: { current_password: MDP, new_password: "Sensible-2026-ok" } });
    verifier("jeton existant d'un compte sans espace établi : opérations refusées (ESPACE_NON_ETABLI)", opSensible.status === 403 && opSensible.data?.code === "ESPACE_NON_ETABLI"
      && (await brut("GET", "/rbac/me", { token: jetonAncien })).data?.code === "ESPACE_NON_ETABLI");
    const avantReset = (await q(`SELECT COUNT(*)::int AS n FROM password_reset_codes WHERE user_id=$1`, [ancien.id]))[0].n;
    const reset = await brut("POST", "/password-reset/request", { corps: { identifier: ancien.email } });
    verifier("récupération de mot de passe : réponse neutre, AUCUN code créé", reset.status === 200 && /Si ce compte existe/.test(reset.data?.message || "")
      && (await q(`SELECT COUNT(*)::int AS n FROM password_reset_codes WHERE user_id=$1`, [ancien.id]))[0].n === avantReset);

    // Attribution administrative explicite (script VPS), journalisée.
    const sa = await compte({ nom: "Super Admin Attribution", role: "super_admin", superAdmin: true, espace: A });
    ctx.sa = sa;
    const script = (...a) => { try { return execFileSync("node", ["scripts/comptes/attribuer-espace.js", ...a], { env: process.env, encoding: "utf8", stdio: "pipe" }); } catch (e) { return `ÉCHEC ${e.stdout || ""}${e.stderr || ""}`; } };
    const rapport = script("--rapport");
    verifier("rapport (lecture seule) : comptes non rattachés listés, emails masqués", rapport.includes(`- ${ancien.id} `) && !rapport.includes(ancien.email) && /NON rattachés/.test(rapport), rapport.slice(0, 300));
    const sansOui = script("--attribuer", "--espace", A, "--ids", String(ancien.id), "--par", sa.email, "--motif", "Client historique de MaliLink Global");
    verifier("attribution sans --oui : refusée, rien modifié", /ÉCHEC/.test(sansOui) && (await q(`SELECT account_tenant_id FROM users WHERE id=$1`, [ancien.id]))[0].account_tenant_id === null);
    const fait = script("--attribuer", "--espace", A, "--ids", `${ancien.id},${ctx.ancienOAuth.id}`, "--par", sa.email, "--motif", "Clients historiques de MaliLink Global (vérifiés)", "--preuve", "ticket support 42", "--oui");
    const attribue = (await q(`SELECT account_tenant_id, account_tenant_source, account_tenant_set_by FROM users WHERE id=$1`, [ancien.id]))[0];
    const journal = await q(`SELECT tenant_id, assigned_by, reason, evidence FROM account_tenant_assignments WHERE user_id=$1`, [ancien.id]);
    verifier("attribution explicite : espace, source « attribution_admin », auteur, motif et preuve journalisés",
      /ATTRIBUTION_ESPACE_EFFECTUEE · 2 compte/.test(fait) && attribue.account_tenant_id === A && attribue.account_tenant_source === "attribution_admin" && attribue.account_tenant_set_by === sa.id
      && journal.length === 1 && journal[0].evidence === "ticket support 42"
      && (await q(`SELECT 1 FROM audit_logs WHERE action='attribution_espace_compte' AND entity_id=$1`, [String(ancien.id)])).length === 1, fait.slice(-300));
    verifier("une seconde attribution ne change pas un compte déjà rattaché", /déjà rattaché/.test(script("--attribuer", "--espace", B, "--ids", String(ancien.id), "--par", sa.email, "--motif", "Tentative de changement d'espace", "--oui")));
    verifier("après attribution : connexion acceptée dans son espace, jeton existant de nouveau valable",
      (await connexion(ancien.email, null)).status === 200 && (await brut("GET", "/rbac/me", { token: jetonAncien })).status === 200);
    verifier("après attribution : refusé sur le domaine de l'autre espace (AUTRE_ESPACE)", (await connexion(ancien.email, B)).data?.code === "AUTRE_ESPACE");
    const oauthApres = await parcoursOAuth({ id: `ig-${alea()}`, email: ctx.ancienOAuth.email, name: "Ancien client" }, A);
    verifier("après attribution : la connexion OAuth de l'ancien compte aboutit", decoder(oauthApres.connexion?.token).tenant_id === A, oauthApres.erreur || "");
    const livreur = await brut("POST", "/delivery/drivers/public-register", { corps: { fullname: "Livreur Essai", phone: `6${String(Date.now()).slice(-7)}`, password: MDP, driver_type: "livreur", vehicle_type: "moto" } });
    if (livreur.status === 201) {
      const l = (await q(`SELECT account_tenant_id, account_tenant_source FROM users WHERE id=$1`, [livreur.data.user.id]))[0];
      verifier("inscription livreur : espace du compte enregistré à la création", l.account_tenant_id === A && l.account_tenant_source === "inscription" && decoder(livreur.data.token).tenant_id === A);
    } else {
      verifier("inscription livreur : route atteinte", false, `${livreur.status} ${JSON.stringify(livreur.data).slice(0, 150)}`);
    }
  }

  section("5. ACCÈS ENTRE ESPACES — SUPER ADMIN COMPRIS");
  {
    const sa = ctx.sa;
    const c = await connexion(sa.email, null);
    const tSA = c.data?.token;
    verifier("Super Admin : jeton de son espace", c.status === 200 && decoder(tSA).tenant_id === A);
    const choisie = await brut("GET", "/users", { token: tSA, entetes: { "x-active-company-id": String(ecoleA.id) } });
    verifier("Super Admin choisit une école de son espace : autorisé (comportement préservé)", choisie.status === 200 && Array.isArray(choisie.data) && choisie.data.some((u) => u.id === adminA.id));
    const horsEspace = await brut("GET", "/users", { token: tSA, entetes: { "x-active-company-id": String(societeB) } });
    verifier("Super Admin choisit une société de l'espace B : refusé (SOCIETE_HORS_ESPACE)", horsEspace.status === 403 && horsEspace.data?.code === "SOCIETE_HORS_ESPACE");
    const inexistante = await brut("GET", "/users", { token: tSA, entetes: { "x-active-company-id": "987654" } });
    verifier("société inexistante : refusée", inexistante.status === 403);
    const corps = await brut("POST", "/users", { token: tSA, corps: { fullname: "Intrus", email: `intrus-${alea()}@essai.test`, password: MDP, role: "magasinier", company_id: societeB } });
    verifier("création d'un utilisateur dans une société de l'espace B (company_id du corps) : refusée", corps.status === 403
      && (await q(`SELECT 1 FROM users WHERE company_id=$1 AND fullname='Intrus'`, [societeB])).length === 0);

    const societes = await brut("GET", "/super-admin/companies", { token: tSA });
    verifier("liste des sociétés : seulement l'espace A", societes.status === 200 && societes.data.some((x) => x.id === ecoleA.id) && !societes.data.some((x) => x.id === societeB));
    const utilisateurs = await brut("GET", "/super-admin/users", { token: tSA });
    const nonEtabli = await compte({ nom: "Compte non etabli" });
    const listeApres = await brut("GET", "/super-admin/users", { token: tSA });
    verifier("liste des utilisateurs : appartenance PROUVÉE seulement (ni espace B, ni compte sans espace établi)",
      utilisateurs.status === 200 && utilisateurs.data.some((x) => x.id === adminA.id) && utilisateurs.data.some((x) => x.id === ctx.ancien.id)
      && !utilisateurs.data.some((x) => x.id === adminB.id) && !listeApres.data.some((x) => x.id === nonEtabli.id) && sansMotDePasse(utilisateurs.data));
    const empreinte = (await q(`SELECT password, fullname FROM users WHERE id=$1`, [nonEtabli.id]))[0];
    const actions = [
      ["PUT", `/super-admin/users/${nonEtabli.id}`, { fullname: "Modifié par le Super Admin" }],
      ["PUT", `/super-admin/users/${nonEtabli.id}/password`, { password: "Autre-2026-ok" }],
      ["DELETE", `/super-admin/users/${nonEtabli.id}`],
      ["POST", `/users/${nonEtabli.id}/reset-password`],
      ["PUT", `/users/${nonEtabli.id}`, { fullname: "Modifié (route générique)" }],
      ["DELETE", `/users/${nonEtabli.id}`],
      ["GET", `/users/${nonEtabli.id}/permissions`],
      ["PUT", `/users/${adminB.id}/permissions`, { permissions: [] }],
      ["DELETE", `/users/${adminB.id}`],
    ];
    const accepte = [];
    for (const [m, chemin, corps] of actions) {
      const r = await brut(m, chemin, { token: tSA, corps });
      if (r.status !== 404) accepte.push(`${m} ${chemin} → ${r.status}`);
    }
    const apresActions = (await q(`SELECT password, fullname FROM users WHERE id=$1`, [nonEtabli.id]))[0];
    verifier("Super Admin sur un compte sans appartenance prouvée (ou de l'espace B) : modification, mot de passe, réinitialisation, permissions et suppression refusées (404)",
      accepte.length === 0 && apresActions && apresActions.password === empreinte.password && apresActions.fullname === empreinte.fullname
      && (await q(`SELECT 1 FROM users WHERE id=$1`, [adminB.id])).length === 1, accepte.join(" ; "));
    const prouve = await brut("PUT", `/super-admin/users/${ctx.ancien.id}`, { token: tSA, corps: { fullname: "Ancien client (vérifié)", email: ctx.ancien.email, phone: "", role: "customer", is_active: true } });
    verifier("…mais autorisé sur un compte dont l'appartenance a été prouvée", prouve.status === 200, JSON.stringify(prouve.data).slice(0, 120));
    const modules = await brut("GET", "/super-admin/modules", { token: tSA });
    verifier("modules par société : seulement l'espace A", modules.status === 200 && !modules.data.companies.some((x) => x.id === societeB));
    const vue = await brut("GET", "/super-admin/overview", { token: tSA });
    const nbA = (await q(`SELECT COUNT(*)::int AS n FROM companies WHERE tenant_id=$1`, [A]))[0].n;
    verifier("vue d'ensemble : chiffres de l'espace A uniquement", vue.status === 200 && vue.data.total_companies === nbA, `${vue.data?.total_companies} / ${nbA}`);
    const detailB = await brut("GET", `/super-admin/entreprises/${societeB}`, { token: tSA });
    verifier("fiche « Modifier » d'une société de l'espace B : introuvable", detailB.status === 404 && detailB.data?.code === "SOCIETE_HORS_ESPACE");
    const modB = await brut("PUT", `/super-admin/companies/${societeB}/modules`, { token: tSA, corps: { modules: { social: true } } });
    verifier("modules d'une société de l'espace B : introuvable", modB.status === 404);
    const avant = (await q(`SELECT password FROM users WHERE id=$1`, [adminB.id]))[0].password;
    const mdpB = await brut("PUT", `/super-admin/users/${adminB.id}/password`, { token: tSA, corps: { password: "Autre-2026-ok" } });
    const reinitB = await brut("POST", `/users/${adminB.id}/reset-password`, { token: tSA });
    verifier("mot de passe d'un compte de l'espace B : introuvable (ni fixé, ni réinitialisé)", mdpB.status === 404 && reinitB.status === 404
      && (await q(`SELECT password FROM users WHERE id=$1`, [adminB.id]))[0].password === avant);
    const detailA = await brut("GET", `/super-admin/entreprises/${ecoleA.id}`, { token: tSA });
    verifier("fiche « Modifier » d'une école de l'espace A : accessible, aucun mot de passe", detailA.status === 200 && sansMotDePasse(detailA.data));
    const tB = (await connexion(adminB.email, B)).data?.token;
    verifier("compte de l'espace B : n'atteint pas l'espace A", (await brut("GET", "/rbac/me", { token: tB })).status === 403);
  }

  section("6. SESSIONS APRÈS CHANGEMENTS SENSIBLES, CODES");
  {
    const u = await compte({ nom: "Utilisateur Sessions", companyId: ecoleA.id, role: "magasinier" });
    const t1 = (await connexion(u.email, null)).data.token;
    await attendre(1100);
    const t2 = (await connexion(u.email, null)).data.token;
    const change = await brut("PUT", "/me/password", { token: t1, corps: { current_password: MDP, new_password: "Nouveau-2026-ok" } });
    verifier("changement de mot de passe : nouveau jeton pour cette session", change.status === 200 && Boolean(change.data?.token) && decoder(change.data.token).tenant_id === A);
    verifier("autres sessions fermées (401)", (await brut("GET", "/rbac/me", { token: t2 })).status === 401 && (await brut("GET", "/rbac/me", { token: t1 })).status === 401);
    verifier("la session courante continue avec le nouveau jeton", (await brut("GET", "/rbac/me", { token: change.data.token })).status === 200);

    const tAvant = (await connexion(u.email, null, "Nouveau-2026-ok")).data.token;
    if (process.env.SMTP_HOST) {
      await fetch(`${MAILPIT}/messages`, { method: "DELETE" });
      const demande = await brut("POST", "/password-reset/request", { corps: { identifier: u.email } });
      await attendre(800);
      const code = codeDe((await boite(u.email))?.texte);
      verifier("récupération : code reçu par email (Mailpit)", demande.status === 200 && Boolean(code), JSON.stringify(demande.data));
      const faux = await brut("POST", "/password-reset/confirm", { corps: { code: "000000", identifier: u.email, new_password: "Recup-2026-ok", confirm_password: "Recup-2026-ok" } });
      verifier("code faux : refusé", faux.status === 400);
      const ok = await brut("POST", "/password-reset/confirm", { corps: { code, identifier: u.email, new_password: "Recup-2026-ok", confirm_password: "Recup-2026-ok" } });
      verifier("récupération par code : mot de passe changé", ok.status === 200);
      verifier("après récupération : anciennes sessions fermées", (await brut("GET", "/rbac/me", { token: tAvant })).data?.code === "session_revoquee");
      const rejoue = await brut("POST", "/password-reset/confirm", { corps: { code, identifier: u.email, new_password: "Encore-2026-ok", confirm_password: "Encore-2026-ok" } });
      verifier("même code rejoué : refusé (usage unique)", rejoue.status === 400);
      verifier("connexion avec le mot de passe récupéré", (await connexion(u.email, null, "Recup-2026-ok")).status === 200);

      await brut("POST", "/password-reset/request", { corps: { identifier: u.email } });
      await attendre(800);
      const code2 = codeDe((await boite(u.email))?.texte);
      await q(`UPDATE password_reset_codes SET expires_at = NOW() - INTERVAL '1 minute' WHERE user_id=$1 AND used_at IS NULL`, [u.id]);
      const expire = await brut("POST", "/password-reset/confirm", { corps: { code: code2, identifier: u.email, new_password: "Expire-2026-ok", confirm_password: "Expire-2026-ok" } });
      verifier("code de récupération expiré : refusé", expire.status === 400 && /expir/i.test(expire.data?.error || ""));

      await brut("POST", "/password-reset/request", { corps: { identifier: u.email } });
      await attendre(800);
      const code3 = codeDe((await boite(u.email))?.texte);
      for (let i = 0; i < 5; i++) await brut("POST", "/password-reset/confirm", { corps: { code: "111111", identifier: u.email, new_password: "Essai-2026-xx", confirm_password: "Essai-2026-xx" } });
      const bloque = await brut("POST", "/password-reset/confirm", { corps: { code: code3, identifier: u.email, new_password: "Bloque-2026-ok", confirm_password: "Bloque-2026-ok" } });
      verifier("5 codes faux : le bon code est bloqué ensuite (429)", bloque.status === 429);

      const inscrit = `verif-${alea()}@essai.test`;
      await brut("POST", "/marketplace/customers/register", { corps: { fullname: "Client Email", email: inscrit, password: MDP } });
      await attendre(800);
      const codeV = codeDe((await boite(inscrit))?.texte);
      await q(`UPDATE verification_codes SET expires_at = NOW() - INTERVAL '1 minute' WHERE LOWER(target_value)=LOWER($1) AND used_at IS NULL`, [inscrit]);
      const vExpire = await brut("POST", "/verification/verify", { corps: { target_type: "email", target_value: inscrit, code: codeV } });
      verifier("code de confirmation d'email expiré : refusé, compte non vérifié", vExpire.status >= 400
        && (await q(`SELECT email_verified FROM users WHERE LOWER(email)=LOWER($1)`, [inscrit]))[0].email_verified !== true, JSON.stringify(vExpire.data));
    }

    const sa = await compte({ nom: "Super Admin Sessions", role: "super_admin", superAdmin: true, espace: A });
    const tSA = (await connexion(sa.email, null)).data.token;
    const tU = (await connexion(u.email, null, process.env.SMTP_HOST ? "Recup-2026-ok" : "Nouveau-2026-ok")).data.token;
    const fixe = await brut("PUT", `/super-admin/users/${u.id}/password`, { token: tSA, corps: { password: "Fixe-2026-ok" } });
    const apres = (await q(`SELECT force_password_change FROM users WHERE id=$1`, [u.id]))[0];
    verifier("mot de passe fixé par le Super Admin : changement imposé, sessions fermées, rien d'affiché",
      fixe.status === 200 && apres.force_password_change === true && (await brut("GET", "/rbac/me", { token: tU })).status === 401 && sansMotDePasse(fixe.data));
    verifier("journal : mot de passe fixé par le Super Admin", (await q(`SELECT 1 FROM audit_logs WHERE action='super_admin_password_set' AND entity_id=$1`, [String(u.id)])).length === 1);
  }

  section("7. TEMPS RÉEL (socket) : ESPACE, STATUT DU COMPTE, RÉVOCATION, PRÉSENCE");
  {
    const ioClient = require(require.resolve("socket.io-client", { paths: [path.join(__dirname, "../../frontend")] }));
    const ouvrir = (token, hote) => new Promise((ok) => {
      const evenements = [];
      const s = ioClient.io(BASE, { auth: { token }, transports: ["websocket"], reconnection: false, timeout: 8000, ...(hote ? { extraHeaders: { host: hote } } : {}) });
      s.onAny((nom, donnees) => evenements.push({ nom, donnees }));
      s.on("connect", () => ok({ s, connecte: true, evenements }));
      s.on("connect_error", (e) => { s.close(); ok({ s, connecte: false, erreur: e.message, evenements }); });
    });
    const membre = async (nom, companyId, espace) => {
      const u = await compte({ nom, companyId, role: companyId ? "magasinier" : "customer", espace: companyId ? null : espace });
      const r = await connexion(u.email, espace);
      return { ...u, token: r.data?.token };
    };
    const a1 = await membre("Socket A1", ecoleA.id, A);
    const a2 = await membre("Socket A2", ecoleA.id, A);
    const b1 = await membre("Socket B1", societeB, B);
    const sa1 = await ouvrir(a1.token);
    const sb1 = await ouvrir(b1.token, DOMAINE[B]);
    verifier("connexion temps réel valide dans chaque espace (A par le site, B par son domaine)", sa1.connecte && sb1.connecte, `${sa1.erreur || ""} ${sb1.erreur || ""}`);
    const sa2 = await ouvrir(a2.token);
    await attendre(800);
    const presence = (ev, id) => ev.some((e) => e.nom === "presence:online" && e.donnees?.user_id === id);
    verifier("présence : A1 voit l'arrivée de A2 (même espace)", presence(sa1.evenements, a2.id));
    verifier("présence : B1 ne voit RIEN de l'espace A, A1 ne voit rien de B", !presence(sb1.evenements, a2.id) && !presence(sb1.evenements, a1.id) && !presence(sa1.evenements, b1.id));
    const mauvaisDomaine = await ouvrir(a1.token, DOMAINE[B]);
    verifier("jeton A sur le domaine de l'espace B : connexion refusée (AUTRE_ESPACE)", !mauvaisDomaine.connecte && mauvaisDomaine.erreur === "AUTRE_ESPACE", mauvaisDomaine.erreur);
    const nonEtabli = await compte({ nom: "Socket non etabli" });
    const sansEspace = await ouvrir(jeton({ id: nonEtabli.id, role: "customer", company_id: null, tenant_id: A }));
    verifier("compte sans espace établi : connexion refusée (ESPACE_NON_ETABLI)", !sansEspace.connecte && sansEspace.erreur === "ESPACE_NON_ETABLI", sansEspace.erreur);

    // Révocation : changement de mot de passe → la connexion ouverte est fermée aussitôt.
    const ferme = new Promise((ok) => { sa1.s.on("disconnect", (raison) => ok(raison)); setTimeout(() => ok("toujours connecté"), 8000); });
    await brut("PUT", "/me/password", { token: a1.token, corps: { current_password: MDP, new_password: "Socket-2026-ok" } });
    const raison = await ferme;
    verifier("session révoquée (mot de passe changé) : connexion temps réel fermée par le serveur, motif annoncé",
      raison === "io server disconnect" && sa1.evenements.some((e) => e.nom === "session:fermee" && e.donnees?.code === "session_revoquee"), `${raison} ${JSON.stringify(sa1.evenements.slice(-2))}`);
    const revoque = await ouvrir(a1.token);
    verifier("ancien jeton révoqué : nouvelle connexion refusée", !revoque.connecte && revoque.erreur === "session_revoquee", revoque.erreur);

    // Désactivation par le Super Admin : connexion fermée, API et temps réel refusés.
    const tSA = (await connexion(ctx.sa.email, null)).data.token;
    const fermeA2 = new Promise((ok) => { sa2.s.on("disconnect", (r) => ok(r)); setTimeout(() => ok("toujours connecté"), 8000); });
    await brut("PUT", `/super-admin/users/${a2.id}`, { token: tSA, corps: { fullname: "Socket A2", email: a2.email, phone: "", role: "magasinier", is_active: false } });
    verifier("compte désactivé : connexion temps réel fermée aussitôt", (await fermeA2) === "io server disconnect");
    verifier("compte désactivé : API refusée (COMPTE_DESACTIVE) et reconnexion temps réel refusée",
      (await brut("GET", "/rbac/me", { token: a2.token })).data?.code === "COMPTE_DESACTIVE" && (await ouvrir(a2.token)).erreur === "COMPTE_DESACTIVE");
    for (const x of [sa2, sb1]) x.s.close();
  }

  fournisseur.close();
  await terminer();
}

main().catch(async (e) => { console.error(e); fournisseur.close(); await terminer(); });
