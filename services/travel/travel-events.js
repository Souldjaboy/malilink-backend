"use strict";

/**
 * Événements du domaine Travel — noms stables pour notifications & webhooks.
 * Réutilisés par le moteur Webhooks (services/wallet-webhooks.js) au Lot 4B.
 */
module.exports = {
  BOOKING_CREATED: "travel.booking.created",
  BOOKING_CONFIRMED: "travel.booking.confirmed",
  BOOKING_CANCELLED: "travel.booking.cancelled",
  TICKET_ISSUED: "travel.ticket.issued",
  TICKET_SCANNED: "travel.ticket.scanned",
  PAYMENT_COMPLETED: "travel.payment.completed",
  REFUND_PROCESSED: "travel.refund.processed"
};
