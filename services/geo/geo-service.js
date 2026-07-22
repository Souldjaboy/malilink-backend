"use strict";

/**
 * Service géographique (Lot 1) — orchestration du référentiel mondial.
 *
 * Recherche : référentiel LOCAL geo_locations d'abord (rapide, hors-ligne),
 * puis enrichissement par le fournisseur de géocodage (Nominatim par défaut)
 * si disponible. Un lieu sélectionné est PERSISTÉ (persistPlace) pour être
 * réutilisé — anti-doublon garanti par index unique. Jamais de texte libre non
 * vérifié comme destination : seule une entrée geo_locations (id) est acceptée.
 */

const { getProvider, haversineKm, estimateDurationMin } = require("./geocoding-provider");
const crypto = require("crypto");

function normalize(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function searchLocal(db, q, limit = 8) {
  const term = normalize(q);
  if (!term) return [];
  const { rows } = await db.query(
    `SELECT id, public_id, name, country_code, country_name, region, city,
            latitude, longitude, location_type
       FROM geo_locations
      WHERE is_active=true AND normalized_name LIKE $1
      ORDER BY (normalized_name = $2) DESC, length(name) ASC
      LIMIT $3`,
    [`${term}%`, term, limit]
  );
  return rows.map((r) => ({ ...r, source: "local" }));
}

/**
 * Recherche mondiale : local + fournisseur (candidats sans id, à persister au
 * moment du choix). Déduplique par (normalized_name, country_code).
 */
async function searchPlaces(db, q) {
  const local = await searchLocal(db, q, 8);
  const seen = new Set(local.map((l) => `${normalize(l.name)}|${l.country_code}`));
  const results = [...local];

  let providerResults = [];
  try {
    providerResults = await getProvider().searchPlaces(q);
  } catch {
    providerResults = [];
  }
  for (const p of providerResults) {
    const key = `${normalize(p.name)}|${p.country_code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      id: null, // candidat non encore persisté
      name: p.name,
      country_code: p.country_code,
      country_name: p.country_name,
      region: p.region,
      city: p.city,
      latitude: p.latitude,
      longitude: p.longitude,
      location_type: p.location_type,
      source: "provider",
      external_provider: p.provider,
      external_place_id: p.place_id,
    });
  }
  return results.slice(0, 12);
}

/** Insère (ou récupère) un lieu dans geo_locations. Anti-doublon. */
async function persistPlace(db, place, userId = null) {
  const name = String(place.name || "").trim();
  if (!name) throw new Error("Nom du lieu obligatoire.");
  const normalized = normalize(name);
  const publicId = `GEO-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
  const { rows } = await db.query(
    `INSERT INTO geo_locations
       (public_id, name, normalized_name, country_code, country_name, region, city,
        latitude, longitude, location_type, external_provider, external_place_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (normalized_name, country_code, location_type) DO UPDATE SET
       updated_at=NOW()
     RETURNING id, public_id, name, country_code, country_name, region, city,
               latitude, longitude, location_type`,
    [
      publicId, name, normalized, (place.country_code || "").toUpperCase(),
      place.country_name || "", place.region || "", place.city || "",
      place.latitude ?? null, place.longitude ?? null, place.location_type || "city",
      place.external_provider || "manual", place.external_place_id || "", userId,
    ]
  );
  return rows[0];
}

async function getById(db, id) {
  const { rows } = await db.query(
    `SELECT id, public_id, name, country_code, country_name, region, city,
            latitude, longitude, location_type FROM geo_locations WHERE id=$1 AND is_active=true`,
    [id]
  );
  return rows[0] || null;
}

/** Distance à vol d'oiseau + durée indicative entre deux lieux (par leur id). */
async function routeMetrics(db, originId, destinationId, mode = "bus") {
  const o = await getById(db, originId);
  const d = await getById(db, destinationId);
  if (!o || !d) return { distance_km: null, duration_min: null };
  const distance = haversineKm(o.latitude, o.longitude, d.latitude, d.longitude);
  return { distance_km: distance, duration_min: estimateDurationMin(distance, mode) };
}

module.exports = { normalize, searchLocal, searchPlaces, persistPlace, getById, routeMetrics };
