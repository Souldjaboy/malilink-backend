"use strict";

/**
 * Accès effectif MaliLink — source de vérité unique.
 *
 *   accès(clé, action) =
 *        tenant correct                          (authenticateToken, en amont)
 *      ∧ module activé pour la société           (company_modules)
 *      ∧ module permis par le plan               (subscription_plans.excluded_modules)
 *          … sauf décision du super-admin        (company_modules.source = 'super_admin')
 *      ∧ permission de l'utilisateur             (user_permissions, sinon défaut du rôle)
 *          … un refus explicite gagne toujours.
 *
 * Le frontend ne recalcule rien : /rbac/me lui renvoie le verdict calculé ici,
 * et chaque route API passe par la même fonction. Un module masqué dans le
 * menu est donc forcément refusé par l'API, et inversement.
 *
 * Trois vocabulaires de clés coexistaient sans se rencontrer :
 *   - company_modules et le tableau de bord : clés plates (stock, produits…)
 *   - l'écran « Droits & permissions »      : clés du registre (commerce.stocks…)
 *   - l'écran Utilisateurs                  : clés plates de la table modules
 * Un refus posé sous « commerce.stocks » n'était jamais lu par la carte
 * « stock ». Chaque clé plate déclare ici la chaîne de clés qui la gouverne.
 */

const rbac = require("./rbac");

