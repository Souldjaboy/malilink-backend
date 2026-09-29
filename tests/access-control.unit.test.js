"use strict";
/* Tests unitaires du moteur d'accès effectif (logique pure, sans base). */
const assert = require("assert");
const access = require("../access-control");

let passes = 0;
function test(nom, fn) {
  fn();
  passes += 1;
  console.log("  ✓ " + nom);
}

const ctx = (o = {}) => ({
  isSuperAdmin: false,
  role: "admin",
  companyId: 1,
  companyRows: new Map(),
  permRows: new Map(),
  plan: { excluded_modules: [] },
  profileKey: "commerce",
  ...o,
});

console.log("Profils métier");

test("« Commerce / Boutique » et « commerce » → profil commerce", () => {
  assert.strictEqual(access.normalizeBusinessType("Commerce / Boutique"), "commerce");
  assert.strictEqual(access.normalizeBusinessType("commerce"), "commerce");
  assert.strictEqual(access.normalizeBusinessType("Quincaillerie Matériel"), "commerce");
});

test("libellés scolaires, restauration, santé reconnus sans accents", () => {
  assert.strictEqual(access.normalizeBusinessType("École / Éducation"), "ecole");
  assert.strictEqual(access.normalizeBusinessType("ecole"), "ecole");
  assert.strictEqual(access.normalizeBusinessType("Restaurant"), "restaurant");
  assert.strictEqual(access.normalizeBusinessType("Santé / Clinique"), "sante");
  assert.strictEqual(access.normalizeBusinessType(""), "autre");
});

test("le profil Pharmacie active sa verticale sans ouvrir les autres", () => {
  assert.strictEqual(access.normalizeBusinessType("Pharmacie"), "pharmacie");
  const p = access.profileModules("pharmacie");
  assert.ok(p.has("pharmacie"));
  for (const k of ["education", "restaurant", "immobilier", "automobile", "voyage", "reseau", "cameras"]) assert.ok(!p.has(k), k);
});

test("le profil commerce n'inclut aucune verticale d'un autre métier", () => {
  const p = access.profileModules("commerce");
  for (const k of ["restaurant", "education", "immobilier", "hotel", "automobile", "laboratoire", "voyage", "livraison", "cameras", "marketing"]) {
    assert.ok(!p.has(k), `${k} ne doit pas être dans le profil commerce`);
  }
  for (const k of ["produits", "stock", "pos", "ventes", "achats", "clients", "fournisseurs", "entrepots", "comptabilite", "rapports"]) {
    assert.ok(p.has(k), `${k} doit être dans le profil commerce`);
  }
});

test("le profil école : éducation oui, POS et stock commercial non", () => {
  const p = access.profileModules("ecole");
  assert.ok(p.has("education"));
  for (const k of ["pos", "stock", "produits", "restaurant", "marketplace"]) assert.ok(!p.has(k), k);
});

test("chaque clé des profils existe dans le catalogue", () => {
  for (const [nom, profil] of Object.entries(access.BUSINESS_PROFILES)) {
    for (const k of profil.modules) assert.ok(access.CATALOG_BY_KEY.has(k), `${nom} → ${k} inconnu`);
  }
});

console.log("Niveau société");

test("une verticale SANS ligne reste fermée hors de son profil", () => {
  const r = access.companyModuleState(ctx(), "restaurant");
  assert.strictEqual(r.enabled, false);
  assert.strictEqual(r.reason, "hors_profil");
});

test("un module non vertical sans ligne reste ouvert (non-régression)", () => {
  assert.strictEqual(access.companyModuleState(ctx(), "badges").enabled, true);
});

test("une ligne explicite à false ferme le module", () => {
  const c = ctx({ companyRows: new Map([["stock", { enabled: false, source: "profil" }]]) });
  assert.strictEqual(access.companyModuleState(c, "stock").enabled, false);
});

