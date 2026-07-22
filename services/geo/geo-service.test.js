"use strict";

/**
 * Tests du référentiel géographique mondial (Lot 1). Client PG simulé,
 * fournisseur de géocodage neutralisé (repli local).
 *   Lancer : npm test
 */

process.env.GEOCODING_PROVIDER = "none"; // pas d'appel réseau dans les tests

const test = require("node:test");
const assert = require("node:assert/strict");
const geo = require("./geo-service");
const { haversineKm, estimateDurationMin } = require("./geocoding-provider");

test("normalize : minuscules, sans accents, sans ponctuation", () => {
  assert.equal(geo.normalize("Ségou"), "segou");
  assert.equal(geo.normalize("Aéroport de Bamako-Sénou"), "aeroport de bamako senou");
  assert.equal(geo.normalize("  Paris  "), "paris");
});

test("haversine : distance Bamako–Paris ~ 4100 km", () => {
  const d = haversineKm(12.6392, -8.0029, 48.8566, 2.3522);
  assert.ok(d > 3900 && d < 4300, `distance ${d} hors plage attendue`);
});

test("haversine : coordonnées manquantes → null", () => {
  assert.equal(haversineKm(12.6, -8.0, null, 2.3), null);
});

test("estimateDurationMin : avion plus rapide que bus sur même distance", () => {
  const plane = estimateDurationMin(4100, "plane");
  const bus = estimateDurationMin(4100, "bus");
  assert.ok(plane < bus);
  assert.ok(plane > 0);
});

test("searchLocal : filtre par préfixe normalisé", async () => {
  let captured = null;
  const db = { async query(_t, params) { captured = params; return { rows: [{ id: 1, name: "Kayes", country_code: "ML" }] }; } };
  const r = await geo.searchLocal(db, "Kay");
  assert.equal(captured[0], "kay%");
  assert.equal(r[0].source, "local");
});

test("searchPlaces : local seul quand le fournisseur est neutralisé", async () => {
  const db = { async query() { return { rows: [{ id: 2, name: "Accra", country_code: "GH" }] }; } };
  const r = await geo.searchPlaces(db, "Accra");
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 2);
  assert.equal(r[0].source, "local");
});

test("persistPlace : refuse un nom vide", async () => {
  const db = { async query() { return { rows: [] }; } };
  await assert.rejects(() => geo.persistPlace(db, { name: "" }), /obligatoire/i);
});

test("persistPlace : normalise et insère, renvoie l'id", async () => {
  let captured = null;
  const db = { async query(_t, params) { captured = params; return { rows: [{ id: 9, name: params[1] }] }; } };
  const row = await geo.persistPlace(db, { name: "Paris", country_code: "fr", latitude: 48.85, longitude: 2.35 });
  assert.equal(captured[2], "paris");           // normalized_name
  assert.equal(captured[3], "FR");              // country_code en majuscules
  assert.equal(row.id, 9);
});

test("routeMetrics : distance + durée entre deux lieux connus", async () => {
  const byId = {
    1: { id: 1, latitude: 12.6392, longitude: -8.0029 }, // Bamako
    2: { id: 2, latitude: 14.4469, longitude: -11.4456 }, // Kayes
  };
  const db = { async query(_t, params) { return { rows: byId[params[0]] ? [byId[params[0]]] : [] }; } };
  const m = await geo.routeMetrics(db, 1, 2, "bus");
  assert.ok(m.distance_km > 300 && m.distance_km < 600, `distance ${m.distance_km}`);
  assert.ok(m.duration_min > 0);
});
