"use strict";

/**
 * Runner de migrations SQL pour MaliLink / Triangle / Hafiya.
 *
 * - Applique les fichiers backend/sql/*.sql dans l'ordre alphabétique
 * - Trace les fichiers appliqués dans la table schema_migrations
 * - Idempotent : un fichier déjà appliqué n'est jamais rejoué
 * - Chaque migration s'exécute dans une transaction
 *
 * Usage :
 *   node scripts/migrate.js            # applique les migrations manquantes
 *   node scripts/migrate.js --status   # affiche l'état sans rien appliquer
 *   node scripts/migrate.js --mark-all # marque tout comme appliqué SANS exécuter
 *                                      # (à utiliser UNE FOIS sur une base existante
 *                                      #  déjà à jour, pour initialiser le suivi)
 */

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const SQL_DIR = path.join(__dirname, "..", "sql");

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : new Pool({
      user: process.env.PGUSER || "souleymanediallo",
      host: process.env.PGHOST || "localhost",
      database: process.env.PGDATABASE || "triangle_wms_db",
      password: process.env.PGPASSWORD || "",
      port: Number(process.env.PGPORT || 5432)
    });

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

function listMigrationFiles() {
  return fs
    .readdirSync(SQL_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

async function getApplied(client) {
  const { rows } = await client.query("SELECT filename FROM schema_migrations");
  return new Set(rows.map((r) => r.filename));
}

async function main() {
  const args = process.argv.slice(2);
  const statusOnly = args.includes("--status");
  const markAll = args.includes("--mark-all");

  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await getApplied(client);
    const files = listMigrationFiles();
    const pending = files.filter((f) => !applied.has(f));

    if (statusOnly) {
      console.log(`Migrations totales : ${files.length}`);
      console.log(`Appliquées        : ${files.length - pending.length}`);
      console.log(`En attente        : ${pending.length}`);
      pending.forEach((f) => console.log(`  - ${f}`));
      return;
    }

    if (markAll) {
      for (const f of pending) {
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING",
          [f]
        );
      }
      console.log(`${pending.length} migration(s) marquée(s) comme appliquée(s) sans exécution.`);
      return;
    }

    if (pending.length === 0) {
      console.log("Base à jour. Aucune migration en attente.");
      return;
    }

    for (const file of pending) {
      const sql = fs.readFileSync(path.join(SQL_DIR, file), "utf8");
      console.log(`Application de ${file}...`);
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (filename) VALUES ($1)",
          [file]
        );
        await client.query("COMMIT");
        console.log(`  OK`);
      } catch (err) {
        await client.query("ROLLBACK");
        console.error(`  ECHEC sur ${file} : ${err.message}`);
        console.error("Arrêt. Corrigez la migration puis relancez.");
        process.exitCode = 1;
        return;
      }
    }
    console.log("Toutes les migrations ont été appliquées.");
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Erreur migration :", err.message);
  process.exit(1);
});
