"use strict";

/**
 * Fournisseur de géocodage Nominatim (OpenStreetMap) — par défaut, gratuit.
 *
 * Respecte la politique d'usage OSM : User-Agent explicite, 1 requête/seconde
 * maximum, résultats mis en cache en mémoire. En cas d'indisponibilité réseau
 * ou de timeout, renvoie [] / null (jamais d'exception bloquante) : l'appelant
 * se rabat alors sur le référentiel local geo_locations.
 */

const BASE = process.env.NOMINATIM_URL || "https://nominatim.openstreetmap.org";
const UA = process.env.NOMINATIM_USER_AGENT || "MaliLink-Voyage/1.0 (contact: support@malilinkglobal.com)";
const MIN_INTERVAL_MS = 1000; // 1 req/s

const cache = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
let lastCall = 0;

async function throttle() {
  const wait = lastCall + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

async function getJson(url) {
  const key = url;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;
  await throttle();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: controller.signal });
    if (!res.ok) return null;
    const data = await res.json();
    cache.set(key, { at: Date.now(), data });
    return data;
  } catch {
    return null; // réseau coupé / timeout → repli local
  } finally {
    clearTimeout(timer);
  }
}

function mapItem(it) {
  const a = it.address || {};
  return {
    name: it.display_name ? String(it.display_name).split(",")[0] : it.name || "",
    display_name: it.display_name || "",
    country_code: (a.country_code || "").toUpperCase(),
    country_name: a.country || "",
    region: a.state || a.region || "",
    city: a.city || a.town || a.village || a.municipality || "",
    latitude: it.lat != null ? Number(it.lat) : null,
    longitude: it.lon != null ? Number(it.lon) : null,
    location_type: it.type === "aerodrome" || it.class === "aeroway" ? "airport"
      : it.type === "station" ? "train_station"
      : it.addresstype === "city" || a.city ? "city" : "address",
    provider: "nominatim",
    place_id: String(it.place_id || it.osm_id || ""),
  };
}

class NominatimProvider {
  get name() { return "nominatim"; }

  async searchPlaces(query) {
    const q = String(query || "").trim();
    if (q.length < 2) return [];
    const url = `${BASE}/search?format=jsonv2&addressdetails=1&limit=8&q=${encodeURIComponent(q)}`;
    const data = await getJson(url);
    return Array.isArray(data) ? data.map(mapItem) : [];
  }

  async resolvePlace(placeId) {
    const url = `${BASE}/details?format=json&place_id=${encodeURIComponent(placeId)}&addressdetails=1`;
    const data = await getJson(url);
    return data ? mapItem(data) : null;
  }

  async reverseGeocode(latitude, longitude) {
    const url = `${BASE}/reverse?format=jsonv2&addressdetails=1&lat=${latitude}&lon=${longitude}`;
    const data = await getJson(url);
    return data ? mapItem(data) : null;
  }
}

module.exports = NominatimProvider;
