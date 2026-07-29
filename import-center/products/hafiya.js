"use strict";

/**
 * Profils d'importation HAFIYA (laboratoire). Les données médicales sont
 * sensibles : les résultats importés ne sont JAMAIS validés automatiquement
 * (statut BROUILLON par défaut, voir executor phase 6).
 */
module.exports = function registerHafiya({ register }) {
  register({
    key: "hafiya.patients",
    product_code: "hafiya",
    module_key: "laboratoire",
    submodule_key: "patients",
    name: "Patients",
    permission: "laboratoire",
    requiredFields: ["last_name", "first_name"],
    optionalFields: ["patient_id", "gender", "birth_date", "phone", "email", "description"],
    fieldTypes: { last_name: "text", first_name: "text", birth_date: "date", phone: "text", email: "text" },
    // Doublon patient : id > téléphone > email > nom+prénom+naissance. Jamais de fusion auto sur simple ressemblance.
    dedupKey: (m) => {
      if (m.patient_id) return ["patient", "id", String(m.patient_id).trim().toLowerCase()].join("|");
      if (m.phone) return ["patient", "tel", String(m.phone).replace(/\s/g, "")].join("|");
      if (m.email) return ["patient", "mail", String(m.email).trim().toLowerCase()].join("|");
      return ["patient", "nom", (m.last_name || "").toString().trim().toLowerCase(), (m.first_name || "").toString().trim().toLowerCase(), String(m.birth_date || "")].join("|");
    },
    validate: (m) => {
      const errs = [];
      if (!m.last_name) errs.push({ field: "last_name", code: "REQUIRED", message: "Nom manquant.", severity: "error" });
      if (!m.first_name) errs.push({ field: "first_name", code: "REQUIRED", message: "Prénom manquant.", severity: "error" });
      return errs;
    },
  });

  register({
    key: "hafiya.lab_results",
    product_code: "hafiya",
    module_key: "laboratoire",
    submodule_key: "resultats",
    name: "Résultats d'analyses",
    permission: "laboratoire",
    // Statut d'import : toujours BROUILLON (validation médicale manuelle obligatoire).
    importStatus: "BROUILLON",
    requiredFields: ["patient_id", "description"],
    optionalFields: ["transaction_date", "balance"],
    fieldTypes: { patient_id: "text", description: "text", transaction_date: "date" },
    dedupKey: (m) => ["result", String(m.patient_id || ""), (m.description || "").toString().trim().toLowerCase(), String(m.transaction_date || "")].join("|"),
    validate: (m) => {
      const errs = [];
      if (!m.patient_id) errs.push({ field: "patient_id", code: "REQUIRED", message: "Identifiant patient manquant.", severity: "error" });
      if (!m.description) errs.push({ field: "description", code: "REQUIRED", message: "Analyse/description manquante.", severity: "error" });
      return errs;
    },
  });
};
