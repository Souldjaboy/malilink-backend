"use strict";
/* Tests unitaires légers du moteur RBAC (sans framework : assert natif). */
const assert = require("assert");
const rbac = require("../rbac");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("  ✓ " + name); }

console.log("RBAC — moteur d'accès module/sous-module");

test("module actif -> autorisé", () => {
  const r = rbac.evaluateModuleAccess(new Set(), "restaurant");
  assert.strictEqual(r.allowed, true);
});

test("module désactivé -> MODULE_DISABLED (règle 1)", () => {
  const r = rbac.evaluateModuleAccess(new Set(["restaurant"]), "restaurant", "cuisine");
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.code, "MODULE_DISABLED");
});

test("module actif + sous-module désactivé -> SUBMODULE_DISABLED (règle 2)", () => {
  const r = rbac.evaluateModuleAccess(new Set(["restaurant.cuisine"]), "restaurant", "cuisine");
  assert.strictEqual(r.allowed, false);
  assert.strictEqual(r.code, "SUBMODULE_DISABLED");
});

test("module actif + autre sous-module actif -> autorisé (isolation)", () => {
  const r = rbac.evaluateModuleAccess(new Set(["restaurant.cuisine"]), "restaurant", "commandes");
  assert.strictEqual(r.allowed, true);
});

console.log("RBAC — permissions utilisateur");

test("aucune ligne -> autorisé par défaut (non-régressif)", () => {
  const r = rbac.evaluateUserPermission(null, "delete");
  assert.deepStrictEqual(r, { hasExplicit: false, allowed: true });
});

test("ligne view=true, delete=false -> view ok, delete refusé (deny explicite gagne, règle 4)", () => {
  const row = { can_view: true, can_create: false, can_delete: false };
  assert.strictEqual(rbac.evaluateUserPermission(row, "view").allowed, true);
  assert.strictEqual(rbac.evaluateUserPermission(row, "delete").allowed, false);
  assert.strictEqual(rbac.evaluateUserPermission(row, "delete").hasExplicit, true);
});

test("colonne null -> non contraint (autorisé)", () => {
  const row = { can_view: true, can_export: null };
  assert.strictEqual(rbac.evaluateUserPermission(row, "export").allowed, true);
});

console.log("RBAC — défauts de rôles (PHASE 7)");

test("admin -> tout autorisé", () => {
  const p = rbac.defaultPermissionsForRole("admin", "comptabilite");
  assert.strictEqual(p.view && p.create && p.delete && p.export, true);
});

test("lecture_seule -> view uniquement", () => {
  const p = rbac.defaultPermissionsForRole("lecture_seule", "produits");
  assert.strictEqual(p.view, true);
  assert.strictEqual(p.create || p.update || p.delete, false);
});

test("comptable -> écriture sur finance, lecture seule ailleurs", () => {
  const fin = rbac.defaultPermissionsForRole("comptable", "comptabilite");
  const prod = rbac.defaultPermissionsForRole("comptable", "produits");
  assert.strictEqual(fin.create, true);
  assert.strictEqual(prod.create, false);
  assert.strictEqual(prod.view, true);
});

test("caissier -> écriture sur pos, lecture seule sur comptabilite", () => {
  assert.strictEqual(rbac.defaultPermissionsForRole("caissier", "pos").create, true);
  assert.strictEqual(rbac.defaultPermissionsForRole("caissier", "comptabilite").create, false);
});

test("registre : allModuleKeys contient parents et sous-modules pointés", () => {
  const keys = rbac.allModuleKeys();
  assert.ok(keys.includes("restaurant"));
  assert.ok(keys.includes("restaurant.cuisine"));
  assert.ok(keys.includes("education.notes"));
});

console.log(`\n✅ ${passed} tests RBAC passés.`);
