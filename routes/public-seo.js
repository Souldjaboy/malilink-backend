"use strict";

/**
 * SURFACE PUBLIQUE INDEXABLE — LECTURE SEULE, SANS AUTHENTIFICATION.
 *
 * Alimente le rendu serveur des pages publiques et le sitemap. Chaque réponse
 * est construite par `services/public-catalog`, qui énumère les champs
 * autorisés : aucune donnée d'entrepôt, aucun niveau de stock, aucun champ
 * interne ne peut sortir d'ici, y compris après ajout d'une colonne.
 *
 *   GET /public/products/:id          fiche produit publiée
 *   GET /public/companies             annuaire : profils publics ET listés
 *   GET /public/companies/:slugOrId   profil public d'entreprise (+ ses
 *                                     produits si elle a choisi de les montrer)
 *   GET /public/categories            catégories réellement portées par des
 *                                     produits publiés
 *   GET /public/sitemap               tout ce qui est indexable, avec lastmod
 *
 * Ces routes ne dépendent d'aucun produit : c'est le frontend qui décide de
 * les exposer ou non selon `appProduct`. Triangle et Hafiya ne les appellent
 * pas et n'indexent rien (`publicIndexing: false`).
 */

const express = require("express");
const catalogue = require("../services/public-catalog");

/* Un produit n'est public que publié, vendable et actif. Cette condition est
   écrite une fois : sitemap et fiche doivent répondre la même chose, sinon on
   indexe des pages qui renvoient 404. */
const PRODUIT_PUBLIC = `
  (mp.status = 'published' OR mp.is_published = true)
  AND p.is_sellable IS NOT FALSE
  AND p.is_active IS NOT FALSE`;

/* Les colonnes lues : jamais `mp.*`. Le stock interne est chargé uniquement
   pour calculer une disponibilité, et ne franchit pas le DTO.
   Le profil de l'entreprise (slug, ville, quartier) ne sort que s'il est
   publié : un brouillon de profil n'a rien à faire sur une fiche produit. */
const CHAMPS_PRODUIT = `
  mp.id, mp.company_id, mp.category, mp.slug, mp.created_at, mp.updated_at,
  mp.image_url, mp.images,
  COALESCE(NULLIF(mp.public_title,''), mp.title)             AS title,
  COALESCE(NULLIF(mp.public_description,''), mp.description) AS description,
  COALESCE(NULLIF(mp.public_price,0), mp.price, 0)           AS price,
  mp.available_quantity, mp.available_stock,
  p.reference, p.stock,
  c.name AS vendor_name,
  CASE WHEN cpp.is_public THEN cpp.slug END     AS vendor_slug,
  CASE WHEN cpp.is_public THEN cpp.city END     AS vendor_city,
  CASE WHEN cpp.is_public THEN cpp.quartier END AS vendor_quartier`;

const JOINTURES = `
  FROM marketplace_products mp
  LEFT JOIN products p            ON p.id = mp.product_id
  LEFT JOIN companies c           ON c.id = mp.company_id
  LEFT JOIN company_public_profile cpp ON cpp.company_id = mp.company_id`;