test("l'offre retire un module même activé par la société", () => {
  const c = ctx({
    plan: { excluded_modules: ["cameras"] },
    companyRows: new Map([["cameras", { enabled: true, source: "inscription" }]]),
  });
  const r = access.companyModuleState(c, "cameras");
  assert.strictEqual(r.enabled, false);
  assert.strictEqual(r.reason, "hors_plan");
});

test("la décision du super-admin prime sur l'offre (Starter + Caméras)", () => {
  const c = ctx({
    plan: { excluded_modules: ["cameras"] },
    companyRows: new Map([["cameras", { enabled: true, source: "super_admin" }]]),
  });
  const r = access.companyModuleState(c, "cameras");
  assert.strictEqual(r.enabled, true);
  assert.strictEqual(r.reason, "accorde_super_admin");
});

test("un retrait du super-admin tient même si le profil l'inclut", () => {
  const c = ctx({ companyRows: new Map([["stock", { enabled: false, source: "super_admin" }]]) });
  assert.strictEqual(access.companyModuleState(c, "stock").enabled, false);
});

test("sous-module : fermé si le parent est fermé", () => {
  assert.strictEqual(access.companyModuleState(ctx(), "restaurant.cuisine").enabled, false);
});

test("les alias anciens pointent vers la bonne clé (reseaux_sociaux → marketing)", () => {
  assert.strictEqual(access.normalizeKey("reseaux_sociaux"), "marketing");
  assert.strictEqual(access.normalizeKey("stocks"), "stock");
  assert.strictEqual(access.normalizeKey("assistant_ia"), "ia");
  assert.strictEqual(access.normalizeKey("pharmacy"), "pharmacie");
  assert.strictEqual(access.normalizeKey("network"), "reseau");
});

test("Pharmacie et Réseau restent fermés hors profil sans activation société", () => {
  assert.strictEqual(access.companyModuleState(ctx(), "pharmacie").enabled, false);
  assert.strictEqual(access.companyModuleState(ctx(), "reseau").enabled, false);
});

console.log("Niveau utilisateur");

test("la clé de l'écran (commerce.stocks) gouverne enfin la carte « stock »", () => {
  const c = ctx({ role: "magasinier", permRows: new Map([["commerce.stocks", { can_view: false }]]) });
  assert.strictEqual(access.effectiveAccess(c, "stock", "view").allowed, false);
  assert.strictEqual(access.effectiveAccess(c, "produits", "view").allowed, true);
});

test("« Voir » décoché sur le module parent masque tous ses sous-modules", () => {
  const c = ctx({ permRows: new Map([["commerce", { can_view: false }]]) });
  for (const k of ["stock", "produits", "pos", "ventes"]) {
    assert.strictEqual(access.effectiveAccess(c, k, "view").allowed, false, k);
  }
});

test("un refus explicite gagne sur le rôle (magasinier sans « Voir » sur Stock)", () => {
  const c = ctx({ role: "magasinier", permRows: new Map([["commerce.stocks", { can_view: false, can_create: true }]]) });
  assert.strictEqual(access.effectiveAccess(c, "stock", "create").allowed, false);
});

test("Voir oui, Créer non → consultation seule", () => {
  const c = ctx({ role: "admin", permRows: new Map([["commerce.produits", { can_view: true, can_create: false, can_edit: true }]]) });
  assert.strictEqual(access.effectiveAccess(c, "produits", "view").allowed, true);
  assert.strictEqual(access.effectiveAccess(c, "produits", "create").allowed, false);
  assert.strictEqual(access.effectiveAccess(c, "produits", "update").allowed, true);
});

test("sans ligne, c'est le défaut du rôle qui s'applique (caissier : POS oui, suppression non)", () => {
  const c = ctx({ role: "caissier" });
  assert.strictEqual(access.effectiveAccess(c, "pos", "create").allowed, true);
  assert.strictEqual(access.effectiveAccess(c, "pos", "delete").allowed, false);
  assert.strictEqual(access.effectiveAccess(c, "stock", "create").allowed, false);
  assert.strictEqual(access.effectiveAccess(c, "stock", "view").allowed, true);
});

