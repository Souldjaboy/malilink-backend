"use strict";

/**
 * Super Admin › Entreprises › Modifier.
 *
 *   GET  /super-admin/entreprises/:id                         fiche (entreprise + administrateurs)
 *   PUT  /super-admin/entreprises/:id                         coordonnées et paramètres de l'entreprise
 *   POST /super-admin/entreprises/:id/email                   changement de l'email de l'entreprise (vérifié)
 *   PUT  /super-admin/entreprises/:id/administrateurs/:uid    nom et téléphone d'un administrateur
 *   POST /super-admin/entreprises/:id/administrateurs/:uid/email          changement d'email (vérifié)
 *   POST /super-admin/entreprises/:id/administrateurs/:uid/mot-de-passe   mot de passe temporaire
 *   POST /super-admin/entreprises/:id/administrateurs/:uid/validation     validation administrative
 *   GET  /super-admin/entreprises/:id/journal                 dernières actions sensibles
 *
 *   POST /comptes/changement-email/confirmer                  (public) confirmation par la nouvelle adresse
 *
 * Le rôle Super Admin est RELU EN BASE (compte actif, is_super_admin) : un
 * jeton ou un en-tête falsifié ne suffit pas. Chaque identifiant secondaire
 * (administrateur) est contrôlé contre l'entreprise de l'URL.
 */

const express = require("express");
const comptes = require("../services/comptes");
const courriel = require("../services/courriel");

const texte = (v, max) => String(v ?? "").trim().slice(0, max);
const CHAMPS_ENTREPRISE = { name: 160, responsible_name: 160, phone: 40, address: 300 };
const CHAMPS_REGLAGES = { city: 120, country: 80, website: 200, whatsapp_number: 40, slogan: 200, description: 1000, currency: 10, language: 10 };

