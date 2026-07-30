"use strict";
/* Test d'intégration des exécuteurs d'entités (Triangle/MaliLink/HAFIYA). DB requise. */
const assert = require("assert");
require("dotenv").config();
if (!process.env.DATABASE_URL) { console.log("⏭  import-entity: DATABASE_URL absente, ignoré."); process.exit(0); }

const { Pool } = require("pg");
const ic = require("../import-center");
const { executeEntity, rollbackEntity } = require("../import-center/executor-entity");

const CO = 1; // entreprise réelle (FK companies) ; nettoyage ciblé sur les lignes de test
const row = (i, mapped) => ({ __row: i, status: "new", mapped });

(async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let passed = 0;
  const test = (n, c) => { assert.ok(c, n); passed++; console.log("  ✓ " + n); };
  const clean = async () => {
    await pool.query("DELETE FROM stock_movements WHERE company_id=$1 AND product_name='Sucre 1kg'", [CO]).catch(() => {});
    await pool.query("DELETE FROM products WHERE company_id=$1 AND name='Sucre 1kg'", [CO]).catch(() => {});
    await pool.query("DELETE FROM marketplace_products WHERE company_id=$1 AND title='T-shirt'", [CO]).catch(() => {});
    await pool.query("DELETE FROM laboratory_patients WHERE company_id=$1 AND full_name='Awa Diallo'", [CO]).catch(() => {});
    await pool.query("DELETE FROM laboratory_analyses WHERE company_id=$1 AND name='Glycémie'", [CO]).catch(() => {});
  };
  try {
    await clean();
    console.log("Import — exécuteurs d'entités (3 produits)");

    // TRIANGLE produits
    const pProfile = ic.registry.getProfile("triangle.products");
    const rP = await executeEntity(pool, CO, 1, pProfile, [row(2, { product_name: "Sucre 1kg", product_code: "SUC-1", unit_price: 500, quantity: 12 })], {});
    test("Triangle: produit créé", rP.report.created === 1);
    const prod = (await pool.query("SELECT name, stock, sale_price FROM products WHERE company_id=$1", [CO])).rows[0];
    test("Triangle: nom/stock/prix corrects", prod.name === "Sucre 1kg" && Number(prod.stock) === 12 && Number(prod.sale_price) === 500);
    // Doublon (create_only) -> skip
    const rDup = await executeEntity(pool, CO, 1, pProfile, [row(2, { product_name: "Sucre 1kg", unit_price: 999 })], { strategy: "create_only" });
    test("Triangle: doublon ignoré en create_only", rDup.report.skipped === 1 && rDup.report.created === 0);

    // MALILINK marketplace
    const mProfile = ic.registry.getProfile("malilink.marketplace_products");
    const rM = await executeEntity(pool, CO, 1, mProfile, [row(2, { product_name: "T-shirt", unit_price: 3000, quantity: 5, description: "Coton" })], {});
    test("MaliLink: produit marketplace créé", rM.report.created === 1);
    const mp = (await pool.query("SELECT title, price, available_stock FROM marketplace_products WHERE company_id=$1", [CO])).rows[0];
    test("MaliLink: title/price/stock corrects", mp.title === "T-shirt" && Number(mp.price) === 3000 && Number(mp.available_stock) === 5);

    // HAFIYA patients (full_name calculé) + dedup téléphone
    const patProfile = ic.registry.getProfile("hafiya.patients");
    const rPat = await executeEntity(pool, CO, 1, patProfile, [row(2, { first_name: "Awa", last_name: "Diallo", phone: "70000000", gender: "F" })], {});
    test("HAFIYA: patient créé", rPat.report.created === 1);
    const pat = (await pool.query("SELECT full_name, phone FROM laboratory_patients WHERE company_id=$1", [CO])).rows[0];
    test("HAFIYA: full_name = 'Awa Diallo'", pat.full_name === "Awa Diallo" && pat.phone === "70000000");
    const rPat2 = await executeEntity(pool, CO, 1, patProfile, [row(3, { first_name: "Awa", last_name: "D.", phone: "70000000" })], { strategy: "create_update" });
    const patCount = (await pool.query("SELECT COUNT(*)::int n FROM laboratory_patients WHERE company_id=$1", [CO])).rows[0].n;
    test("HAFIYA: même téléphone -> mise à jour, pas de doublon", rPat2.report.updated === 1 && patCount === 1);

    // HAFIYA catalogue analyses
    const anProfile = ic.registry.getProfile("hafiya.analyses_catalog");
    const rAn = await executeEntity(pool, CO, 1, anProfile, [row(2, { product_name: "Glycémie", unit_price: 2000 })], {});
    test("HAFIYA: analyse catalogue créée", rAn.report.created === 1);

    // ROLLBACK entité (produit sans dépendance -> supprimé)
    const job = (await pool.query(`INSERT INTO import_jobs (job_uid, company_id, product_code, module_key, import_type, status, created_by) VALUES ($1,$2,'triangle','produits','triangle.products','imported',1) RETURNING id`, ["ent-" + Date.now(), CO])).rows[0];
    const created = rP.rowResults.filter((r) => r.result_ref.created).map((r, i) => ({ row_index: 200 + i, result_ref: r.result_ref }));
    for (const rr of created) await pool.query(`INSERT INTO import_rows (job_id, company_id, row_index, raw, status, result_ref) VALUES ($1,$2,$3,'{}','imported',$4)`, [job.id, CO, rr.row_index, JSON.stringify(rr.result_ref)]);
    const rb = await rollbackEntity(pool, CO, 1, pProfile, job, created);
    const remaining = (await pool.query("SELECT COUNT(*)::int n FROM products WHERE company_id=$1", [CO])).rows[0].n;
    test("Rollback: produit créé supprimé (sans dépendance)", rb.detail.deleted === 1 && remaining === 0);
    await pool.query("DELETE FROM import_rows WHERE job_id=$1", [job.id]);
    await pool.query("DELETE FROM import_jobs WHERE id=$1", [job.id]);

    await clean();
    console.log(`\n✅ ${passed} tests import-entités (Triangle/MaliLink/HAFIYA) passés.`);
    await pool.end();
  } catch (e) {
    console.error("❌", e.message);
    await clean().catch(() => {});
    await pool.end();
    process.exit(1);
  }
})();
