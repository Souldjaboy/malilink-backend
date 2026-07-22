"use strict";

/**
 * Tests du service catalogue central (Lot A). Client PG simulé.
 *   Lancer : npm test
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const catalog = require("./catalog");

test("upsertOffer : envoie un statut valide et normalise l'inconnu en 'published'", async () => {
  let captured = null;
  const db = { async query(text, params) { captured = params; return { rows: [{ id: 1, status: params[16] }] }; } };
  const r = await catalog.upsertOffer(db, {
    relatedModule: "travel", relatedId: 7, relatedSubtype: "route",
    category: "voyage", subcategory: "bus", title: "Bamako → Sikasso",
    price: 6000, status: "n'importe quoi",
  });
  assert.equal(captured[1], "travel");
  assert.equal(captured[2], 7);
  assert.equal(captured[16], "published"); // statut inconnu → published
  assert.equal(r.status, "published");
});

test("upsertOffer : conserve un statut valide (draft)", async () => {
  let captured = null;
  const db = { async query(text, params) { captured = params; return { rows: [{ status: params[16] }] }; } };
  await catalog.upsertOffer(db, { relatedModule: "travel", relatedId: 1, category: "voyage", title: "X", status: "draft" });
  assert.equal(captured[16], "draft");
});

test("setStatus : rejette un statut invalide", async () => {
  const db = { async query() { return { rows: [] }; } };
  await assert.rejects(() => catalog.setStatus(db, { relatedModule: "travel", relatedId: 1 }, "zzz"), /invalide/i);
});

test("setStatus : accepte 'suspended' et renvoie la ligne", async () => {
  const db = { async query(_t, params) { return { rows: [{ related_id: params[1], status: params[3] }] }; } };
  const r = await catalog.setStatus(db, { relatedModule: "travel", relatedId: 9, relatedSubtype: "route" }, "suspended");
  assert.equal(r.status, "suspended");
});

test("listPublished : passe les filtres et la limite bornée", async () => {
  let captured = null;
  const db = { async query(_t, params) { captured = params; return { rows: [{ id: 1 }] }; } };
  await catalog.listPublished(db, { category: "voyage", subcategory: "bus", q: "sikasso", limit: 999 });
  assert.equal(captured[0], "voyage");
  assert.equal(captured[1], "bus");
  assert.equal(captured[2], "sikasso");
  assert.equal(captured[3], 200); // borné à 200
});

test("countsBySubcategory : agrège en objet {sous-cat: n}", async () => {
  const db = { async query() { return { rows: [{ subcategory: "bus", n: 3 }, { subcategory: "plane", n: 1 }] }; } };
  const c = await catalog.countsBySubcategory(db, "voyage");
  assert.deepEqual(c, { bus: 3, plane: 1 });
});

test("categoryTree : construit racines + enfants", async () => {
  const rows = [
    { code: "voyage", parent_code: null, label: "Voyages et réservations", emoji: "🧳" },
    { code: "bus", parent_code: "voyage", label: "Bus", emoji: "🚌" },
    { code: "plane", parent_code: "voyage", label: "Avion", emoji: "✈️" },
    { code: "restaurant", parent_code: null, label: "Restaurants", emoji: "🍽️" },
  ];
  const db = { async query() { return { rows }; } };
  const tree = await catalog.categoryTree(db);
  const voyage = tree.find((t) => t.code === "voyage");
  assert.equal(tree.length, 2); // voyage + restaurant
  assert.equal(voyage.children.length, 2);
  assert.deepEqual(voyage.children.map((c) => c.code), ["bus", "plane"]);
});
