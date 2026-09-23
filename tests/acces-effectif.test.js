"use strict";

/**
 * P0 — accès effectif, contre le VRAI serveur HTTP et une vraie base.
 *
 *   phase 1 : ADA existante (état hérité : tout activé) → alignement →
 *             ce qu'ADA voit, par menu, par URL, par API ; droits d'un
 *             employé ; décisions du super-admin ; types d'activité ; offres.
 *   phase 2 : APRÈS REDÉMARRAGE du serveur, les mêmes états tiennent.
 *
 * Lancer via scripts/test-acces-effectif.sh (base neuve, deux phases).
 */

const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { execFileSync } = require("child_process");

const BASE = `http://127.0.0.1:${process.env.PORT || 5078}`;
const SECRET = process.env.JWT_SECRET;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const PHASE = (process.argv.find((a) => a.startsWith("--phase=")) || "--phase=1").split("=")[1];
const ETAT = path.join(process.env.TMPDIR || "/tmp", "acces-effectif-etat.json");

const V = "\x1b[32m", R = "\x1b[31m", G = "\x1b[1m", Z = "\x1b[0m";
let reussis = 0, echoues = 0;
function verifier(titre, condition, detail = "") {
  if (condition) { reussis += 1; console.log(`${V}  ✓${Z} ${titre}`); }
  else { echoues += 1; console.log(`${R}  ✗ ${titre}${Z}${detail ? `  — ${detail}` : ""}`); }
}
const section = (t) => console.log(`\n${G}${t}${Z}`);

const jeton = (u) => jwt.sign({
  id: u.id, fullname: u.fullname || "Essai", email: u.email || `u${u.id}@essai.test`,
  role: u.role, company_id: u.company_id ?? null, is_super_admin: Boolean(u.is_super_admin),
}, SECRET, { expiresIn: "2h" });

