"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { allocateFefo } = require("./pharmacy-fefo");

test("FEFO répartit la vente du lot le plus proche au plus éloigné", () => {
  const rows = allocateFefo([
    { id: 2, lot_number: "L2", expiration_date: "2028-01-01", quantity_remaining: 9, status: "active" },
    { id: 1, lot_number: "L1", expiration_date: "2027-01-01", quantity_remaining: 3, status: "active" },
  ], 7, new Date("2026-01-01"));
  assert.deepEqual(rows.map((r) => [r.batch_id, r.quantity]), [[1, 3], [2, 4]]);
});

test("FEFO exclut les produits périmés et en quarantaine", () => {
  const rows = allocateFefo([
    { id: 1, lot_number: "OLD", expiration_date: "2025-01-01", quantity_remaining: 10, status: "active" },
    { id: 2, lot_number: "Q", expiration_date: "2028-01-01", quantity_remaining: 10, status: "active", quarantine_reason: "retour" },
    { id: 3, lot_number: "OK", expiration_date: "2029-01-01", quantity_remaining: 10, status: "active" },
  ], 4, new Date("2026-01-01"));
  assert.deepEqual(rows.map((r) => r.batch_id), [3]);
});

test("FEFO refuse un stock vendable insuffisant", () => {
  assert.throws(() => allocateFefo([
    { id: 1, expiration_date: "2028-01-01", quantity_remaining: 2, status: "active" },
  ], 3, new Date("2026-01-01")), /INSUFFICIENT_FEFO_STOCK/);
});
