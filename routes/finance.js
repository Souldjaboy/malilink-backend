"use strict";

/**
 * Module Finance MaliLink — tableau de bord financier.
 * Lecture seule agrégée sur les données RÉELLES existantes (ventes POS,
 * commandes marketplace payées, transactions comptables, paie) + budgets.
 * Rien n'est inventé : si une entreprise n'a pas de ventes, les revenus
 * affichent 0. Scopé company_id, réservé direction/comptabilité.
 */

const express = require("express");

module.exports = function createFinanceRouter({
  pool,
  authenticateToken,
  getEffectiveCompanyId,
  isSuperAdminUser
}) {
  const router = express.Router();
  router.use(authenticateToken);

  function canViewFinance(user) {
    const role = String(user?.role || "").toLowerCase();
    return isSuperAdminUser(user) || ["admin", "direction", "directeur", "comptable"].includes(role);
  }

  async function safe(text, values, fallback = 0) {
    try {
      const { rows } = await pool.query(text, values);
      return rows;
    } catch {
      return fallback === 0 ? [] : fallback;
    }
  }

  /* Vue d'ensemble : revenus, dépenses, bénéfice, trésorerie + série 6 mois. */
  router.get("/overview", async (req, res) => {
    try {
      if (!canViewFinance(req.user)) {
        return res.status(403).json({ error: "Réservé à la direction et à la comptabilité." });
      }
      const companyId = getEffectiveCompanyId(req);
      if (!companyId) return res.status(400).json({ error: "Entreprise requise." });

      // Revenus RÉELS : ventes POS payées + commandes marketplace payées.
      const revenueMonth = await safe(
        `SELECT
           COALESCE((SELECT SUM(total_amount) FROM sales
             WHERE company_id=$1 AND payment_status='payé'
               AND date_trunc('month', created_at)=date_trunc('month', CURRENT_DATE)),0)
           + COALESCE((SELECT SUM(total_amount) FROM marketplace_orders
             WHERE vendor_company_id=$1 AND payment_status IN ('paid','payé','completed')
               AND date_trunc('month', created_at)=date_trunc('month', CURRENT_DATE)),0)
           AS total`,
        [companyId]
      );

      // Dépenses RÉELLES : transactions comptables sortantes + paie du mois.
      const expenseMonth = await safe(
        `SELECT
           COALESCE((SELECT SUM(amount) FROM accounting_transactions
             WHERE company_id=$1 AND direction IN ('sortie','out','debit')
               AND date_trunc('month', created_at)=date_trunc('month', CURRENT_DATE)),0)
           + COALESCE((SELECT SUM(net_amount) FROM payroll_items pi
               JOIN payroll_runs pr ON pr.id=pi.payroll_run_id
               WHERE pr.company_id=$1
               AND date_trunc('month', pr.created_at)=date_trunc('month', CURRENT_DATE)),0)
           AS total`,
        [companyId]
      );

      // Trésorerie : banques + caisses + trésorerie (comme /accounting/dashboard).
      const treasury = await safe(
        `SELECT
           COALESCE((SELECT SUM(current_balance) FROM accounting_banks WHERE company_id=$1),0)
           + COALESCE((SELECT SUM(solde_actuel) FROM accounting_caisses WHERE company_id=$1),0)
           + COALESCE((SELECT SUM(current_balance) FROM treasury_accounts WHERE company_id=$1),0)
           AS total`,
        [companyId]
      );

      // Série 6 derniers mois : revenus vs dépenses (pour graphique).
      const series = await safe(
        `WITH months AS (
           SELECT date_trunc('month', CURRENT_DATE) - (n || ' month')::interval AS m
           FROM generate_series(0,5) AS n
         )
         SELECT to_char(m, 'YYYY-MM') AS month,
           COALESCE((SELECT SUM(total_amount) FROM sales
             WHERE company_id=$1 AND payment_status='payé' AND date_trunc('month', created_at)=m),0)
           + COALESCE((SELECT SUM(total_amount) FROM marketplace_orders
             WHERE vendor_company_id=$1 AND payment_status IN ('paid','payé','completed')
               AND date_trunc('month', created_at)=m),0) AS revenue,
           COALESCE((SELECT SUM(amount) FROM accounting_transactions
             WHERE company_id=$1 AND direction IN ('sortie','out','debit')
               AND date_trunc('month', created_at)=m),0) AS expense
         FROM months ORDER BY m ASC`,
        [companyId]
      );

      const revenue = Number(revenueMonth[0]?.total || 0);
      const expense = Number(expenseMonth[0]?.total || 0);

      res.json({
        currency: "FCFA",
        revenue_month: revenue,
        expense_month: expense,
        profit_month: revenue - expense,
        treasury_balance: Number(treasury[0]?.total || 0),
        series: (Array.isArray(series) ? series : []).map((row) => ({
          month: row.month,
          revenue: Number(row.revenue || 0),
          expense: Number(row.expense || 0),
          profit: Number(row.revenue || 0) - Number(row.expense || 0)
        }))
      });
    } catch (error) {
      console.error("ERREUR FINANCE OVERVIEW :", error.message);
      res.status(500).json({ error: "Erreur chargement finance." });
    }
  });

  /* Budgets : liste. */
  router.get("/budgets", async (req, res) => {
    try {
      if (!canViewFinance(req.user)) {
        return res.status(403).json({ error: "Accès refusé." });
      }
      const companyId = getEffectiveCompanyId(req);
      if (!companyId) return res.json([]);
      const year = Number(req.query.year) || new Date().getFullYear();
      const { rows } = await pool.query(
        `SELECT * FROM finance_budgets WHERE company_id=$1 AND year=$2
         ORDER BY month NULLS FIRST, category ASC`,
        [companyId, year]
      );
      res.json(rows);
    } catch (error) {
      res.status(500).json({ error: "Erreur budgets." });
    }
  });

  /* Budgets : créer / mettre à jour. */
  router.post("/budgets", async (req, res) => {
    try {
      if (!canViewFinance(req.user)) {
        return res.status(403).json({ error: "Accès refusé." });
      }
      const companyId = getEffectiveCompanyId(req);
      if (!companyId) return res.status(400).json({ error: "Entreprise requise." });
      const { category, planned_amount, period = "mensuel", month, note = "", id } = req.body || {};
      const amount = Math.round(Number(planned_amount) * 100) / 100;
      if (!category || !Number.isFinite(amount) || amount < 0) {
        return res.status(400).json({ error: "Catégorie et montant valides obligatoires." });
      }
      const year = Number(req.body?.year) || new Date().getFullYear();
      const cleanMonth = period === "annuel" ? null : Math.min(12, Math.max(1, Number(month) || new Date().getMonth() + 1));

      if (id) {
        const { rows } = await pool.query(
          `UPDATE finance_budgets
           SET category=$1, planned_amount=$2, period=$3, month=$4, note=$5, updated_at=NOW()
           WHERE id=$6 AND company_id=$7 RETURNING *`,
          [String(category).slice(0, 80), amount, period, cleanMonth, String(note).slice(0, 300), Number(id), companyId]
        );
        if (!rows[0]) return res.status(404).json({ error: "Budget introuvable." });
        return res.json({ success: true, budget: rows[0] });
      }

      const { rows } = await pool.query(
        `INSERT INTO finance_budgets
           (company_id, category, planned_amount, period, year, month, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [companyId, String(category).slice(0, 80), amount, period, year, cleanMonth, String(note).slice(0, 300), req.user.id]
      );
      res.status(201).json({ success: true, budget: rows[0] });
    } catch (error) {
      console.error("ERREUR FINANCE BUDGET :", error.message);
      res.status(500).json({ error: "Erreur enregistrement du budget." });
    }
  });

  router.delete("/budgets/:id", async (req, res) => {
    try {
      if (!canViewFinance(req.user)) {
        return res.status(403).json({ error: "Accès refusé." });
      }
      const companyId = getEffectiveCompanyId(req);
      await pool.query(`DELETE FROM finance_budgets WHERE id=$1 AND company_id=$2`, [
        Number(req.params.id),
        companyId
      ]);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Erreur suppression du budget." });
    }
  });

  return router;
};
