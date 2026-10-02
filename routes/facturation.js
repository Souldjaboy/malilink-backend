"use strict";

/**
 * ABONNEMENT, PAIEMENTS ET FACTURES — routes client et super-admin.
 *
 * Client (entreprise connectée) — restent ouvertes quand l'abonnement est
 * verrouillé :
 *   GET  /abonnement/etat                      état, montant dû, échéance
 *   GET  /abonnement/moyens-paiement           Orange Money, Wave… publiés
 *   GET  /abonnement/factures                  (direction / administration)
 *   GET  /abonnement/factures/:id/pdf
 *   GET  /abonnement/paiements                 POST /abonnement/paiements (déclaration)
 *   GET  /abonnement/paiements/:id/recu        GET /abonnement/historique
 *
 * Super-admin :
 *   GET  /super-admin/companies/:id/billing
 *   POST /super-admin/companies/:id/invoices   GET …/invoices/:fid(/pdf)
 *   POST …/invoices/:fid/(cancel|avoir|send)
 *   POST /super-admin/companies/:id/payments   POST …/payments/:pid/(confirm|refuse|refund)
 *   GET  …/payments/:pid/recu
 *   POST /super-admin/companies/:id/subscription/(extend|suspend|reactivate|force-unlock|remove-override)
 *   GET  /super-admin/billing/pending-payments
 *   GET|PUT /super-admin/billing/payment-methods(/:code)
 */

const express = require("express");
const { FacturationError } = require("../services/facturation");
const { genererFacturePdf, genererRecuPdf } = require("../services/facture-pdf");

const ROLES_DIRECTION = new Set(["admin", "direction", "directeur", "director", "super_admin"]);

