"use strict";

/**
 * Service du catalogue central MaliLink (Lot A).
 *
 * Générique et agnostique du module : chaque module (Voyage, Hôtel, Resto…)
 * compose une « offre » et l'enregistre ici via upsertOffer. Le catalogue ne
 * duplique JAMAIS la donnée métier — il stocke une référence (related_module +
 * related_id) et des champs d'affichage. Seules les offres `published` sont
 * visibles côté client.
 */

const STATUSES = ["draft", "pending", "published", "suspended", "archived"];

/**
 * Insère ou met à jour une offre par sa référence source.
 * @param offer { relatedModule, relatedId, relatedSubtype?, companyModule?,
 *   companyId?, companyName?, category, subcategory?, title, description?,
 *   price?, currency?, availability?, location?, photos?, status? }
 */
async function upsertOffer(db, offer) {
  const status = STATUSES.includes(offer.status) ? offer.status : "published";
  const { rows } = await db.query(
    `INSERT INTO catalog_offers
       (tenant_id, related_module, related_id, related_subtype, company_module,
        company_id, company_name, category, subcategory, title, description,
        price, currency, availability, location, photos, status, published_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
             CASE WHEN $17='published' THEN NOW() ELSE NULL END)
     ON CONFLICT (related_module, related_id, related_subtype) DO UPDATE SET
       company_module=EXCLUDED.company_module, company_id=EXCLUDED.company_id,
       company_name=EXCLUDED.company_name, category=EXCLUDED.category,
       subcategory=EXCLUDED.subcategory, title=EXCLUDED.title,
       description=EXCLUDED.description, price=EXCLUDED.price,
       currency=EXCLUDED.currency, availability=EXCLUDED.availability,
       location=EXCLUDED.location, photos=EXCLUDED.photos,
       status=EXCLUDED.status, updated_at=NOW(),
       published_at=CASE WHEN EXCLUDED.status='published'
                         THEN COALESCE(catalog_offers.published_at, NOW())
                         ELSE catalog_offers.published_at END
     RETURNING *`,
    [
      offer.tenantId || "malilink", offer.relatedModule, offer.relatedId,
      offer.relatedSubtype || "", offer.companyModule || "", offer.companyId || null,
      offer.companyName || "", offer.category, offer.subcategory || "", offer.title,
      offer.description || "", offer.price ?? null, offer.currency || "XOF",
      offer.availability ?? null, offer.location || "", JSON.stringify(offer.photos || []),
      status,
    ]
  );
  return rows[0];
}

/** Change le statut d'une offre par sa référence source. */
async function setStatus(db, { relatedModule, relatedId, relatedSubtype = "" }, status) {
  if (!STATUSES.includes(status)) throw new Error(`Statut catalogue invalide: ${status}`);
  const { rows } = await db.query(
    `UPDATE catalog_offers
        SET status=$4, updated_at=NOW(),
            published_at=CASE WHEN $4='published' THEN COALESCE(published_at, NOW()) ELSE published_at END
      WHERE related_module=$1 AND related_id=$2 AND related_subtype=$3
      RETURNING *`,
    [relatedModule, relatedId, relatedSubtype, status]
  );
  return rows[0] || null;
}

async function getByRef(db, { relatedModule, relatedId, relatedSubtype = "" }) {
  const { rows } = await db.query(
    `SELECT * FROM catalog_offers WHERE related_module=$1 AND related_id=$2 AND related_subtype=$3`,
    [relatedModule, relatedId, relatedSubtype]
  );
  return rows[0] || null;
}

/** Liste des offres PUBLIÉES (client). Filtres category/subcategory/q. */
async function listPublished(db, { category = null, subcategory = null, q = null, limit = 60 } = {}) {
  const { rows } = await db.query(
    `SELECT id, related_module, related_id, related_subtype, company_id, company_name,
            category, subcategory, title, description, price, currency, availability,
            location, photos, published_at
       FROM catalog_offers
      WHERE status='published'
        AND ($1::text IS NULL OR category=$1)
        AND ($2::text IS NULL OR subcategory=$2)
        AND ($3::text IS NULL OR title ILIKE '%'||$3||'%' OR description ILIKE '%'||$3||'%' OR company_name ILIKE '%'||$3||'%')
      ORDER BY published_at DESC NULLS LAST, id DESC
      LIMIT $4`,
    [category, subcategory, q, Math.min(Number(limit) || 60, 200)]
  );
  return rows;
}

/** Comptage des offres publiées par (sous-)catégorie — pour l'UI. */
async function countsBySubcategory(db, category) {
  const { rows } = await db.query(
    `SELECT subcategory, COUNT(*)::int AS n FROM catalog_offers
      WHERE status='published' AND ($1::text IS NULL OR category=$1)
      GROUP BY subcategory`,
    [category]
  );
  return rows.reduce((acc, r) => { acc[r.subcategory || category] = r.n; return acc; }, {});
}

async function categoryTree(db) {
  const { rows } = await db.query(
    `SELECT code, parent_code, label, emoji, sort_order FROM catalog_categories
      WHERE enabled=true ORDER BY sort_order, code`
  );
  const roots = rows.filter((r) => !r.parent_code).map((r) => ({
    code: r.code, label: r.label, emoji: r.emoji,
    children: rows.filter((c) => c.parent_code === r.code).map((c) => ({ code: c.code, label: c.label, emoji: c.emoji })),
  }));
  return roots;
}

module.exports = { STATUSES, upsertOffer, setStatus, getByRef, listPublished, countsBySubcategory, categoryTree };
