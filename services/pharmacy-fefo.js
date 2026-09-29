"use strict";

function allocateFefo(batches, requestedQuantity, now = new Date()) {
  const requested = Number(requestedQuantity);
  if (!Number.isFinite(requested) || requested <= 0) {
    const error = new Error("INVALID_FEFO_QUANTITY");
    error.statusCode = 400;
    throw error;
  }
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const eligible = (Array.isArray(batches) ? batches : [])
    .filter((batch) => {
      const status = String(batch.status || "active").toLowerCase();
      if (!["active", "actif"].includes(status)) return false;
      if (batch.quarantine_reason) return false;
      const remaining = Number(batch.quantity_remaining || 0);
      const expiry = batch.expiration_date ? new Date(batch.expiration_date) : null;
      return remaining > 0 && expiry && !Number.isNaN(expiry.getTime()) && expiry >= today;
    })
    .sort((a, b) => new Date(a.expiration_date) - new Date(b.expiration_date));

  let remaining = requested;
  const allocations = [];
  for (const batch of eligible) {
    if (remaining <= 0) break;
    const quantity = Math.min(remaining, Number(batch.quantity_remaining));
    allocations.push({
      batch_id: batch.id,
      lot_number: batch.lot_number,
      expiration_date: batch.expiration_date,
      purchase_price: Number(batch.purchase_price || 0),
      quantity,
    });
    remaining -= quantity;
  }
  if (remaining > 0) {
    const error = new Error("INSUFFICIENT_FEFO_STOCK");
    error.statusCode = 409;
    error.available = requested - remaining;
    throw error;
  }
  return allocations;
}

module.exports = { allocateFefo };
