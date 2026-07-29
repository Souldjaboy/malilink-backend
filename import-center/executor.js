"use strict";

/**
 * Exécution TRANSACTIONNELLE. Réutilise le système officiel : chaque ligne de
 * stock crée un mouvement traçable dans stock_movements + met à jour
 * products.stock. Aucune addition SQL « isolée » non tracée.
 * Enregistre les ids créés/modifiés dans import_rows.result_ref (rollback).
 */
const crypto = require("crypto");
const { simulateStock, resolveProduct, movementDelta } = require("./simulator");

function genRef(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`.toUpperCase();
}

async function ensureProduct(client, companyId, userId, m) {
  const existing = await resolveProduct(client, companyId, m);
  if (existing) return { id: existing.id, reference: existing.reference, name: existing.name, created: false };
  const reference = (m.product_code && String(m.product_code).trim()) || genRef("PRD");
  const { rows } = await client.query(
    `INSERT INTO products (company_id, name, reference, sku, barcode, sale_price, purchase_price, stock, is_active, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$6,0,true,NOW(),NOW()) RETURNING id, reference, name`,
    [companyId, String(m.product_name).trim(), reference, m.product_code || null, m.barcode || null, Number(m.unit_price) || 0]
  );
  return { id: rows[0].id, reference: rows[0].reference, name: rows[0].name, created: true };
}

/**
 * Exécute un import de stock dans UNE transaction.
 * @param validatedRows lignes validées (statut new/warning) avec mapped.
 * @returns { report, rowResults } — rowResults: [{__row, status, result_ref}]
 */
async function executeStock(pool, companyId, userId, profile, validatedRows, options = {}) {
  const client = await pool.connect();
  const rowResults = [];
  const report = { imported: 0, createdProducts: 0, movements: 0, failed: 0 };
  try {
    await client.query("BEGIN");
    // Re-simule dans la transaction pour cohérence (stock à jour).
    const sim = await simulateStock(client, companyId, profile, validatedRows, options);
    const decisionByRow = new Map(sim.rows.map((d) => [d.__row, d]));

    for (const r of validatedRows) {
      if (["invalid", "duplicate", "skipped"].includes(r.status)) { rowResults.push({ __row: r.__row, status: "skipped", result_ref: {} }); continue; }
      const d = decisionByRow.get(r.__row);
      if (!d || d.blocked) { rowResults.push({ __row: r.__row, status: "failed", result_ref: {}, messages: d ? d.messages : [] }); report.failed++; continue; }
      const m = r.mapped;
      const prod = await ensureProduct(client, companyId, userId, m);
      if (prod.created) report.createdProducts++;

      const qty = Math.abs(Number(m.quantity) || 0);
      const delta = movementDelta(d.movementType, qty);
      const mv = await client.query(
        `INSERT INTO stock_movements
           (type, product_reference, product_name, quantity, reason, status, company_id, created_by, product_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,'validated',$6,$7,$8,NOW(),NOW()) RETURNING id`,
        [d.movementType, prod.reference, prod.name, qty, m.description || `Import ${profile.key}`, companyId, userId, prod.id]
      );
      await client.query(`UPDATE products SET stock = COALESCE(stock,0) + $1, updated_at=NOW() WHERE id=$2 AND company_id=$3`, [delta, prod.id, companyId]);

      report.movements++; report.imported++;
      rowResults.push({
        __row: r.__row, status: "imported",
        result_ref: { movement_id: mv.rows[0].id, product_id: prod.id, created_product: prod.created, delta },
      });
    }

    await client.query("COMMIT");
    return { report, rowResults };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { executeStock, ensureProduct };
