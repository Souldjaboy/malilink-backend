"use strict";

/**
 * ADAPTATEUR MALILINK du noyau biométrique.
 *
 * Ce que MaliLink décide pour le noyau :
 *   • les droits : traduits dans son moteur d'accès effectif (module
 *     « biometrie » et ses sous-modules, sensible : direction/admin par
 *     défaut) ;
 *   • le personnel : un compte `users` de LA société, actif, qui n'est pas un
 *     client ;
 *   • le pointage : services/pointage-engine (même moteur que le QR) ;
 *   • la connexion par passkey : les mêmes contrôles que le mot de passe.
 */

const { BiometrieError } = require("./core/erreurs");

const CARTE_DROITS = {
  "biometrie.voir": ["biometrie", "view"],
  "biometrie.enroler": ["biometrie.enrolement", "create"],
  "biometrie.verifier": ["biometrie.verification", "create"],
  "biometrie.revoquer": ["biometrie.revocation", "delete"],
  "biometrie.audit": ["biometrie.audit", "view"],
  "biometrie.appareils": ["biometrie.appareils", "update"],
  "biometrie.parametres": ["biometrie.parametres", "update"],
  "pointage.biometrie": ["biometrie.pointage", "create"],
};

const ROLES_NON_PERSONNEL = new Set(["customer", "client", "patient"]);

function jetonBadge(valeur) {
  const texte = String(valeur || "").trim();
  const url = texte.match(/\/badge\/([A-Za-z0-9_-]{16,128})/);
  return url ? url[1] : texte.slice(0, 160);
}

module.exports = function creerHoteMaliLink(d) {
  const { pool, authenticateToken, getEffectiveCompanyId, isSuperAdminUser, access, accessContextFor,
    pointageEngine, finaliserConnexionParId, logAudit } = d;

  async function verifierPersonnel(db, companyId, sujet) {
    if (!sujet || sujet.type !== "user") {
      throw new BiometrieError("MaliLink : la biométrie vise un compte du personnel.", "SUJET_INVALIDE", 400);
    }
    const { rows } = await (db || pool).query(
      `SELECT id, fullname, role, company_id, COALESCE(is_active, TRUE) AS actif
         FROM users WHERE id = $1 AND company_id = $2`,
      [Number(sujet.userId), Number(companyId)]);
    const u = rows[0];
    // Même réponse pour une personne d'une autre société que pour une personne inexistante.
    if (!u) throw new BiometrieError("Personne introuvable dans cette entreprise.", "PERSONNE_INTROUVABLE", 404);
    if (ROLES_NON_PERSONNEL.has(String(u.role || "").toLowerCase())) {
      throw new BiometrieError("Un compte client ne peut pas recevoir de donnée biométrique.", "PAS_PERSONNEL", 403);
    }
    if (!u.actif) throw new BiometrieError("Compte désactivé.", "PERSONNE_INACTIVE", 403);
    return { type: "user", userId: u.id, employeeId: null, nom: u.fullname };
  }

  return {
    pool,
    authenticateToken,
    societe: (req) => getEffectiveCompanyId(req) || req.user?.company_id || null,
    tenant: (req) => req.tenant_id || null,
    estSuperAdmin: (req) => isSuperAdminUser(req.user),

    async autoriser(req, permission) {
      if (isSuperAdminUser(req.user)) return true;
      const cible = CARTE_DROITS[permission];
      if (!cible) return false;
      const ctx = await accessContextFor(req, req.user);
      return access.effectiveAccess(ctx, cible[0], cible[1]).allowed;
    },

    async sujetDeLaRequete(req, source) {
      const type = String(source.subject_type || source.type || "user");
      if (type !== "user") {
        throw new BiometrieError("MaliLink : la biométrie vise un compte du personnel.", "SUJET_INVALIDE", 400);
      }
      const id = Number(source.user_id || source.userId || req.user.id);
      if (!Number.isInteger(id) || id <= 0) throw new BiometrieError("Personne invalide.", "SUJET_INVALIDE", 400);
      return { type: "user", userId: id };
    },

    /** Badge du module Badges (jeton opaque) → personne de LA société. */
    async sujetDepuisBadge(companyId, badge) {
      const { rows } = await pool.query(
        `SELECT b.user_id FROM user_badges b JOIN users u ON u.id = b.user_id AND u.company_id = b.company_id
          WHERE b.qr_token = $1 AND b.company_id = $2 AND b.status = 'actif'
            AND (b.valid_until IS NULL OR b.valid_until >= CURRENT_DATE)
          LIMIT 1`,
        [jetonBadge(badge), companyId]);
      return rows[0] ? { type: "user", userId: rows[0].user_id } : null;
    },

    verifierPersonnel,

    async listerPersonnel(companyId) {
      const { rows } = await pool.query(
        `SELECT id, fullname, role FROM users
          WHERE company_id = $1 AND COALESCE(is_active, TRUE) = TRUE
            AND lower(COALESCE(role, '')) NOT IN ('customer', 'client', 'patient')
          ORDER BY fullname LIMIT 1000`, [companyId]);
      return rows.map((u) => ({ type: "user", userId: u.id, employeeId: null, nom: u.fullname, role: u.role }));
    },

    async nomsSujets(companyId, sujets) {
      const ids = [...new Set(sujets.filter((s) => s.type === "user" && s.userId).map((s) => Number(s.userId)))];
      if (!ids.length) return new Map();
      const { rows } = await pool.query(`SELECT id, fullname FROM users WHERE company_id = $1 AND id = ANY($2)`, [companyId, ids]);
      return new Map(rows.map((u) => [`user:${u.id}`, u.fullname]));
    },

    async enregistrerPointage(o) {
      try {
        return await pointageEngine.enregistrerPointage(pool, {
          companyId: o.companyId, userId: o.sujet.userId, action: o.action, methode: o.methode,
          tenantId: o.tenantId, deviceId: o.deviceId, site: o.siteId ? { id: o.siteId, name: "" } : null,
          confidence: o.confidence, createdBy: o.createdBy, metadata: o.metadata,
        });
      } catch (e) {
        if (e instanceof pointageEngine.PointageError) throw new BiometrieError(e.message, e.code, e.httpStatus);
        throw e;
      }
    },

    async utilisateurCourant(req) {
      const { rows } = await pool.query(`SELECT id, email, fullname, company_id FROM users WHERE id = $1`, [req.user.id]);
      if (!rows[0]) throw new BiometrieError("Compte introuvable.", "COMPTE_INTROUVABLE", 404);
      return rows[0];
    },

    finaliserConnexion: (req, res, userId, methode) => finaliserConnexionParId(req, res, userId, methode),

    async journalAudit(req, action, details) {
      try {
        await logAudit(req, action, "biometrie", req.user?.id || null, details || {});
      } catch (e) {
        console.error("audit biométrie :", e.message);
      }
    },
  };
};

module.exports.CARTE_DROITS = CARTE_DROITS;