test("un parent refusant « Créer » n'écrase pas un enfant qui l'autorise", () => {
  const c = ctx({ role: "caissier", permRows: new Map([
    ["commerce", { can_view: true, can_create: false }],
    ["commerce.pos", { can_view: true, can_create: true }],
  ]) });
  assert.strictEqual(access.effectiveAccess(c, "pos", "create").allowed, true);
});

test("une ancienne ligne à clé plate est aussi respectée (refus gagne)", () => {
  const c = ctx({ permRows: new Map([["stock", { can_view: false }], ["commerce.stocks", { can_view: true }]]) });
  assert.strictEqual(access.effectiveAccess(c, "stock", "view").allowed, false);
});

test("module fermé pour la société : refus même pour un directeur", () => {
  const c = ctx({ role: "directeur" });
  const r = access.effectiveAccess(c, "education", "view");
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.level, "societe");
});

test("super-admin : tout est ouvert", () => {
  assert.strictEqual(access.effectiveAccess(ctx({ isSuperAdmin: true }), "education", "delete").allowed, true);
});

console.log("Routes API");

test("chaque préfixe d'API renvoie au bon module", () => {
  assert.strictEqual(access.ruleForPath("/stock-movements").module, "stock");
  assert.strictEqual(access.ruleForPath("/restaurant/tables").module, "restaurant");
  assert.strictEqual(access.ruleForPath("/marketplace/vendor/products").module, "marketplace");
  assert.strictEqual(access.ruleForPath("/marketplace/products"), null, "navigation publique non gardée");
  assert.strictEqual(access.ruleForPath("/travel/search"), null, "voyage côté voyageur non gardé");
  assert.strictEqual(access.ruleForPath("/travel/partner/routes").module, "voyage");
  assert.strictEqual(access.ruleForPath("/productsX"), null, "préfixe exact, pas une sous-chaîne");
  assert.strictEqual(access.ruleForPath("/marketing/publications/4/publier").module, "marketing.publications");
  assert.strictEqual(access.ruleForPath("/marketing/tableau-de-bord").module, "marketing");
  assert.strictEqual(access.ruleForPath("/cameras/journal").module, "cameras.identifiants");
});

test("un « Valider » accordé sur un sous-module suffit, même si le parent ne le porte pas", () => {
  const c = ctx({
    role: "community_manager",
    // Marketing est une option : ouvert ici par décision du super-admin.
    companyRows: new Map([["marketing", { enabled: true, source: "super_admin" }]]),
    permRows: new Map([
      ["marketing", { can_view: true, can_validate: false }],
      ["marketing.publications", { can_view: true, can_validate: true }],
    ]),
  });
  assert.strictEqual(access.effectiveAccess(c, "marketing.publications", "validate").allowed, true);
  assert.strictEqual(access.effectiveAccess(c, "marketing", "validate").allowed, false);
});

test("l'action vient de la méthode, ou du dernier segment", () => {
  assert.strictEqual(access.actionForRequest("GET", "/products"), "view");
  assert.strictEqual(access.actionForRequest("POST", "/products"), "create");
  assert.strictEqual(access.actionForRequest("PATCH", "/products/3"), "update");
  assert.strictEqual(access.actionForRequest("DELETE", "/products/3"), "delete");
  assert.strictEqual(access.actionForRequest("POST", "/pos/sales/4/cancel"), "cancel");
  assert.strictEqual(access.actionForRequest("GET", "/documents/4/pdf"), "print");
  assert.strictEqual(access.actionForRequest("POST", "/import"), "import");
  assert.strictEqual(access.actionForRequest("POST", "/marketing/publications/4/publier"), "validate");
  assert.strictEqual(access.actionForRequest("POST", "/marketing/campagnes/2/statut"), "validate");
  assert.strictEqual(access.actionForRequest("POST", "/cameras/9/verifier"), "update");
  assert.strictEqual(access.actionForRequest("POST", "/marketing/publications/4/medias"), "update");
});

console.log(`\n✅ ${passes} tests du moteur d'accès passés.`);
