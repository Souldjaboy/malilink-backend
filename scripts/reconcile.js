"use strict";

/**
 * Réconciliation planifiée du grand livre Wallet (Phase 0, #5).
 *
 * À exécuter périodiquement (cron / job) :
 *
 *   node scripts/reconcile.js               # incrémental (défaut, rapide)
 *   node scripts/reconcile.js --full        # contrôle complet (audit ponctuel)
 *
 * Le mode incrémental ne traite que les écritures apparues depuis le dernier
 * passage (curseur persistant). Code de sortie 2 si un écart est détecté →
 * exploitable par un système de supervision.
 *
 * Exemple crontab (toutes les 15 minutes) :
 *   [slash]15 * * * * cd /chemin/backend && node scripts/reconcile.js >> logs/reconcile.log 2>&1
 *   (remplacer [slash]15 par une barre oblique suivie de 15)
 */

require("dotenv").config();
const { Pool } = require("pg");
const reconciliation = require("../services/wallet-reconciliation");

async function main() {
  const full = process.argv.includes("--full");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 2,
    connectionTimeoutMillis: 5000
  });
  try {
    const report = full
      ? await reconciliation.reconcile(pool, { tenantId: "malilink" })
      : await reconciliation.reconcileIncremental(pool, { tenantId: "malilink" });

    const tag = full ? "COMPLET" : "INCRÉMENTAL";
    console.log(
      `[réconciliation ${tag}] statut=${report.status} ` +
        `traitées=${report.processed ?? report.checked} écarts=${report.mismatch} ` +
        `débit=${report.ledger_debit_total} crédit=${report.ledger_credit_total}` +
        (report.from_entry_id != null ? ` curseur=${report.from_entry_id}→${report.to_entry_id}` : "")
    );
    if (report.mismatch > 0) {
      console.error("[réconciliation] ÉCART DÉTECTÉ :", JSON.stringify(report.details));
      process.exitCode = 2; // signal pour la supervision
    }
  } catch (e) {
    console.error("[réconciliation] ERREUR :", e.message);
    process.exitCode = 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

main();
