"use strict";

/**
 * Tests unitaires du Travel Service (Lot 4A) : tarification, promotions,
 * répartition commission, comparateur, signature de billet, et recherche
 * via un repository SIMULÉ. Aucune base réelle.
 *
 *   Lancer : npm test
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createTravelService, signTicket, applyDiscount, priceOffer, splitCommission, comparator
} = require("./travel-service");

/* ───────────────────────── Tarification ───────────────────────── */

test("priceOffer : adultes + enfants, sans promotion", () => {
  const r = priceOffer({ basePrice: 5000, childPrice: 2500, adults: 2, children: 1 });
  assert.equal(r.subtotal, 12500); // 5000*2 + 2500*1
  assert.equal(r.discount, 0);
  assert.equal(r.total, 12500);
});

test("priceOffer : prix enfant absent → tarif adulte appliqué", () => {
  const r = priceOffer({ basePrice: 4000, childPrice: null, adults: 1, children: 1 });
  assert.equal(r.subtotal, 8000);
});

test("applyDiscount : pourcentage", () => {
  const { discount, net } = applyDiscount(10000, { discount_type: "percent", discount_value: 10 });
  assert.equal(discount, 1000);
  assert.equal(net, 9000);
});

test("applyDiscount : montant fixe plafonné au sous-total", () => {
  const { discount, net } = applyDiscount(3000, { discount_type: "amount", discount_value: 5000 });
  assert.equal(discount, 3000); // ne descend jamais sous 0
  assert.equal(net, 0);
});

test("priceOffer : avec promotion pourcentage", () => {
  const r = priceOffer({ basePrice: 10000, adults: 1, children: 0 }, { discount_type: "percent", discount_value: 20 });
  assert.equal(r.subtotal, 10000);
  assert.equal(r.discount, 2000);
  assert.equal(r.total, 8000);
});

/* ───────────────────────── Commission ───────────────────────── */

test("splitCommission : 8% → part partenaire nette + commission MaliLink", () => {
  const s = splitCommission(10000, 0.08);
  assert.equal(s.commission, 800);
  assert.equal(s.partner_net, 9200);
  assert.equal(s.commission + s.partner_net, 10000); // conservation
});

/* ───────────────────────── Comparateur ───────────────────────── */

test("comparator : identifie le moins cher, le plus rapide, le mieux noté", () => {
  const offers = [
    { offer_id: "A", total: 9000, duration_minutes: 300, rating: 4.5 },
    { offer_id: "B", total: 7000, duration_minutes: 360, rating: 3.8 },
    { offer_id: "C", total: 8000, duration_minutes: 240, rating: 4.9 }
  ];
  const c = comparator(offers);
  assert.equal(c.cheapest, "B");   // 7000
  assert.equal(c.fastest, "C");    // 240 min
  assert.equal(c.best_rated, "C"); // 4.9
});

test("comparator : liste vide → nuls sans erreur", () => {
  assert.deepEqual(comparator([]), { cheapest: null, fastest: null, best_rated: null });
});

/* ───────────────────────── Signature billet ───────────────────────── */

test("signTicket : déterministe et sensible au contenu", () => {
  const a = signTicket(["MLV-TKT-1", "FINOP-1", "2026-07-21"]);
  const b = signTicket(["MLV-TKT-1", "FINOP-1", "2026-07-21"]);
  const c = signTicket(["MLV-TKT-1", "FINOP-1", "2026-07-22"]);
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{24}$/);
});

/* ───────────────────────── Recherche (repo simulé) ───────────────────────── */

function mockRepo(offers, promos = []) {
  return {
    async searchOffers() { return offers; },
    async activePromotions() { return promos; },
    async getSetting(_k, d) { return d; },
    async listModes() { return []; },
    async searchCities() { return []; },
    async listCompanies() { return []; }
  };
}

test("service.search : mappe les offres, applique promo et calcule le total", async () => {
  const svc = createTravelService(mockRepo(
    [{
      route_id: 1, schedule_id: 10, mode_code: "bus", company_id: 5, company_name: "Sonef",
      logo_url: "", rating: 4.2, rating_count: 30, origin_city: "Bamako", destination_city: "Sikasso",
      departure_time: "08:00", arrival_time: "12:00", duration_minutes: 240, seats_total: 50,
      seat_class: "standard", services: [], base_price: 6000, child_price: 3000, currency: "XOF", baggage_included_kg: 20
    }],
    [{ route_id: 1, discount_type: "percent", discount_value: 10 }]
  ));
  const r = await svc.search({ originCityId: 1, destinationCityId: 2, date: "2026-07-21", adults: 2, children: 0 });
  assert.equal(r.count, 1);
  assert.equal(r.offers[0].subtotal, 12000);       // 6000 * 2
  assert.equal(r.offers[0].discount, 1200);        // 10%
  assert.equal(r.offers[0].total, 10800);
  assert.equal(r.offers[0].company.name, "Sonef");
  assert.equal(r.comparator.cheapest, r.offers[0].offer_id);
});

test("service.search : aucune offre → count 0, comparateur nul", async () => {
  const svc = createTravelService(mockRepo([]));
  const r = await svc.search({ originCityId: 1, destinationCityId: 9, date: "2026-07-21" });
  assert.equal(r.count, 0);
  assert.equal(r.comparator.cheapest, null);
});
