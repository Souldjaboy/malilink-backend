"use strict";

/**
 * Module générique « Marketing & Réseaux sociaux » (comptes professionnels
 * d'une entreprise).
 *
 * À ne pas confondre avec MaliLink Social (routes/social.js), qui est le
 * réseau social des personnes. Ici on gère les comptes d'une entreprise,
 * ses publications et son calendrier éditorial. Préfixe de tables : smm_.
 *
 * V1 sans connecteur : aucune API officielle n'est configurée, donc rien
 * n'est publié pour de vrai. Un compte reste « non_connecte » et une
 * publication ne peut pas passer à « publie » toute seule — annoncer une
 * publication qui n'a pas eu lieu serait pire que ne rien annoncer.
 */

const express = require("express");
const vault = require("../services/secret-vault");

module.exports = function createMarketingRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId, requirePermission } = deps;
  const router = express.Router();

  const perm = (action) =>
    requirePermission ? requirePermission("marketing", action) : (req, res, next) => next();
  const companyOf = (req) => getEffectiveCompanyId(req) || req.user.company_id;
  const txt = (v, max = 255) => String(v ?? "").trim().slice(0, max);

  const RESEAUX = new Set(["facebook", "instagram", "tiktok", "whatsapp", "linkedin", "x"]);
  const STATUTS_POST = new Set(["brouillon", "programme", "publie", "echoue"]);

  // ══════════════════════════════════════════════════════════ COMPTES

  router.get("/marketing/comptes", authenticateToken, perm("view"), async (req, res) => {
    try {
      /* Le jeton n'est jamais renvoyé : seulement le fait qu'il existe. */
      const { rows } = await pool.query(
        `SELECT id, network, display_name, handle, profile_url, status,
                connected_at, token_expires_at, notes, created_at,
                (token_encrypted <> '') AS jeton_configure
           FROM smm_accounts WHERE company_id = $1
          ORDER BY network, display_name`,
        [companyOf(req)]
      );
      res.json({ comptes: rows, chiffrement_actif: vault.isEnabled() });
    } catch (e) {
      console.error("smm comptes list:", e);
      res.status(500).json({ error: "Erreur lors de la lecture des comptes." });
    }
  });

  router.post("/marketing/comptes", authenticateToken, perm("manage_accounts"), async (req, res) => {
    try {
      const reseau = txt(req.body?.network, 40).toLowerCase();
      if (!RESEAUX.has(reseau)) {
        return res.status(400).json({ error: "Réseau non pris en charge.", code: "RESEAU_INCONNU",
          reseaux_acceptes: [...RESEAUX] });
      }
      const nom = txt(req.body?.display_name, 180);
      if (!nom) return res.status(400).json({ error: "Le nom affiché est obligatoire." });

      const { rows } = await pool.query(
        `INSERT INTO smm_accounts
           (company_id, network, display_name, handle, profile_url, status, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,'non_connecte',$6,$7) RETURNING
           id, network, display_name, handle, profile_url, status, notes, created_at`,
        [companyOf(req), reseau, nom, txt(req.body?.handle, 180),
         txt(req.body?.profile_url, 500), txt(req.body?.notes, 1000), req.user.id]
      );
      res.status(201).json({ compte: rows[0] });
    } catch (e) {
      console.error("smm compte create:", e);
      res.status(500).json({ error: "Erreur lors de la création du compte." });
    }
  });

  router.delete("/marketing/comptes/:id", authenticateToken, perm("manage_accounts"), async (req, res) => {
    try {
      const { rows } = await pool.query(
        `DELETE FROM smm_accounts WHERE id = $1 AND company_id = $2 RETURNING id`,
        [Number(req.params.id), companyOf(req)]);
      if (!rows.length) return res.status(404).json({ error: "Compte introuvable." });
      res.json({ ok: true });
    } catch (e) {
      console.error("smm compte delete:", e);
      res.status(500).json({ error: "Erreur lors de la suppression du compte." });
    }
  });

  // ═════════════════════════════════════════════════════ PUBLICATIONS

  router.get("/marketing/publications", authenticateToken, perm("view"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const params = [companyId];
      let where = "p.company_id = $1";
      if (req.query.status && STATUTS_POST.has(String(req.query.status))) {
        params.push(String(req.query.status));
        where += ` AND p.status = $${params.length}`;
      }
      if (req.query.du) { params.push(req.query.du); where += ` AND p.scheduled_for >= $${params.length}`; }
      if (req.query.au) { params.push(req.query.au); where += ` AND p.scheduled_for <= $${params.length}`; }

      const { rows } = await pool.query(
        `SELECT p.id, p.title, p.body, p.network, p.status, p.scheduled_for,
                p.published_at, p.failure_reason, p.account_id, p.created_at,
                a.display_name AS account_name,
                (SELECT COUNT(*)::int FROM smm_media m
                  WHERE m.post_id = p.id AND m.company_id = p.company_id) AS medias
           FROM smm_posts p
           LEFT JOIN smm_accounts a ON a.id = p.account_id AND a.company_id = p.company_id
          WHERE ${where}
          ORDER BY COALESCE(p.scheduled_for, p.created_at) DESC
          LIMIT 500`,
        params
      );

      const resume = (await pool.query(
        `SELECT COUNT(*) FILTER (WHERE status='brouillon')::int AS brouillons,
                COUNT(*) FILTER (WHERE status='programme')::int  AS programmes,
                COUNT(*) FILTER (WHERE status='publie')::int     AS publies,
                COUNT(*) FILTER (WHERE status='echoue')::int     AS echoues
           FROM smm_posts WHERE company_id = $1`, [companyId])).rows[0];

      res.json({ publications: rows, resume });
    } catch (e) {
      console.error("smm publications list:", e);
      res.status(500).json({ error: "Erreur lors de la lecture des publications." });
    }
  });

  router.post("/marketing/publications", authenticateToken, perm("create"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const corps = txt(req.body?.body, 5000);
      if (!corps) return res.status(400).json({ error: "Le texte de la publication est obligatoire." });

      /* Un compte d'une autre société ne doit jamais pouvoir être ciblé. */
      let accountId = null;
      let reseau = txt(req.body?.network, 40).toLowerCase();
      if (req.body?.account_id) {
        const { rows } = await pool.query(
          `SELECT id, network FROM smm_accounts WHERE id = $1 AND company_id = $2`,
          [Number(req.body.account_id), companyId]);
        if (!rows.length) {
          return res.status(400).json({ error: "Compte inconnu pour votre entreprise.", code: "ACCOUNT_NOT_ALLOWED" });
        }
        accountId = rows[0].id;
        reseau = rows[0].network;
      }
      if (reseau && !RESEAUX.has(reseau)) {
        return res.status(400).json({ error: "Réseau non pris en charge.", code: "RESEAU_INCONNU" });
      }

      /* « publie » ne peut pas être demandé : aucune publication réelle
         n'a lieu tant qu'aucun connecteur officiel n'est configuré. */
      let statut = txt(req.body?.status, 30) || "brouillon";
      if (statut === "publie" || statut === "echoue") statut = "brouillon";
      if (!STATUTS_POST.has(statut)) statut = "brouillon";

      const quand = req.body?.scheduled_for || null;
      if (statut === "programme" && !quand) {
        return res.status(400).json({ error: "Une publication programmée exige une date." });
      }

      const { rows } = await pool.query(
        `INSERT INTO smm_posts
           (company_id, account_id, network, title, body, status, scheduled_for, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [companyId, accountId, reseau, txt(req.body?.title), corps, statut, quand, req.user.id]
      );
      res.status(201).json({ publication: rows[0] });
    } catch (e) {
      console.error("smm publication create:", e);
      res.status(500).json({ error: "Erreur lors de la création de la publication." });
    }
  });

  router.put("/marketing/publications/:id", authenticateToken, perm("update"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      let statut = txt(req.body?.status, 30);
      if (statut === "publie" || statut === "echoue") statut = "";  // jamais posé à la main
      if (statut && !STATUTS_POST.has(statut)) statut = "";

      const { rows } = await pool.query(
        `UPDATE smm_posts SET
           title         = COALESCE($3, title),
           body          = COALESCE($4, body),
           status        = COALESCE($5, status),
           scheduled_for = COALESCE($6, scheduled_for),
           updated_at    = CURRENT_TIMESTAMP
         WHERE id = $1 AND company_id = $2 AND status <> 'publie'
         RETURNING *`,
        [Number(req.params.id), companyId,
         req.body?.title === undefined ? null : txt(req.body.title),
         req.body?.body === undefined ? null : txt(req.body.body, 5000),
         statut || null, req.body?.scheduled_for || null]
      );
      if (!rows.length) {
        return res.status(404).json({ error: "Publication introuvable ou déjà publiée." });
      }
      res.json({ publication: rows[0] });
    } catch (e) {
      console.error("smm publication update:", e);
      res.status(500).json({ error: "Erreur lors de la mise à jour." });
    }
  });

  router.delete("/marketing/publications/:id", authenticateToken, perm("delete"), async (req, res) => {
    try {
      const { rows } = await pool.query(
        `DELETE FROM smm_posts WHERE id = $1 AND company_id = $2 RETURNING id`,
        [Number(req.params.id), companyOf(req)]);
      if (!rows.length) return res.status(404).json({ error: "Publication introuvable." });
      res.json({ ok: true });
    } catch (e) {
      console.error("smm publication delete:", e);
      res.status(500).json({ error: "Erreur lors de la suppression." });
    }
  });

  // ══════════════════════════════════════════════════ TABLEAU DE BORD

  router.get("/marketing/tableau-de-bord", authenticateToken, perm("view"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const comptes = (await pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'connecte')::int AS connectes
           FROM smm_accounts WHERE company_id = $1`, [companyId])).rows[0];
      const posts = (await pool.query(
        `SELECT COUNT(*) FILTER (WHERE status='brouillon')::int AS brouillons,
                COUNT(*) FILTER (WHERE status='programme')::int  AS programmes,
                COUNT(*) FILTER (WHERE status='publie')::int     AS publies,
                COUNT(*) FILTER (WHERE status='echoue')::int     AS echoues
           FROM smm_posts WHERE company_id = $1`, [companyId])).rows[0];
      const prochaines = (await pool.query(
        `SELECT id, title, network, scheduled_for FROM smm_posts
          WHERE company_id = $1 AND status = 'programme' AND scheduled_for >= CURRENT_TIMESTAMP
          ORDER BY scheduled_for LIMIT 10`, [companyId])).rows;

      res.json({
        comptes, publications: posts, prochaines,
        connecteurs_actifs: false,
        message_connecteurs:
          "Aucun connecteur officiel n'est configuré : les publications sont préparées ici, puis publiées à la main sur chaque réseau.",
      });
    } catch (e) {
      console.error("smm tableau de bord:", e);
      res.status(500).json({ error: "Erreur lors du calcul du tableau de bord." });
    }
  });

  return router;
};
