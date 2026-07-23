"use strict";

/**
 * Moteur de réservation / paiement / e-billet du module Voyage.
 *
 * Le paiement passe EXCLUSIVEMENT par le grand livre Wallet
 * (services/wallet-ledger) : débit voyageur → crédit transporteur (net) +
 * crédit plateforme (commission MaliLink). Le billet n'est émis qu'APRÈS
 * confirmation du paiement. QR signé (HMAC) + code alphanumérique de secours,
 * tous deux vérifiés côté serveur (jamais uniquement sur l'apparence du QR).
 *
 * Vente en ligne et vente au comptoir (POS) utilisent EXACTEMENT la même
 * structure de réservation et de billet — aucun système parallèle.
 */

const crypto = require("crypto");
const ledger = require("../wallet-ledger");
const accounts = require("../wallet-accounts");
const { signTicket } = require("./travel-service");

function newBookingRef() {
  return `MLV-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}
function newTicketNumber() {
  return `MLV-TKT-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
}
// Code alphanumérique de secours : non séquentiel, difficile à deviner.
// Format MLK-TRV-XXXXXX (Crockford base32, sans I/L/O/U ambigus).
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function newVerificationCode() {
  const bytes = crypto.randomBytes(6);
  let code = "";
  for (let i = 0; i < 6; i += 1) code += ALPHABET[bytes[i] % ALPHABET.length];
  return `MLK-TRV-${code}`;
}

/**
 * Devis d'une réservation à partir d'une ligne + horaire + passagers.
 * Lit les tarifs (travel_prices) et le taux de commission (travel_settings).
 */
async function quote(db, { routeId, scheduleId, seatClass = "standard", adults = 1, children = 0 }) {
  const priceRow = await db.query(
    `SELECT base_price, child_price, currency FROM travel_prices
      WHERE route_id=$1 AND (schedule_id IS NULL OR schedule_id=$2) AND seat_class=$3
      ORDER BY schedule_id NULLS LAST LIMIT 1`,
    [routeId, scheduleId || null, seatClass]
  );
  const p = priceRow.rows[0];
  if (!p) return null;
  const adult = Number(p.base_price);
  const child = p.child_price != null ? Number(p.child_price) : adult;
  const subtotal = Math.round((adult * Number(adults) + child * Number(children)) * 100) / 100;
  const rateRow = await db.query(`SELECT value FROM travel_settings WHERE key='commission_rate'`);
  const rate = Number(rateRow.rows[0]?.value || 0.08);
  const commission = Math.round(subtotal * rate * 100) / 100;
  return { subtotal, commission, total: subtotal, currency: p.currency || "XOF", vendor_net: Math.round((subtotal - commission) * 100) / 100 };
}

