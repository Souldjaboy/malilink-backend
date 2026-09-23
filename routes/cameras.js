"use strict";

/**
 * Module générique « Caméras & Sécurité ».
 *
 * Inventaire, sites, enregistreurs NVR/DVR, connecteurs (ONVIF, RTSP,
 * Hikvision, Dahua, autre), test de joignabilité réel, identifiants chiffrés.
 *
 * Trois règles tiennent tout le module :
 *  1. company_id vient TOUJOURS du jeton. Tout warehouse_id ou recorder_id
 *     fourni par l'appelant est vérifié comme appartenant à SA société.
 *  2. Un identifiant (mot de passe, chemin RTSP) n'est enregistré que
 *     CHIFFRÉ (services/secret-vault.js, AES-256-GCM). Sans clé de
 *     chiffrement configurée, l'enregistrement est REFUSÉ — jamais stocké en
 *     clair avec un simple avertissement. Il ne ressort jamais par l'API.
 *  3. Rien n'est simulé : l'état « en ligne » vient d'un vrai test de
 *     connexion, sinon il reste « inconnu » ; pas de lecteur vidéo tant
 *     qu'aucune passerelle vidéo n'est installée.
 *
 * Droits (registre RBAC) :
 *   cameras                 voir / créer / modifier / supprimer l'inventaire
 *   cameras.sites           sites de sécurité (bureau, siège…)
 *   cameras.enregistreurs   NVR / DVR
 *   cameras.identifiants    poser ou effacer des identifiants (« Modifier »)
 */

const express = require("express");
const vault = require("../services/secret-vault");
const sonde = require("../services/camera-probe");