// ════════════════════════════════════════════════════════════════════
// 1. CATALOGUE DES MODULES
// ════════════════════════════════════════════════════════════════════
// key         : clé plate (company_modules, tableau de bord, gardes)
// permission  : clés du registre RBAC qui la gouvernent, du plus précis au parent
// core        : toujours actif pour la société (le droit utilisateur s'applique)
// vertical    : verticale métier — jamais active hors de son profil sans
//               décision explicite
const MODULE_CATALOG = [
  // Général
  { key: "dashboard", label: "Tableau de bord", group: "general", core: true, permission: [] },
  { key: "recherche", label: "Recherche", group: "general", core: true, permission: ["ia.recherche", "ia"] },

  // Communication
  { key: "ia", label: "Assistant IA", group: "communication", permission: ["ia.assistant", "ia"] },
  { key: "chat", label: "Chat interne", group: "communication", permission: ["ia.chat", "ia"] },
  { key: "notifications", label: "Notifications", group: "communication", permission: ["ia.notifications", "ia"] },
  { key: "reunions", label: "Réunions", group: "communication", permission: ["ia.reunions", "ia"] },
  { key: "social", label: "MaliLink Social", group: "communication", permission: ["ia.social", "ia"] },

  // Ventes
  { key: "pos", label: "POS / Caisse", group: "ventes", permission: ["commerce.pos", "commerce"] },
  { key: "ventes", label: "Ventes", group: "ventes", permission: ["commerce.ventes", "commerce"] },
  { key: "paiements", label: "Paiements", group: "ventes", permission: ["commerce.ventes", "commerce"] },
  { key: "recus", label: "Reçus", group: "ventes", permission: ["commerce.ventes", "commerce"] },
  { key: "clients", label: "Clients", group: "ventes", permission: ["commerce.partenaires", "commerce"] },
  { key: "partenaires", label: "Partenaires", group: "ventes", permission: ["commerce.partenaires", "commerce"] },
  { key: "crm", label: "CRM", group: "ventes", permission: ["commerce.partenaires", "commerce"] },
  { key: "marketplace", label: "Marketplace", group: "ventes", permission: ["commerce.marketplace", "commerce"] },
  { key: "commandes_recues", label: "Commandes reçues", group: "ventes", permission: ["commerce.marketplace", "commerce"] },

  // Stock & approvisionnement
  { key: "produits", label: "Produits", group: "stock", permission: ["commerce.produits", "commerce"] },
  { key: "stock", label: "Stock", group: "stock", permission: ["commerce.stocks", "commerce"] },
  { key: "mouvements", label: "Mouvements & transferts", group: "stock", permission: ["commerce.stocks", "commerce"] },
  { key: "inventaire", label: "Inventaires", group: "stock", permission: ["commerce.inventaires", "commerce"] },
  { key: "scanner", label: "Scanner", group: "stock", permission: ["commerce.scanner", "commerce"] },
  { key: "achats", label: "Achats", group: "stock", permission: ["commerce.achats", "commerce"] },
  { key: "fournisseurs", label: "Fournisseurs", group: "stock", permission: ["commerce.partenaires", "commerce"] },
  { key: "entrepots", label: "Entrepôts", group: "stock", permission: ["administration.entrepots", "administration"] },
  { key: "emplacements", label: "Emplacements", group: "stock", permission: ["administration.emplacements", "administration"] },
  { key: "alertes", label: "Alertes", group: "stock", permission: ["administration.alertes", "administration"] },

  // Finance
  { key: "comptabilite", label: "Comptabilité", group: "finance", permission: ["finance.comptabilite", "finance"] },
  { key: "documents", label: "Documents & factures", group: "finance", permission: ["finance.documents", "finance"] },
  { key: "rapports", label: "Rapports", group: "finance", permission: ["finance.rapports", "finance"] },
  { key: "wallet", label: "MaliLink Wallet", group: "finance", permission: ["finance.wallet", "finance"] },

  // Administration
  { key: "utilisateurs", label: "Utilisateurs", group: "administration", permission: ["administration.utilisateurs", "administration"] },
  { key: "parametres", label: "Paramètres", group: "administration", core: true, permission: ["administration.parametres", "administration"] },
  { key: "activites", label: "Activités", group: "administration", permission: ["finance.activites", "finance"] },
  { key: "import", label: "Centre d'import", group: "administration", permission: ["administration.import", "administration"] },
  { key: "pointage", label: "Pointage", group: "administration", permission: ["administration.pointage", "administration"] },
  { key: "pointage_qr", label: "Pointage QR", group: "administration", permission: ["administration.pointage", "administration"] },
  { key: "parametres_pointage", label: "Paramètres pointage", group: "administration", permission: ["administration.pointage", "administration"] },
  { key: "badges", label: "Badges", group: "administration", permission: ["administration.badges", "administration"] },

  // Verticales métier
  { key: "restaurant", label: "Restaurant", group: "verticales", vertical: true, permission: ["restaurant"] },
  { key: "education", label: "Éducation", group: "verticales", vertical: true, permission: ["education"] },
  { key: "immobilier", label: "Immobilier", group: "verticales", vertical: true, permission: ["immobilier"] },
  { key: "hotel", label: "Hôtel", group: "verticales", vertical: true, permission: ["immobilier.hotel", "immobilier"] },
  { key: "automobile", label: "Automobile / Garage", group: "verticales", vertical: true, permission: ["automobile"] },
  { key: "laboratoire", label: "Laboratoire / Santé", group: "verticales", vertical: true, permission: ["laboratoire"] },
  { key: "livraison", label: "Livraison", group: "verticales", vertical: true, permission: ["livraison"] },
  { key: "voyage", label: "MaliLink Voyage", group: "verticales", vertical: true, permission: ["voyage"] },
  { key: "pharmacie", label: "Pharmacie", group: "verticales", vertical: true, permission: ["pharmacie"] },

  // Options (jamais actives par défaut hors profil ; soumises au plan)
  { key: "cameras", label: "Caméras & Sécurité", group: "options", vertical: true, permission: ["cameras"] },
  { key: "marketing", label: "Marketing & Réseaux sociaux", group: "options", vertical: true, permission: ["marketing"] },
  // Données sensibles : fermé par défaut (migration 082), ouvert par décision explicite.
  { key: "biometrie", label: "Biométrie", group: "options", vertical: true, permission: ["biometrie"] },
  { key: "reseau", label: "Réseau & Infrastructure", group: "options", vertical: true, permission: ["reseau"] },
];

