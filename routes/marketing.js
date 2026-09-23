"use strict";

/**
 * Module générique « Marketing & Réseaux sociaux ».
 *
 * À ne pas confondre avec MaliLink Social (routes/social.js, tables social_*),
 * le réseau social des personnes. Ici : les comptes PROFESSIONNELS d'une
 * entreprise, ses publications, son calendrier et ses campagnes. Tables smm_*.
 *
 * Aucune API officielle n'est connectée (Meta, Google, TikTok, LinkedIn, X,
 * Snapchat). Le module ne publie et ne lance donc RIEN tout seul :
 *   - une publication passe à « publiée » quand un utilisateur autorisé
 *     déclare l'avoir publiée à la main, avec le lien qui le prouve ;
 *   - une campagne se crée et se paie sur la plateforme officielle (lien
 *     fourni) ; ses étapes au-delà de « prête » sont des déclarations
 *     manuelles, marquées comme telles.
 * Aucun système de paiement publicitaire n'est contourné.
 *
 * Droits (registre RBAC) :
 *   marketing               voir le module
 *   marketing.comptes       gérer les comptes (créer / supprimer)
 *   marketing.publications  créer, modifier, supprimer ; « Valider » = publier
 *   marketing.campagnes     préparer ; « Valider » = faire avancer le statut
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer");

// ── Plateformes et régies, avec leurs liens OFFICIELS ────────────────
const PLATEFORMES = {
  facebook: { label: "Facebook", lien: "https://business.facebook.com/", api: "Meta Graph API" },
  instagram: { label: "Instagram", lien: "https://business.facebook.com/", api: "Instagram Graph API" },
  tiktok: { label: "TikTok", lien: "https://www.tiktok.com/tiktokstudio", api: "TikTok Content Posting API" },
  whatsapp: { label: "WhatsApp Business", lien: "https://business.whatsapp.com/", api: "WhatsApp Business Platform" },
  linkedin: { label: "LinkedIn", lien: "https://www.linkedin.com/", api: "LinkedIn Marketing API" },
  x: { label: "X", lien: "https://x.com/compose/post", api: "X API" },
  snapchat: { label: "Snapchat", lien: "https://business.snapchat.com/", api: "Snap Marketing API" },
  google_business: { label: "Google Business Profile", lien: "https://business.google.com/", api: "Business Profile API" },
};

const REGIES = {
  meta_ads: { label: "Meta Ads (Facebook, Instagram)", lien: "https://adsmanager.facebook.com/" },
  google_ads: { label: "Google Ads", lien: "https://ads.google.com/" },
  tiktok_ads: { label: "TikTok Ads", lien: "https://ads.tiktok.com/" },
  linkedin_ads: { label: "LinkedIn Ads", lien: "https://www.linkedin.com/campaignmanager/" },
  snapchat_ads: { label: "Snapchat Ads", lien: "https://ads.snapchat.com/" },
};

const OBJECTIFS = {
  notoriete: "Notoriété", trafic: "Trafic vers un lien", engagement: "Engagement",
  prospects: "Prospects", ventes: "Ventes", messages: "Messages",
};

const STATUTS_POST = new Set(["brouillon", "programme", "publie", "echoue"]);
const STATUTS_POSABLES = new Set(["brouillon", "programme"]); // jamais « publie » à la main ici

/* Statut d'une campagne : qui peut aller où. Au-delà de « prêt », chaque
   étape est une DÉCLARATION de ce qui s'est passé sur la plateforme. */
const TRANSITIONS = {
  brouillon: ["pret"],
  pret: ["brouillon", "en_attente"],
  en_attente: ["actif", "erreur"],
  actif: ["termine", "erreur"],
  erreur: ["brouillon"],
  termine: [],
};

const MESSAGE_CONNECTEURS =
  "Aucun connecteur officiel n'est installé : rien n'est publié ni lancé automatiquement. "
  + "Préparez ici, publiez ou lancez sur la plateforme officielle, puis enregistrez le lien.";

