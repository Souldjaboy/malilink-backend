"use strict";

/**
 * Travel Service — règles métier du module Voyage (aucun SQL direct : passe
 * par le repository). Pur et testable : les fonctions de calcul (tarif,
 * promotion, commission, comparateur, signature de billet) sont exportées
 * séparément pour les tests unitaires.
 *
 * Principe non négociable : MaliLink est un AGRÉGATEUR. Au Lot 4B, tout
 * paiement passera par le moteur Wallet (services/wallet-ledger.js) — ce
 * service ne fait que PRÉPARER les montants (sous-total, remise, commission,
 * total) ; il ne touche jamais un solde.
 */

const crypto = require("crypto");

/* Signature de billet — même mécanique HMAC que les reçus Wallet, mais
   secret INDÉPENDANT (Phase 0 : ne jamais réutiliser un autre secret). */
const TICKET_SECRET =
  process.env.TRAVEL_TICKET_SECRET ||
  (process.env.NODE_ENV === "production"
    ? (() => { throw new Error("TRAVEL_TICKET_SECRET requis en production."); })()
    : "malilink_travel_tickets_dev_only");

function signTicket(fields) {
  return crypto.createHmac("sha256", TICKET_SECRET).update(fields.join("|")).digest("hex").slice(0, 24);
}

/** Applique une promotion (percent|amount) à un montant. Jamais négatif. */
function applyDiscount(amount, promo) {
  if (!promo) return { discount: 0, net: amount };
  const value = Number(promo.discount_value || 0);
  const discount = promo.discount_type === "percent"
    ? Math.round((amount * value) / 100 * 100) / 100
    : Math.min(value, amount);
  const net = Math.max(0, Math.round((amount - discount) * 100) / 100);
  return { discount: Math.round((amount - net) * 100) / 100, net };
}

/**
 * Calcule le tarif d'une offre pour un nombre de voyageurs.
 * @returns { subtotal, discount, total, unit }
 */
function priceOffer({ basePrice, childPrice, adults = 1, children = 0 }, promo) {
  const adult = Number(basePrice || 0);
  const child = childPrice != null ? Number(childPrice) : adult;
  const subtotal = Math.round((adult * adults + child * children) * 100) / 100;
  const { discount, net } = applyDiscount(subtotal, promo);
  return { subtotal, discount, total: net, unit: adult };
}

/**
 * Répartition financière d'une réservation (préparée pour le Lot 4B).
 * @param total montant payé par le client
 * @param commissionRate ex 0.08
 * @returns { total, commission, partner_net }
 */
function splitCommission(total, commissionRate) {
  const commission = Math.round(total * Number(commissionRate) * 100) / 100;
  const partnerNet = Math.round((total - commission) * 100) / 100;
  return { total, commission, partner_net: partnerNet };
}

/** Indicateurs de comparaison, normalisés pour l'UI comparateur. */
function comparator(offers) {
  if (!offers.length) return { cheapest: null, fastest: null, best_rated: null };
  const byPrice = [...offers].sort((a, b) => a.total - b.total);
  const byTime = [...offers].sort((a, b) => (a.duration_minutes || 1e9) - (b.duration_minutes || 1e9));
  const byRating = [...offers].sort((a, b) => Number(b.rating) - Number(a.rating));
  return {
    cheapest: byPrice[0]?.offer_id ?? null,
    fastest: byTime[0]?.offer_id ?? null,
    best_rated: byRating[0]?.offer_id ?? null
  };
}

function createTravelService(repo) {
  return {
    signTicket,
    // Exposé pour tests / réutilisation.
    _calc: { applyDiscount, priceOffer, splitCommission, comparator },

    async modes() { return repo.listModes(); },
    async cities(term) { return repo.searchCities(term); },
    async companies() { return repo.listCompanies(); },

    /**
     * Recherche d'offres : trouve les trajets, applique promotions et tarif.
     * @param q { originCityId, destinationCityId, date, adults, children, modeCode }
     */
    async search(q) {
      const date = q.date ? new Date(q.date) : new Date();
      const dayOfWeek = Number.isNaN(date.getTime()) ? null : date.getUTCDay(); // 0=dim
      const raw = await repo.searchOffers({
        originLocationId: Number(q.originLocationId),
        destinationLocationId: Number(q.destinationLocationId),
        dayOfWeek,
        modeCode: q.modeCode || null
      });
      const promos = await repo.activePromotions([...new Set(raw.map((r) => r.route_id))]);
      const promoByRoute = new Map(promos.map((p) => [p.route_id, p]));

      const offers = raw.map((r, i) => {
        const promo = promoByRoute.get(r.route_id) || null;
        const pricing = priceOffer(
          { basePrice: r.base_price, childPrice: r.child_price, adults: Number(q.adults || 1), children: Number(q.children || 0) },
          promo
        );
        return {
          offer_id: `${r.route_id}:${r.schedule_id}:${r.seat_class || "standard"}`,
          route_id: r.route_id,
          schedule_id: r.schedule_id,
          mode_code: r.mode_code,
          company: { id: r.company_id, name: r.company_name, logo_url: r.logo_url, rating: Number(r.rating), rating_count: r.rating_count },
          origin_city: r.origin_city,
          destination_city: r.destination_city,
          departure_time: r.departure_time,
          arrival_time: r.arrival_time,
          duration_minutes: r.duration_minutes,
          seats_total: r.seats_total,
          seat_class: r.seat_class || "standard",
          services: r.services || [],
          baggage_included_kg: r.baggage_included_kg,
          currency: r.currency || "XOF",
          promo: promo ? { type: promo.discount_type, value: Number(promo.discount_value) } : null,
          subtotal: pricing.subtotal,
          discount: pricing.discount,
          total: pricing.total
        };
      });
      return { count: offers.length, comparator: comparator(offers), offers };
    },

    async commissionRate() {
      return Number(await repo.getSetting("commission_rate", "0.08"));
    }
  };
}

module.exports = { createTravelService, signTicket, applyDiscount, priceOffer, splitCommission, comparator };
