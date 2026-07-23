"use strict";

/**
 * Tests du moteur réservation/billet (finalisation Voyage). Client PG simulé.
 *   Lancer : npm test
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const booking = require("./travel-booking");

test("code de vérification : format MLK-TRV-XXXXXX, non ambigu", () => {
  const c = booking.newVerificationCode();
  assert.match(c, /^MLK-TRV-[0-9A-HJ-NP-TV-Z]{6}$/);
  // Pas de I/L/O/U ambigus dans la partie aléatoire.
  assert.ok(!/[ILOU]/.test(c.slice(8)));
  assert.notEqual(booking.newVerificationCode(), booking.newVerificationCode());
});

test("référence réservation : format MLV-<ts>-<hex>", () => {
  assert.match(booking.newBookingRef(), /^MLV-\d+-[0-9A-F]{6}$/);
});

test("quote : sous-total adultes+enfants + commission plateforme", async () => {
  const db = {
    async query(text) {
      if (/FROM travel_prices/i.test(text)) return { rows: [{ base_price: 6000, child_price: 3000, currency: "XOF" }] };
      if (/travel_settings/i.test(text)) return { rows: [{ value: "0.08" }] };
      return { rows: [] };
    },
  };
  const q = await booking.quote(db, { routeId: 1, adults: 2, children: 1 });
  assert.equal(q.subtotal, 15000);        // 6000*2 + 3000*1
  assert.equal(q.commission, 1200);       // 8%
  assert.equal(q.vendor_net, 13800);      // net transporteur
  assert.equal(q.currency, "XOF");
});

test("quote : aucun tarif → null", async () => {
  const db = { async query() { return { rows: [] }; } };
  assert.equal(await booking.quote(db, { routeId: 99 }), null);
});

test("verifyTicket : billet introuvable", async () => {
  const db = { async query() { return { rows: [] }; } };
  const r = await booking.verifyTicket(db, "MLK-TRV-XXXXXX");
  assert.equal(r.valid, false);
  assert.equal(r.result, "not_found");
});

test("verifyTicket : signature invalide → rejeté", async () => {
  const db = {
    async query() {
      return { rows: [{
        ticket_number: "MLV-TKT-AAA", verification_code: "MLK-TRV-ABC123",
        financial_operation_id: "FINOP-1", booking_id: 5, signature: "fausse-signature",
        payment_status: "paid", status: "issued", travel_date: null,
      }] };
    },
  };
  const r = await booking.verifyTicket(db, "MLK-TRV-ABC123");
  assert.equal(r.valid, false);
  assert.equal(r.result, "invalid_signature");
});
