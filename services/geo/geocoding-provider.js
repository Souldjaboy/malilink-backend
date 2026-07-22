"use strict";

/**
 * Abstraction de géocodage (Lot 1).
 *
 * Interface commune GeocodingProvider — aucun fournisseur imposé dans le code :
 *   searchPlaces(query)                 → [{ name, country_code, country_name,
 *                                            region, city, lat, lon, type,
 *                                            provider, place_id }]
 *   resolvePlace(placeId)               → détail d'un lieu
 *   reverseGeocode(latitude, longitude) → lieu le plus proche
 *   calculateRoute(origin, destination) → { distance_km, duration_min }
 *
 * Fournisseur par défaut : Nominatim (OpenStreetMap), gratuit, aucune clé.
 * Configurable via GEOCODING_PROVIDER = nominatim | google | mapbox.
 * Si le fournisseur est indisponible (réseau coupé, quota), le service
 * appelant se rabat sur le référentiel local geo_locations — jamais d'erreur
 * bloquante, jamais de données inventées.
 */

const NominatimProvider = require("./nominatim-provider");

/** Fournisseur inactif : renvoie systématiquement vide (repli local pur). */
class NoopProvider {
  get name() { return "none"; }
  async searchPlaces() { return []; }
  async resolvePlace() { return null; }
  async reverseGeocode() { return null; }
}

/** Rayon terrestre — distance à vol d'oiseau (Haversine), commune à tous. */
function haversineKm(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some((v) => v == null || Number.isNaN(Number(v)))) return null;
  const R = 6371;
  const toRad = (d) => (Number(d) * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 10) / 10;
}

/**
 * Durée indicative selon la distance et le mode (vitesses moyennes réalistes).
 * Approximation : le partenaire peut toujours corriger.
 */
function estimateDurationMin(distanceKm, mode = "bus") {
  if (distanceKm == null) return null;
  const speed = {
    plane: 700, helico: 220, train: 90, bus: 60, car: 70,
    taxi: 65, moto: 45, boat: 35,
  }[mode] || 60;
  // + temps fixe d'embarquement/manœuvre selon le mode
  const overhead = mode === "plane" ? 90 : mode === "helico" ? 20 : 15;
  return Math.round((distanceKm / speed) * 60 + overhead);
}

function buildProvider() {
  const name = (process.env.GEOCODING_PROVIDER || "nominatim").toLowerCase();
  if (name === "none") return new NoopProvider();
  // google/mapbox : brancher ici quand une clé est configurée. Par défaut OSM.
  return new NominatimProvider();
}

let cached = null;
function getProvider() {
  if (!cached) cached = buildProvider();
  return cached;
}

module.exports = { getProvider, NoopProvider, haversineKm, estimateDurationMin };