const CATALOG_BY_KEY = new Map(MODULE_CATALOG.map((m) => [m.key, m]));

const GROUP_LABELS = {
  general: "Général",
  communication: "Communication",
  ventes: "Ventes & clients",
  stock: "Stock & approvisionnement",
  finance: "Finance",
  administration: "Administration",
  verticales: "Verticales métier",
  options: "Options",
};

// Anciennes clés ou alias rencontrés en base et dans les pages.
const KEY_ALIASES = {
  assistant_ia: "ia",
  assistant: "ia",
  stocks: "stock",
  inventaires: "inventaire",
  produit: "produits",
  partenaire: "partenaires",
  travel: "voyage",
  voyages: "voyage",
  finance: "comptabilite",
  compta: "comptabilite",
  attendance: "pointage",
  livreur: "livraison",
  restaurants: "restaurant",
  alerte: "alertes",
  reseaux_sociaux: "marketing",
  pharmacy: "pharmacie",
  network: "reseau",
};

function normalizeKey(key) {
  const clean = String(key || "").trim().toLowerCase();
  if (clean.includes(".")) return clean;
  return KEY_ALIASES[clean] || clean;
}

// ════════════════════════════════════════════════════════════════════
// 2. PROFILS MÉTIER — modules activés PAR DÉFAUT selon le type d'activité
// ════════════════════════════════════════════════════════════════════
// Une sélection de départ : le super-admin peut ensuite accorder ou retirer
// n'importe quel module à une société précise.

const COMMUN = ["dashboard", "recherche", "ia", "chat", "notifications", "reunions", "social",
  "wallet", "utilisateurs", "parametres", "activites"];
const FINANCE = ["comptabilite", "documents", "rapports"];
const VENTE = ["pos", "ventes", "paiements", "recus", "clients", "partenaires", "crm"];
const STOCK = ["produits", "stock", "mouvements", "inventaire", "scanner", "achats",
  "fournisseurs", "entrepots", "emplacements", "alertes"];

const BUSINESS_PROFILES = {
  commerce: {
    label: "Commerce / Boutique",
    modules: [...COMMUN, ...VENTE, ...STOCK, ...FINANCE, "import"],
  },
  b2b: {
    label: "B2B / Grossiste",
    modules: [...COMMUN, ...VENTE, ...STOCK, ...FINANCE, "import", "marketplace", "commandes_recues"],
  },
  restaurant: {
    label: "Restaurant",
    modules: [...COMMUN, "restaurant", ...VENTE, "produits", "stock", "inventaire", "achats",
      "fournisseurs", "alertes", ...FINANCE],
  },
  ecole: {
    label: "École / Éducation",
    modules: [...COMMUN, "education", "paiements", "recus", ...FINANCE],
  },
  laboratoire: {
    label: "Laboratoire",
    modules: [...COMMUN, "laboratoire", "paiements", "recus", "clients", ...FINANCE],
  },
  pharmacie: {
    label: "Pharmacie",
    modules: [...COMMUN, "pharmacie", ...VENTE, ...STOCK, ...FINANCE],
  },
  sante: {
    label: "Santé / Clinique",
    modules: [...COMMUN, "laboratoire", "paiements", "recus", "clients", ...FINANCE],
  },
  immobilier: {
    label: "Immobilier / Hôtel",
    modules: [...COMMUN, "immobilier", "hotel", "paiements", "recus", "clients", "partenaires", "crm", ...FINANCE],
  },
  automobile: {
    label: "Automobile / Garage",
    modules: [...COMMUN, "automobile", "paiements", "recus", "clients", "partenaires", "crm",
      "produits", "stock", "inventaire", "achats", "fournisseurs", ...FINANCE],
  },
  logistique: {
    label: "Livraison / Transport",
    modules: [...COMMUN, "livraison", "voyage", "clients", "partenaires", "crm", "paiements", "recus",
      "produits", "stock", "mouvements", "entrepots", "emplacements", "alertes", ...FINANCE],
  },
  services: {
    label: "Services",
    modules: [...COMMUN, "clients", "partenaires", "crm", "ventes", "paiements", "recus", ...FINANCE],
  },
  autre: {
    label: "Autre",
    modules: [...COMMUN, "clients", "partenaires", "crm", "paiements", "recus", ...FINANCE],
  },
};