async function appel(methode, chemin, token, corps, entetes = {}) {
  const r = await fetch(`${BASE}${chemin}`, {
    method: methode,
    headers: {
      "Content-Type": "application/json",
      "x-tenant-id": "malilink",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...entetes,
    },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch { /* corps vide ou HTML */ }
  return { status: r.status, data };
}
const q = async (sql, p = []) => (await pool.query(sql, p)).rows;

const refuse = (r) => r.status === 403 && ["MODULE_DISABLED", "PERMISSION_DENIED"].includes(r.data?.code);

// ════════════════════════════════════════════════════════════════════
async function phase1() {
  const etat = {};

  // ── Jeu d'essai : ADA SERVICE telle qu'elle existe en production ────
  // Inscrite avant le correctif : business_type « commerce » et une ligne
  // company_modules à TRUE pour tout, verticales comprises.
  const standard = (await q(`SELECT id FROM subscription_plans WHERE LOWER(name)='standard'`))[0];
  const essentiel = (await q(`SELECT id FROM subscription_plans WHERE LOWER(name)='essentiel'`))[0];
  const ada = (await q(
    `INSERT INTO companies (name, business_type, status, subscription_status, plan_id, tenant_id)
     VALUES ('ADA SERVICE', 'commerce', 'active', 'active', $1, 'malilink') RETURNING id`, [standard.id]))[0];
  const admin = (await q(
    `INSERT INTO users (fullname, email, password, role, company_id)
     VALUES ('Direction ADA', 'direction@ada-essai.test', 'x', 'admin', $1) RETURNING id, role, company_id`, [ada.id]))[0];
  for (const cle of ["dashboard", "produits", "stock", "pos", "ventes", "restaurant", "education",
    "immobilier", "automobile", "laboratoire", "voyage", "hotel", "marketplace", "wallet", "pointage"]) {
    await q(`INSERT INTO company_modules (company_id, module_key, is_enabled, enabled, updated_by, source)
             VALUES ($1,$2,TRUE,TRUE,$3,'inscription')`, [ada.id, cle, admin.id]);
  }
  // Une donnée métier d'une verticale qui sera masquée : elle doit survivre.
  await q(`INSERT INTO restaurant_tables (company_id, table_number) VALUES ($1, 'Table témoin')`, [ada.id]);
  etat.ada = ada.id; etat.admin = admin.id;

  const tAdmin = jeton({ ...admin });
  const tSuper = jeton({ id: 999001, role: "super_admin", is_super_admin: true });

  section("AVANT CORRECTION — le défaut, reproduit");
  {
    const me = await appel("GET", "/rbac/me", tAdmin);
    // L'état hérité : les verticales ont des lignes TRUE ; seul l'alignement les retire.
    verifier("l'état hérité d'ADA ouvre encore Restaurant (lignes TRUE écrites à l'inscription)",
      me.data?.effective?.restaurant?.view === true, JSON.stringify(me.data?.effective?.restaurant));
  }

  section("OUTIL D'ALIGNEMENT — ADA SERVICE existe déjà, elle n'est jamais recréée");
  const script = path.join(__dirname, "..", "scripts", "aligner-modules-societe.js");
  const lancer = (args) => {
    try { return { ok: true, sortie: execFileSync("node", [script, ...args], { env: process.env, encoding: "utf8" }) }; }
    catch (e) { return { ok: false, sortie: `${e.stdout || ""}${e.stderr || ""}` }; }
  };
  {
    const inconnue = lancer(["--societe=Societe Inexistante", "--preview"]);
    verifier("une société inconnue est refusée, et rien n'est créé",
      !inconnue.ok && /ne cr[ée]e jamais/i.test(inconnue.sortie));
    const nb = (await q(`SELECT COUNT(*)::int AS n FROM companies WHERE name ILIKE '%ada%'`))[0].n;
    verifier("toujours une seule société ADA", nb === 1, `${nb}`);

    const apercu = lancer(["--societe=ADA SERVICE", "--preview"]);
    verifier("l'aperçu s'exécute", apercu.ok, apercu.sortie.slice(-300));
    verifier("l'aperçu montre AVANT et APRÈS", /AVANT/.test(apercu.sortie) && /APRÈS/.test(apercu.sortie));
    verifier("l'aperçu annonce le masquage de Restaurant et Éducation",
      /Restaurant/.test(apercu.sortie) && /Éducation/.test(apercu.sortie) && /MASQUÉS/.test(apercu.sortie));
    const encore = (await q(`SELECT is_enabled FROM company_modules WHERE company_id=$1 AND module_key='restaurant'`, [ada.id]))[0];
    verifier("l'aperçu n'a rien écrit", encore.is_enabled === true);

    const sansConfirmation = lancer(["--societe=ADA SERVICE", "--apply", "--motif=Alignement de test ADA"]);
    verifier("--apply sans la phrase exacte est refusé", !sansConfirmation.ok && /Confirmation exacte/.test(sansConfirmation.sortie));

    const applique = lancer(["--societe=ADA SERVICE", "--apply", "--motif=Alignement de test ADA",
      "--confirmer=OUI J'ALIGNE ADA SERVICE"]);
    verifier("l'alignement s'applique", applique.ok && /APPLIQUÉ/.test(applique.sortie), applique.sortie.slice(-300));

    const deuxieme = lancer(["--societe=ADA SERVICE", "--apply", "--motif=Second passage idempotent",
      "--confirmer=OUI J'ALIGNE ADA SERVICE"]);
    verifier("un second passage n'écrit plus rien", /0 ligne\(s\) company_modules/.test(deuxieme.sortie), deuxieme.sortie.slice(-200));

    const temoin = await q(`SELECT table_number FROM restaurant_tables WHERE company_id=$1`, [ada.id]);
    verifier("les données d'une verticale masquée sont conservées", temoin.length === 1, `${temoin.length}`);
  }

  section("CAS ADA — ce que voit la Direction d'ADA SERVICE");
  {
    const me = await appel("GET", "/rbac/me", tAdmin);
    const vue = (k) => me.data?.effective?.[k]?.view === true;
    verifier("profil métier reconnu : commerce", me.data?.business_profile === "commerce", me.data?.business_profile);
    for (const k of ["produits", "stock", "pos", "ventes", "achats", "clients", "fournisseurs", "entrepots",
      "inventaire", "comptabilite", "rapports", "chat", "notifications", "utilisateurs"]) {
      verifier(`ADA voit ${k}`, vue(k));
    }
    for (const k of ["education", "restaurant", "immobilier", "automobile", "laboratoire", "voyage", "livraison"]) {
      verifier(`ADA ne voit PAS ${k}`, !vue(k));
    }
    verifier("la garde d'URL connaît /restaurant et /education",
      (me.data?.page_routes || []).some(([p, m]) => p === "/restaurant" && m === "restaurant") &&
      (me.data?.page_routes || []).some(([p, m]) => p === "/education" && m === "education"));
    verifier("le menu QR public d'un restaurant n'est pas gardé",
      (me.data?.page_routes || []).some(([p, m]) => p === "/restaurant/public" && m === ""));
  }

  section("CAS ADA — appels API directs");
  {
    for (const [chemin, nom] of [["/restaurant/tables", "restaurant"], ["/education/school", "éducation"],
      ["/immobilier/properties", "immobilier"], ["/automobile/vehicles", "automobile"], ["/laboratory/settings", "laboratoire"]]) {
      const r = await appel("GET", chemin, tAdmin);
      verifier(`GET ${chemin} → 403 (${nom})`, r.status === 403 && r.data?.code === "MODULE_DISABLED",
        `statut ${r.status} ${r.data?.code || ""}`);
    }
    const r1 = await appel("POST", "/restaurant/tables", tAdmin, { name: "Pirate" });
    verifier("POST /restaurant/tables → 403 aussi (pas seulement la lecture)", refuse(r1), `statut ${r1.status}`);
    const stock = await appel("GET", "/stock-movements", tAdmin);
    verifier("GET /stock-movements → autorisé", stock.status === 200, `statut ${stock.status}`);
    const produits = await appel("GET", "/products", tAdmin);
    verifier("GET /products → autorisé", produits.status === 200, `statut ${produits.status}`);
    const autreSociete = await appel("GET", "/restaurant/tables", tAdmin, null, { "x-active-company-id": "999999" });
    verifier("un x-active-company-id forgé ne change pas le contexte d'ADA", autreSociete.status === 403);
    verifier("un refus de module ne déconnecte pas : code explicite renvoyé",
      ["MODULE_DISABLED", "PERMISSION_DENIED"].includes(r1.data?.code));
  }

  section("DROITS D'UN EMPLOYÉ — Mohamed, magasinier");
  {
    const mohamed = (await q(
      `INSERT INTO users (fullname, email, password, role, company_id)
       VALUES ('Mohamed', 'mohamed@ada-essai.test', 'x', 'magasinier', $1) RETURNING id, role, company_id`, [ada.id]))[0];
    etat.mohamed = mohamed.id;
    const tMohamed = jeton(mohamed);

    // Sans aucune ligne enregistrée : l'écran doit montrer l'accès RÉEL.
    const lecture = await appel("GET", `/company/users/${mohamed.id}/permissions`, tAdmin);
    verifier("l'écran reçoit l'accès réel d'un employé sans ligne (Stock → Voir coché)",
      lecture.data?.effective?.["commerce.stocks"]?.view === true);
    verifier("… et le défaut du rôle (magasinier peut créer sur Stock)",
      lecture.data?.effective?.["commerce.stocks"]?.create === true);
    verifier("… mais pas supprimer (défaut du rôle, affiché décoché ET refusé)",
      lecture.data?.effective?.["commerce.stocks"]?.delete === false);
    verifier("les modules fermés pour l'entreprise sont signalés", (lecture.data?.unavailable_keys || []).includes("restaurant"));

    const avant = await appel("GET", "/stock-movements", tMohamed);
    verifier("avant : Mohamed lit le stock (200)", avant.status === 200, `statut ${avant.status}`);
    const suppression = await appel("DELETE", "/products/424242", tMohamed);
    verifier("DELETE /products refusé au magasinier par défaut de rôle (403)", refuse(suppression), `statut ${suppression.status}`);

    // L'administrateur décoche Stock → Voir, EXACTEMENT comme l'écran l'enregistre.
    const tableau = lecture.data.effective;
    const envoi = Object.entries(tableau).map(([cle, actions]) => ({ module_key: cle, ...actions }));
    const ligne = envoi.find((e) => e.module_key === "commerce.stocks");
    ligne.view = false;
    const enregistrement = await appel("PUT", `/company/users/${mohamed.id}/permissions`, tAdmin, { permissions: envoi });
    verifier("l'écran enregistre les droits", enregistrement.status === 200, `statut ${enregistrement.status}`);

    const me = await appel("GET", "/rbac/me", tMohamed);
    verifier("Stock disparaît du menu de Mohamed", me.data?.effective?.stock?.view === false);
    verifier("Produits reste visible", me.data?.effective?.produits?.view === true);
    const bloque = await appel("GET", "/stock-movements", tMohamed);
    verifier("GET /stock-movements → 403 PERMISSION_DENIED", bloque.status === 403 && bloque.data?.code === "PERMISSION_DENIED",
      `statut ${bloque.status} ${bloque.data?.code || ""}`);
    const relecture = await appel("GET", `/company/users/${mohamed.id}/permissions`, tAdmin);
    verifier("l'écran relit bien Stock → Voir décoché", relecture.data?.effective?.["commerce.stocks"]?.view === false);

    // Réactivation.
    ligne.view = true;
    await appel("PUT", `/company/users/${mohamed.id}/permissions`, tAdmin, { permissions: envoi });
    const reouvert = await appel("GET", "/stock-movements", tMohamed);
    verifier("Stock → Voir recoché : l'API répond à nouveau (200)", reouvert.status === 200, `statut ${reouvert.status}`);
    const me2 = await appel("GET", "/rbac/me", tMohamed);
    verifier("… et Stock réapparaît dans le menu", me2.data?.effective?.stock?.view === true);

    // Voir oui, Créer non.
    const lp = envoi.find((e) => e.module_key === "commerce.produits");
    lp.view = true; lp.create = false;
    await appel("PUT", `/company/users/${mohamed.id}/permissions`, tAdmin, { permissions: envoi });
    const lectureProduits = await appel("GET", "/products", tMohamed);
    const creationProduit = await appel("POST", "/products", tMohamed, { name: "Essai" });
    verifier("Produits : Voir oui → GET 200", lectureProduits.status === 200, `statut ${lectureProduits.status}`);
    verifier("Produits : Créer non → POST 403", refuse(creationProduit), `statut ${creationProduit.status}`);

    // Pour la phase 2 : on laisse Stock → Voir décoché.
    ligne.view = false;
    await appel("PUT", `/company/users/${mohamed.id}/permissions`, tAdmin, { permissions: envoi });
  }

  section("SUPER-ADMIN — modules d'ADA");
  {
    const lecture = await appel("GET", `/super-admin/companies/${ada.id}/modules`, tSuper);
    const tous = (lecture.data?.groups || []).flatMap((g) => g.modules.map((m) => m.key));
    verifier("l'éditeur expose tout le catalogue, verticales comprises",
      ["restaurant", "education", "laboratoire", "cameras", "marketing", "stock"].every((k) => tous.includes(k)), `${tous.length} modules`);
    verifier("il indique le profil métier d'ADA", lecture.data?.company?.business_profile === "commerce");

    const refusNonSuper = await appel("PUT", `/super-admin/companies/${ada.id}/modules`, tAdmin, { modules: { cameras: true } });
    verifier("un admin d'entreprise ne peut pas s'accorder un module", refusNonSuper.status === 403);

    const accord = await appel("PUT", `/super-admin/companies/${ada.id}/modules`, tSuper, { modules: { cameras: true, restaurant: false } });
    verifier("le super-admin active Caméras et confirme le retrait de Restaurant", accord.status === 200, `statut ${accord.status}`);
    const me = await appel("GET", "/rbac/me", tAdmin);
    verifier("ADA voit Caméras aussitôt", me.data?.effective?.cameras?.view === true);
    verifier("ADA ne voit toujours pas Restaurant", me.data?.effective?.restaurant?.view === false);
    const cam = await appel("GET", "/cameras", tAdmin);
    verifier("GET /cameras → 200", cam.status === 200, `statut ${cam.status}`);

    await appel("PUT", `/super-admin/companies/${ada.id}/modules`, tSuper, { modules: { stock: false } });
    const coupe = await appel("GET", "/stock-movements", tAdmin);
    verifier("Stock retiré à la société → même la Direction reçoit 403 MODULE_DISABLED",
      coupe.status === 403 && coupe.data?.code === "MODULE_DISABLED", `statut ${coupe.status}`);
    await appel("PUT", `/super-admin/companies/${ada.id}/modules`, tSuper, { modules: { stock: true } });
    const rouvre = await appel("GET", "/stock-movements", tAdmin);
    verifier("Stock rendu → 200", rouvre.status === 200, `statut ${rouvre.status}`);

    // Un réalignement ne défait jamais une décision du super-admin.
    execFileSync("node", [script, "--societe=ADA SERVICE", "--apply", "--motif=Réalignement après décision",
      "--confirmer=OUI J'ALIGNE ADA SERVICE"], { env: process.env, encoding: "utf8" });
    const apres = await q(`SELECT module_key, is_enabled, source FROM company_modules
                             WHERE company_id=$1 AND module_key IN ('cameras','restaurant')`, [ada.id]);
    const cams = apres.find((l) => l.module_key === "cameras");
    verifier("après réalignement, Caméras reste accordé (décision super-admin)", cams?.is_enabled === true && cams?.source === "super_admin");
  }

  section("TYPES D'ACTIVITÉ — inscription réelle");
  let tel = 70000000 + Math.floor(Math.random() * 900000);
  const inscrire = async (nom, type, planId, modules) => appel("POST", "/register-saas", null, {
    company_name: nom, business_type: type, responsible_name: `Resp ${nom}`,
    phone: String(tel++), password: "Essai2026x", plan_id: planId, selected_modules: modules,
  });
  const lignesDe = async (id) => Object.fromEntries(
    (await q(`SELECT module_key, is_enabled, source FROM company_modules WHERE company_id=$1`, [id])).map((l) => [l.module_key, l]));
  // Ce que l'ANCIEN formulaire envoyait : ses 29 cartes toutes cochées.
  const ancienFormulaire = Object.fromEntries(["produits", "stock", "inventaire", "mouvements", "entrepots", "emplacements",
    "ventes", "pos", "paiements", "recus", "achats", "fournisseurs", "clients", "partenaires", "comptabilite", "documents",
    "rapports", "pointage", "ia", "marketplace", "commandes_recues", "restaurant", "automobile", "immobilier",
    "laboratoire", "alertes", "activites", "utilisateurs", "parametres"].map((k) => [k, true]));
  {
    const com = await inscrire("Company Commerce", "commerce", standard.id, {});
    verifier("inscription Commerce acceptée", com.status === 201, `statut ${com.status} ${com.data?.error || ""}`);
    const lc = await lignesDe(com.data.company.id);
    verifier("Commerce : stock, POS, comptabilité activés", lc.stock?.is_enabled && lc.pos?.is_enabled && lc.comptabilite?.is_enabled);
    verifier("Commerce : restaurant, éducation, laboratoire désactivés — par une ligne EXPLICITE",
      lc.restaurant?.is_enabled === false && lc.education?.is_enabled === false && lc.laboratoire?.is_enabled === false);
    verifier("les lignes portent la provenance « inscription »", lc.stock?.source === "inscription");

    const resto = await inscrire("Company Restaurant", "restaurant", essentiel.id, {});
    verifier("Restaurant sur l'offre d'entrée : accepté", resto.status === 201, `statut ${resto.status} ${resto.data?.error || ""}`);
    const lr = await lignesDe(resto.data.company.id);
    verifier("Restaurant : module restaurant activé", lr.restaurant?.is_enabled === true);
    verifier("Restaurant : éducation, automobile, laboratoire désactivés",
      lr.education?.is_enabled === false && lr.automobile?.is_enabled === false && lr.laboratoire?.is_enabled === false);

    // L'ANCIEN formulaire cochait tout. Sur une offre qui laisse de la place :
    // les verticales d'autres métiers sont ignorées malgré la case cochée.
    const ancienStandard = await inscrire("Company Restaurant B", "restaurant", standard.id, ancienFormulaire);
    verifier("ancien formulaire, offre Standard : accepté", ancienStandard.status === 201,
      `statut ${ancienStandard.status} ${ancienStandard.data?.error || ""}`);
    const lb = await lignesDe(ancienStandard.data.company.id);
    verifier("… mais automobile, immobilier, laboratoire refusés malgré la case cochée",
      lb.automobile?.is_enabled === false && lb.immobilier?.is_enabled === false && lb.laboratoire?.is_enabled === false);

    // Sur l'offre d'entrée : 6 ajouts hors profil pour 5 permis → refus explicite.
    const ancienEssentiel = await inscrire("Company Restaurant C", "restaurant", essentiel.id, ancienFormulaire);
    verifier("ancien formulaire, offre d'entrée : la limite est CONTRÔLÉE (400 MODULE_LIMIT)",
      ancienEssentiel.status === 400 && ancienEssentiel.data?.code === "MODULE_LIMIT",
      `statut ${ancienEssentiel.status} ${ancienEssentiel.data?.code || ""}`);
    verifier("… le refus nomme les modules ajoutés",
      Array.isArray(ancienEssentiel.data?.added_modules) && ancienEssentiel.data.added_modules.length === 6,
      JSON.stringify(ancienEssentiel.data?.added_modules));

    const ecole = await inscrire("Company School", "ecole", standard.id, {});
    const le = await lignesDe(ecole.data.company.id);
    verifier("École : éducation activée", le.education?.is_enabled === true);
    verifier("École : POS, stock, restaurant, marketplace désactivés",
      le.pos?.is_enabled === false && le.stock?.is_enabled === false && le.restaurant?.is_enabled === false && le.marketplace?.is_enabled === false);

    // Limite de l'offre : elle compte les ajouts au-delà du profil, et elle est CONTRÔLÉE.
    const six = { marketplace: true, commandes_recues: true, pointage: true, pointage_qr: true, parametres_pointage: true, badges: true };
    const trop = await inscrire("Company Trop", "commerce", essentiel.id, { ...Object.fromEntries([...require("../access-control").profileModules("commerce")].map((k) => [k, true])), ...six });
    verifier("6 ajouts sur une offre qui en permet 5 → refus 400 MODULE_LIMIT", trop.status === 400 && trop.data?.code === "MODULE_LIMIT",
      `statut ${trop.status} ${trop.data?.code || ""}`);
    const nbTrop = (await q(`SELECT COUNT(*)::int AS n FROM companies WHERE name='Company Trop'`))[0].n;
    verifier("… et aucune société n'a été créée", nbTrop === 0, `${nbTrop}`);

    const camStarter = await inscrire("Company Starter", "commerce", essentiel.id, { cameras: true, marketing: true });
    const ls = await lignesDe(camStarter.data.company.id);
    verifier("offre d'entrée : Caméras et Marketing demandés mais NON accordés", ls.cameras?.is_enabled === false && ls.marketing?.is_enabled === false);
    etat.starterX = camStarter.data.company.id;
    etat.commerce = com.data.company.id;
  }

  section("OFFRES — dérogation par société");
  {
    const x = etat.starterX;
    const y = (await inscrire("Company Starter Y", "commerce", essentiel.id, {})).data.company.id;
    etat.starterY = y;
    const ux = (await q(`SELECT id, role, company_id FROM users WHERE company_id=$1 LIMIT 1`, [x]))[0];
    const uy = (await q(`SELECT id, role, company_id FROM users WHERE company_id=$1 LIMIT 1`, [y]))[0];
    await appel("PUT", `/super-admin/companies/${x}/modules`, tSuper, { modules: { cameras: true } });
    const mx = await appel("GET", "/rbac/me", jeton(ux));
    const my = await appel("GET", "/rbac/me", jeton(uy));
    verifier("Starter X + dérogation Caméras → X voit Caméras", mx.data?.effective?.cameras?.view === true);
    verifier("Starter Y sans dérogation → Y ne voit pas Caméras", my.data?.effective?.cameras?.view === false);
    const gy = await appel("GET", "/cameras", jeton(uy));
    verifier("Y : GET /cameras → 403", gy.status === 403, `statut ${gy.status}`);
    const offre = (await q(`SELECT excluded_modules FROM subscription_plans WHERE id=$1`, [essentiel.id]))[0];
    verifier("l'offre Starter elle-même n'a pas changé", (offre.excluded_modules || []).includes("cameras"));
  }

  section("ISOLATION ENTRE SOCIÉTÉS");
  {
    const autre = (await q(`SELECT id FROM users WHERE company_id=$1 LIMIT 1`, [etat.commerce]))[0];
    const r = await appel("GET", `/company/users/${autre.id}/permissions`, tAdmin);
    verifier("ADA ne lit pas les droits d'un employé d'une autre société", r.status === 403, `statut ${r.status}`);
    const w = await appel("PUT", `/company/users/${autre.id}/permissions`, tAdmin, { permissions: [{ module_key: "commerce", view: false }] });
    verifier("… ni ne les modifie", w.status === 403, `statut ${w.status}`);
    const client = await appel("GET", "/marketplace/products", jeton({ id: 999002, role: "customer" }));
    verifier("un client de la marketplace n'est pas bloqué par les modules", client.status !== 403, `statut ${client.status}`);
  }

  fs.writeFileSync(ETAT, JSON.stringify(etat));
}

// ════════════════════════════════════════════════════════════════════
async function phase2() {
  const etat = JSON.parse(fs.readFileSync(ETAT, "utf8"));
  section("APRÈS REDÉMARRAGE DU SERVEUR — les états tiennent");
  const admin = (await q(`SELECT id, role, company_id FROM users WHERE id=$1`, [etat.admin]))[0];
  const mohamed = (await q(`SELECT id, role, company_id FROM users WHERE id=$1`, [etat.mohamed]))[0];
  // Nouveaux jetons = nouvelle connexion.
  const me = await appel("GET", "/rbac/me", jeton(admin));
  verifier("ADA : Restaurant toujours masqué", me.data?.effective?.restaurant?.view === false);
  verifier("ADA : Éducation toujours masquée", me.data?.effective?.education?.view === false);
  verifier("ADA : Caméras toujours accordé", me.data?.effective?.cameras?.view === true);
  verifier("ADA : Stock toujours actif", me.data?.effective?.stock?.view === true);
  const mm = await appel("GET", "/rbac/me", jeton(mohamed));
  verifier("Mohamed : Stock → Voir toujours refusé", mm.data?.effective?.stock?.view === false);
  const r = await appel("GET", "/stock-movements", jeton(mohamed));
  verifier("Mohamed : GET /stock-movements toujours 403", r.status === 403, `statut ${r.status}`);
  const resto = await appel("GET", "/restaurant/tables", jeton(admin));
  verifier("ADA : GET /restaurant/tables toujours 403", resto.status === 403, `statut ${resto.status}`);
}

(async () => {
  try {
    if (PHASE === "2") await phase2(); else await phase1();
  } catch (e) {
    echoues += 1;
    console.error(`${R}Erreur : ${e.stack || e.message}${Z}`);
  }
  console.log(`\n${G}BILAN phase ${PHASE}${Z}  ${reussis} réussis, ${echoues} échoués`);
  await pool.end();
  process.exit(echoues === 0 ? 0 : 1);
})();
