"use strict";

/**
 * Module Badges MaliLink — gestion professionnelle des badges.
 *
 * Sécurité :
 * - gestion réservée aux rôles autorisés, scopée company_id (anti-IDOR) ;
 * - le QR ne contient JAMAIS de données : uniquement un jeton opaque
 *   vérifié par le backend (/public/badges/verify/:token) ;
 * - la vérification publique n'expose que : identité, photo, rôle,
 *   entreprise, type, statut et validité — jamais téléphone/email ;
 * - toute action (création, impression, statut, remplacement) est auditée.
 */

const crypto = require("crypto");
const express = require("express");
const { createRateLimiter } = require("../middleware/rateLimit");

const BADGE_TYPES = [
  "etudiant", "enseignant", "employe", "magasinier", "responsable",
  "directeur", "administrateur", "livreur", "chauffeur", "laboratoire", "restaurant"
];

const BADGE_STATUSES = ["actif", "expire", "suspendu", "perdu", "remplace", "revoque"];

const TYPE_LABELS = {
  etudiant: "BADGE ÉTUDIANT",
  enseignant: "BADGE ENSEIGNANT",
  employe: "BADGE EMPLOYÉ",
  magasinier: "BADGE MAGASINIER",
  responsable: "BADGE RESPONSABLE",
  directeur: "BADGE DIRECTEUR",
  administrateur: "BADGE ADMINISTRATEUR",
  livreur: "BADGE LIVREUR",
  chauffeur: "BADGE CHAUFFEUR",
  laboratoire: "BADGE LABORATOIRE",
  restaurant: "BADGE RESTAURANT"
};

/* Déduction du type de badge depuis le rôle réel de l'utilisateur. */
function badgeTypeFromRole(role) {
  const map = {
    student: "etudiant",
    teacher: "enseignant",
    magasinier: "magasinier",
    responsable_entrepot: "magasinier",
    chef_entrepot: "responsable",
    direction: "directeur",
    directeur: "directeur",
    director: "directeur",
    admin: "administrateur",
    super_admin: "administrateur",
    livreur: "livreur",
    taxi: "chauffeur",
    chauffeur: "chauffeur",
    laboratoire: "laboratoire",
    employe_laboratoire: "laboratoire"
  };
  return map[String(role || "").toLowerCase()] || "employe";
}

