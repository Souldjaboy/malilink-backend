"use strict";

/**
 * CE QUI A LE DROIT DE SORTIR SUR INTERNET.
 *
 * Source unique du contrat public du catalogue. Toute réponse non
 * authentifiée passe par ici.
 *
 * La règle est une liste blanche, jamais une liste noire : on énumère les
 * champs autorisés au lieu de retirer les champs gênants d'un `SELECT *`.
 * Une liste noire oublie silencieusement toute colonne ajoutée plus tard —
 * c'est exactement ainsi que `location_code` et `warehouse`, données
 * d'entrepôt internes, se sont retrouvés exposés sur la fiche publique.
 *
 * Le stock n'est pas publié en clair. Un client a besoin de savoir si le
 * produit est disponible ; le niveau de stock, lui, renseigne un concurrent
 * sur l'activité du vendeur. On n'expose donc qu'une disponibilité.
 */

const access = require("../access-control");

/* Champs internes qui ne doivent jamais franchir la frontière publique.
   Sert uniquement d'assertion de test : le code de production, lui,
   construit la réponse par liste blanche. */
const CHAMPS_INTERNES_INTERDITS = [
  "location_code", "warehouse", "stock", "minimum_stock", "available_stock",
  "published_quantity", "sold_quantity", "available_quantity", "display_stock",
  "is_b2b", "is_b2c", "created_by", "product_id", "tenant_id", "cost",
  "cost_price", "purchase_price", "margin",
];

