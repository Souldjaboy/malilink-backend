"use strict";

/**
 * Module générique « Caméras & Sécurité ».
 *
 * V1 : inventaire, état, organisation, rattachement au site. Pas de flux
 * vidéo : tant que l'infrastructure n'est pas prête, afficher un lecteur
 * donnerait l'illusion d'un service qui n'existe pas.
 *
 * Deux règles tiennent tout le module :
 *  1. company_id vient TOUJOURS du jeton, jamais du corps de la requête.
 *     Un warehouse_id ou un recorder_id fourni par l'appelant est vérifié
 *     comme appartenant à SA société avant d'être écrit.
 *  2. Un identifiant caméra (mot de passe, RTSP) entre chiffré et ne
 *     ressort jamais : l'API n'expose qu'un booléen « configuré ».
 */

const express = require("express");
const vault = require("../services/secret-vault");

module.exports = function createCamerasRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId, requirePermission } = deps;
  const router = express.Router();

  const perm = (action) =>
    requirePermission ? requirePermission("cameras", action) : (req, res, next) => next();
  const companyOf = (req) => getEffectiveCompanyId(req) || req.user.company_id;
  const txt = (v, max = 255) => String(v ?? "").trim().slice(0, max);

  const STATUTS = new Set(["actif", "inactif", "maintenance", "retire"]);
  const ETATS_RESEAU = new Set(["en_ligne", "hors_ligne", "inconnu"]);

  /* Un identifiant d'une AUTRE société ne doit jamais pouvoir être rattaché.
     On renvoie null plutôt que l'id, et l'appelant refuse. */
  async function idDeLaSociete(table, id, companyId) {
    if (id === null || id === undefined || id === "") return { ok: true, id: null };
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) return { ok: false, id: null };
    const { rows } = await pool.query(
      `SELECT id FROM ${table} WHERE id = $1 AND company_id = $2`, [n, companyId]);
    return rows.length ? { ok: true, id: n } : { ok: false, id: null };
  }

  async function journaliser(companyId, userId, cameraId, action, detail, req) {
    try {
      await pool.query(
        `INSERT INTO camera_access_logs (company_id, camera_id, user_id, action, detail, ip)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [companyId, cameraId, userId, action, txt(detail, 500),
         txt(req.headers["x-forwarded-for"] || req.ip || "", 80)]
      );
    } catch (e) {
      console.error("camera_access_logs:", e.message || e);
    }
  }

  // ════════════════════════════════════════════════ ENREGISTREURS (NVR/DVR)

  router.get("/cameras/enregistreurs", authenticateToken, perm("view"), async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT r.id, r.name, r.kind, r.brand, r.model, r.channels, r.host,
                r.status, r.notes, r.warehouse_id, w.name AS warehouse_name,
                EXISTS (SELECT 1 FROM camera_credentials c
                         WHERE c.recorder_id = r.id AND c.company_id = r.company_id
                           AND c.secret_encrypted <> '') AS identifiants_configures
           FROM camera_recorders r
           LEFT JOIN warehouses w ON w.id = r.warehouse_id AND w.company_id = r.company_id
          WHERE r.company_id = $1
          ORDER BY r.name`,
        [companyOf(req)]
      );
      res.json({ enregistreurs: rows });
    } catch (e) {
      console.error("enregistreurs list:", e);
      res.status(500).json({ error: "Erreur lors de la lecture des enregistreurs." });
    }
  });

  router.post("/cameras/enregistreurs", authenticateToken, perm("create"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const nom = txt(req.body?.name, 180);
      if (!nom) return res.status(400).json({ error: "Le nom est obligatoire." });

      const site = await idDeLaSociete("warehouses", req.body?.warehouse_id, companyId);
      if (!site.ok) return res.status(400).json({ error: "Site inconnu pour votre entreprise.", code: "WAREHOUSE_NOT_ALLOWED" });

      const { rows } = await pool.query(
        `INSERT INTO camera_recorders
           (company_id, warehouse_id, name, kind, brand, model, channels, host, notes, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [companyId, site.id, nom,
         ["nvr", "dvr"].includes(txt(req.body?.kind)) ? txt(req.body.kind) : "nvr",
         txt(req.body?.brand, 120), txt(req.body?.model, 120),
         Number.isInteger(Number(req.body?.channels)) ? Number(req.body.channels) : 0,
         txt(req.body?.host), txt(req.body?.notes, 1000),
         STATUTS.has(txt(req.body?.status)) ? txt(req.body.status) : "actif",
         req.user.id]
      );
      res.status(201).json({ enregistreur: rows[0] });
    } catch (e) {
      console.error("enregistreur create:", e);
      res.status(500).json({ error: "Erreur lors de la création de l'enregistreur." });
    }
  });

  // ════════════════════════════════════════════════════════════ CAMÉRAS

  router.get("/cameras", authenticateToken, perm("view"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const params = [companyId];
      let where = "c.company_id = $1";

      if (req.query.warehouse_id) {
        params.push(Number(req.query.warehouse_id));
        where += ` AND c.warehouse_id = $${params.length}`;
      }
      if (req.query.status) {
        params.push(txt(req.query.status, 30));
        where += ` AND c.status = $${params.length}`;
      }

      const { rows } = await pool.query(
        `SELECT c.id, c.code, c.name, c.location, c.camera_type, c.brand, c.model,
                c.host, c.channel_number, c.status, c.online_status, c.installed_on,
                c.last_checked_at, c.observations, c.warehouse_id, c.recorder_id,
                w.name AS warehouse_name, r.name AS recorder_name,
                EXISTS (SELECT 1 FROM camera_credentials k
                         WHERE k.camera_id = c.id AND k.company_id = c.company_id
                           AND k.secret_encrypted <> '') AS identifiants_configures
           FROM cameras c
           LEFT JOIN warehouses w      ON w.id = c.warehouse_id AND w.company_id = c.company_id
           LEFT JOIN camera_recorders r ON r.id = c.recorder_id  AND r.company_id = c.company_id
          WHERE ${where}
          ORDER BY w.name NULLS LAST, c.name`,
        params
      );

      const resume = (await pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'actif')::int          AS actives,
                COUNT(*) FILTER (WHERE online_status = 'en_ligne')::int AS en_ligne,
                COUNT(*) FILTER (WHERE online_status = 'hors_ligne')::int AS hors_ligne,
                COUNT(*) FILTER (WHERE online_status = 'inconnu')::int  AS etat_inconnu
           FROM cameras WHERE company_id = $1`, [companyId])).rows[0];

      res.json({ cameras: rows, resume });
    } catch (e) {
      console.error("cameras list:", e);
      res.status(500).json({ error: "Erreur lors de la lecture des caméras." });
    }
  });

  router.post("/cameras", authenticateToken, perm("create"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const nom = txt(req.body?.name, 180);
      if (!nom) return res.status(400).json({ error: "Le nom de la caméra est obligatoire." });

      const site = await idDeLaSociete("warehouses", req.body?.warehouse_id, companyId);
      if (!site.ok) return res.status(400).json({ error: "Site inconnu pour votre entreprise.", code: "WAREHOUSE_NOT_ALLOWED" });

      const enregistreur = await idDeLaSociete("camera_recorders", req.body?.recorder_id, companyId);
      if (!enregistreur.ok) return res.status(400).json({ error: "Enregistreur inconnu pour votre entreprise.", code: "RECORDER_NOT_ALLOWED" });

      const { rows } = await pool.query(
        `INSERT INTO cameras
           (company_id, warehouse_id, recorder_id, code, name, location, camera_type,
            brand, model, host, channel_number, status, online_status, installed_on,
            observations, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'inconnu',$13,$14,$15)
         RETURNING *`,
        [companyId, site.id, enregistreur.id, txt(req.body?.code, 80), nom,
         txt(req.body?.location, 500), txt(req.body?.camera_type, 40),
         txt(req.body?.brand, 120), txt(req.body?.model, 120), txt(req.body?.host),
         Number.isInteger(Number(req.body?.channel_number)) ? Number(req.body.channel_number) : null,
         STATUTS.has(txt(req.body?.status)) ? txt(req.body.status) : "actif",
         req.body?.installed_on || null, txt(req.body?.observations, 1000), req.user.id]
      );
      await journaliser(companyId, req.user.id, rows[0].id, "creation", nom, req);
      res.status(201).json({ camera: rows[0] });
    } catch (e) {
      if (e.code === "23505") {
        return res.status(409).json({ error: "Ce code de caméra existe déjà dans votre entreprise.", code: "CODE_DEJA_PRIS" });
      }
      console.error("camera create:", e);
      res.status(500).json({ error: "Erreur lors de la création de la caméra." });
    }
  });

  router.put("/cameras/:id", authenticateToken, perm("update"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const id = Number(req.params.id);

      const site = await idDeLaSociete("warehouses", req.body?.warehouse_id, companyId);
      if (!site.ok) return res.status(400).json({ error: "Site inconnu pour votre entreprise.", code: "WAREHOUSE_NOT_ALLOWED" });
      const enregistreur = await idDeLaSociete("camera_recorders", req.body?.recorder_id, companyId);
      if (!enregistreur.ok) return res.status(400).json({ error: "Enregistreur inconnu pour votre entreprise.", code: "RECORDER_NOT_ALLOWED" });

      /* COALESCE : un champ absent du corps garde sa valeur. La clause
         company_id fait que la caméra d'une autre société est introuvable,
         donc 404 — jamais une modification silencieuse. */
      const { rows } = await pool.query(
        `UPDATE cameras SET
           warehouse_id   = $3,
           recorder_id    = $4,
           code           = COALESCE($5, code),
           name           = COALESCE($6, name),
           location       = COALESCE($7, location),
           camera_type    = COALESCE($8, camera_type),
           brand          = COALESCE($9, brand),
           model          = COALESCE($10, model),
           host           = COALESCE($11, host),
           channel_number = $12,
           status         = COALESCE($13, status),
           online_status  = COALESCE($14, online_status),
           installed_on   = COALESCE($15, installed_on),
           observations   = COALESCE($16, observations),
           last_checked_at = CASE WHEN $14::text IS NOT NULL THEN CURRENT_TIMESTAMP ELSE last_checked_at END,
           updated_at     = CURRENT_TIMESTAMP
         WHERE id = $1 AND company_id = $2
         RETURNING *`,
        [id, companyId, site.id, enregistreur.id,
         req.body?.code === undefined ? null : txt(req.body.code, 80),
         req.body?.name === undefined ? null : txt(req.body.name, 180),
         req.body?.location === undefined ? null : txt(req.body.location, 500),
         req.body?.camera_type === undefined ? null : txt(req.body.camera_type, 40),
         req.body?.brand === undefined ? null : txt(req.body.brand, 120),
         req.body?.model === undefined ? null : txt(req.body.model, 120),
         req.body?.host === undefined ? null : txt(req.body.host),
         Number.isInteger(Number(req.body?.channel_number)) ? Number(req.body.channel_number) : null,
         STATUTS.has(txt(req.body?.status)) ? txt(req.body.status) : null,
         ETATS_RESEAU.has(txt(req.body?.online_status)) ? txt(req.body.online_status) : null,
         req.body?.installed_on || null,
         req.body?.observations === undefined ? null : txt(req.body.observations, 1000)]
      );
      if (!rows.length) return res.status(404).json({ error: "Caméra introuvable." });
      await journaliser(companyId, req.user.id, id, "modification", rows[0].name, req);
      res.json({ camera: rows[0] });
    } catch (e) {
      console.error("camera update:", e);
      res.status(500).json({ error: "Erreur lors de la mise à jour de la caméra." });
    }
  });

  router.delete("/cameras/:id", authenticateToken, perm("delete"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const { rows } = await pool.query(
        `DELETE FROM cameras WHERE id = $1 AND company_id = $2 RETURNING id, name`,
        [Number(req.params.id), companyId]);
      if (!rows.length) return res.status(404).json({ error: "Caméra introuvable." });
      await journaliser(companyId, req.user.id, null, "suppression", rows[0].name, req);
      res.json({ ok: true });
    } catch (e) {
      console.error("camera delete:", e);
      res.status(500).json({ error: "Erreur lors de la suppression de la caméra." });
    }
  });

  // ══════════════════════════════════════════════════════ IDENTIFIANTS
  /* Permission distincte : gérer l'inventaire n'est pas détenir les accès. */

  router.put("/cameras/:id/identifiants", authenticateToken, perm("manage_credentials"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const camera = await idDeLaSociete("cameras", req.params.id, companyId);
      if (!camera.ok || !camera.id) return res.status(404).json({ error: "Caméra introuvable." });

      const motDePasse = String(req.body?.password ?? "");
      const chemin = String(req.body?.stream_path ?? "");
      const secret = motDePasse ? vault.encrypt(motDePasse) : { format: "plain", value: "" };
      const flux = chemin ? vault.encrypt(chemin) : { format: "plain", value: "" };

      /* Un seul jeu d'identifiants par caméra : on met à jour, et on n'insère
         que si rien n'existait. L'index unique (company_id, camera_id) ferme
         la course entre deux enregistrements simultanés. */
      const valeurs = [companyId, camera.id, txt(req.body?.username, 180),
                       secret.format, secret.value, flux.value, req.user.id];
      const maj = await pool.query(
        `UPDATE camera_credentials
            SET username = $3, secret_format = $4, secret_encrypted = $5,
                stream_path_encrypted = $6, updated_by = $7, updated_at = CURRENT_TIMESTAMP
          WHERE company_id = $1 AND camera_id = $2`, valeurs);
      if (maj.rowCount === 0) {
        await pool.query(
          `INSERT INTO camera_credentials
             (company_id, camera_id, username, secret_format, secret_encrypted, stream_path_encrypted, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (company_id, camera_id) WHERE camera_id IS NOT NULL
           DO UPDATE SET username = EXCLUDED.username, secret_format = EXCLUDED.secret_format,
                         secret_encrypted = EXCLUDED.secret_encrypted,
                         stream_path_encrypted = EXCLUDED.stream_path_encrypted,
                         updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`,
          valeurs);
      }

      await journaliser(companyId, req.user.id, camera.id, "identifiants_modifies", "", req);

      /* On ne renvoie JAMAIS le secret — seulement s'il est posé, et si le
         coffre est réellement actif. « plain » signale une clé manquante. */
      res.json({
        ok: true,
        identifiants_configures: Boolean(motDePasse),
        chiffrement_actif: vault.isEnabled(),
        avertissement: vault.isEnabled() ? "" :
          "WALLET_SECRET_ENC_KEY n'est pas configurée : le secret est stocké en clair. À configurer avant toute mise en production.",
      });
    } catch (e) {
      console.error("camera credentials:", e);
      res.status(500).json({ error: "Erreur lors de l'enregistrement des identifiants." });
    }
  });

  return router;
};