module.exports = function creerRoutesSuperAdminEntreprises({ pool, authenticateToken, logAudit, reinitialiserMotDePasseTemporaire, getTenantFromRequest, revoquerSessions = () => {} }) {
  const router = express.Router();
  const publique = express.Router();

  router.use(authenticateToken);
  router.use(async (req, res, next) => {
    try {
      const { rows } = await pool.query(`SELECT id, is_super_admin, role, is_active FROM users WHERE id=$1`, [Number(req.user?.id) || 0]);
      const u = rows[0];
      if (!u || u.is_active === false || !(u.is_super_admin === true || String(u.role).toLowerCase() === "super_admin")) {
        return res.status(403).json({ error: "Réservé au Super Admin." });
      }
      next();
    } catch (e) { console.error("SUPER ADMIN ENTREPRISES :", e.message); res.status(500).json({ error: "Erreur de contrôle d'accès." }); }
  });

  // Le Super Admin n'a pas d'entreprise : l'audit est rattaché à l'entreprise CIBLÉE.
  const auditer = (req, action, type, id, companyId, details) =>
    logAudit({ ...req, headers: req.headers, user: { ...req.user, company_id: Number(companyId) } }, action, type, id, details);

  const idValide = (v) => Number.isInteger(Number(v)) && Number(v) > 0;
  router.param("id", (req, res, next, v) => (idValide(v) ? next() : res.status(400).json({ error: "Identifiant d'entreprise invalide." })));
  router.param("uid", (req, res, next, v) => (idValide(v) ? next() : res.status(400).json({ error: "Identifiant d'utilisateur invalide." })));

  async function administrateurDe(companyId, userId) {
    const { rows } = await pool.query(
      `SELECT id, fullname, email, phone, role, is_active, company_id FROM users
        WHERE id=$1 AND company_id=$2 AND LOWER(role) = ANY($3::text[])`, [Number(userId), Number(companyId), comptes.ROLES_ADMIN]);
    return rows[0] || null;
  }

  router.get("/:id", async (req, res) => {
    try {
      const c = (await pool.query(`SELECT * FROM companies WHERE id=$1`, [req.params.id])).rows[0];
      if (!c) return res.status(404).json({ error: "Entreprise introuvable." });
      const reglages = (await pool.query(`SELECT * FROM company_settings WHERE company_id=$1 ORDER BY id LIMIT 1`, [c.id])).rows[0] || {};
      const admins = (await pool.query(
        `SELECT id, fullname, email, phone, role, is_active, account_status, email_verified, verification_required,
                force_password_change, admin_validated_at, created_at
           FROM users WHERE company_id=$1 AND LOWER(role) = ANY($2::text[]) ORDER BY id`, [c.id, comptes.ROLES_ADMIN])).rows;
      const enAttente = (await pool.query(
        `SELECT subject_type, subject_id, new_email, expires_at FROM account_email_changes
          WHERE confirmed_at IS NULL AND cancelled_at IS NULL AND expires_at > NOW()
            AND ((subject_type='company' AND subject_id=$1) OR (subject_type='user' AND subject_id = ANY($2::int[])))`,
        [c.id, admins.map((a) => a.id)])).rows;
      res.json({
        entreprise: {
          id: c.id, name: c.name, business_type: c.business_type, responsible_name: c.responsible_name, email: c.email, phone: c.phone,
          address: c.address, status: c.status, account_status: c.account_status, subscription_status: c.subscription_status,
          email_verified: c.email_verified, tenant_id: c.tenant_id, admin_validated_at: c.admin_validated_at, created_at: c.created_at,
        },
        reglages: Object.fromEntries(Object.keys(CHAMPS_REGLAGES).map((k) => [k, reglages[k] ?? ""])),
        administrateurs: admins,
        changements_email_en_attente: enAttente.map((d) => ({ ...d, new_email: courriel.masquer(d.new_email) })),
      });
    } catch (e) {
      console.error("SUPER ADMIN FICHE ENTREPRISE :", e.message);
      res.status(500).json({ error: "Erreur lecture de l'entreprise." });
    }
  });

  router.put("/:id", async (req, res) => {
    const client = await pool.connect();
    try {
      const b = req.body || {};
      if (b.email !== undefined) return res.status(400).json({ error: "L'email se change par la procédure de vérification.", code: "EMAIL_VERIFICATION" });
      if (b.name !== undefined && texte(b.name, 160).length < 2) return res.status(400).json({ error: "Nom de l'entreprise trop court." });
      if (b.website && !/^https?:\/\/[^\s]+$/i.test(String(b.website).trim())) return res.status(400).json({ error: "Site internet : adresse http(s) attendue." });
      for (const k of ["phone", "whatsapp_number"]) {
        if (b[k] && !/^[+0-9 ().-]{6,40}$/.test(String(b[k]).trim())) return res.status(400).json({ error: `Numéro invalide (${k === "phone" ? "téléphone" : "WhatsApp"}).` });
      }
      await client.query("BEGIN");
      const avant = (await client.query(`SELECT * FROM companies WHERE id=$1 FOR UPDATE`, [req.params.id])).rows[0];
      if (!avant) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Entreprise introuvable." }); }
      const reglagesAvant = (await client.query(`SELECT * FROM company_settings WHERE company_id=$1 ORDER BY id LIMIT 1 FOR UPDATE`, [avant.id])).rows[0] || null;

      const modifs = Object.keys(CHAMPS_ENTREPRISE).filter((k) => b[k] !== undefined);
      if (modifs.length) {
        await client.query(
          `UPDATE companies SET ${modifs.map((k, i) => `${k}=$${i + 2}`).join(", ")}, updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
          [avant.id, ...modifs.map((k) => texte(b[k], CHAMPS_ENTREPRISE[k]))]);
      }
      const reglages = Object.keys(CHAMPS_REGLAGES).filter((k) => b[k] !== undefined);
      if (reglages.length) {
        const valeurs = reglages.map((k) => texte(b[k], CHAMPS_REGLAGES[k]));
        if (reglagesAvant) {
          await client.query(`UPDATE company_settings SET ${reglages.map((k, i) => `${k}=$${i + 2}`).join(", ")}, updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
            [reglagesAvant.id, ...valeurs]);
        } else {
          await client.query(`INSERT INTO company_settings (company_id, ${reglages.join(", ")}) VALUES ($1, ${reglages.map((_, i) => `$${i + 2}`).join(", ")})`,
            [avant.id, ...valeurs]);
        }
      }
      if (b.name !== undefined && reglagesAvant) {
        await client.query(`UPDATE company_settings SET company_name=$2 WHERE id=$1`, [reglagesAvant.id, texte(b.name, 160)]);
      }
      const apres = (await client.query(`SELECT * FROM companies WHERE id=$1`, [avant.id])).rows[0];
      const reglagesApres = (await client.query(`SELECT * FROM company_settings WHERE company_id=$1 ORDER BY id LIMIT 1`, [avant.id])).rows[0] || {};
      const diff = {};
      for (const k of modifs) if (String(avant[k] ?? "") !== String(apres[k] ?? "")) diff[k] = { avant: avant[k] ?? "", apres: apres[k] ?? "" };
      for (const k of reglages) if (String(reglagesAvant?.[k] ?? "") !== String(reglagesApres[k] ?? "")) diff[`reglages.${k}`] = { avant: reglagesAvant?.[k] ?? "", apres: reglagesApres[k] ?? "" };
      await client.query("COMMIT");
      await auditer(req, "super_admin_company_update", "company", avant.id, avant.id, { modifications: diff });
      res.json({ success: true, modifications: Object.keys(diff) });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("SUPER ADMIN MAJ ENTREPRISE :", e.message);
      res.status(500).json({ error: "Erreur enregistrement de l'entreprise." });
    } finally {
      client.release();
    }
  });

  router.post("/:id/email", async (req, res) => {
    try {
      const c = (await pool.query(`SELECT id FROM companies WHERE id=$1`, [req.params.id])).rows[0];
      if (!c) return res.status(404).json({ error: "Entreprise introuvable." });
      const r = await comptes.demanderChangementEmail(pool, { sujet: "company", sujetId: c.id, nouvelEmail: req.body?.email, parId: req.user.id, tenant: getTenantFromRequest(req) });
      await auditer(req, "super_admin_company_email_change_requested", "company", c.id, c.id, { destinataire: r.destinataire, envoi: r.envoi });
      res.status(r.accepte ? 202 : 503).json({
        ...r,
        message: r.accepte
          ? `Un code et un lien ont été envoyés à ${r.destinataire} (accepté par le serveur d'envoi). L'adresse ne changera qu'après confirmation.`
          : `Email de confirmation non envoyé (${r.raison}) : l'adresse n'a pas été changée.`,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("SUPER ADMIN EMAIL ENTREPRISE :", e.message);
      res.status(500).json({ error: "Erreur changement d'email." });
    }
  });

  router.put("/:id/administrateurs/:uid", async (req, res) => {
    try {
      const admin = await administrateurDe(req.params.id, req.params.uid);
      if (!admin) return res.status(404).json({ error: "Administrateur introuvable dans cette entreprise." });
      const b = req.body || {};
      if (b.email !== undefined) return res.status(400).json({ error: "L'email se change par la procédure de vérification.", code: "EMAIL_VERIFICATION" });
      const fullname = b.fullname !== undefined ? texte(b.fullname, 160) : admin.fullname;
      const phone = b.phone !== undefined ? texte(b.phone, 40) : admin.phone;
      if (fullname.length < 2) return res.status(400).json({ error: "Nom trop court." });
      if (phone && !/^[+0-9 ().-]{6,40}$/.test(phone)) return res.status(400).json({ error: "Téléphone invalide." });
      if (phone) {
        const pris = await pool.query(`SELECT 1 FROM users WHERE regexp_replace(COALESCE(phone,''),'[^0-9]','','g') = regexp_replace($1,'[^0-9]','','g') AND id<>$2 AND $1<>''`, [phone, admin.id]);
        if (pris.rows[0]) return res.status(409).json({ error: "Ce numéro est déjà utilisé par un autre compte." });
      }
      await pool.query(`UPDATE users SET fullname=$2, phone=$3, updated_at=CURRENT_TIMESTAMP WHERE id=$1`, [admin.id, fullname, phone || ""]);
      await auditer(req, "super_admin_admin_update", "user", admin.id, req.params.id, {
        company_id: Number(req.params.id),
        modifications: { ...(fullname !== admin.fullname ? { fullname: { avant: admin.fullname, apres: fullname } } : {}),
          ...(phone !== (admin.phone || "") ? { phone: { avant: admin.phone || "", apres: phone } } : {}) },
      });
      res.json({ success: true });
    } catch (e) {
      console.error("SUPER ADMIN MAJ ADMIN :", e.message);
      res.status(500).json({ error: "Erreur modification de l'administrateur." });
    }
  });

  router.post("/:id/administrateurs/:uid/email", async (req, res) => {
    try {
      const admin = await administrateurDe(req.params.id, req.params.uid);
      if (!admin) return res.status(404).json({ error: "Administrateur introuvable dans cette entreprise." });
      const r = await comptes.demanderChangementEmail(pool, { sujet: "user", sujetId: admin.id, nouvelEmail: req.body?.email, parId: req.user.id, tenant: getTenantFromRequest(req) });
      await auditer(req, "super_admin_admin_email_change_requested", "user", admin.id, req.params.id, { destinataire: r.destinataire, envoi: r.envoi });
      res.status(r.accepte ? 202 : 503).json({
        ...r,
        message: r.accepte
          ? `Un code et un lien ont été envoyés à ${r.destinataire} (accepté par le serveur d'envoi). L'identifiant de connexion ne changera qu'après confirmation par cette adresse.`
          : `Email de confirmation non envoyé (${r.raison}) : l'adresse n'a pas été changée.`,
      });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("SUPER ADMIN EMAIL ADMIN :", e.message);
      res.status(500).json({ error: "Erreur changement d'email." });
    }
  });

  router.post("/:id/administrateurs/:uid/mot-de-passe", async (req, res) => {
    try {
      const admin = await administrateurDe(req.params.id, req.params.uid);
      if (!admin) return res.status(404).json({ error: "Administrateur introuvable dans cette entreprise." });
      const r = await reinitialiserMotDePasseTemporaire(req, { userId: admin.id, companyId: Number(req.params.id), envoyerEmail: req.body?.envoyer_email === true });
      if (!r) return res.status(404).json({ error: "Administrateur introuvable." });
      res.json({
        success: true,
        // Montré UNE fois au Super Admin ; l'ancien mot de passe n'est jamais lu.
        mot_de_passe_temporaire: r.temporary_password,
        email_envoye: r.email_sent,
        message: `${r.email_message} Sessions ouvertes fermées ; un nouveau mot de passe sera exigé à la prochaine connexion.`,
      });
    } catch (e) {
      console.error("SUPER ADMIN MDP ADMIN :", e.message);
      res.status(500).json({ error: "Erreur réinitialisation du mot de passe." });
    }
  });

  router.post("/:id/administrateurs/:uid/validation", async (req, res) => {
    try {
      const r = await comptes.validerAdministrativement(pool, {
        companyId: Number(req.params.id), userId: Number(req.params.uid), parId: req.user.id, motif: req.body?.motif,
        source: "interface_super_admin", ip: req.ip || "",
      });
      res.json({ success: true, journal_id: r.journal_id, avant: r.avant, apres: r.apres,
        message: "Compte validé administrativement : la connexion est ouverte. L'email reste « non vérifié » tant que son propriétaire n'a pas saisi de code." });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("SUPER ADMIN VALIDATION :", e.message);
      res.status(500).json({ error: "Erreur validation du compte." });
    }
  });

  router.get("/:id/journal", async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT a.id, a.action, a.entity_type, a.entity_id, a.user_email, a.details, a.created_at
           FROM audit_logs a
          WHERE a.company_id=$1
            AND a.action IN ('super_admin_company_update','super_admin_company_email_change_requested','super_admin_admin_update',
                             'super_admin_admin_email_change_requested','reset_password','admin_account_validation','email_change_confirmed')
          ORDER BY a.id DESC LIMIT 50`, [req.params.id]);
      res.json(rows.map((r) => ({ ...r, user_email: courriel.masquer(r.user_email) })));
    } catch (e) {
      console.error("SUPER ADMIN JOURNAL :", e.message);
      res.status(500).json({ error: "Erreur journal." });
    }
  });

  publique.post("/changement-email/confirmer", async (req, res) => {
    try {
      const b = req.body || {};
      if (!b.token && !(b.demande_id && b.code)) return res.status(400).json({ error: "Lien ou code obligatoire." });
      const r = await comptes.confirmerChangementEmail(pool, { jeton: b.token ? String(b.token).slice(0, 100) : null, demandeId: b.demande_id, code: b.code });
      if (r.sujet === "user") revoquerSessions(r.sujet_id);
      res.json({ success: true, ...r, message: `Adresse ${r.nouvelle} confirmée et enregistrée.${r.sujet === "user" ? " Reconnectez-vous avec cette adresse." : ""}` });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("CONFIRMATION EMAIL :", e.message);
      res.status(500).json({ error: "Erreur confirmation." });
    }
  });

  return { router, publique };
};
