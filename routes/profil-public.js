"use strict";

/**
 * Profil public MaliLink — édition par l'entreprise.
 *
 *   GET /company/public-profile   le profil (ou un brouillon vide) + des
 *                                 suggestions tirées des paramètres
 *   PUT /company/public-profile   enregistre ; publie ou retire
 *
 * Opt-in strict : rien ne devient public sans que l'entreprise coche
 * « Publier ». Les suggestions (téléphone, email, adresse des paramètres…)
 * ne sont JAMAIS enregistrées d'office : l'écran les propose, l'utilisateur
 * les reprend s'il le souhaite. Téléphone et email ont en plus leur propre
 * case « afficher ».
 *
 * Droits : « Paramètres » (Voir pour lire, Modifier pour enregistrer). Le
 * profil public est une décision de l'entreprise, disponible sur toutes les
 * offres.
 *
 * Ce que le profil publié permet — et ne permet pas : une page
 * /boutique/<slug> indexable et, si l'entreprise l'accepte, une fiche dans
 * l'annuaire /entreprises. MaliLink ne garantit aucun affichage dans Google :
 * l'indexation et le classement relèvent du moteur.
 */

const express = require("express");
const catalogue = require("../services/public-catalog");

const DESCRIPTION_MIN = 30;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const TELEPHONE = /^\+?[0-9 ()./-]{6,30}$/;

function texte(v, max) {
  return String(v ?? "").trim().slice(0, max);
}