/** Accents, ponctuation et espaces deviennent des tirets ASCII. */
function slugify(value) {
  return String(value ?? "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * URL d'un produit : `/produit/<slug>-<id>`.
 *
 * L'identifiant reste la source de vérité et le seul critère de lecture. Le
 * slug est décoratif : un titre modifié change l'URL sans casser la page, et
 * un slug deviné ne donne accès à rien.
 */
function productPath(row) {
  const base = slugify(row.slug || row.public_title || row.title || "produit");
  return `/produit/${base ? `${base}-` : ""}${row.id}`;
}

/** L'identifiant porté par `<slug>-<id>`, ou 0 si le segment n'en contient pas. */
function idFromSlugParam(param) {
  const m = String(param ?? "").match(/(\d+)\s*$/);
  return m ? Number(m[1]) : 0;
}

/* Vitrine publique d'un vendeur.
   Surtout pas `/partenaires/<id>` : cette route-là est la fiche CRM privée
   d'un partenaire commercial (ventes, encaissements, impayés), réservée à
   l'entreprise connectée. Les deux notions portent le même mot et n'ont pas
   du tout le même public. */
function companyPath(profile) {
  return `/boutique/${profile?.slug || profile?.company_id}`;
}

/**
 * Chemin d'image réellement servi.
 *
 * Les images sont stockées tantôt en `/uploads/x.jpg`, tantôt en
 * `/api/uploads/x.jpg`. Seul le second est servi : le frontend ne relaie que
 * `/api/*` vers le backend. Un chemin non normalisé produit une image
 * introuvable — invisible sur la page, et surtout dans l'aperçu Open Graph
 * qu'affichent Facebook et WhatsApp au partage.
 */
function normaliserImage(url) {
  const brut = String(url ?? "").trim();
  if (!brut) return "";
  if (/^https?:\/\//i.test(brut) || brut.startsWith("/api/")) return brut;
  if (brut.startsWith("/uploads/")) return `/api${brut}`;
  return brut;
}

/** Liste d'images publiques, quelle que soit la forme stockée. */
function imageList(row) {
  const out = [];
  if (row.image_url) out.push(normaliserImage(row.image_url));
  const brut = row.images;
  const tableau = Array.isArray(brut)
    ? brut
    : typeof brut === "string"
      ? (() => { try { return JSON.parse(brut); } catch { return []; } })()
      : [];
  tableau.forEach((x) => {
    const url = normaliserImage(typeof x === "string" ? x : x?.url || x?.src || "");
    if (url) out.push(url);
  });
  return [...new Set(out.filter(Boolean))];
}

/**
 * Disponibilité commerciale, à partir de données internes qui ne sortent pas.
 * Renvoie un état, jamais une quantité.
 */
function availability(row) {
  const publiable = Math.min(
    Number(row.stock ?? Infinity),
    Number(row.available_quantity ?? row.available_stock ?? Infinity)
  );
  if (!Number.isFinite(publiable)) return "InStock"; // stock non suivi
  return publiable > 0 ? "InStock" : "OutOfStock";
}

/** La fiche produit telle qu'internet a le droit de la voir. */
function publicProduct(row) {
  if (!row) return null;
  const images = imageList(row);
  return {
    id: row.id,
    slug: slugify(row.slug || row.title || ""),
    url: productPath(row),
    title: row.title || "",
    description: row.description || "",
    reference: row.reference || "",          // référence commerciale, pas un secret
    price: Number(row.price || 0),
    currency: "XOF",
    availability: availability(row),
    category: row.category || "",
    images,
    image_url: images[0] || "",
    vendor: {
      company_id: row.company_id || null,
      name: row.vendor_name || "",
      slug: row.vendor_slug || "",
      city: row.vendor_city || "",
      quartier: row.vendor_quartier || "",
    },
    created_at: row.created_at || null,
    updated_at: row.updated_at || row.created_at || null,
  };
}

/* Réseaux acceptés sur un profil public, avec les domaines qui font foi.
   Un lien « Facebook » qui mène ailleurs que sur Facebook serait un piège
   pour le visiteur : le domaine est vérifié à l'écriture ET à la lecture. */
const RESEAUX_PUBLICS = {
  facebook: { label: "Facebook", domaines: ["facebook.com", "fb.com"] },
  instagram: { label: "Instagram", domaines: ["instagram.com"] },
  tiktok: { label: "TikTok", domaines: ["tiktok.com"] },
  whatsapp: { label: "WhatsApp", domaines: ["wa.me", "whatsapp.com"] },
  linkedin: { label: "LinkedIn", domaines: ["linkedin.com"] },
  x: { label: "X", domaines: ["x.com", "twitter.com"] },
  snapchat: { label: "Snapchat", domaines: ["snapchat.com"] },
  youtube: { label: "YouTube", domaines: ["youtube.com", "youtu.be"] },
  google_business: { label: "Google Business Profile", domaines: ["g.page", "google.com", "goo.gl"] },
};

/** L'URL https normalisée si elle pointe bien vers le réseau annoncé, sinon null. */
function lienReseau(cle, valeur) {
  const reseau = RESEAUX_PUBLICS[cle];
  const brut = String(valeur ?? "").trim();
  if (!reseau || !brut || brut.length > 300) return null;
  try {
    const u = new URL(brut);
    if (u.protocol !== "https:" || u.username || u.password) return null;
    const hote = u.hostname.toLowerCase();
    const ok = reseau.domaines.some((d) => hote === d || hote.endsWith(`.${d}`));
    return ok ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Uniquement les réseaux connus, aux liens vérifiés. */
function reseauxPublics(brut) {
  const source = brut && typeof brut === "object" && !Array.isArray(brut) ? brut : {};
  const out = {};
  for (const cle of Object.keys(RESEAUX_PUBLICS)) {
    const lien = lienReseau(cle, source[cle]);
    if (lien) out[cle] = lien;
  }
  return out;
}

/** Services saisis par l'entreprise : nom obligatoire, textes bornés. */
function servicesPublics(brut) {
  const liste = Array.isArray(brut) ? brut : [];
  return liste
    .map((s) => ({
      name: String(s?.name ?? "").trim().slice(0, 80),
      description: String(s?.description ?? "").trim().slice(0, 300),
    }))
    .filter((s) => s.name)
    .slice(0, 20);
}

/** Début d'un texte, coupé sur un mot. */
function extraitTexte(texte, longueur = 200) {
  const t = String(texte ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= longueur) return t;
  const coupe = t.slice(0, longueur);
  const espace = coupe.lastIndexOf(" ");
  return `${(espace > longueur * 0.6 ? coupe.slice(0, espace) : coupe).trim()}…`;
}

/** Horaires : un texte libre saisi par l'entreprise, jamais un objet interne. */
function horairesPublics(brut) {
  return typeof brut === "string" ? brut.trim().slice(0, 300) : "";
}

/* Type d'activité lisible. Le registre des profils métier est la seule
   source : pas de seconde liste de libellés. */
function activitePublique(businessType) {
  const cle = access.normalizeBusinessType(businessType);
  const profil = access.BUSINESS_PROFILES[cle] || access.BUSINESS_PROFILES.autre;
  return { key: cle, label: profil?.label || "Entreprise" };
}

/**
 * Le profil public d'une entreprise. Téléphone et email ne sortent que si
 * l'entreprise a explicitement coché de les afficher.
 */
function publicCompany(row) {
  if (!row) return null;
  return {
    company_id: row.company_id,
    slug: row.slug || String(row.company_id),
    name: row.name || "",
    description: row.description || "",
    logo_url: normaliserImage(row.logo_url),
    website: row.website || "",
    country: row.country || "",
    region: row.region || "",
    city: row.city || "",
    quartier: row.quartier || "",
    address_line: row.address_line || "",
    latitude: row.latitude != null ? Number(row.latitude) : null,
    longitude: row.longitude != null ? Number(row.longitude) : null,
    opening_hours: horairesPublics(row.opening_hours),
    phone: row.show_phone ? row.public_phone || "" : "",
    email: row.show_email ? row.public_email || "" : "",
    social_links: reseauxPublics(row.social_links),
    services: servicesPublics(row.services),
    activity: activitePublique(row.business_type),
    products_public: row.show_products === true,
    url: companyPath(row),
    updated_at: row.updated_at || null,
  };
}

module.exports = {
  CHAMPS_INTERNES_INTERDITS, RESEAUX_PUBLICS,
  slugify, productPath, companyPath, idFromSlugParam,
  imageList, normaliserImage, availability, publicProduct, publicCompany,
  lienReseau, reseauxPublics, servicesPublics, horairesPublics, activitePublique, extraitTexte,
};