module.exports = function createBadgesRouter({ pool, authenticateToken, getEffectiveCompanyId, isSuperAdminUser }) {
  const router = express.Router();

  /* ---------- Vérification publique par jeton (scan du QR) ---------- */
  const verifyLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 30,
    message: "Trop de vérifications. Patientez un instant."
  });

  router.get("/public/verify/:token", verifyLimiter, async (req, res) => {
    try {
      const token = String(req.params.token || "").replace(/[^a-f0-9]/gi, "").slice(0, 64);
      if (!token) return res.status(400).json({ error: "Jeton invalide." });

      const { rows } = await pool.query(
        `SELECT b.badge_type, b.status, b.valid_until, b.matricule, b.department,
                u.fullname, u.role, u.profile_image_url,
                COALESCE(cs.company_name, c.name, '') AS company_name,
                COALESCE(cs.logo_url, '') AS company_logo
         FROM user_badges b
         JOIN users u ON u.id=b.user_id
         LEFT JOIN companies c ON c.id=b.company_id
         LEFT JOIN company_settings cs ON cs.company_id=b.company_id
         WHERE b.qr_token=$1
         LIMIT 1`,
        [token]
      );
      const badge = rows[0];
      if (!badge) return res.status(404).json({ error: "Badge introuvable." });

      const expired =
        badge.status === "actif" &&
        badge.valid_until &&
        new Date(badge.valid_until) < new Date();
      const effectiveStatus = expired ? "expire" : badge.status;

      // Audit de la vérification (sans identité du vérificateur anonyme)
      pool
        .query(
          `INSERT INTO badge_audit_logs (badge_id, action, details)
           SELECT id, 'verified', $2 FROM user_badges WHERE qr_token=$1`,
          [token, `ip:${String(req.headers["x-forwarded-for"] || req.ip || "").split(",")[0]}`]
        )
        .catch(() => {});

      res.json({
        valid: effectiveStatus === "actif",
        status: effectiveStatus,
        badge_type: badge.badge_type,
        badge_label: TYPE_LABELS[badge.badge_type] || "BADGE",
        fullname: badge.fullname,
        role: badge.role,
        photo_url: badge.profile_image_url || "",
        matricule: badge.matricule,
        department: badge.department || "",
        company_name: badge.company_name,
        company_logo: badge.company_logo,
        valid_until: badge.valid_until
      });
    } catch (error) {
      console.error("ERREUR BADGE VERIFY :", error.message);
      res.status(500).json({ error: "Erreur vérification du badge." });
    }
  });

  /* ---------- Gestion (authentifiée, scopée entreprise) ---------- */
  router.use(authenticateToken);

  function canManageBadges(user) {
    const role = String(user?.role || "").toLowerCase();
    return (
      isSuperAdminUser(user) ||
      ["admin", "direction", "directeur", "rh", "responsable_rh", "school_admin", "director"].includes(role)
    );
  }

  function requireManager(req, res) {
    if (!canManageBadges(req.user)) {
      res.status(403).json({ error: "Accès réservé à l'administration et aux RH." });
      return false;
    }
    return true;
  }

  async function audit(badgeId, action, actorId, details = "") {
    await pool
      .query(
        `INSERT INTO badge_audit_logs (badge_id, action, actor_user_id, details)
         VALUES ($1,$2,$3,$4)`,
        [badgeId, action, actorId, String(details).slice(0, 500)]
      )
      .catch(() => {});
  }

  /* Un utilisateur voit toujours SON badge ; les gestionnaires voient ceux
     de leur entreprise. */
  router.get("/", async (req, res) => {
    try {
      const companyId = getEffectiveCompanyId(req);
      const manager = canManageBadges(req.user);
      const values = [];
      let where;
      if (manager) {
        if (companyId) {
          values.push(companyId);
          where = `b.company_id=$1`;
        } else if (isSuperAdminUser(req.user)) {
          where = `TRUE`;
        } else {
          values.push(req.user.id);
          where = `b.user_id=$1`;
        }
      } else {
        values.push(req.user.id);
        where = `b.user_id=$1`;
      }

      const { rows } = await pool.query(
        `SELECT b.*, u.fullname, u.role, u.profile_image_url, u.email, u.phone,
                COALESCE(cs.company_name, c.name, '') AS company_name,
                COALESCE(cs.logo_url, '') AS company_logo
         FROM user_badges b
         JOIN users u ON u.id=b.user_id
         LEFT JOIN companies c ON c.id=b.company_id
         LEFT JOIN company_settings cs ON cs.company_id=b.company_id
         WHERE ${where}
         ORDER BY b.status='actif' DESC, u.fullname ASC
         LIMIT 500`,
        values
      );
      res.json(rows);
    } catch (error) {
      console.error("ERREUR BADGES LIST :", error.message);
      res.status(500).json({ error: "Erreur chargement des badges." });
    }
  });

  /* Génération pour un utilisateur (ou récupération du badge actif). */
  router.post("/generate", async (req, res) => {
    try {
      if (!requireManager(req, res)) return;
      const targetId = Number(req.body?.user_id);
      if (!targetId) return res.status(400).json({ error: "Utilisateur obligatoire." });

      const companyId = getEffectiveCompanyId(req);
      const userResult = await pool.query(
        `SELECT id, fullname, role, company_id, badge_code, profile_image_url
         FROM users WHERE id=$1 LIMIT 1`,
        [targetId]
      );
      const target = userResult.rows[0];
      if (!target) return res.status(404).json({ error: "Utilisateur introuvable." });
      // Anti-IDOR : un gestionnaire ne badge que SON entreprise.
      if (!isSuperAdminUser(req.user) && Number(target.company_id) !== Number(companyId)) {
        return res.status(403).json({ error: "Cet utilisateur n'appartient pas à votre entreprise." });
      }

      // Profil incomplet : pas de badge définitif sans nom complet et rôle.
      const missing = [];
      if (!String(target.fullname || "").trim()) missing.push("nom complet");
      if (!String(target.role || "").trim()) missing.push("rôle");
      if (missing.length > 0) {
        return res.status(400).json({
          error: `Profil incomplet : ${missing.join(", ")} manquant(s). Complétez la fiche avant de générer le badge.`,
          incomplete: true
        });
      }

      const existing = await pool.query(
        `SELECT * FROM user_badges WHERE user_id=$1 AND status='actif' LIMIT 1`,
        [targetId]
      );
      if (existing.rows[0]) {
        return res.json({ success: true, badge: existing.rows[0], existing: true });
      }

      const requestedType = String(req.body?.badge_type || "");
      const badgeType = BADGE_TYPES.includes(requestedType)
        ? requestedType
        : badgeTypeFromRole(target.role);
      const matricule =
        String(target.badge_code || "").trim() ||
        `ML-${target.company_id || 0}-${String(target.id).padStart(5, "0")}`;
      const qrToken = crypto.randomBytes(24).toString("hex");
      const validUntil = req.body?.valid_until || null;

      const { rows } = await pool.query(
        `INSERT INTO user_badges
           (tenant_id, company_id, user_id, badge_type, matricule, barcode_value,
            qr_token, department, valid_until, created_by)
         VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9)
         RETURNING *`,
        [
          req.tenant_id || "malilink",
          target.company_id || null,
          target.id,
          badgeType,
          matricule,
          qrToken,
          String(req.body?.department || "").slice(0, 80),
          validUntil,
          req.user.id
        ]
      );
      await audit(rows[0].id, "created", req.user.id, `type=${badgeType}`);
      res.status(201).json({ success: true, badge: rows[0] });
    } catch (error) {
      console.error("ERREUR BADGE GENERATE :", error.message);
      res.status(500).json({ error: "Erreur génération du badge." });
    }
  });

  /* Génération en masse pour tous les utilisateurs sans badge actif. */
  router.post("/generate-missing", async (req, res) => {
    try {
      if (!requireManager(req, res)) return;
      const companyId = getEffectiveCompanyId(req);
      if (!companyId) return res.status(400).json({ error: "Entreprise requise." });

      const users = await pool.query(
        `SELECT u.id, u.fullname, u.role, u.company_id, u.badge_code
         FROM users u
         WHERE u.company_id=$1
           AND NOT EXISTS (
             SELECT 1 FROM user_badges b WHERE b.user_id=u.id AND b.status='actif')
         LIMIT 200`,
        [companyId]
      );

      let created = 0;
      const incomplete = [];
      for (const target of users.rows) {
        if (!String(target.fullname || "").trim() || !String(target.role || "").trim()) {
          incomplete.push(target.fullname || `utilisateur #${target.id}`);
          continue;
        }
        const matricule =
          String(target.badge_code || "").trim() ||
          `ML-${companyId}-${String(target.id).padStart(5, "0")}`;
        const inserted = await pool.query(
          `INSERT INTO user_badges
             (tenant_id, company_id, user_id, badge_type, matricule, barcode_value, qr_token, created_by)
           VALUES ($1,$2,$3,$4,$5,$5,$6,$7) RETURNING id`,
          [
            req.tenant_id || "malilink",
            companyId,
            target.id,
            badgeTypeFromRole(target.role),
            matricule,
            crypto.randomBytes(24).toString("hex"),
            req.user.id
          ]
        );
        await audit(inserted.rows[0].id, "created", req.user.id, "generation groupée");
        created += 1;
      }
      res.json({
        success: true,
        created,
        incomplete_profiles: incomplete,
        message: `${created} badge(s) généré(s).${incomplete.length ? ` Profils incomplets ignorés : ${incomplete.join(", ")}.` : ""}`
      });
    } catch (error) {
      console.error("ERREUR BADGES GENERATE MISSING :", error.message);
      res.status(500).json({ error: "Erreur génération groupée." });
    }
  });

  async function loadScopedBadge(req, res) {
    const badgeResult = await pool.query(`SELECT * FROM user_badges WHERE id=$1`, [Number(req.params.id)]);
    const badge = badgeResult.rows[0];
    if (!badge) {
      res.status(404).json({ error: "Badge introuvable." });
      return null;
    }
    const companyId = getEffectiveCompanyId(req);
    if (!isSuperAdminUser(req.user) && Number(badge.company_id) !== Number(companyId)) {
      res.status(403).json({ error: "Badge d'une autre entreprise." });
      return null;
    }
    return badge;
  }

  /* Changement de statut (suspendre, révoquer, perdu, réactiver). */
  router.post("/:id/status", async (req, res) => {
    try {
      if (!requireManager(req, res)) return;
      const badge = await loadScopedBadge(req, res);
      if (!badge) return;
      const status = String(req.body?.status || "");
      if (!BADGE_STATUSES.includes(status) || status === "remplace") {
        return res.status(400).json({ error: "Statut invalide." });
      }
      const { rows } = await pool.query(
        `UPDATE user_badges SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
        [status, badge.id]
      );
      await audit(badge.id, "status_changed", req.user.id, `${badge.status} → ${status}`);
      res.json({ success: true, badge: rows[0] });
    } catch (error) {
      console.error("ERREUR BADGE STATUS :", error.message);
      res.status(500).json({ error: "Erreur changement de statut." });
    }
  });

  /* Remplacement (perte/vol) : l'ancien jeton devient immédiatement invalide. */
  router.post("/:id/replace", async (req, res) => {
    try {
      if (!requireManager(req, res)) return;
      const badge = await loadScopedBadge(req, res);
      if (!badge) return;

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const replacement = await client.query(
          `INSERT INTO user_badges
             (tenant_id, company_id, user_id, badge_type, template, matricule,
              barcode_value, qr_token, department, valid_until, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10)
           RETURNING *`,
          [
            badge.tenant_id,
            badge.company_id,
            badge.user_id,
            badge.badge_type,
            badge.template,
            badge.matricule,
            crypto.randomBytes(24).toString("hex"),
            badge.department,
            badge.valid_until,
            req.user.id
          ]
        );
        await client.query(
          `UPDATE user_badges
           SET status='remplace', replaced_by_id=$1, updated_at=NOW()
           WHERE id=$2`,
          [replacement.rows[0].id, badge.id]
        );
        await client.query("COMMIT");
        await audit(badge.id, "replaced", req.user.id, `nouveau badge #${replacement.rows[0].id}`);
        await audit(replacement.rows[0].id, "created", req.user.id, `remplace #${badge.id}`);
        res.status(201).json({ success: true, badge: replacement.rows[0] });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("ERREUR BADGE REPLACE :", error.message);
      res.status(500).json({ error: "Erreur remplacement du badge." });
    }
  });

  /* Journal d'impression (individuelle ou groupée côté frontend). */
  router.post("/:id/printed", async (req, res) => {
    try {
      if (!requireManager(req, res)) return;
      const badge = await loadScopedBadge(req, res);
      if (!badge) return;
      const { rows } = await pool.query(
        `UPDATE user_badges
         SET printed_at=NOW(), print_count=print_count+1, updated_at=NOW()
         WHERE id=$1 RETURNING *`,
        [badge.id]
      );
      await audit(badge.id, "printed", req.user.id, `impression n°${rows[0].print_count}`);
      res.json({ success: true, badge: rows[0] });
    } catch (error) {
      res.status(500).json({ error: "Erreur journal d'impression." });
    }
  });

  /* Journal d'audit d'un badge. */
  router.get("/:id/audit", async (req, res) => {
    try {
      if (!requireManager(req, res)) return;
      const badge = await loadScopedBadge(req, res);
      if (!badge) return;
      const { rows } = await pool.query(
        `SELECT a.*, u.fullname AS actor_name
         FROM badge_audit_logs a
         LEFT JOIN users u ON u.id=a.actor_user_id
         WHERE a.badge_id=$1
         ORDER BY a.created_at DESC LIMIT 100`,
        [badge.id]
      );
      res.json(rows);
    } catch (error) {
      res.status(500).json({ error: "Erreur journal du badge." });
    }
  });

  return router;
};