module.exports = function createPublicSeoRouter({ pool }) {
  const router = express.Router();

  const echec = (res, e, message) => {
    console.error(message, e.message);
    res.status(500).json({ error: message });
  };

  /** Fiche produit publiée. L'identifiant est le seul critère de lecture. */
  router.get("/public/products/:id", async (req, res) => {
    try {
      const id = catalogue.idFromSlugParam(req.params.id);
      if (!id) return res.status(404).json({ error: "Produit introuvable." });

      const { rows } = await pool.query(
        `SELECT ${CHAMPS_PRODUIT} ${JOINTURES} WHERE mp.id = $1 AND ${PRODUIT_PUBLIC} LIMIT 1`,
        [id]
      );
      if (!rows[0]) return res.status(404).json({ error: "Produit introuvable." });
      res.json({ product: catalogue.publicProduct(rows[0]) });
    } catch (e) { echec(res, e, "Erreur lecture du produit public."); }
  });

  /**
   * Annuaire des entreprises MaliLink.
   *
   * N'y figurent que les entreprises actives qui ont publié leur profil ET
   * accepté d'apparaître dans l'annuaire. Filtres : `q` (nom, description,
   * services), `ville`, `activite` (clé de profil métier), `page`.
   *
   * Le type d'activité se déduit du registre des profils métier, en
   * JavaScript : on lit donc l'ensemble borné des profils publics, puis on
   * filtre et pagine. Au-delà de quelques milliers d'entreprises publiques,
   * il faudra stocker la clé de profil pour filtrer en SQL.
   */
  router.get("/public/companies", async (req, res) => {
    try {
      const q = String(req.query.q || "").trim().slice(0, 80).toLowerCase();
      const ville = String(req.query.ville || "").trim().slice(0, 80).toLowerCase();
      const activite = String(req.query.activite || "").trim().slice(0, 40).toLowerCase();
      const parPage = Math.min(Math.max(Number(req.query.limit) || 24, 1), 48);
      const page = Math.max(Math.floor(Number(req.query.page) || 1), 1);

      const { rows } = await pool.query(
        `SELECT cpp.*, c.name, c.business_type,
                CASE WHEN cpp.show_products THEN (
                  SELECT count(*)::int
                    FROM marketplace_products mp
                    LEFT JOIN products p ON p.id = mp.product_id
                   WHERE mp.company_id = cpp.company_id AND ${PRODUIT_PUBLIC}
                ) ELSE 0 END AS produits_publics
           FROM company_public_profile cpp
           JOIN companies c ON c.id = cpp.company_id
          WHERE cpp.is_public = true
            AND cpp.listed_in_directory = true
            AND c.status = 'active'
          ORDER BY cpp.published_at DESC NULLS LAST, cpp.updated_at DESC, cpp.company_id DESC
          LIMIT 5000`
      );

      const fiches = rows.map((r) => ({ ...catalogue.publicCompany(r), products_count: r.produits_publics || 0 }));

      // Facettes calculées sur l'annuaire entier : on ne propose que ce qui existe.
      const villes = new Map();
      const activites = new Map();
      for (const f of fiches) {
        if (f.city) {
          const k = f.city.toLowerCase();
          villes.set(k, { name: villes.get(k)?.name || f.city, total: (villes.get(k)?.total || 0) + 1 });
        }
        const a = activites.get(f.activity.key) || { key: f.activity.key, label: f.activity.label, total: 0 };
        a.total += 1;
        activites.set(f.activity.key, a);
      }

      const retenues = fiches.filter((f) => {
        if (ville && f.city.toLowerCase() !== ville) return false;
        if (activite && f.activity.key !== activite) return false;
        if (q) {
          const texte = [f.name, f.description, f.city, f.quartier, ...f.services.map((s) => s.name)]
            .join(" ").toLowerCase();
          if (!texte.includes(q)) return false;
        }
        return true;
      });

      const total = retenues.length;
      const debut = (page - 1) * parPage;
      res.json({
        companies: retenues.slice(debut, debut + parPage).map((f) => ({
          company_id: f.company_id,
          slug: f.slug,
          name: f.name,
          description: catalogue.extraitTexte(f.description, 220),
          logo_url: f.logo_url,
          city: f.city,
          quartier: f.quartier,
          activity: f.activity,
          phone: f.phone,
          services: f.services.slice(0, 4).map((s) => s.name),
          products_count: f.products_public ? f.products_count : 0,
          url: f.url,
          updated_at: f.updated_at,
        })),
        total,
        page,
        pages: Math.max(Math.ceil(total / parPage), 1),
        per_page: parPage,
        facets: {
          cities: [...villes.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name, "fr")),
          activities: [...activites.values()].sort((a, b) => b.total - a.total || a.label.localeCompare(b.label, "fr")),
        },
      });
    } catch (e) { echec(res, e, "Erreur lecture de l'annuaire."); }
  });

  /**
   * Profil public d'entreprise. Accepte le slug ou l'identifiant, pour que les
   * anciens liens `/partenaires/<id>` continuent de fonctionner.
   */
  router.get("/public/companies/:slugOrId", async (req, res) => {
    try {
      const brut = String(req.params.slugOrId || "");
      const id = Number(brut) || 0;

      const { rows } = await pool.query(
        `SELECT cpp.*, c.name, c.business_type
           FROM company_public_profile cpp
           JOIN companies c ON c.id = cpp.company_id
          WHERE cpp.is_public = true
            AND c.status = 'active'
            AND (($1::int > 0 AND cpp.company_id = $1::int) OR lower(cpp.slug) = lower($2))
          LIMIT 1`,
        [id, brut]
      );
      if (!rows[0]) return res.status(404).json({ error: "Entreprise introuvable." });

      const entreprise = catalogue.publicCompany(rows[0]);
      // Les produits ne s'affichent sur la page que si l'entreprise l'a choisi.
      if (!entreprise.products_public) return res.json({ company: entreprise, products: [] });

      const { rows: produits } = await pool.query(
        `SELECT ${CHAMPS_PRODUIT} ${JOINTURES}
          WHERE mp.company_id = $1 AND ${PRODUIT_PUBLIC}
          ORDER BY mp.updated_at DESC NULLS LAST, mp.id DESC LIMIT 60`,
        [rows[0].company_id]
      );
      res.json({ company: entreprise, products: produits.map(catalogue.publicProduct) });
    } catch (e) { echec(res, e, "Erreur lecture du profil public."); }
  });

  /** Catégories réellement portées par des produits publiés — jamais une liste inventée. */
  router.get("/public/categories", async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT mp.category AS name, count(*)::int AS total, max(mp.updated_at) AS updated_at
           ${JOINTURES}
          WHERE ${PRODUIT_PUBLIC} AND NULLIF(mp.category,'') IS NOT NULL
          GROUP BY mp.category ORDER BY total DESC, mp.category`
      );
      res.json({
        categories: rows.map((r) => ({
          name: r.name,
          slug: catalogue.slugify(r.name),
          total: r.total,
          updated_at: r.updated_at,
        })),
      });
    } catch (e) { echec(res, e, "Erreur lecture des catégories."); }
  });

  /**
   * Tout ce qui est indexable, avec sa date de dernière modification réelle.
   * `lastmod` n'est renvoyé que lorsqu'une vraie date existe : une date
   * inventée apprend au moteur à ignorer le sitemap.
   */
  router.get("/public/sitemap", async (req, res) => {
    try {
      const [produits, entreprises, categories] = await Promise.all([
        pool.query(
          `SELECT mp.id, mp.slug, mp.updated_at, mp.created_at,
                  COALESCE(NULLIF(mp.public_title,''), mp.title) AS title
             ${JOINTURES} WHERE ${PRODUIT_PUBLIC}
            ORDER BY mp.updated_at DESC NULLS LAST, mp.id DESC LIMIT 45000`
        ),
        pool.query(
          `SELECT cpp.company_id, cpp.slug, cpp.updated_at
             FROM company_public_profile cpp
             JOIN companies c ON c.id = cpp.company_id
            WHERE cpp.is_public = true AND c.status = 'active'
            ORDER BY cpp.updated_at DESC NULLS LAST LIMIT 5000`
        ),
        pool.query(
          `SELECT mp.category AS name, max(mp.updated_at) AS updated_at
             ${JOINTURES} WHERE ${PRODUIT_PUBLIC} AND NULLIF(mp.category,'') IS NOT NULL
            GROUP BY mp.category`
        ),
      ]);

      res.json({
        products: produits.rows.map((r) => ({
          path: catalogue.productPath(r),
          lastmod: r.updated_at || r.created_at || null,
        })),
        companies: entreprises.rows.map((r) => ({
          path: catalogue.companyPath(r),
          lastmod: r.updated_at || null,
        })),
        categories: categories.rows.map((r) => ({
          path: `/marketplace?categorie=${encodeURIComponent(catalogue.slugify(r.name))}`,
          lastmod: r.updated_at || null,
        })),
        totals: {
          products: produits.rowCount,
          companies: entreprises.rowCount,
          categories: categories.rowCount,
        },
      });
    } catch (e) { echec(res, e, "Erreur construction du sitemap."); }
  });

  return router;
};