// Libellés libres rencontrés en base → profil. Comparaison sans accents.
const BUSINESS_TYPE_PATTERNS = [
  ["ecole", ["ecole", "education", "scolaire", "universite", "institut", "formation", "lycee", "college"]],
  ["restaurant", ["restaurant", "restauration", "cafe", "maquis", "fast", "traiteur"]],
  ["laboratoire", ["laboratoire", "labo"]],
  ["pharmacie", ["pharmacie", "pharmacy", "officine"]],
  ["sante", ["sante", "clinique", "cabinet medical", "hopital"]],
  ["immobilier", ["immobilier", "hotel", "hebergement", "residence"]],
  ["automobile", ["automobile", "garage", "auto", "vehicule"]],
  ["logistique", ["logistique", "livraison", "transport", "coursier"]],
  ["b2b", ["b2b", "grossiste", "gros", "distribution"]],
  ["services", ["service", "prestataire", "conseil", "agence"]],
  ["commerce", ["commerce", "boutique", "magasin", "quincaillerie", "materiel", "supermarche", "vente"]],
];

function sansAccents(texte) {
  return String(texte || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** Type d'activité libre ou code → clé de profil. Défaut : « autre ». */
function normalizeBusinessType(raw) {
  const t = sansAccents(raw);
  if (!t) return "autre";
  if (BUSINESS_PROFILES[t]) return t;
  for (const [profil, motifs] of BUSINESS_TYPE_PATTERNS) {
    if (motifs.some((m) => t === m || t.includes(m))) return profil;
  }
  return "autre";
}

function profileModules(profileKey) {
  return new Set((BUSINESS_PROFILES[profileKey] || BUSINESS_PROFILES.autre).modules);
}

// ════════════════════════════════════════════════════════════════════
// 3. NIVEAU SOCIÉTÉ : module actif ?
// ════════════════════════════════════════════════════════════════════

function planAllows(plan, key) {
  const exclus = Array.isArray(plan?.excluded_modules) ? plan.excluded_modules : [];
  return !exclus.includes(key);
}

/**
 * @param ctx.companyRows Map clé → { enabled, source }
 * @param ctx.plan        { excluded_modules: [] } ou null
 * @param ctx.profileKey  profil métier de la société
 * @returns { enabled, reason }
 */
function companyModuleState(ctx, rawKey) {
  const key = normalizeKey(rawKey);

  // Sous-module (parent.enfant) : le parent d'abord, puis sa propre ligne.
  if (key.includes(".")) {
    const [parent] = key.split(".");
    const parentState = CATALOG_BY_KEY.has(parent)
      ? companyModuleState(ctx, parent)
      : { enabled: true, reason: "hors_catalogue" };
    if (!parentState.enabled) return parentState;
    const row = ctx.companyRows.get(key);
    if (row && row.enabled === false) return { enabled: false, reason: "sous_module_desactive" };
    return { enabled: true, reason: parentState.reason };
  }

  const entry = CATALOG_BY_KEY.get(key);
  if (!entry) return { enabled: true, reason: "hors_catalogue" };
  if (entry.core) return { enabled: true, reason: "socle" };

  const row = ctx.companyRows.get(key);

  // La décision du super-admin prime sur tout, y compris sur le plan.
  if (row && row.source === "super_admin") {
    return { enabled: row.enabled === true, reason: row.enabled ? "accorde_super_admin" : "retire_super_admin" };
  }
  if (row && row.enabled === false) return { enabled: false, reason: "desactive_societe" };
  if (!planAllows(ctx.plan, key)) return { enabled: false, reason: "hors_plan" };
  if (row && row.enabled === true) return { enabled: true, reason: "active_societe" };

  // Aucune ligne : une verticale n'est jamais ouverte hors de son profil.
  if (entry.vertical) {
    return profileModules(ctx.profileKey).has(key)
      ? { enabled: true, reason: "profil_metier" }
      : { enabled: false, reason: "hors_profil" };
  }
  return { enabled: true, reason: "defaut" };
}

// ════════════════════════════════════════════════════════════════════
// 4. NIVEAU UTILISATEUR : permission pour l'action
// ════════════════════════════════════════════════════════════════════

const REGISTRY_KEYS = new Set(rbac.allModuleKeys());

/** Clés à consulter, de la plus précise à la plus générale. */
function permissionChain(rawKey) {
  const key = normalizeKey(rawKey);
  const chain = [key];
  if (key.includes(".")) {
    chain.push(key.split(".")[0]);
  } else {
    const entry = CATALOG_BY_KEY.get(key);
    if (entry) chain.push(...entry.permission);
  }
  return [...new Set(chain)];
}

/** La clé du registre la plus précise de la chaîne (pour le défaut du rôle). */
function roleDefaultKey(chain) {
  return chain.find((k) => REGISTRY_KEYS.has(k)) || chain[0];
}

/**
 * @param ctx.permRows Map clé → ligne user_permissions
 * @param ctx.role     rôle de l'utilisateur
 * @returns { allowed, reason }
 */
function userPermission(ctx, rawKey, action) {
  const chain = permissionChain(rawKey);
  const rows = chain.map((k) => ctx.permRows.get(k)).filter(Boolean);

  // Un « Voir » refusé n'importe où dans la chaîne masque tout le module.
  if (rows.some((r) => r.can_view === false)) {
    return { allowed: false, reason: "voir_refuse" };
  }

  const col = rbac.ACTION_COLUMN[action] || "can_view";
  // La valeur explicite la plus précise décide.
  for (const r of rows) {
    const v = r[col];
    if (v === true) return { allowed: true, reason: "permission_explicite" };
    if (v === false) return { allowed: false, reason: "refus_explicite" };
  }

  // Rien d'explicite : le défaut du rôle — exactement ce que l'écran
  // « Droits & permissions » affiche pour cet employé.
  const defaults = rbac.defaultPermissionsForRole(ctx.role, roleDefaultKey(chain));
  return defaults[action] === true
    ? { allowed: true, reason: "defaut_role" }
    : { allowed: false, reason: "hors_role" };
}

// ════════════════════════════════════════════════════════════════════
// 5. VERDICT
// ════════════════════════════════════════════════════════════════════

function effectiveAccess(ctx, rawKey, action = "view") {
  if (ctx.isSuperAdmin) return { allowed: true, reason: "super_admin" };
  const moduleState = companyModuleState(ctx, rawKey);
  if (!moduleState.enabled) {
    return { allowed: false, reason: moduleState.reason, level: "societe" };
  }
  const perm = userPermission(ctx, rawKey, action);
  return { ...perm, level: perm.allowed ? null : "utilisateur" };
}

/** Carte complète clé → { action: bool } pour le frontend. */
function effectiveMap(ctx, keys) {
  const out = {};
  for (const key of keys) {
    out[key] = {};
    for (const action of rbac.ACTIONS) out[key][action] = effectiveAccess(ctx, key, action).allowed;
  }
  return out;
}

/** Clés exposées au frontend : le catalogue + tout le registre RBAC. */
function exposedKeys() {
  return [...new Set([...MODULE_CATALOG.map((m) => m.key), ...REGISTRY_KEYS])];
}

// ════════════════════════════════════════════════════════════════════
// 6. CHARGEMENT DU CONTEXTE
// ════════════════════════════════════════════════════════════════════

async function loadAccessContext(pool, { companyId, userId, role, isSuperAdmin }) {
  const ctx = {
    isSuperAdmin: Boolean(isSuperAdmin),
    role: role || "",
    companyId: companyId || null,
    companyRows: new Map(),
    permRows: new Map(),
    plan: null,
    profileKey: "autre",
  };
  if (ctx.isSuperAdmin) return ctx;

  if (companyId) {
    /* Offre courante : la dernière ligne de subscriptions (c'est là que
       s'écrit un changement d'offre, et ce que lit déjà getCompanyPlanLimits),
       à défaut companies.plan_id. */
    const societe = (await pool.query(
      `SELECT c.business_type, p.excluded_modules
         FROM companies c
         LEFT JOIN subscription_plans p ON p.id = COALESCE(
           (SELECT s.plan_id FROM subscriptions s
             WHERE s.company_id = c.id AND s.plan_id IS NOT NULL
             ORDER BY s.id DESC LIMIT 1),
           c.plan_id)
        WHERE c.id = $1`, [companyId])).rows[0];
    ctx.profileKey = normalizeBusinessType(societe?.business_type);
    ctx.plan = { excluded_modules: societe?.excluded_modules || [] };

    const lignes = (await pool.query(
      `SELECT module_key, COALESCE(is_enabled, enabled, TRUE) AS enabled, source
         FROM company_modules WHERE company_id = $1`, [companyId])).rows;
    for (const l of lignes) {
      const k = normalizeKey(l.module_key);
      // Deux lignes pour une même clé (ancienne + alias) : un refus l'emporte.
      const deja = ctx.companyRows.get(k);
      if (deja && deja.source === "super_admin" && l.source !== "super_admin") continue;
      if (deja && deja.enabled === false && l.source !== "super_admin") continue;
      ctx.companyRows.set(k, { enabled: l.enabled === true, source: l.source || "" });
    }
  }

  if (userId) {
    const perms = (await pool.query(`SELECT * FROM user_permissions WHERE user_id = $1`, [userId])).rows;
    for (const p of perms) ctx.permRows.set(normalizeKey(p.module_key), p);
  }
  return ctx;
}

// ════════════════════════════════════════════════════════════════════
// 7. ROUTES API → MODULE
// ════════════════════════════════════════════════════════════════════
// readAlso : modules dont les écrans ont besoin de LIRE ces données de
// référence (le POS lit les produits, le stock lit les entrepôts…). Seule la
// lecture est élargie ; créer, modifier ou supprimer exige le module lui-même.

const API_ROUTE_RULES = [
  { prefix: "/products", module: "produits", readAlso: ["pos", "stock", "inventaire", "ventes", "achats", "scanner", "marketplace"] },
  // Pas d'élargissement : « Stock → Voir » refusé doit fermer l'API du stock,
  // même à qui garde l'accès aux inventaires.
  { prefix: "/stock-movements", module: "stock" },
  { prefix: "/inventory-history", module: "inventaire", readAlso: ["stock"] },
  { prefix: "/scan", module: "scanner", readAlso: ["stock", "inventaire"] },
  { prefix: "/warehouses", module: "entrepots", readAlso: ["stock", "pos", "inventaire", "produits", "emplacements", "cameras", "scanner", "mouvements"] },
  { prefix: "/locations", module: "emplacements", readAlso: ["stock", "inventaire", "entrepots", "produits"] },
  { prefix: "/pos", module: "pos" },
  { prefix: "/partners", module: "partenaires", readAlso: ["pos", "ventes", "achats", "crm", "clients", "fournisseurs"] },
  { prefix: "/documents", module: "documents" },
  { prefix: "/reports", module: "rapports" },
  { prefix: "/accounting", module: "comptabilite" },
  { prefix: "/finance", module: "comptabilite" },
  { prefix: "/disbursement-requests", module: "comptabilite" },
  { prefix: "/restaurant", module: "restaurant" },
  { prefix: "/immobilier", module: "immobilier", readAlso: ["hotel"] },
  { prefix: "/automobile", module: "automobile" },
  { prefix: "/laboratory", module: "laboratoire" },
  { prefix: "/laboratories", module: "laboratoire" },
  { prefix: "/education", module: "education" },
  // Voyage côté VOYAGEUR (recherche, réservation) = service de plateforme ouvert
  // à tous ; le module de la société ne gouverne que l'espace partenaire.
  { prefix: "/travel/partner", module: "voyage" },
  { prefix: "/wallet", module: "wallet" },
  { prefix: "/social", module: "social" },
  { prefix: "/chat", module: "chat" },
  { prefix: "/meetings", module: "reunions" },
  { prefix: "/attendance", module: "pointage", readAlso: ["pointage_qr", "parametres_pointage"] },
  /* Libre-service : tout le personnel pointe pour LUI-MÊME dès que le module
     est actif pour la société. Pointer un collègue est contrôlé par la route
     (« Valider » sur Pointage QR ou Pointage). Sans cela, un magasinier ou
     un caissier — lecture seule hors de leur périmètre — ne pouvait plus
     pointer son arrivée. */
  { prefix: "/attendance/scan", module: "pointage_qr", companyOnly: true },
  { prefix: "/attendance/check", module: "pointage", companyOnly: true },
  { prefix: "/attendance-sites", module: "parametres_pointage", readAlso: ["pointage"] },
  { prefix: "/attendance-report", module: "pointage" },
  { prefix: "/alerts", module: "alertes" },
  { prefix: "/activities", module: "activites" },
  { prefix: "/assistant", module: "ia" },
  { prefix: "/ai", module: "ia" },
  { prefix: "/import", module: "import" },
  { prefix: "/delivery", module: "livraison" },
  { prefix: "/badges", module: "badges", readAlso: ["pointage"] },
  { prefix: "/users", module: "utilisateurs", readAlso: ["chat", "pointage", "parametres_pointage", "pos", "reunions"] },
  { prefix: "/marketplace/vendor", module: "marketplace", readAlso: ["commandes_recues"] },
  { prefix: "/cameras", module: "cameras" },
  /* Biométrie : le module de la société décide ; chaque route vérifie le
     droit précis (biometrie.voir, .enroler…) ou « soi-même ». */
  { prefix: "/biometrics", module: "biometrie", companyOnly: true },
  { prefix: "/marketing", module: "marketing" },
  { prefix: "/pharmacy", module: "pharmacie" },
  { prefix: "/network", module: "reseau" },
  /* Sous-modules : le droit accordé sur un sous-module (ex. « Valider » sur
     marketing.publications) doit suffire, même si le parent ne porte pas
     cette action. Pas d'élargissement de lecture ici : un « Voir » refusé
     sur le sous-module doit tenir. */
  { prefix: "/marketing/publications", module: "marketing.publications" },
  { prefix: "/marketing/medias", module: "marketing.publications" },
  { prefix: "/marketing/campagnes", module: "marketing.campagnes" },
  { prefix: "/marketing/comptes", module: "marketing.comptes" },
  { prefix: "/cameras/sites", module: "cameras.sites" },
  { prefix: "/cameras/enregistreurs", module: "cameras.enregistreurs" },
  { prefix: "/cameras/journal", module: "cameras.identifiants" },
];

// Le préfixe le plus long l'emporte (/marketplace/vendor avant /marketplace).
const SORTED_API_RULES = [...API_ROUTE_RULES].sort((a, b) => b.prefix.length - a.prefix.length);

function ruleForPath(path) {
  const p = String(path || "").split("?")[0];
  return SORTED_API_RULES.find((r) => p === r.prefix || p.startsWith(`${r.prefix}/`)) || null;
}

const METHOD_ACTION = { GET: "view", HEAD: "view", OPTIONS: "view", POST: "create", PUT: "update", PATCH: "update", DELETE: "delete" };

// Segments d'URL qui désignent une action métier plutôt qu'une création.
const SEGMENT_ACTIONS = [
  [/^(import|imports|importer)$/, "import"],
  [/^(export|exports|exporter|csv|xlsx)$/, "export"],
  [/^(pdf|print|imprimer|impression)$/, "print"],
  [/^(cancel|annuler|annulation|void)$/, "cancel"],
  [/^(validate|valider|validation|approve|approuver)$/, "validate"],
  [/^(share|partager|email|whatsapp)$/, "share"],
  // Publier une publication, faire avancer une campagne : « Valider ».
  [/^(publier|publish|statut|echec)$/, "validate"],
  // Tester une caméra, ajouter un média à une publication : « Modifier ».
  [/^(verifier|tester|medias)$/, "update"],
];

function actionForRequest(method, path) {
  const base = METHOD_ACTION[String(method || "GET").toUpperCase()] || "view";
  const segments = String(path || "").split("?")[0].split("/").filter(Boolean).map((s) => s.toLowerCase());
  const dernier = segments[segments.length - 1] || "";
  for (const [motif, action] of SEGMENT_ACTIONS) {
    if (motif.test(dernier)) {
      // Une lecture reste une lecture : exporter/imprimer exigent aussi « Voir ».
      return action;
    }
  }
  return base;
}

// ════════════════════════════════════════════════════════════════════
// 8. PAGES → MODULE (garde des URL directes côté frontend)
// ════════════════════════════════════════════════════════════════════

const PAGE_ROUTE_RULES = [
  ["/produits", "produits"], ["/stocks", "stock"], ["/inventaires", "inventaire"],
  ["/scanner", "scanner"], ["/entrepots", "entrepots"], ["/emplacements", "emplacements"],
  ["/pos", "pos"], ["/partenaires", "partenaires"], ["/marketplace/business", "marketplace"],
  ["/vendor", "marketplace"], ["/comptabilite", "comptabilite"], ["/finance", "comptabilite"],
  ["/documents", "documents"], ["/rapports", "rapports"], ["/wallet", "wallet"],
  ["/utilisateurs", "utilisateurs"], ["/activites", "activites"], ["/import", "import"],
  ["/pointage", "pointage"], ["/attendance-scan", "pointage_qr"], ["/parametres-pointage", "parametres_pointage"],
  ["/badges", "badges"], ["/alertes", "alertes"], ["/assistant", "ia"], ["/chat", "chat"],
  ["/notifications", "notifications"], ["/social", "social"], ["/reunions", "reunions"],
  ["/restaurant", "restaurant"], ["/restaurant/public", ""], ["/education", "education"], ["/immobilier", "immobilier"],
  ["/automobile", "automobile"], ["/laboratoire", "laboratoire"], ["/travel/partenaire", "voyage"],
  ["/livreur", "livraison"], ["/client/livraison", "livraison"],
  ["/cameras", "cameras"], ["/marketing", "marketing"],
  ["/parametres/securite/biometrie", "biometrie"],
  ["/parametres/profil-public", "parametres"],
];

module.exports = {
  MODULE_CATALOG,
  CATALOG_BY_KEY,
  GROUP_LABELS,
  BUSINESS_PROFILES,
  API_ROUTE_RULES,
  PAGE_ROUTE_RULES,
  normalizeKey,
  normalizeBusinessType,
  profileModules,
  planAllows,
  companyModuleState,
  permissionChain,
  userPermission,
  effectiveAccess,
  effectiveMap,
  exposedKeys,
  loadAccessContext,
  ruleForPath,
  actionForRequest,
};