module.exports = function createFacturationRouter(deps) {
  const { pool, facturation, authenticateToken, authorizeRoles, getEffectiveCompanyId, isSuperAdminUser,
    normalizeRole, logAudit, controlerStepUp, envoyerEmail } = deps;
  const router = express.Router();
  const superAdmin = [authenticateToken, authorizeRoles("super_admin")];

  const erreur = (res, e, ctx) => {
    if (e instanceof FacturationError) return res.status(e.httpStatus).json({ error: e.message, code: e.code });
    if (e?.httpStatus && e?.code) return res.status(e.httpStatus).json({ error: e.message, code: e.code });
    if (e?.code === "23514") return res.status(409).json({ error: "Opération refusée : document figé.", code: "DOCUMENT_FIGE" });
    console.error(`facturation ${ctx} :`, e.message);
    return res.status(500).json({ error: "Erreur de facturation.", code: "ERREUR_INTERNE" });
  };

  const societeClient = (req) => {
    if (normalizeRole(req.user.role) === "customer") {
      throw new FacturationError("Espace réservé aux entreprises.", "ESPACE_ENTREPRISE", 403);
    }
    const id = Number(isSuperAdminUser(req.user) ? getEffectiveCompanyId(req) : req.user.company_id);
    if (!id) throw new FacturationError("Aucune entreprise associée.", "SOCIETE_REQUISE", 400);
    return id;
  };
  const exigerDirection = (req) => {
    if (!ROLES_DIRECTION.has(normalizeRole(req.user.role)) && !isSuperAdminUser(req.user)) {
      throw new FacturationError("Réservé à la direction de l'entreprise.", "DIRECTION_REQUISE", 403);
    }
  };
  const audit = (req, action, companyId, details) =>
    logAudit(req, action, "facturation", companyId, details).catch?.(() => {});
  const envoyerPdf = (res, nom, buffer) => {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${nom}.pdf"`);
    res.setHeader("Cache-Control", "private, no-store");
    res.send(buffer);
  };

  // ════════════════════════════════════════════════════════════════ CLIENT

  router.get("/abonnement/etat", authenticateToken, async (req, res) => {
    try {
      res.json({ etat: await facturation.etat(societeClient(req)) });
    } catch (e) {
      erreur(res, e, "etat");
    }
  });

  router.get("/abonnement/moyens-paiement", authenticateToken, async (req, res) => {
    try {
      societeClient(req);
      res.json({ moyens: await facturation.moyensPaiement() });
    } catch (e) {
      erreur(res, e, "moyens");
    }
  });

  router.get("/abonnement/factures", authenticateToken, async (req, res) => {
    try {
      const id = societeClient(req);
      exigerDirection(req);
      res.json({ factures: await facturation.factures(id) });
    } catch (e) {
      erreur(res, e, "factures client");
    }
  });

  router.get("/abonnement/factures/:fid/pdf", authenticateToken, async (req, res) => {
    try {
      const id = societeClient(req);
      exigerDirection(req);
      const f = await facturation.facture(id, req.params.fid);
      envoyerPdf(res, f.number, await genererFacturePdf(f, { moyens: await facturation.moyensPaiement() }));
    } catch (e) {
      erreur(res, e, "pdf client");
    }
  });

  router.get("/abonnement/paiements", authenticateToken, async (req, res) => {
    try {
      const id = societeClient(req);
      exigerDirection(req);
      res.json({ paiements: await facturation.paiements(id) });
    } catch (e) {
      erreur(res, e, "paiements client");
    }
  });

  /* Déclaration : le client a payé par Orange Money / Wave au numéro affiché
     et indique la référence reçue par SMS. Le MONTANT est fixé par le
     serveur ; MaliLink valide ensuite (aucune API d'opérateur connectée). */
  router.post("/abonnement/paiements", authenticateToken, async (req, res) => {
    try {
      const id = societeClient(req);
      exigerDirection(req);
      const b = req.body || {};
      const r = await facturation.enregistrerPaiement({
        companyId: id, factureId: b.invoice_id || null, methode: b.method, reference: b.transaction_reference,
        cleIdempotence: req.headers["idempotency-key"] || null, source: "declaration_client", mois: b.months,
        notes: b.notes, par: req.user.id,
      });
      res.status(r.deja ? 200 : 201).json({ paiement: r.paiement, deja: r.deja,
        message: "Paiement déclaré : il sera validé par MaliLink après vérification de la transaction." });
    } catch (e) {
      erreur(res, e, "declaration");
    }
  });

  router.get("/abonnement/paiements/:pid/recu", authenticateToken, async (req, res) => {
    try {
      const id = societeClient(req);
      exigerDirection(req);
      const { rows } = await pool.query(`SELECT * FROM subscription_payments WHERE id = $1 AND company_id = $2 AND status = 'confirmed'`,
        [Number(req.params.pid), id]);
      if (!rows[0]) throw new FacturationError("Reçu introuvable.", "RECU_INTROUVABLE", 404);
      const f = rows[0].invoice_id ? await facturation.facture(id, rows[0].invoice_id) : null;
      envoyerPdf(res, rows[0].receipt_number, await genererRecuPdf(rows[0], f));
    } catch (e) {
      erreur(res, e, "recu client");
    }
  });

  router.get("/abonnement/historique", authenticateToken, async (req, res) => {
    try {
      const id = societeClient(req);
      exigerDirection(req);
      res.json({ historique: await facturation.historique(id) });
    } catch (e) {
      erreur(res, e, "historique client");
    }
  });

  // ═══════════════════════════════════════════════════════════ SUPER-ADMIN

  const sid = (req) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new FacturationError("Entreprise invalide.", "SOCIETE_REQUISE", 400);
    return id;
  };

  router.get("/super-admin/companies/:id/billing", ...superAdmin, async (req, res) => {
    try {
      const id = sid(req);
      const [etat, factures, paiements, historique] = await Promise.all([
        facturation.etat(id), facturation.factures(id), facturation.paiements(id), facturation.historique(id)]);
      res.json({ etat, factures, paiements, historique });
    } catch (e) {
      erreur(res, e, "billing");
    }
  });

  router.post("/super-admin/companies/:id/invoices", ...superAdmin, async (req, res) => {
    try {
      const id = sid(req);
      const b = req.body || {};
      const f = await facturation.creerFacture({ companyId: id, lignes: b.lines, echeance: b.due_date,
        reference: b.reference, notes: b.notes, par: req.user.id });
      await audit(req, "facture_emise", id, { facture: f.number, total: f.total });
      res.status(201).json({ facture: await facturation.facture(id, f.id) });
    } catch (e) {
      erreur(res, e, "creer facture");
    }
  });

  router.get("/super-admin/companies/:id/invoices/:fid", ...superAdmin, async (req, res) => {
    try {
      res.json({ facture: await facturation.facture(sid(req), req.params.fid) });
    } catch (e) {
      erreur(res, e, "facture");
    }
  });

  router.get("/super-admin/companies/:id/invoices/:fid/pdf", ...superAdmin, async (req, res) => {
    try {
      const f = await facturation.facture(sid(req), req.params.fid);
      envoyerPdf(res, f.number, await genererFacturePdf(f, { moyens: await facturation.moyensPaiement() }));
    } catch (e) {
      erreur(res, e, "pdf");
    }
  });

  router.post("/super-admin/companies/:id/invoices/:fid/cancel", ...superAdmin, async (req, res) => {
    try {
      const id = sid(req);
      await controlerStepUp(req, "facturation.correction");
      const f = await facturation.annulerFacture({ companyId: id, id: req.params.fid, raison: req.body?.reason, par: req.user.id });
      await audit(req, "facture_annulee", id, { facture: f.number, motif: req.body?.reason });
      res.json({ facture: f });
    } catch (e) {
      erreur(res, e, "annuler");
    }
  });

  router.post("/super-admin/companies/:id/invoices/:fid/avoir", ...superAdmin, async (req, res) => {
    try {
      const id = sid(req);
      await controlerStepUp(req, "facturation.correction");
      const f = await facturation.emettreAvoir({ companyId: id, id: req.params.fid, raison: req.body?.reason,
        montant: req.body?.amount, par: req.user.id });
      await audit(req, "avoir_emis", id, { avoir: f.number, montant: f.total });
      res.status(201).json({ avoir: f });
    } catch (e) {
      erreur(res, e, "avoir");
    }
  });

  router.post("/super-admin/companies/:id/invoices/:fid/send", ...superAdmin, async (req, res) => {
    try {
      const id = sid(req);
      const f = await facturation.facture(id, req.params.fid);
      const destinataire = String(req.body?.to || f.client_snapshot?.email || "").trim();
      if (!destinataire) throw new FacturationError("Aucune adresse email pour ce client.", "EMAIL_ABSENT", 400);
      const pdf = await genererFacturePdf(f, { moyens: await facturation.moyensPaiement() });
      const envoi = await envoyerEmail({
        to: destinataire,
        subject: `Facture ${f.number} — MaliLink Global`,
        text: `Bonjour,\n\nVeuillez trouver ci-joint la facture ${f.number}.\n\nMaliLink Global — malilinkglobal.com`,
        attachments: [{ filename: `${f.number}.pdf`, content: pdf }],
      });
      if (!envoi.ok) throw new FacturationError(envoi.message || "Envoi impossible.", envoi.code || "EMAIL_ECHEC", envoi.status || 502);
      await pool.query(`UPDATE invoices SET sent_at = now() WHERE id = $1`, [f.id]);
      await facturation.evenement(null, { companyId: id, type: "envoi", factureId: f.id, details: { a: destinataire }, par: req.user.id });
      res.json({ ok: true, envoye_a: destinataire });
    } catch (e) {
      erreur(res, e, "envoi");
    }
  });

  /* Paiement saisi par le super-admin (« Marquer payée » = solde entier,
     « partielle » = montant inférieur au solde). Confirmé dans la foulée si
     demandé : même automatisation qu'une validation. */
  router.post("/super-admin/companies/:id/payments", ...superAdmin, async (req, res) => {
    try {
      const id = sid(req);
      const b = req.body || {};
      const r = await facturation.enregistrerPaiement({
        companyId: id, factureId: b.invoice_id || null, montant: b.amount, methode: b.method,
        reference: b.transaction_reference, cleIdempotence: req.headers["idempotency-key"] || null,
        source: "manuel", mois: b.months, notes: b.notes, par: req.user.id, payeLe: b.paid_at || null,
      });
      let confirmation = null;
      if (b.confirm === true && !r.deja) {
        confirmation = await facturation.confirmerPaiement({ companyId: id, paiementId: r.paiement.id, par: req.user.id });
      }
      await audit(req, "paiement_enregistre", id, { paiement: r.paiement.id, montant: r.paiement.amount, confirme: Boolean(confirmation) });
      res.status(r.deja ? 200 : 201).json({ paiement: confirmation?.paiement || r.paiement, deja: r.deja, confirmation });
    } catch (e) {
      erreur(res, e, "paiement manuel");
    }
  });

  router.post("/super-admin/companies/:id/payments/:pid/confirm", ...superAdmin, async (req, res) => {
    try {
      const id = sid(req);
      const r = await facturation.confirmerPaiement({ companyId: id, paiementId: req.params.pid, par: req.user.id });
      await audit(req, "paiement_confirme", id, { paiement: Number(req.params.pid), deja: r.deja });
      res.json(r);
    } catch (e) {
      erreur(res, e, "confirmer");
    }
  });

  router.post("/super-admin/companies/:id/payments/:pid/refuse", ...superAdmin, async (req, res) => {
    try {
      const id = sid(req);
      const p = await facturation.refuserPaiement({ companyId: id, paiementId: req.params.pid, raison: req.body?.reason, par: req.user.id });
      await audit(req, "paiement_refuse", id, { paiement: p.id, motif: req.body?.reason });
      res.json({ paiement: p });
    } catch (e) {
      erreur(res, e, "refuser");
    }
  });

  router.post("/super-admin/companies/:id/payments/:pid/refund", ...superAdmin, async (req, res) => {
    try {
      const id = sid(req);
      await controlerStepUp(req, "facturation.correction");
      const r = await facturation.rembourserPaiement({ companyId: id, paiementId: req.params.pid, raison: req.body?.reason, par: req.user.id });
      await audit(req, "paiement_rembourse", id, { paiement: Number(req.params.pid), motif: req.body?.reason });
      res.json(r);
    } catch (e) {
      erreur(res, e, "rembourser");
    }
  });

  router.get("/super-admin/companies/:id/payments/:pid/recu", ...superAdmin, async (req, res) => {
    try {
      const id = sid(req);
      const { rows } = await pool.query(`SELECT * FROM subscription_payments WHERE id = $1 AND company_id = $2 AND status = 'confirmed'`,
        [Number(req.params.pid), id]);
      if (!rows[0]) throw new FacturationError("Reçu introuvable.", "RECU_INTROUVABLE", 404);
      const f = rows[0].invoice_id ? await facturation.facture(id, rows[0].invoice_id) : null;
      envoyerPdf(res, rows[0].receipt_number, await genererRecuPdf(rows[0], f));
    } catch (e) {
      erreur(res, e, "recu");
    }
  });

  const actionAbonnement = (nom, fn, { stepUp } = {}) => async (req, res) => {
    try {
      const id = sid(req);
      if (stepUp) await controlerStepUp(req, stepUp);
      const etat = await fn(id, req.body || {}, req.user.id);
      await audit(req, `abonnement_${nom}`, id, { ...(req.body || {}) });
      res.json({ etat });
    } catch (e) {
      erreur(res, e, nom);
    }
  };

  router.post("/super-admin/companies/:id/subscription/extend", ...superAdmin, actionAbonnement("prolongation",
    (id, b, par) => facturation.prolonger({ companyId: id, mois: b.months, jours: b.days, gratuit: b.free === true, raison: b.reason, par })));
  router.post("/super-admin/companies/:id/subscription/suspend", ...superAdmin, actionAbonnement("suspension",
    (id, b, par) => facturation.suspendre({ companyId: id, raison: b.reason, par })));
  router.post("/super-admin/companies/:id/subscription/reactivate", ...superAdmin, actionAbonnement("reactivation",
    (id, b, par) => facturation.reactiver({ companyId: id, raison: b.reason, par })));
  router.post("/super-admin/companies/:id/subscription/force-unlock", ...superAdmin, actionAbonnement("deverrouillage_force",
    (id, b, par) => facturation.deverrouillerForce({ companyId: id, raison: b.reason, jusqua: b.until, par }),
    { stepUp: "facturation.deverrouillage" }));
  router.post("/super-admin/companies/:id/subscription/remove-override", ...superAdmin, actionAbonnement("fin_derogation",
    (id, b, par) => facturation.leverDerogation({ companyId: id, raison: b.reason, par })));

  router.get("/super-admin/billing/pending-payments", ...superAdmin, async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT sp.*, c.name AS company_name, i.number AS invoice_number
           FROM subscription_payments sp JOIN companies c ON c.id = sp.company_id
           LEFT JOIN invoices i ON i.id = sp.invoice_id
          WHERE sp.status = 'pending' ORDER BY sp.created_at`);
      res.json({ paiements: rows });
    } catch (e) {
      erreur(res, e, "en attente");
    }
  });

  router.get("/super-admin/billing/payment-methods", ...superAdmin, async (req, res) => {
    try {
      res.json({ moyens: await facturation.moyensPaiement({ tous: true }) });
    } catch (e) {
      erreur(res, e, "moyens admin");
    }
  });

  router.put("/super-admin/billing/payment-methods/:code", ...superAdmin, async (req, res) => {
    try {
      const m = await facturation.majMoyenPaiement(String(req.params.code), req.body || {}, req.user.id);
      await audit(req, "moyen_paiement_modifie", null, { code: m.code, actif: m.enabled });
      res.json({ moyen: m });
    } catch (e) {
      erreur(res, e, "moyen maj");
    }
  });

  return router;
};