/* Un site web : http(s) uniquement, sans identifiants dans l'URL. */
function siteWeb(v) {
  const brut = texte(v, 300);
  if (!brut) return "";
  try {
    const u = new URL(brut);
    if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/* Logo : une image déjà servie par MaliLink, ou une adresse https.
   L'envoi de logo (/upload-logo) renvoie une URL absolue dont l'hôte dépend
   du proxy (parfois en http) : on n'en garde que le chemin /api/uploads/…,
   servi par le site lui-même quel que soit le domaine. */
const CHEMIN_UPLOAD = /^\/(api\/)?uploads\/[A-Za-z0-9._/-]+$/;
function logo(v) {
  const brut = texte(v, 500);
  if (!brut) return "";
  if (CHEMIN_UPLOAD.test(brut) && !brut.includes("..")) return catalogue.normaliserImage(brut);
  try {
    const u = new URL(brut);
    if (u.username || u.password || !["http:", "https:"].includes(u.protocol)) return null;
    if (CHEMIN_UPLOAD.test(u.pathname) && !u.pathname.includes("..")) return catalogue.normaliserImage(u.pathname);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

function coordonnee(v, limite) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) <= limite ? Number(n.toFixed(6)) : undefined;
}

/** Ce qui manque pour publier. Vide = publiable. */
function manquantsPourPublier(p, nom) {
  const manque = [];
  if (!nom) manque.push("nom de l'entreprise");
  if (!p.slug) manque.push("adresse de la page");
  if ((p.description || "").length < DESCRIPTION_MIN) manque.push(`description (${DESCRIPTION_MIN} caractères minimum)`);
  if (!p.city) manque.push("ville");
  return manque;
}

module.exports = function createProfilPublicRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId, requirePermission } = deps;
  const router = express.Router();

  const perm = (cle, action) =>
    requirePermission ? requirePermission(cle, action) : (req, res, next) => next();
  const companyOf = (req) => getEffectiveCompanyId(req) || req.user?.company_id || null;

  async function lireSociete(companyId) {
    const { rows } = await pool.query(
      `SELECT id, name, business_type, status, email, phone, address FROM companies WHERE id = $1`,
      [companyId]
    );
    return rows[0] || null;
  }

  function vueProfil(row, societe) {
    const p = row || {};
    const liens = p.social_links && typeof p.social_links === "object" ? p.social_links : {};
    return {
      exists: Boolean(row),
      slug: p.slug || "",
      description: p.description || "",
      logo_url: p.logo_url || "",
      website: p.website || "",
      public_phone: p.public_phone || "",
      public_email: p.public_email || "",
      country: p.country || "",
      region: p.region || "",
      city: p.city || "",
      quartier: p.quartier || "",
      address_line: p.address_line || "",
      latitude: p.latitude != null ? Number(p.latitude) : null,
      longitude: p.longitude != null ? Number(p.longitude) : null,
      opening_hours: catalogue.horairesPublics(p.opening_hours),
      social_links: Object.fromEntries(Object.keys(catalogue.RESEAUX_PUBLICS).map((k) => [k, liens[k] || ""])),
      services: catalogue.servicesPublics(p.services),
      is_public: p.is_public === true,
      show_phone: p.show_phone === true,
      show_email: p.show_email === true,
      show_products: p.show_products === true,
      listed_in_directory: p.listed_in_directory !== false,
      published_at: p.published_at || null,
      updated_at: p.updated_at || null,
      public_url: p.is_public && p.slug ? catalogue.companyPath(p) : "",
      activity: catalogue.activitePublique(societe?.business_type),
      company_name: societe?.name || "",
    };
  }

  // ══════════════════════════════════════════════════════════ LECTURE

  router.get("/company/public-profile", authenticateToken, perm("parametres", "view"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      if (!companyId) return res.status(400).json({ error: "Choisissez d'abord une entreprise.", code: "SOCIETE_REQUISE" });
      const societe = await lireSociete(companyId);
      if (!societe) return res.status(404).json({ error: "Entreprise introuvable." });

      const { rows } = await pool.query(`SELECT * FROM company_public_profile WHERE company_id = $1`, [companyId]);
      const reglages = (await pool.query(
        `SELECT * FROM company_settings WHERE company_id = $1 ORDER BY id DESC LIMIT 1`, [companyId]
      )).rows[0] || {};
      const produits = (await pool.query(
        `SELECT count(*)::int AS n FROM marketplace_products
          WHERE company_id = $1 AND (status = 'published' OR is_published = true)`, [companyId]
      )).rows[0].n;

      /* Suggestions : ce que l'entreprise a déjà saisi ailleurs. Proposé,
         jamais enregistré ni publié sans action de l'utilisateur. */
      const suggestions = {
        slug: catalogue.slugify(societe.name),
        description: reglages.description || "",
        logo_url: reglages.logo_url || "",
        website: reglages.website || "",
        public_phone: reglages.phone || societe.phone || "",
        public_email: reglages.email || societe.email || "",
        city: reglages.city || "",
        country: reglages.country || "",
        address_line: reglages.address || societe.address || "",
        opening_hours: reglages.opening_hours || "",
        social_links: {
          facebook: reglages.facebook_url || "",
          instagram: reglages.instagram_url || "",
          whatsapp: reglages.whatsapp_number
            ? `https://wa.me/${String(reglages.whatsapp_number).replace(/[^0-9]/g, "")}`
            : "",
        },
      };

      res.json({
        profile: vueProfil(rows[0], societe),
        suggestions,
        published_products: produits,
        networks: Object.entries(catalogue.RESEAUX_PUBLICS).map(([cle, r]) => ({ key: cle, label: r.label, domains: r.domaines })),
        company_active: societe.status === "active",
        description_min: DESCRIPTION_MIN,
        missing_to_publish: manquantsPourPublier(vueProfil(rows[0], societe), societe.name),
      });
    } catch (e) {
      console.error("profil public lecture:", e);
      res.status(500).json({ error: "Erreur lors de la lecture du profil public." });
    }
  });

  // ══════════════════════════════════════════════════════ ENREGISTREMENT

  router.put("/company/public-profile", authenticateToken, perm("parametres", "update"), async (req, res) => {
    const client = await pool.connect();
    try {
      const companyId = companyOf(req);
      if (!companyId) return res.status(400).json({ error: "Choisissez d'abord une entreprise.", code: "SOCIETE_REQUISE" });
      const societe = await lireSociete(companyId);
      if (!societe) return res.status(404).json({ error: "Entreprise introuvable." });

      const b = req.body || {};
      const erreurs = [];

      // Adresse de la page : lettres obligatoires (un nombre seul désigne un identifiant).
      const slug = catalogue.slugify(b.slug || societe.name).slice(0, 60);
      if (slug.length < 3 || !/[a-z]/.test(slug)) erreurs.push("L'adresse de la page doit contenir au moins 3 caractères, dont une lettre.");

      const website = siteWeb(b.website);
      if (website === null) erreurs.push("Le site web doit être une adresse http(s) valide.");
      const logoUrl = logo(b.logo_url);
      if (logoUrl === null) erreurs.push("Le logo doit être une image MaliLink ou une adresse https.");

      const telephone = texte(b.public_phone, 30);
      if (telephone && !TELEPHONE.test(telephone)) erreurs.push("Numéro de téléphone public invalide.");
      const email = texte(b.public_email, 180).toLowerCase();
      if (email && !EMAIL.test(email)) erreurs.push("Email public invalide.");

      const latitude = coordonnee(b.latitude, 90);
      const longitude = coordonnee(b.longitude, 180);
      if (latitude === undefined || longitude === undefined) erreurs.push("Coordonnées GPS invalides.");

      // Réseaux : réseau connu, lien https vers son propre domaine.
      const liens = {};
      const source = b.social_links && typeof b.social_links === "object" ? b.social_links : {};
      for (const [cle, valeur] of Object.entries(source)) {
        if (!String(valeur ?? "").trim()) continue;
        if (!catalogue.RESEAUX_PUBLICS[cle]) { erreurs.push(`Réseau inconnu : ${cle}.`); continue; }
        const lien = catalogue.lienReseau(cle, valeur);
        if (!lien) {
          erreurs.push(`Le lien ${catalogue.RESEAUX_PUBLICS[cle].label} doit être une adresse https sur ${catalogue.RESEAUX_PUBLICS[cle].domaines.join(" ou ")}.`);
        } else {
          liens[cle] = lien;
        }
      }

      if (b.services !== undefined && !Array.isArray(b.services)) erreurs.push("Les services doivent être une liste.");
      const services = catalogue.servicesPublics(b.services);
      if (Array.isArray(b.services) && b.services.length > 20) erreurs.push("20 services au maximum.");

      const profil = {
        slug,
        description: texte(b.description, 1500),
        logo_url: logoUrl || "",
        website: website || "",
        public_phone: telephone,
        public_email: email,
        country: texte(b.country, 80),
        region: texte(b.region, 80),
        city: texte(b.city, 80),
        quartier: texte(b.quartier, 120),
        address_line: texte(b.address_line, 200),
        latitude: latitude ?? null,
        longitude: longitude ?? null,
        opening_hours: texte(b.opening_hours, 300),
        social_links: liens,
        services,
        is_public: b.is_public === true,
        show_phone: b.show_phone === true,
        show_email: b.show_email === true,
        show_products: b.show_products === true,
        listed_in_directory: b.listed_in_directory !== false,
      };

      if (profil.show_phone && !profil.public_phone) erreurs.push("Renseignez le téléphone public avant de l'afficher.");
      if (profil.show_email && !profil.public_email) erreurs.push("Renseignez l'email public avant de l'afficher.");
      if (erreurs.length) return res.status(400).json({ error: erreurs[0], errors: erreurs, code: "PROFIL_INVALIDE" });

      if (profil.is_public) {
        const manque = manquantsPourPublier(profil, societe.name);
        if (manque.length) {
          return res.status(400).json({
            error: `Pour publier, complétez : ${manque.join(", ")}.`,
            code: "PROFIL_INCOMPLET",
            missing: manque,
          });
        }
      }

      const pris = await client.query(
        `SELECT company_id FROM company_public_profile WHERE lower(slug) = lower($1) AND company_id <> $2`,
        [slug, companyId]
      );
      if (pris.rows.length) {
        return res.status(409).json({ error: `L'adresse « ${slug} » est déjà utilisée par une autre entreprise.`, code: "SLUG_PRIS" });
      }

      await client.query("BEGIN");
      const avant = (await client.query(
        `SELECT is_public, slug FROM company_public_profile WHERE company_id = $1 FOR UPDATE`, [companyId]
      )).rows[0] || null;

      const { rows } = await client.query(
        `INSERT INTO company_public_profile
           (company_id, slug, description, logo_url, website, public_phone, public_email,
            country, region, city, quartier, address_line, latitude, longitude, opening_hours,
            social_links, services, is_public, show_phone, show_email, show_products,
            listed_in_directory, published_at, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,to_jsonb($15::text),
                 $16::jsonb,$17::jsonb,$18,$19,$20,$21,$22,
                 CASE WHEN $18 THEN now() END, $23, now())
         ON CONFLICT (company_id) DO UPDATE SET
           slug = EXCLUDED.slug, description = EXCLUDED.description, logo_url = EXCLUDED.logo_url,
           website = EXCLUDED.website, public_phone = EXCLUDED.public_phone,
           public_email = EXCLUDED.public_email, country = EXCLUDED.country, region = EXCLUDED.region,
           city = EXCLUDED.city, quartier = EXCLUDED.quartier, address_line = EXCLUDED.address_line,
           latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
           opening_hours = EXCLUDED.opening_hours, social_links = EXCLUDED.social_links,
           services = EXCLUDED.services, is_public = EXCLUDED.is_public,
           show_phone = EXCLUDED.show_phone, show_email = EXCLUDED.show_email,
           show_products = EXCLUDED.show_products, listed_in_directory = EXCLUDED.listed_in_directory,
           -- Date de mise en ligne : posée à la publication, conservée tant
           -- que le profil reste public, effacée au retrait.
           published_at = CASE
             WHEN NOT EXCLUDED.is_public THEN NULL
             WHEN company_public_profile.is_public THEN company_public_profile.published_at
             ELSE now() END,
           updated_by = EXCLUDED.updated_by, updated_at = now()
         RETURNING *`,
        [companyId, profil.slug, profil.description, profil.logo_url, profil.website,
         profil.public_phone, profil.public_email, profil.country, profil.region, profil.city,
         profil.quartier, profil.address_line, profil.latitude, profil.longitude, profil.opening_hours,
         JSON.stringify(profil.social_links), JSON.stringify(profil.services), profil.is_public,
         profil.show_phone, profil.show_email, profil.show_products, profil.listed_in_directory,
         req.user.id]
      );

      const etaitPublic = avant?.is_public === true;
      const action = profil.is_public && !etaitPublic ? "profil_public_publie"
        : !profil.is_public && etaitPublic ? "profil_public_retire"
          : "profil_public_modifie";
      await client.query(
        `INSERT INTO audit_logs (company_id, user_id, action, entity_type, entity_id, old_values, new_values)
         VALUES ($1, $2, $3, 'company_public_profile', $4, $5, $6)`,
        [companyId, req.user.id, action, String(companyId),
         JSON.stringify(avant || {}),
         JSON.stringify({ is_public: profil.is_public, slug: profil.slug, listed_in_directory: profil.listed_in_directory,
           show_phone: profil.show_phone, show_email: profil.show_email, show_products: profil.show_products })]
      );
      await client.query("COMMIT");

      res.json({
        profile: vueProfil(rows[0], societe),
        message: profil.is_public
          ? "Profil publié. Sa page est accessible à tous et l'annuaire se met à jour sous une minute ; son apparition dans les moteurs de recherche dépend de leur indexation."
          : etaitPublic
            ? "Profil retiré : la page publique n'est plus accessible, la fiche de l'annuaire disparaît sous une minute."
            : "Profil enregistré. Il n'est pas public.",
      });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      if (e.code === "23505") {
        return res.status(409).json({ error: "Cette adresse de page vient d'être prise par une autre entreprise.", code: "SLUG_PRIS" });
      }
      console.error("profil public enregistrement:", e);
      res.status(500).json({ error: "Erreur lors de l'enregistrement du profil public." });
    } finally {
      client.release();
    }
  });

  return router;
};
