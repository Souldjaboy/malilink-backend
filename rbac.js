"use strict";

/**
 * RBAC MaliLink — source de vérité unique (backend).
 * - Registre modules / sous-modules / actions.
 * - Moteur d'accès (priorité module -> sous-module -> permission).
 * - Défauts de rôles (pré-remplissage de l'UI de gestion des droits).
 *
 * Règle d'or : DÉFAUT = AUTORISÉ. On ne refuse que sur une désactivation
 * explicite (company_modules.is_enabled = false) ou une permission
 * utilisateur explicitement à false. Aucune régression possible.
 */

// Actions possibles sur chaque module / sous-module.
const ACTIONS = [
  "view", "create", "update", "delete",
  "import", "export", "print", "validate", "cancel", "share",
];

// Colonnes réelles de user_permissions -> action.
const ACTION_COLUMN = {
  view: "can_view",
  create: "can_create",
  update: "can_edit",
  delete: "can_delete",
  validate: "can_validate",
  import: "can_import",
  export: "can_export",
  print: "can_print",
  cancel: "can_cancel",
  share: "can_share",
};

/**
 * Registre des sous-modules par module parent (clés normalisées, stables).
 * La clé complète d'un sous-module est `parent.enfant` (ex. restaurant.cuisine).
 */
const SUBMODULES = {
  commerce: ["marketplace", "produits", "stocks", "inventaires", "scanner", "pos", "achats", "ventes", "partenaires", "rapports"],
  livraison: ["livreur", "inscription", "suivi", "paiements"],
  voyage: ["mes_voyages", "partenaire", "promotions", "reservations", "billets"],
  restaurant: ["commandes", "cuisine", "menu", "tables", "serveurs", "qr", "paiements"],
  immobilier: ["biens", "ventes", "locations", "contrats", "paiements", "hotel", "reservations"],
  automobile: ["vehicules", "ventes", "locations", "contrats", "paiements", "documents"],
  education: ["eleves", "professeurs", "classes", "cours", "emploi_du_temps", "presences", "notes", "paiements", "mensualites", "inscriptions", "parents", "parametres"],
  laboratoire: ["patients", "rendez_vous", "analyses", "resultats", "paiements", "documents", "parametres"],
  finance: ["wallet", "finance", "comptabilite", "rapports", "documents", "activites"],
  administration: ["utilisateurs", "parametres", "entrepots", "emplacements", "pointage", "badges", "alertes", "support", "super_admin"],
  ia: ["assistant", "social", "chat", "notifications", "recherche", "reunions"],
  // Triangle WMS Pro (logistique / entrepôt / ressources humaines)
  logistique: ["mouvements", "transferts", "demandes", "reception", "expedition", "inventaire"],
  rh: ["employes", "contrats", "conges", "paie", "pointage"],
};

// Libellés lisibles (UI). Facultatif — défaut = clé humanisée.
const MODULE_LABELS = {
  commerce: "Commerce", livraison: "Livraison", voyage: "Voyage", restaurant: "Restaurant",
  immobilier: "Immobilier / Hôtel", automobile: "Automobile", education: "Éducation",
  laboratoire: "Laboratoire", finance: "Finance / Gestion", administration: "Administration",
  ia: "IA / Communication", logistique: "Logistique / Entrepôt", rh: "Ressources humaines",
};

/** Toutes les clés (modules + sous-modules) connues. */
function allModuleKeys() {
  const keys = new Set();
  for (const parent of Object.keys(SUBMODULES)) {
    keys.add(parent);
    for (const sub of SUBMODULES[parent]) keys.add(`${parent}.${sub}`);
  }
  return [...keys];
}

/** Décompose une clé `parent.enfant` -> { moduleKey, subKey }. */
function splitKey(key) {
  const [moduleKey, subKey] = String(key || "").split(".");
  return { moduleKey, subKey: subKey || null };
}

/**
 * Moteur d'accès module/sous-module (PHASE 8, règles 1-3, 5).
 * @param disabled Set des clés explicitement désactivées pour l'entreprise
 *                 (ex. { "restaurant.cuisine" }).
 * @returns { allowed: boolean, code?: string, key?: string }
 */
