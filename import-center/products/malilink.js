"use strict";

/** Profils d'importation MaliLink (marketplace, clients, etc.). */
module.exports = function registerMaliLink({ register }) {
  register({
    key: "malilink.marketplace_products",
    product_code: "malilink",
    module_key: "marketplace",
    submodule_key: "produits",
    name: "Produits marketplace",
    permission: "produits",
    requiredFields: ["product_name", "unit_price"],
    optionalFields: ["product_code", "barcode", "quantity", "description", "supplier_name"],
    fieldTypes: { product_name: "text", unit_price: "amount", quantity: "quantity" },
    dedupKey: (m) => ["mlk_product", (m.product_code || m.barcode || m.product_name || "").toString().trim().toLowerCase()].join("|"),
    validate: (m) => {
      const errs = [];
      if (!m.product_name) errs.push({ field: "product_name", code: "REQUIRED", message: "Nom du produit manquant.", severity: "error" });
      if (!(Number(m.unit_price) >= 0)) errs.push({ field: "unit_price", code: "INVALID_AMOUNT", message: "Prix invalide.", severity: "error" });
      return errs;
    },
  });

  register({
    key: "malilink.customers",
    product_code: "malilink",
    module_key: "crm",
    submodule_key: "clients",
    name: "Clients",
    permission: "partenaires",
    requiredFields: ["customer_name"],
    optionalFields: ["phone", "email", "description"],
    fieldTypes: { customer_name: "text", phone: "text", email: "text" },
    dedupKey: (m) => ["mlk_customer", (m.phone || m.email || m.customer_name || "").toString().trim().toLowerCase()].join("|"),
    validate: (m) => {
      const errs = [];
      if (!m.customer_name) errs.push({ field: "customer_name", code: "REQUIRED", message: "Nom du client manquant.", severity: "error" });
      return errs;
    },
  });
};