function lienHttps(v) {
  const t = String(v || "").trim();
  if (!t) return "";
  if (t.length > 500) return null;
  try {
    const u = new URL(t);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

module.exports = function createMarketingRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId, requirePermission } = deps;
  const router = express.Router();

  const perm = (cle, action) =>
    requirePermission ? requirePermission(cle, action) : (req, res, next) => next();
  const companyOf = (req) => getEffectiveCompanyId(req) || req.user.company_id;
  const txt = (v, max = 255) => String(v ?? "").trim().slice(0, max);

  // ── Médias : dossier dédié, noms aléatoires, types et taille bornés ──
  const dossierMedias = path.join(__dirname, "..", "uploads", "marketing");
  fs.mkdirSync(dossierMedias, { recursive: true });
  const TYPES_MEDIA = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "video/mp4": ".mp4", "video/webm": ".webm" };
  const envoiMedia = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, dossierMedias),
      // Nom aléatoire : ni le nom d'origine ni la société ne s'y lisent.
      filename: (req, file, cb) => cb(null, `${crypto.randomBytes(16).toString("hex")}${TYPES_MEDIA[file.mimetype] || ""}`),
    }),
    limits: { fileSize: 25 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => (TYPES_MEDIA[file.mimetype]
      ? cb(null, true)
      : cb(new Error("Format non accepté : JPG, PNG, WEBP, MP4 ou WEBM."))),
  });

  async function appartient(table, id, companyId) {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) return null;
    const { rows } = await pool.query(`SELECT * FROM ${table} WHERE id = $1 AND company_id = $2`, [n, companyId]);
    return rows[0] || null;
  }

  // ══════════════════════════════════════════════════ TABLEAU DE BORD

  router.get("/marketing/tableau-de-bord", authenticateToken, perm("marketing", "view"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const comptes = (await pool.query(
        `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'connecte')::int AS connectes
           FROM smm_accounts WHERE company_id = $1`, [companyId])).rows[0];
      const publications = (await pool.query(
        `SELECT COUNT(*) FILTER (WHERE status='brouillon')::int AS brouillons,
                COUNT(*) FILTER (WHERE status='programme')::int  AS programmes,
                COUNT(*) FILTER (WHERE status='publie')::int     AS publies,
                COUNT(*) FILTER (WHERE status='echoue')::int     AS echoues
           FROM smm_posts WHERE company_id = $1`, [companyId])).rows[0];
      const campagnes = (await pool.query(
        `SELECT status, COUNT(*)::int AS n FROM smm_campaigns WHERE company_id = $1 GROUP BY status`, [companyId])).rows;
      const prochaines = (await pool.query(
        `SELECT id, title, network, scheduled_for FROM smm_posts
          WHERE company_id = $1 AND status = 'programme' AND scheduled_for >= CURRENT_TIMESTAMP
          ORDER BY scheduled_for LIMIT 10`, [companyId])).rows;
      res.json({
        comptes, publications,
        campagnes: Object.fromEntries(campagnes.map((c) => [c.status, c.n])),
        prochaines,
        connecteurs_actifs: false,
        message_connecteurs: MESSAGE_CONNECTEURS,
        statistiques_disponibles: false,
        message_statistiques: "Les statistiques d'audience viendront des API officielles, une fois connectées. Aucune donnée n'est estimée.",
        plateformes: Object.entries(PLATEFORMES).map(([cle, p]) => ({ cle, ...p, connecte: false })),
        regies: Object.entries(REGIES).map(([cle, r]) => ({ cle, ...r })),
        objectifs: OBJECTIFS,
      });
    } catch (e) {
      console.error("marketing tableau de bord:", e);
      res.status(500).json({ error: "Erreur lors du calcul du tableau de bord." });
    }
  });

  // ══════════════════════════════════════════════════════════ COMPTES

  router.get("/marketing/comptes", authenticateToken, perm("marketing.comptes", "view"), async (req, res) => {
    try {
      // Le jeton OAuth n'est jamais renvoyé : seulement le fait qu'il existe.
      const { rows } = await pool.query(
        `SELECT id, network, display_name, handle, profile_url, status, connected_at, notes, created_at,
                (token_encrypted <> '') AS jeton_configure
           FROM smm_accounts WHERE company_id = $1 ORDER BY network, display_name`, [companyOf(req)]);
      res.json({ comptes: rows.map((c) => ({ ...c, plateforme: PLATEFORMES[c.network] || null })) });
    } catch (e) {
      console.error("marketing comptes:", e);
      res.status(500).json({ error: "Erreur lors de la lecture des comptes." });
    }
  });

  router.post("/marketing/comptes", authenticateToken, perm("marketing.comptes", "create"), async (req, res) => {
    try {
      const reseau = txt(req.body?.network, 40).toLowerCase();
      if (!PLATEFORMES[reseau]) {
        return res.status(400).json({ error: "Plateforme non prise en charge.", code: "RESEAU_INCONNU", reseaux_acceptes: Object.keys(PLATEFORMES) });
      }
      const nom = txt(req.body?.display_name, 180);
      if (!nom) return res.status(400).json({ error: "Le nom affiché est obligatoire." });
      const lien = lienHttps(req.body?.profile_url);
      if (lien === null) return res.status(400).json({ error: "Le lien du profil doit commencer par https://", code: "LIEN_INVALIDE" });
      const { rows } = await pool.query(
        `INSERT INTO smm_accounts (company_id, network, display_name, handle, profile_url, status, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,'non_connecte',$6,$7)
         RETURNING id, network, display_name, handle, profile_url, status, notes, created_at`,
        [companyOf(req), reseau, nom, txt(req.body?.handle, 180), lien, txt(req.body?.notes, 1000), req.user.id]);
      res.status(201).json({ compte: rows[0] });
    } catch (e) {
      console.error("marketing compte create:", e);
      res.status(500).json({ error: "Erreur lors de la création du compte." });
    }
  });

  router.delete("/marketing/comptes/:id", authenticateToken, perm("marketing.comptes", "delete"), async (req, res) => {
    try {
      const { rows } = await pool.query(`DELETE FROM smm_accounts WHERE id = $1 AND company_id = $2 RETURNING id`,
        [Number(req.params.id), companyOf(req)]);
      if (!rows.length) return res.status(404).json({ error: "Compte introuvable." });
      res.json({ ok: true });
    } catch (e) {
      console.error("marketing compte delete:", e);
      res.status(500).json({ error: "Erreur lors de la suppression du compte." });
    }
  });

  // ═════════════════════════════════════════════════════ PUBLICATIONS

  router.get("/marketing/publications", authenticateToken, perm("marketing.publications", "view"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const params = [companyId];
      let where = "p.company_id = $1";
      if (req.query.status && STATUTS_POST.has(String(req.query.status))) {
        params.push(String(req.query.status)); where += ` AND p.status = $${params.length}`;
      }
      if (req.query.du) { params.push(req.query.du); where += ` AND COALESCE(p.scheduled_for, p.published_at, p.created_at) >= $${params.length}`; }
      if (req.query.au) { params.push(req.query.au); where += ` AND COALESCE(p.scheduled_for, p.published_at, p.created_at) < $${params.length}`; }
      const { rows } = await pool.query(
        `SELECT p.id, p.title, p.body, p.network, p.status, p.scheduled_for, p.published_at,
                p.published_url, p.published_manually, p.failure_reason, p.account_id, p.created_at,
                a.display_name AS account_name,
                COALESCE((SELECT json_agg(json_build_object('id', m.id, 'kind', m.kind, 'url', m.url) ORDER BY m.position, m.id)
                            FROM smm_media m WHERE m.post_id = p.id AND m.company_id = p.company_id), '[]') AS medias
           FROM smm_posts p
           LEFT JOIN smm_accounts a ON a.id = p.account_id AND a.company_id = p.company_id
          WHERE ${where}
          ORDER BY COALESCE(p.scheduled_for, p.published_at, p.created_at) DESC
          LIMIT 500`, params);
      res.json({ publications: rows });
    } catch (e) {
      console.error("marketing publications:", e);
      res.status(500).json({ error: "Erreur lors de la lecture des publications." });
    }
  });

  async function compteCible(req, companyId) {
    if (!req.body?.account_id) return { ok: true, id: null, reseau: txt(req.body?.network, 40).toLowerCase() };
    const compte = await appartient("smm_accounts", req.body.account_id, companyId);
    return compte ? { ok: true, id: compte.id, reseau: compte.network } : { ok: false };
  }

  router.post("/marketing/publications", authenticateToken, perm("marketing.publications", "create"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const corps = txt(req.body?.body, 5000);
      if (!corps) return res.status(400).json({ error: "Le texte de la publication est obligatoire." });
      const cible = await compteCible(req, companyId);
      if (!cible.ok) return res.status(400).json({ error: "Compte inconnu pour votre entreprise.", code: "ACCOUNT_NOT_ALLOWED" });
      if (cible.reseau && !PLATEFORMES[cible.reseau]) return res.status(400).json({ error: "Plateforme non prise en charge.", code: "RESEAU_INCONNU" });

      // « publiée » ou « échouée » ne se posent jamais à la création.
      let statut = txt(req.body?.status, 30) || "brouillon";
      if (!STATUTS_POSABLES.has(statut)) statut = "brouillon";
      const quand = req.body?.scheduled_for || null;
      if (statut === "programme" && !quand) return res.status(400).json({ error: "Une publication programmée exige une date." });

      const { rows } = await pool.query(
        `INSERT INTO smm_posts (company_id, account_id, network, title, body, status, scheduled_for, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [companyId, cible.id, cible.reseau || "", txt(req.body?.title), corps, statut, quand, req.user.id]);
      res.status(201).json({ publication: rows[0] });
    } catch (e) {
      console.error("marketing publication create:", e);
      res.status(500).json({ error: "Erreur lors de la création de la publication." });
    }
  });

  router.put("/marketing/publications/:id", authenticateToken, perm("marketing.publications", "update"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const statut = txt(req.body?.status, 30);
      if (statut && !STATUTS_POSABLES.has(statut)) {
        return res.status(400).json({ error: "Ce statut ne se pose pas ici : utilisez « Marquer comme publiée ».", code: "STATUT_INTERDIT" });
      }
      const { rows } = await pool.query(
        `UPDATE smm_posts SET
           title = COALESCE($3, title), body = COALESCE($4, body),
           status = COALESCE($5, status), scheduled_for = COALESCE($6, scheduled_for),
           updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND company_id = $2 AND status <> 'publie'
         RETURNING *`,
        [Number(req.params.id), companyId,
         req.body?.title === undefined ? null : txt(req.body.title),
         req.body?.body === undefined ? null : txt(req.body.body, 5000),
         statut || null, req.body?.scheduled_for || null]);
      if (!rows.length) return res.status(404).json({ error: "Publication introuvable ou déjà publiée." });
      res.json({ publication: rows[0] });
    } catch (e) {
      console.error("marketing publication update:", e);
      res.status(500).json({ error: "Erreur lors de la mise à jour." });
    }
  });

  /* Publier = droit « Valider » sur marketing.publications. Sans connecteur
     officiel, c'est la DÉCLARATION d'une publication faite à la main sur le
     réseau, avec le lien public de la publication comme preuve. */
  router.post("/marketing/publications/:id/publier", authenticateToken, perm("marketing.publications", "validate"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const lien = lienHttps(req.body?.published_url);
      if (!lien) {
        return res.status(400).json({
          error: "Indiquez le lien https:// de la publication sur le réseau : aucun connecteur ne publie à votre place.",
          code: "LIEN_PUBLICATION_REQUIS",
        });
      }
      const { rows } = await pool.query(
        `UPDATE smm_posts SET status = 'publie', published_at = CURRENT_TIMESTAMP, published_url = $3,
                published_manually = TRUE, published_by = $4, failure_reason = '', updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND company_id = $2 AND status IN ('brouillon','programme','echoue')
          RETURNING *`, [Number(req.params.id), companyId, lien, req.user.id]);
      if (!rows.length) return res.status(404).json({ error: "Publication introuvable ou déjà publiée." });
      res.json({ publication: rows[0], precision: "Enregistrée comme publiée MANUELLEMENT, avec son lien." });
    } catch (e) {
      console.error("marketing publier:", e);
      res.status(500).json({ error: "Erreur lors de l'enregistrement." });
    }
  });

  router.post("/marketing/publications/:id/echec", authenticateToken, perm("marketing.publications", "validate"), async (req, res) => {
    try {
      const raison = txt(req.body?.reason, 500);
      if (!raison) return res.status(400).json({ error: "Indiquez la raison de l'échec." });
      const { rows } = await pool.query(
        `UPDATE smm_posts SET status = 'echoue', failure_reason = $3, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND company_id = $2 AND status IN ('brouillon','programme') RETURNING *`,
        [Number(req.params.id), companyOf(req), raison]);
      if (!rows.length) return res.status(404).json({ error: "Publication introuvable ou déjà publiée." });
      res.json({ publication: rows[0] });
    } catch (e) {
      console.error("marketing echec:", e);
      res.status(500).json({ error: "Erreur lors de l'enregistrement." });
    }
  });

  router.delete("/marketing/publications/:id", authenticateToken, perm("marketing.publications", "delete"), async (req, res) => {
    try {
      const { rows } = await pool.query(`DELETE FROM smm_posts WHERE id = $1 AND company_id = $2 RETURNING id`,
        [Number(req.params.id), companyOf(req)]);
      if (!rows.length) return res.status(404).json({ error: "Publication introuvable." });
      res.json({ ok: true });
    } catch (e) {
      console.error("marketing publication delete:", e);
      res.status(500).json({ error: "Erreur lors de la suppression." });
    }
  });

  // ══════════════════════════════════════════════════════════ MÉDIAS

  router.post("/marketing/publications/:id/medias", authenticateToken, perm("marketing.publications", "update"),
    (req, res, next) => envoiMedia.single("fichier")(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message || "Fichier refusé.", code: "MEDIA_REFUSE" });
      next();
    }),
    async (req, res) => {
      const supprimerFichier = () => { if (req.file) fs.promises.unlink(req.file.path).catch(() => {}); };
      try {
        const companyId = companyOf(req);
        const post = await appartient("smm_posts", req.params.id, companyId);
        if (!post) { supprimerFichier(); return res.status(404).json({ error: "Publication introuvable." }); }
        if (!req.file) return res.status(400).json({ error: "Aucun fichier reçu.", code: "MEDIA_ABSENT" });
        const kind = req.file.mimetype.startsWith("video/") ? "video" : "image";
        const { rows } = await pool.query(
          `INSERT INTO smm_media (company_id, post_id, kind, url, caption, position)
           VALUES ($1,$2,$3,$4,$5,(SELECT COALESCE(MAX(position),0)+1 FROM smm_media WHERE post_id=$2)) RETURNING id, kind, url`,
          [companyId, post.id, kind, `/uploads/marketing/${req.file.filename}`, txt(req.body?.caption, 500)]);
        res.status(201).json({ media: rows[0] });
      } catch (e) {
        supprimerFichier();
        console.error("marketing media:", e);
        res.status(500).json({ error: "Erreur lors de l'ajout du média." });
      }
    });

  router.delete("/marketing/medias/:id", authenticateToken, perm("marketing.publications", "update"), async (req, res) => {
    try {
      const { rows } = await pool.query(`DELETE FROM smm_media WHERE id = $1 AND company_id = $2 RETURNING url`,
        [Number(req.params.id), companyOf(req)]);
      if (!rows.length) return res.status(404).json({ error: "Média introuvable." });
      const nom = path.basename(String(rows[0].url || ""));
      if (/^[a-f0-9]{32}\.(jpg|png|webp|mp4|webm)$/.test(nom)) fs.promises.unlink(path.join(dossierMedias, nom)).catch(() => {});
      res.json({ ok: true });
    } catch (e) {
      console.error("marketing media delete:", e);
      res.status(500).json({ error: "Erreur lors de la suppression du média." });
    }
  });

  // ════════════════════════════════════════════════════════ CAMPAGNES

  function lireCampagne(corps) {
    const erreurs = [];
    const lien = lienHttps(corps.destination_url);
    if (lien === null) erreurs.push("Le lien de destination doit commencer par https://");
    const budget = corps.budget_total === undefined || corps.budget_total === "" ? undefined : Number(corps.budget_total);
    if (budget !== undefined && (!Number.isFinite(budget) || budget < 0)) erreurs.push("Budget invalide.");
    const plateforme = corps.platform === undefined ? undefined : txt(corps.platform, 30);
    if (plateforme !== undefined && !REGIES[plateforme]) erreurs.push("Régie publicitaire non prise en charge.");
    const objectif = corps.objective === undefined ? undefined : txt(corps.objective, 30);
    if (objectif !== undefined && !OBJECTIFS[objectif]) erreurs.push("Objectif inconnu.");
    if (corps.start_date && corps.end_date && String(corps.end_date) < String(corps.start_date)) erreurs.push("La fin précède le début.");
    return { erreurs, lien, budget, plateforme, objectif };
  }

  /* Le pilote pg renvoie une colonne DATE comme un objet Date à minuit LOCAL ;
     sérialisé en JSON, il devient la veille en UTC (1er octobre → 30 septembre
     dès que le serveur n'est pas en UTC). On rend la date telle que saisie,
     à partir de ses composantes locales. */
  const dateSaisie = (d) => {
    if (!(d instanceof Date)) return d || null;
    const z = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
  };
  const campagneJson = (c) => ({
    ...c, start_date: dateSaisie(c.start_date), end_date: dateSaisie(c.end_date),
    regie: REGIES[c.platform] || null, manques: manquesPourPret(c), transitions: TRANSITIONS[c.status] || [],
  });

  /* Une campagne n'est « prête » que complète : sinon on la lancerait sur la
     plateforme avec des trous. */
  function manquesPourPret(c) {
    const m = [];
    if (!c.name) m.push("nom");
    if (!REGIES[c.platform]) m.push("régie");
    if (!(Number(c.budget_total) > 0)) m.push("budget");
    if (!c.start_date) m.push("date de début");
    if (!c.end_date) m.push("date de fin");
    if (!c.destination_url) m.push("lien de destination");
    if (!c.content && !c.post_id) m.push("contenu");
    if (!c.zone) m.push("zone");
    return m;
  }

  router.get("/marketing/campagnes", authenticateToken, perm("marketing.campagnes", "view"), async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT c.*, p.title AS publication FROM smm_campaigns c
           LEFT JOIN smm_posts p ON p.id = c.post_id AND p.company_id = c.company_id
          WHERE c.company_id = $1 ORDER BY c.updated_at DESC LIMIT 300`, [companyOf(req)]);
      res.json({ campagnes: rows.map(campagneJson) });
    } catch (e) {
      console.error("marketing campagnes:", e);
      res.status(500).json({ error: "Erreur lors de la lecture des campagnes." });
    }
  });

  router.post("/marketing/campagnes", authenticateToken, perm("marketing.campagnes", "create"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const nom = txt(req.body?.name, 180);
      if (!nom) return res.status(400).json({ error: "Le nom de la campagne est obligatoire." });
      const v = lireCampagne(req.body || {});
      if (!v.plateforme) v.erreurs.push("Choisissez la régie publicitaire.");
      if (v.erreurs.length) return res.status(400).json({ error: v.erreurs.join(" "), code: "CAMPAGNE_INVALIDE" });
      let postId = null;
      if (req.body?.post_id) {
        const post = await appartient("smm_posts", req.body.post_id, companyId);
        if (!post) return res.status(400).json({ error: "Publication inconnue pour votre entreprise.", code: "POST_NOT_ALLOWED" });
        postId = post.id;
      }
      const { rows } = await pool.query(
        `INSERT INTO smm_campaigns (company_id, name, platform, objective, post_id, content, audience, zone,
                                    budget_total, start_date, end_date, destination_url, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) RETURNING *`,
        [companyId, nom, v.plateforme, v.objectif || "notoriete", postId, txt(req.body?.content, 5000),
         txt(req.body?.audience, 1000), txt(req.body?.zone, 500), v.budget ?? 0,
         req.body?.start_date || null, req.body?.end_date || null, v.lien || "", req.user.id]);
      res.status(201).json({ campagne: campagneJson(rows[0]) });
    } catch (e) {
      if (e.code === "23514") return res.status(400).json({ error: "Valeur refusée (dates ou budget).", code: "CAMPAGNE_INVALIDE" });
      console.error("marketing campagne create:", e);
      res.status(500).json({ error: "Erreur lors de la création de la campagne." });
    }
  });

  router.put("/marketing/campagnes/:id", authenticateToken, perm("marketing.campagnes", "update"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const c = await appartient("smm_campaigns", req.params.id, companyId);
      if (!c) return res.status(404).json({ error: "Campagne introuvable." });
      if (!["brouillon", "pret"].includes(c.status)) {
        return res.status(409).json({ error: "Une campagne lancée ne se modifie plus : ses réglages vivent sur la plateforme.", code: "CAMPAGNE_LANCEE" });
      }
      const v = lireCampagne(req.body || {});
      if (v.erreurs.length) return res.status(400).json({ error: v.erreurs.join(" "), code: "CAMPAGNE_INVALIDE" });
      const { rows } = await pool.query(
        `UPDATE smm_campaigns SET
           name = COALESCE($3, name), platform = COALESCE($4, platform), objective = COALESCE($5, objective),
           content = COALESCE($6, content), audience = COALESCE($7, audience), zone = COALESCE($8, zone),
           budget_total = COALESCE($9, budget_total), start_date = COALESCE($10, start_date),
           end_date = COALESCE($11, end_date), destination_url = COALESCE($12, destination_url),
           status = 'brouillon', updated_by = $13, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND company_id = $2 RETURNING *`,
        [c.id, companyId, req.body?.name === undefined ? null : txt(req.body.name, 180), v.plateforme ?? null,
         v.objectif ?? null, req.body?.content === undefined ? null : txt(req.body.content, 5000),
         req.body?.audience === undefined ? null : txt(req.body.audience, 1000),
         req.body?.zone === undefined ? null : txt(req.body.zone, 500), v.budget ?? null,
         req.body?.start_date || null, req.body?.end_date || null,
         req.body?.destination_url === undefined ? null : v.lien, req.user.id]);
      // Toute modification renvoie en brouillon : il faudra re-valider « prête ».
      res.json({ campagne: campagneJson(rows[0]) });
    } catch (e) {
      if (e.code === "23514") return res.status(400).json({ error: "Valeur refusée (dates ou budget).", code: "CAMPAGNE_INVALIDE" });
      console.error("marketing campagne update:", e);
      res.status(500).json({ error: "Erreur lors de la mise à jour." });
    }
  });

  router.post("/marketing/campagnes/:id/statut", authenticateToken, perm("marketing.campagnes", "validate"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const c = await appartient("smm_campaigns", req.params.id, companyId);
      if (!c) return res.status(404).json({ error: "Campagne introuvable." });
      const vers = txt(req.body?.status, 20);
      if (!(TRANSITIONS[c.status] || []).includes(vers)) {
        return res.status(409).json({
          error: `Passage de « ${c.status} » à « ${vers || "?"} » impossible.`,
          code: "TRANSITION_INTERDITE", transitions: TRANSITIONS[c.status] || [],
        });
      }
      if (vers === "pret") {
        const manques = manquesPourPret(c);
        if (manques.length) return res.status(400).json({ error: `Campagne incomplète : ${manques.join(", ")}.`, code: "CAMPAGNE_INCOMPLETE", manques });
      }
      const reference = txt(req.body?.external_ref, 500);
      if (vers === "en_attente" && !reference) {
        return res.status(400).json({
          error: `Créez et payez la campagne sur ${REGIES[c.platform]?.label || "la plateforme officielle"}, puis indiquez sa référence ou son lien.`,
          code: "REFERENCE_PLATEFORME_REQUISE", lien_officiel: REGIES[c.platform]?.lien || null,
        });
      }
      const note = txt(req.body?.note, 1000);
      if (vers === "erreur" && !note) return res.status(400).json({ error: "Indiquez ce qui s'est passé.", code: "NOTE_REQUISE" });
      const manuel = ["en_attente", "actif", "termine", "erreur"].includes(vers);
      const { rows } = await pool.query(
        `UPDATE smm_campaigns SET status = $3,
                external_ref = CASE WHEN $4 <> '' THEN $4 ELSE external_ref END,
                status_note = $5, declared_manually = declared_manually OR $6,
                updated_by = $7, updated_at = CURRENT_TIMESTAMP
          WHERE id = $1 AND company_id = $2 RETURNING *`,
        [c.id, companyId, vers, reference, note, manuel, req.user.id]);
      res.json({
        campagne: campagneJson(rows[0]),
        precision: manuel ? "Statut déclaré MANUELLEMENT : aucune API publicitaire n'est connectée." : "",
      });
    } catch (e) {
      console.error("marketing campagne statut:", e);
      res.status(500).json({ error: "Erreur lors du changement de statut." });
    }
  });

  router.delete("/marketing/campagnes/:id", authenticateToken, perm("marketing.campagnes", "delete"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const c = await appartient("smm_campaigns", req.params.id, companyId);
      if (!c) return res.status(404).json({ error: "Campagne introuvable." });
      // L'historique d'une campagne lancée se garde.
      if (!["brouillon", "pret", "erreur"].includes(c.status)) {
        return res.status(409).json({ error: "Une campagne lancée ou terminée se garde dans l'historique.", code: "CAMPAGNE_HISTORIQUE" });
      }
      await pool.query(`DELETE FROM smm_campaigns WHERE id = $1 AND company_id = $2`, [c.id, companyId]);
      res.json({ ok: true });
    } catch (e) {
      console.error("marketing campagne delete:", e);
      res.status(500).json({ error: "Erreur lors de la suppression." });
    }
  });

  return router;
};

module.exports.PLATEFORMES = PLATEFORMES;
module.exports.REGIES = REGIES;
module.exports.TRANSITIONS = TRANSITIONS;