/** Crée une réservation (statut pending) + les passagers. */
async function createBooking(db, data) {
  const q = await quote(db, data);
  if (!q) throw new Error("Aucun tarif disponible pour ce trajet.");
  const reference = newBookingRef();
  const seats = Number(data.adults || 1) + Number(data.children || 0);
  const { rows } = await db.query(
    `INSERT INTO travel_bookings
       (reference, user_id, travel_company_id, route_id, schedule_id, travel_date,
        seat_class, seats_count, adults, children, subtotal, commission, total, currency,
        status, payment_status, channel, sold_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending','pending',$15,$16)
     RETURNING *`,
    [
      reference, data.userId || null, data.travelCompanyId, data.routeId, data.scheduleId || null,
      data.travelDate, data.seatClass || "standard", seats, Number(data.adults || 1),
      Number(data.children || 0), q.subtotal, q.commission, q.total, q.currency,
      data.channel || "online", data.soldBy || null,
    ]
  );
  const booking = rows[0];
  for (const p of data.passengers || []) {
    await db.query(
      `INSERT INTO travel_booking_passengers
         (booking_id, first_name, last_name, phone, email, id_document, seat_number, passenger_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [booking.id, p.first_name || "", p.last_name || "", p.phone || "", p.email || "",
       p.id_document || "", p.seat_number || "", p.passenger_type || "adult"]
    );
  }
  return booking;
}

/** Émet le billet e-ticket signé (QR + code) — appelé après paiement. */
async function issueTicket(db, booking, financialOperationId) {
  const passenger = (await db.query(
    `SELECT id, seat_number FROM travel_booking_passengers WHERE booking_id=$1 ORDER BY id LIMIT 1`, [booking.id]
  )).rows[0];
  const ticketNumber = newTicketNumber();
  const verificationCode = newVerificationCode();
  // Signature au niveau billet : liaison ticket ↔ code ↔ opération financière.
  const signature = signTicket([ticketNumber, verificationCode, financialOperationId || "", String(booking.id)]);
  // Le QR ne porte AUCUNE donnée personnelle : juste une référence signée.
  const qrPayload = `MLV|${ticketNumber}|${verificationCode}|${signature}`;
  const { rows } = await db.query(
    `INSERT INTO travel_tickets
       (booking_id, passenger_id, ticket_number, verification_code, qr_payload, barcode,
        seat_number, status, signature, financial_operation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'issued',$8,$9)
     RETURNING *`,
    [booking.id, passenger?.id || null, ticketNumber, verificationCode, qrPayload, verificationCode,
     passenger?.seat_number || "", signature, financialOperationId || null]
  );
  return rows[0];
}

/**
 * Paiement d'une réservation via le Wallet MaliLink (moteur unique).
 * Atomique : verrous FOR UPDATE, contrôle de solde, double-entrée équilibrée,
 * puis émission du billet. Idempotent par réservation.
 */
async function payWithWallet(pool, { reference, payerUserId }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const b = (await client.query(`SELECT * FROM travel_bookings WHERE reference=$1 FOR UPDATE`, [reference])).rows[0];
    if (!b) { await client.query("ROLLBACK"); return { error: "not_found" }; }
    if (b.payment_status === "paid") {
      const t = (await client.query(`SELECT * FROM travel_tickets WHERE booking_id=$1 ORDER BY id LIMIT 1`, [b.id])).rows[0];
      await client.query("COMMIT");
      return { booking: b, ticket: t, duplicate: true };
    }
    const total = Number(b.total);
    const commission = Number(b.commission);
    const vendorNet = Math.round((total - commission) * 100) / 100;

    const payer = await accounts.ensureWallet(client, { userId: payerUserId });
    const company = (await client.query(`SELECT company_id FROM travel_companies WHERE id=$1`, [b.travel_company_id])).rows[0];
    // Le transporteur est payé sur le wallet de son entreprise MaliLink si liée,
    // sinon sur le wallet plateforme (fonds à reverser manuellement).
    const platformId = await ledger.getPlatformWalletId(client);
    const vendorWallet = company?.company_id
      ? await accounts.ensureWallet(client, { companyId: company.company_id })
      : { id: platformId, company_id: null };

    const lockIds = [payer.id, vendorWallet.id, platformId].filter(Boolean).sort((a, x) => a - x);
    for (const id of lockIds) await client.query(`SELECT id FROM wallets WHERE id=$1 FOR UPDATE`, [id]);

    if (payer.status !== "active") { await client.query("ROLLBACK"); return { error: "wallet_blocked" }; }
    const bal = await accounts.available(client, payer.id);
    if (bal.available < total) { await client.query("ROLLBACK"); return { error: "insufficient", available: bal.available }; }

    const legs = [{ walletId: payer.id, direction: "debit", amount: total, companyId: payer.company_id }];
    if (commission > 0 && platformId && vendorWallet.id !== platformId) {
      legs.push({ walletId: vendorWallet.id, direction: "credit", amount: vendorNet, companyId: vendorWallet.company_id });
      legs.push({ walletId: platformId, direction: "credit", amount: commission, companyId: null });
    } else {
      legs.push({ walletId: vendorWallet.id, direction: "credit", amount: total, companyId: vendorWallet.company_id });
    }

    const result = await ledger.postLedgerTransaction(client, {
      kind: "payment", description: `Voyage ${b.reference}`, relatedModule: "travel",
      relatedId: b.id, initiatedBy: payerUserId, idempotencyKey: `travel-pay-${b.id}`, commission, legs,
    });

    await client.query(
      `UPDATE travel_bookings SET status='confirmed', payment_status='paid', payment_method='wallet',
         financial_operation_id=$1, paid_at=NOW(), updated_at=NOW() WHERE id=$2`,
      [result.financial_operation_id, b.id]
    );
    const paidBooking = { ...b, status: "confirmed", payment_status: "paid", financial_operation_id: result.financial_operation_id };
    const ticket = await issueTicket(client, paidBooking, result.financial_operation_id);
    await client.query("COMMIT");
    return { booking: paidBooking, ticket, reference: result.reference, financial_operation_id: result.financial_operation_id };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    if (String(e.message || "").includes("idempotency")) return { error: "duplicate" };
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Vérifie un billet par son code (ou ticket_number) — TOUJOURS côté serveur.
 * Renvoie un statut clair : valid | already_used | cancelled | refunded |
 * expired | payment_unconfirmed | not_found | invalid_signature.
 */
async function verifyTicket(db, codeOrNumber) {
  const code = String(codeOrNumber || "").trim().toUpperCase();
  const { rows } = await db.query(
    `SELECT t.*, b.reference AS booking_ref, b.travel_date, b.payment_status, b.status AS booking_status,
            b.seat_class, c.name AS company_name,
            ol.name AS origin, dl.name AS destination
       FROM travel_tickets t
       JOIN travel_bookings b ON b.id=t.booking_id
       LEFT JOIN travel_companies c ON c.id=b.travel_company_id
       LEFT JOIN travel_routes r ON r.id=b.route_id
       LEFT JOIN geo_locations ol ON ol.id=r.origin_location_id
       LEFT JOIN geo_locations dl ON dl.id=r.destination_location_id
      WHERE t.verification_code=$1 OR t.ticket_number=$1`,
    [code]
  );
  const t = rows[0];
  if (!t) return { valid: false, result: "not_found" };
  const expected = signTicket([t.ticket_number, t.verification_code, t.financial_operation_id || "", String(t.booking_id)]);
  if (t.signature !== expected) return { valid: false, result: "invalid_signature" };

  const detail = {
    ticket_number: t.ticket_number, booking_ref: t.booking_ref, company: t.company_name,
    origin: t.origin, destination: t.destination, travel_date: t.travel_date,
    seat_class: t.seat_class, seat_number: t.seat_number,
  };
  if (t.payment_status !== "paid") return { valid: false, result: "payment_unconfirmed", ...detail };
  if (t.status === "cancelled") return { valid: false, result: "cancelled", ...detail };
  if (t.status === "refunded") return { valid: false, result: "refunded", ...detail };
  if (t.status === "used") return { valid: false, result: "already_used", used_at: t.used_at, ...detail };
  if (t.travel_date && new Date(t.travel_date) < new Date(new Date().toDateString())) {
    return { valid: false, result: "expired", ...detail };
  }
  return { valid: true, result: "valid", ticket_id: t.id, ...detail };
}

/** Contrôle à l'embarquement : marque « utilisé » + journal (anti double-scan). */
async function scanTicket(db, { codeOrNumber, scannedBy, agencyId = null, device = "" }) {
  const check = await verifyTicket(db, codeOrNumber);
  if (!check.valid) {
    await db.query(
      `INSERT INTO travel_scans (ticket_id, scanned_by, agency_id, result, device)
       SELECT id, $2, $3, $4, $5 FROM travel_tickets WHERE verification_code=$1 OR ticket_number=$1`,
      [String(codeOrNumber).toUpperCase(), scannedBy || null, agencyId, check.result, device]
    ).catch(() => {});
    return check;
  }
  await db.query(
    `UPDATE travel_tickets SET status='used', used_at=NOW(), used_by=$2 WHERE id=$1`,
    [check.ticket_id, scannedBy || null]
  );
  await db.query(
    `INSERT INTO travel_scans (ticket_id, scanned_by, agency_id, result, status_set, device)
     VALUES ($1,$2,$3,'valid','embarque',$4)`,
    [check.ticket_id, scannedBy || null, agencyId, device]
  );
  return { ...check, result: "boarded", boarded: true };
}

/** Statistiques réelles d'une compagnie (zéros si aucune donnée). */
async function partnerStats(db, companyId) {
  const q = async (sql, params = [companyId]) => Number((await db.query(sql, params)).rows[0]?.n || 0);
  const [vehicles, routes, schedules, seatsTotal] = await Promise.all([
    q(`SELECT COUNT(*) n FROM travel_vehicles WHERE travel_company_id=$1`),
    q(`SELECT COUNT(*) n FROM travel_routes WHERE travel_company_id=$1`),
    q(`SELECT COUNT(*) n FROM travel_schedules s JOIN travel_routes r ON r.id=s.route_id WHERE r.travel_company_id=$1`),
    q(`SELECT COALESCE(SUM(s.seats_total),0) n FROM travel_schedules s JOIN travel_routes r ON r.id=s.route_id WHERE r.travel_company_id=$1`),
  ]);
  const bk = (await db.query(
    `SELECT
        COUNT(*) FILTER (WHERE payment_status='paid') AS paid,
        COUNT(*) FILTER (WHERE payment_status='pending') AS pending,
        COUNT(*) FILTER (WHERE status='cancelled') AS cancelled,
        COALESCE(SUM(seats_count) FILTER (WHERE payment_status='paid'),0) AS seats_sold,
        COALESCE(SUM(total) FILTER (WHERE payment_status='paid'),0) AS revenue,
        COALESCE(SUM(commission) FILTER (WHERE payment_status='paid'),0) AS commission
       FROM travel_bookings WHERE travel_company_id=$1`, [companyId]
  )).rows[0];
  const revenue = Number(bk.revenue);
  const commission = Number(bk.commission);
  const seatsSold = Number(bk.seats_sold);
  const topRoutes = (await db.query(
    `SELECT ol.name AS origin, dl.name AS destination, COUNT(*)::int AS sales
       FROM travel_bookings b JOIN travel_routes r ON r.id=b.route_id
       JOIN geo_locations ol ON ol.id=r.origin_location_id
       JOIN geo_locations dl ON dl.id=r.destination_location_id
      WHERE b.travel_company_id=$1 AND b.payment_status='paid'
      GROUP BY ol.name, dl.name ORDER BY sales DESC LIMIT 5`, [companyId]
  )).rows;
  return {
    vehicles, routes, schedules, seats_total: seatsTotal,
    bookings_paid: Number(bk.paid), bookings_pending: Number(bk.pending), bookings_cancelled: Number(bk.cancelled),
    seats_sold: seatsSold, revenue, commission, vendor_net: Math.round((revenue - commission) * 100) / 100,
    fill_rate: seatsTotal > 0 ? Math.round((seatsSold / seatsTotal) * 1000) / 10 : 0,
    top_routes: topRoutes,
  };
}

module.exports = {
  quote, createBooking, issueTicket, payWithWallet, verifyTicket, scanTicket, partnerStats,
  newVerificationCode, newBookingRef,
};