module.exports = function createCamerasRouter(deps) {
  const { pool, authenticateToken, getEffectiveCompanyId, requirePermission } = deps;
  const router = express.Router();

  const perm = (cle, action) =>
    requirePermission ? requirePermission(cle, action) : (req, res, next) => next();
  const companyOf = (req) => getEffectiveCompanyId(req) || req.user.company_id;
  const txt = (v, max = 255) => String(v ?? "").trim().slice(0, max);

  const STATUTS = new Set(["actif", "inactif", "maintenance", "retire"]);
  const TYPES_SITE = new Set(["entrepot", "magasin", "depot", "point_de_vente", "bureau", "siege"]);

  function connecteur(v) {
    const c = txt(v, 20).toLowerCase();
    return Object.prototype.hasOwnProperty.call(sonde.CONNECTEURS, c) ? c : "onvif";
  }
  function port(v, connecteurChoisi) {
    if (v === undefined || v === null || v === "") return sonde.CONNECTEURS[connecteurChoisi]?.port ?? null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : undefined;
  }

  /* Un identifiant d'une AUTRE société ne doit jamais pouvoir être rattaché. */
  async function idDeLaSociete(table, id, companyId) {
    if (id === null || id === undefined || id === "") return { ok: true, id: null };
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) return { ok: false, id: null };
    const { rows } = await pool.query(`SELECT id FROM ${table} WHERE id = $1 AND company_id = $2`, [n, companyId]);
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

  const refusSecret = (res) => res.status(503).json({
    error: "Chiffrement des secrets non configuré sur le serveur : l'enregistrement d'identifiants est refusé. "
      + "L'administrateur de la plateforme doit définir WALLET_SECRET_ENC_KEY.",
    code: "SECRET_VAULT_DISABLED",
  });

  // ══════════════════════════════════════════════════ TABLEAU DE BORD

  router.get("/cameras/tableau-de-bord", authenticateToken, perm("cameras", "view"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const resume = (await pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE online_status = 'en_ligne')::int   AS en_ligne,
                COUNT(*) FILTER (WHERE online_status = 'hors_ligne')::int AS hors_ligne,
                COUNT(*) FILTER (WHERE online_status = 'inconnu')::int    AS inconnu,
                COUNT(*) FILTER (WHERE status = 'maintenance')::int       AS maintenance,
                COUNT(DISTINCT warehouse_id)::int                         AS sites
           FROM cameras WHERE company_id = $1 AND status <> 'retire'`, [companyId])).rows[0];

      /* Alertes : uniquement des faits établis, jamais une supposition. */
      const lignes = (await pool.query(
        `SELECT c.id, c.name, c.status, c.online_status, c.last_checked_at, c.last_seen_at,
                w.name AS site,
                EXISTS (SELECT 1 FROM camera_credentials k WHERE k.camera_id = c.id
                          AND k.company_id = c.company_id AND k.secret_encrypted <> '') AS identifiants
           FROM cameras c
           LEFT JOIN warehouses w ON w.id = c.warehouse_id AND w.company_id = c.company_id
          WHERE c.company_id = $1 AND c.status <> 'retire'
          ORDER BY c.name`, [companyId])).rows;
      const alertes = [];
      for (const c of lignes) {
        const ou = c.site ? ` (${c.site})` : "";
        if (c.online_status === "hors_ligne") alertes.push({ niveau: "critique", camera_id: c.id, message: `${c.name}${ou} ne répondait pas au dernier test.` });
        if (c.status === "maintenance") alertes.push({ niveau: "info", camera_id: c.id, message: `${c.name}${ou} est en maintenance.` });
        if (!c.last_checked_at) alertes.push({ niveau: "info", camera_id: c.id, message: `${c.name}${ou} n'a jamais été testée.` });
      }
      if (!vault.isEnabled()) {
        alertes.unshift({ niveau: "attention", message: "Chiffrement des secrets non configuré : aucun identifiant de caméra ne peut être enregistré." });
      }

      res.json({
        resume,
        alertes: alertes.slice(0, 50),
        chiffrement_actif: vault.isEnabled(),
        visualisation_disponible: false,
        message_visualisation:
          "La visualisation en direct nécessite une passerelle vidéo (conversion du flux RTSP pour le navigateur), qui n'est pas installée. "
          + "Les identifiants et chemins de flux sont déjà conservés chiffrés pour l'activer plus tard.",
        connecteurs: Object.entries(sonde.CONNECTEURS).map(([cle, c]) => ({ cle, ...c })),
      });
    } catch (e) {
      console.error("cameras tableau de bord:", e);
      res.status(500).json({ error: "Erreur lors du calcul du tableau de bord." });
    }
  });

  // ════════════════════════════════════════════════════════════ SITES

  /* Les sites sont les entrepôts de la société (quel que soit leur type),
     plus les bureaux et sièges créés ici, hors stock. */
  router.get("/cameras/sites", authenticateToken, perm("cameras.sites", "view"), async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT w.id, w.code, w.name, w.type, w.address, w.status,
                COALESCE(w.is_stock_visible, TRUE) AS lieu_de_stock,
                COUNT(c.id)::int AS cameras,
                COUNT(c.id) FILTER (WHERE c.online_status = 'hors_ligne')::int AS hors_ligne
           FROM warehouses w
           LEFT JOIN cameras c ON c.warehouse_id = w.id AND c.company_id = w.company_id AND c.status <> 'retire'
          WHERE w.company_id = $1
          GROUP BY w.id
          ORDER BY w.name`, [companyOf(req)]);
      res.json({ sites: rows });
    } catch (e) {
      console.error("cameras sites:", e);
      res.status(500).json({ error: "Erreur lors de la lecture des sites." });
    }
  });

  router.post("/cameras/sites", authenticateToken, perm("cameras.sites", "create"), async (req, res) => {
    try {
      const nom = txt(req.body?.name, 255);
      if (!nom) return res.status(400).json({ error: "Le nom du site est obligatoire." });
      const type = txt(req.body?.type, 30);
      if (!TYPES_SITE.has(type)) return res.status(400).json({ error: "Type de site inconnu.", code: "TYPE_SITE_INCONNU" });
      // Un bureau ou un siège n'est pas un lieu de stock.
      const lieuDeStock = !["bureau", "siege"].includes(type);
      const { rows } = await pool.query(
        `INSERT INTO warehouses (company_id, code, name, type, address, status, is_stock_visible, is_pos_visible)
         VALUES ($1,$2,$3,$4,$5,'Actif',$6,$6) RETURNING id, code, name, type, address`,
        [companyOf(req), txt(req.body?.code, 100) || null, nom, type, txt(req.body?.address, 500), lieuDeStock]);
      res.status(201).json({ site: rows[0] });
    } catch (e) {
      if (e.code === "23505") return res.status(409).json({ error: "Ce code de site existe déjà.", code: "CODE_DEJA_PRIS" });
      console.error("cameras site create:", e);
      res.status(500).json({ error: "Erreur lors de la création du site." });
    }
  });

  // ══════════════════════════════════════════════════ ENREGISTREURS

  router.get("/cameras/enregistreurs", authenticateToken, perm("cameras.enregistreurs", "view"), async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT r.id, r.name, r.kind, r.connector_type, r.brand, r.model, r.channels, r.host, r.port,
                r.status, r.online_status, r.last_checked_at, r.last_seen_at, r.notes,
                r.warehouse_id, w.name AS warehouse_name,
                EXISTS (SELECT 1 FROM camera_credentials c
                         WHERE c.recorder_id = r.id AND c.company_id = r.company_id
                           AND c.secret_encrypted <> '') AS identifiants_configures
           FROM camera_recorders r
           LEFT JOIN warehouses w ON w.id = r.warehouse_id AND w.company_id = r.company_id
          WHERE r.company_id = $1
          ORDER BY r.name`, [companyOf(req)]);
      res.json({ enregistreurs: rows });
    } catch (e) {
      console.error("enregistreurs list:", e);
      res.status(500).json({ error: "Erreur lors de la lecture des enregistreurs." });
    }
  });

  router.post("/cameras/enregistreurs", authenticateToken, perm("cameras.enregistreurs", "create"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const nom = txt(req.body?.name, 180);
      if (!nom) return res.status(400).json({ error: "Le nom est obligatoire." });
      const site = await idDeLaSociete("warehouses", req.body?.warehouse_id, companyId);
      if (!site.ok) return res.status(400).json({ error: "Site inconnu pour votre entreprise.", code: "WAREHOUSE_NOT_ALLOWED" });
      const c = connecteur(req.body?.connector_type);
      const p = port(req.body?.port, c);
      if (p === undefined) return res.status(400).json({ error: "Port invalide (1 à 65535).", code: "PORT_INVALIDE" });
      const hote = txt(req.body?.host);
      if (hote && !sonde.hoteValide(hote)) return res.status(400).json({ error: "Adresse invalide.", code: "ADRESSE_INVALIDE" });

      const { rows } = await pool.query(
        `INSERT INTO camera_recorders
           (company_id, warehouse_id, name, kind, connector_type, brand, model, channels, host, port, notes, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [companyId, site.id, nom, ["nvr", "dvr"].includes(txt(req.body?.kind)) ? txt(req.body.kind) : "nvr",
         c, txt(req.body?.brand, 120), txt(req.body?.model, 120),
         Number.isInteger(Number(req.body?.channels)) ? Number(req.body.channels) : 0,
         hote, p, txt(req.body?.notes, 1000),
         STATUTS.has(txt(req.body?.status)) ? txt(req.body.status) : "actif", req.user.id]);
      res.status(201).json({ enregistreur: rows[0] });
    } catch (e) {
      console.error("enregistreur create:", e);
      res.status(500).json({ error: "Erreur lors de la création de l'enregistreur." });
    }
  });

  router.delete("/cameras/enregistreurs/:id", authenticateToken, perm("cameras.enregistreurs", "delete"), async (req, res) => {
    try {
      const { rows } = await pool.query(
        `DELETE FROM camera_recorders WHERE id = $1 AND company_id = $2 RETURNING id`,
        [Number(req.params.id), companyOf(req)]);
      if (!rows.length) return res.status(404).json({ error: "Enregistreur introuvable." });
      res.json({ ok: true });
    } catch (e) {
      console.error("enregistreur delete:", e);
      res.status(500).json({ error: "Erreur lors de la suppression." });
    }
  });

  // ══════════════════════════════════════════════════════ JOURNAL

  router.get("/cameras/journal", authenticateToken, perm("cameras.identifiants", "view"), async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT l.id, l.action, l.detail, l.created_at, l.camera_id, c.name AS camera, u.fullname AS utilisateur
           FROM camera_access_logs l
           LEFT JOIN cameras c ON c.id = l.camera_id AND c.company_id = l.company_id
           LEFT JOIN users u ON u.id = l.user_id
          WHERE l.company_id = $1
          ORDER BY l.created_at DESC LIMIT 100`, [companyOf(req)]);
      res.json({ journal: rows });
    } catch (e) {
      console.error("cameras journal:", e);
      res.status(500).json({ error: "Erreur lors de la lecture du journal." });
    }
  });

  // ════════════════════════════════════════════════════════════ CAMÉRAS

  router.get("/cameras", authenticateToken, perm("cameras", "view"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const params = [companyId];
      let where = "c.company_id = $1";
      if (req.query.warehouse_id) { params.push(Number(req.query.warehouse_id)); where += ` AND c.warehouse_id = $${params.length}`; }
      if (req.query.status) { params.push(txt(req.query.status, 30)); where += ` AND c.status = $${params.length}`; }

      const { rows } = await pool.query(
        `SELECT c.id, c.code, c.name, c.location, c.camera_type, c.connector_type, c.brand, c.model,
                c.host, c.port, c.channel_number, c.status, c.online_status, c.installed_on,
                c.last_checked_at, c.last_seen_at, c.last_check_error, c.observations,
                c.warehouse_id, c.recorder_id, w.name AS warehouse_name, w.type AS warehouse_type,
                r.name AS recorder_name,
                EXISTS (SELECT 1 FROM camera_credentials k
                         WHERE k.camera_id = c.id AND k.company_id = c.company_id
                           AND k.secret_encrypted <> '') AS identifiants_configures
           FROM cameras c
           LEFT JOIN warehouses w       ON w.id = c.warehouse_id AND w.company_id = c.company_id
           LEFT JOIN camera_recorders r ON r.id = c.recorder_id  AND r.company_id = c.company_id
          WHERE ${where}
          ORDER BY w.name NULLS LAST, c.name`, params);

      const resume = (await pool.query(
        `SELECT COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'actif')::int            AS actives,
                COUNT(*) FILTER (WHERE online_status = 'en_ligne')::int   AS en_ligne,
                COUNT(*) FILTER (WHERE online_status = 'hors_ligne')::int AS hors_ligne,
                COUNT(*) FILTER (WHERE online_status = 'inconnu')::int    AS etat_inconnu
           FROM cameras WHERE company_id = $1`, [companyId])).rows[0];

      res.json({ cameras: rows, resume });
    } catch (e) {
      console.error("cameras list:", e);
      res.status(500).json({ error: "Erreur lors de la lecture des caméras." });
    }
  });

  async function validerCorps(req, companyId, partiel) {
    const site = await idDeLaSociete("warehouses", req.body?.warehouse_id, companyId);
    if (!site.ok) return { erreur: { status: 400, error: "Site inconnu pour votre entreprise.", code: "WAREHOUSE_NOT_ALLOWED" } };
    const enregistreur = await idDeLaSociete("camera_recorders", req.body?.recorder_id, companyId);
    if (!enregistreur.ok) return { erreur: { status: 400, error: "Enregistreur inconnu pour votre entreprise.", code: "RECORDER_NOT_ALLOWED" } };
    const c = partiel && req.body?.connector_type === undefined ? null : connecteur(req.body?.connector_type);
    const p = partiel && req.body?.port === undefined ? null : port(req.body?.port, c || "other");
    if (p === undefined) return { erreur: { status: 400, error: "Port invalide (1 à 65535).", code: "PORT_INVALIDE" } };
    const hote = req.body?.host === undefined ? null : txt(req.body.host);
    if (hote && !sonde.hoteValide(hote)) return { erreur: { status: 400, error: "Adresse invalide.", code: "ADRESSE_INVALIDE" } };
    return { site, enregistreur, c, p, hote };
  }

  router.post("/cameras", authenticateToken, perm("cameras", "create"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const nom = txt(req.body?.name, 180);
      if (!nom) return res.status(400).json({ error: "Le nom de la caméra est obligatoire." });
      const v = await validerCorps(req, companyId, false);
      if (v.erreur) return res.status(v.erreur.status).json(v.erreur);

      const { rows } = await pool.query(
        `INSERT INTO cameras
           (company_id, warehouse_id, recorder_id, code, name, location, camera_type, connector_type,
            brand, model, host, port, channel_number, status, online_status, installed_on, observations, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'inconnu',$15,$16,$17)
         RETURNING *`,
        [companyId, v.site.id, v.enregistreur.id, txt(req.body?.code, 80), nom,
         txt(req.body?.location, 500), txt(req.body?.camera_type, 40), v.c,
         txt(req.body?.brand, 120), txt(req.body?.model, 120), v.hote || "", v.p,
         Number.isInteger(Number(req.body?.channel_number)) ? Number(req.body.channel_number) : null,
         STATUTS.has(txt(req.body?.status)) ? txt(req.body.status) : "actif",
         req.body?.installed_on || null, txt(req.body?.observations, 1000), req.user.id]);
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

  router.put("/cameras/:id", authenticateToken, perm("cameras", "update"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const id = Number(req.params.id);
      const v = await validerCorps(req, companyId, true);
      if (v.erreur) return res.status(v.erreur.status).json(v.erreur);

      /* COALESCE : un champ absent garde sa valeur. La clause company_id rend
         la caméra d'une autre société introuvable (404), jamais modifiée.
         L'état réseau ne se pose pas à la main : il vient du test. */
      const { rows } = await pool.query(
        `UPDATE cameras SET
           warehouse_id   = CASE WHEN $3::boolean THEN $4 ELSE warehouse_id END,
           recorder_id    = CASE WHEN $5::boolean THEN $6 ELSE recorder_id END,
           code           = COALESCE($7, code),
           name           = COALESCE($8, name),
           location       = COALESCE($9, location),
           camera_type    = COALESCE($10, camera_type),
           connector_type = COALESCE($11, connector_type),
           brand          = COALESCE($12, brand),
           model          = COALESCE($13, model),
           host           = COALESCE($14, host),
           port           = COALESCE($15, port),
           status         = COALESCE($16, status),
           installed_on   = COALESCE($17, installed_on),
           observations   = COALESCE($18, observations),
           updated_at     = CURRENT_TIMESTAMP
         WHERE id = $1 AND company_id = $2
         RETURNING *`,
        [id, companyId,
         req.body?.warehouse_id !== undefined, v.site.id,
         req.body?.recorder_id !== undefined, v.enregistreur.id,
         req.body?.code === undefined ? null : txt(req.body.code, 80),
         req.body?.name === undefined ? null : txt(req.body.name, 180),
         req.body?.location === undefined ? null : txt(req.body.location, 500),
         req.body?.camera_type === undefined ? null : txt(req.body.camera_type, 40),
         v.c, req.body?.brand === undefined ? null : txt(req.body.brand, 120),
         req.body?.model === undefined ? null : txt(req.body.model, 120),
         v.hote, v.p,
         STATUTS.has(txt(req.body?.status)) ? txt(req.body.status) : null,
         req.body?.installed_on || null,
         req.body?.observations === undefined ? null : txt(req.body.observations, 1000)]);
      if (!rows.length) return res.status(404).json({ error: "Caméra introuvable." });
      await journaliser(companyId, req.user.id, id, "modification", rows[0].name, req);
      res.json({ camera: rows[0] });
    } catch (e) {
      if (e.code === "23505") return res.status(409).json({ error: "Ce code de caméra existe déjà.", code: "CODE_DEJA_PRIS" });
      console.error("camera update:", e);
      res.status(500).json({ error: "Erreur lors de la mise à jour de la caméra." });
    }
  });

  router.delete("/cameras/:id", authenticateToken, perm("cameras", "delete"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const { rows } = await pool.query(
        `DELETE FROM cameras WHERE id = $1 AND company_id = $2 RETURNING id, name`, [Number(req.params.id), companyId]);
      if (!rows.length) return res.status(404).json({ error: "Caméra introuvable." });
      await journaliser(companyId, req.user.id, null, "suppression", rows[0].name, req);
      res.json({ ok: true });
    } catch (e) {
      console.error("camera delete:", e);
      res.status(500).json({ error: "Erreur lors de la suppression de la caméra." });
    }
  });

  // ═══════════════════════════════════════════ TEST DE JOIGNABILITÉ

  router.post("/cameras/:id/verifier", authenticateToken, perm("cameras", "update"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const camera = (await pool.query(
        `SELECT id, name, host, port, connector_type FROM cameras WHERE id = $1 AND company_id = $2`,
        [Number(req.params.id), companyId])).rows[0];
      if (!camera) return res.status(404).json({ error: "Caméra introuvable." });
      if (!camera.host) return res.status(400).json({ error: "Aucune adresse renseignée pour cette caméra.", code: "ADRESSE_ABSENTE" });
      if (!sonde.debitAutorise(companyId)) {
        return res.status(429).json({ error: "Trop de tests en peu de temps. Réessayez dans quelques minutes.", code: "TROP_DE_TESTS" });
      }
      const cible = await sonde.verifierCible(camera.host, camera.port || sonde.CONNECTEURS[camera.connector_type]?.port);
      if (!cible.ok) {
        // Pas d'état inventé : on n'écrit pas « hors ligne » pour une adresse qu'on a refusé de sonder.
        await pool.query(`UPDATE cameras SET last_check_error = $3 WHERE id = $1 AND company_id = $2`,
          [camera.id, companyId, cible.message]);
        return res.status(422).json({ error: cible.message, code: cible.code });
      }
      const r = await sonde.connexionTcp(cible.adresse, cible.port);
      const { rows } = await pool.query(
        `UPDATE cameras SET online_status = $3, last_checked_at = CURRENT_TIMESTAMP,
                last_seen_at = CASE WHEN $3 = 'en_ligne' THEN CURRENT_TIMESTAMP ELSE last_seen_at END,
                last_check_error = $4
          WHERE id = $1 AND company_id = $2
          RETURNING online_status, last_checked_at, last_seen_at`,
        [camera.id, companyId, r.joignable ? "en_ligne" : "hors_ligne", r.joignable ? "" : r.erreur]);
      await journaliser(companyId, req.user.id, camera.id, "test_joignabilite", r.joignable ? "joignable" : `injoignable : ${r.erreur}`, req);
      res.json({
        ...rows[0], joignable: r.joignable, duree_ms: r.duree_ms,
        precision: "Test de connexion au port déclaré, sans authentification : il ne garantit pas que le flux vidéo fonctionne.",
      });
    } catch (e) {
      console.error("camera verifier:", e);
      res.status(500).json({ error: "Erreur lors du test." });
    }
  });

  // ══════════════════════════════════════════════════════ IDENTIFIANTS

  router.put("/cameras/:id/identifiants", authenticateToken, perm("cameras.identifiants", "update"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const camera = await idDeLaSociete("cameras", req.params.id, companyId);
      if (!camera.ok || !camera.id) return res.status(404).json({ error: "Caméra introuvable." });

      const motDePasse = String(req.body?.password ?? "");
      const chemin = String(req.body?.stream_path ?? "");
      /* Refus net sans clé : un secret n'est JAMAIS stocké en clair. */
      if ((motDePasse || chemin) && !vault.isEnabled()) return refusSecret(res);

      const secret = motDePasse ? vault.encrypt(motDePasse) : { format: "plain", value: "" };
      const flux = chemin ? vault.encrypt(chemin) : { format: "plain", value: "" };
      if ((motDePasse && secret.format === "plain") || (chemin && flux.format === "plain")) return refusSecret(res);

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
                         updated_by = EXCLUDED.updated_by, updated_at = CURRENT_TIMESTAMP`, valeurs);
      }
      await journaliser(companyId, req.user.id, camera.id, "identifiants_modifies", "", req);
      // Le secret ne ressort jamais — seulement le fait qu'il est posé.
      res.json({ ok: true, identifiants_configures: Boolean(motDePasse), chiffrement: secret.format || flux.format });
    } catch (e) {
      console.error("camera credentials:", e);
      res.status(500).json({ error: "Erreur lors de l'enregistrement des identifiants." });
    }
  });

  router.delete("/cameras/:id/identifiants", authenticateToken, perm("cameras.identifiants", "delete"), async (req, res) => {
    try {
      const companyId = companyOf(req);
      const camera = await idDeLaSociete("cameras", req.params.id, companyId);
      if (!camera.ok || !camera.id) return res.status(404).json({ error: "Caméra introuvable." });
      await pool.query(`DELETE FROM camera_credentials WHERE company_id = $1 AND camera_id = $2`, [companyId, camera.id]);
      await journaliser(companyId, req.user.id, camera.id, "identifiants_effaces", "", req);
      res.json({ ok: true });
    } catch (e) {
      console.error("camera credentials delete:", e);
      res.status(500).json({ error: "Erreur lors de l'effacement des identifiants." });
    }
  });

  return router;
};