function evaluateModuleAccess(disabled, moduleKey, subKey = null) {
  const disabledSet = disabled instanceof Set ? disabled : new Set(disabled || []);
  // Règle 1 : module entreprise désactivé -> refus total.
  if (moduleKey && disabledSet.has(moduleKey)) {
    return { allowed: false, code: "MODULE_DISABLED", key: moduleKey };
  }
  // Règle 2 : sous-module désactivé -> refus du sous-module.
  if (subKey && disabledSet.has(`${moduleKey}.${subKey}`)) {
    return { allowed: false, code: "SUBMODULE_DISABLED", key: `${moduleKey}.${subKey}` };
  }
  return { allowed: true };
}

/**
 * Défauts de permissions par rôle (PHASE 7) — sert à pré-remplir l'UI.
 * Retourne un objet action->bool pour un module donné.
 */
const FULL_ACCESS_ROLES = new Set([
  "super_admin", "admin", "administrateur", "administrateur_entreprise", "manager", "direction", "directeur", "gerant",
]);
const READONLY_ROLES = new Set(["lecture_seule", "readonly", "read_only", "invite", "client", "customer"]);

// Modules « métier » d'un rôle spécialisé (accès étendu à ces modules seulement).
const ROLE_SCOPES = {
  comptable: ["finance", "comptabilite", "rapports", "documents", "activites", "wallet"],
  magasinier: ["produits", "stock", "stocks", "inventaires", "inventaire", "entrepots", "emplacements", "scanner"],
  commercial: ["ventes", "produits", "marketplace", "partenaires", "clients", "crm"],
  caissier: ["pos", "ventes", "recus", "paiements"],
  livreur: ["livraison"],
  professeur: ["education", "education.cours", "education.notes", "education.presences", "education.eleves", "education.classes", "education.emploi_du_temps"],
  teacher: ["education", "education.cours", "education.notes", "education.presences", "education.eleves", "education.classes", "education.emploi_du_temps"],
  laborantin: ["laboratoire"],
  receptionniste: ["reservations", "rendez_vous", "immobilier", "laboratoire", "restaurant"],
};

const WRITE_ACTIONS = new Set(["view", "create", "update", "export", "print"]);

/**
 * Permissions par défaut d'un rôle pour un module/sous-module.
 * @returns objet { view, create, update, delete, import, export, print, validate, cancel, share }
 */
function defaultPermissionsForRole(role, moduleKey) {
  const r = String(role || "").toLowerCase().trim();
  const grant = (all) => ACTIONS.reduce((acc, a) => { acc[a] = all === true ? true : (all === "write" ? WRITE_ACTIONS.has(a) : a === "view"); return acc; }, {});

  if (FULL_ACCESS_ROLES.has(r)) return grant(true);
  if (READONLY_ROLES.has(r)) return grant(false); // view only

  const scope = ROLE_SCOPES[r];
  if (scope) {
    const inScope = scope.some((k) => k === moduleKey || moduleKey.startsWith(`${k}.`) || k.startsWith(`${moduleKey}.`));
    return inScope ? grant("write") : grant(false); // hors périmètre -> lecture seule
  }
  // Rôle standard / inconnu : lecture + création/édition, pas de suppression.
  return grant("write");
}

/**
 * Évalue une permission utilisateur pour une action (PHASE 5, règle 4).
 * @param permRow ligne user_permissions (ou null si aucune).
 * @param action  action demandée.
 * @returns { hasExplicit: boolean, allowed: boolean }
 *
 * DÉFAUT = AUTORISÉ : si aucune ligne explicite n'existe pour ce module,
 * on autorise (non-régressif). Une ligne explicite fait foi (deny gagne).
 */
function evaluateUserPermission(permRow, action) {
  if (!permRow) return { hasExplicit: false, allowed: true };
  const col = ACTION_COLUMN[action] || "can_view";
  const val = permRow[col];
  // Colonne non renseignée (null) -> on ne bloque pas cette action précise.
  if (val === null || val === undefined) return { hasExplicit: false, allowed: true };
  return { hasExplicit: true, allowed: val === true };
}

module.exports = {
  ACTIONS,
  ACTION_COLUMN,
  SUBMODULES,
  MODULE_LABELS,
  allModuleKeys,
  splitKey,
  evaluateModuleAccess,
  defaultPermissionsForRole,
  evaluateUserPermission,
};
