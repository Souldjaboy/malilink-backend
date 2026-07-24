"use strict";

/**
 * MaliLink Voyage (Travel) — contrôleur REST. Lot 4A : référentiels,
 * recherche publique, espace partenaire (compagnies, agences, véhicules,
 * lignes, horaires, prix). Réservation/paiement/billet = Lot 4B.
 *
 * Réutilise l'authentification et le périmètre entreprise du monolithe ;
 * aucune logique financière ici (le moteur Wallet reste unique).
 */

const express = require("express");
const { createTravelRepository } = require("../services/travel/travel-repository");
const { createTravelService } = require("../services/travel/travel-service");
const catalog = require("../services/catalog");
const geo = require("../services/geo/geo-service");
const booking = require("./../services/travel/travel-booking");

module.exports = function createTravelRouter({ pool, authenticateToken, isSuperAdminUser, getEffectiveCompanyId, phoneVariants }) {
  const phoneVar = phoneVariants || ((p) => [String(p || "")]);
  const router = express.Router();
  const repo = createTravelRepository(pool);
  const service = createTravelService(repo);

  // Garde : module actif ?
  async function ensureEnabled(res) {
    if (!(await repo.getFlag("travel_enabled"))) {
      res.status(503).json({ error: "Le module Voyage est temporairement indisponible." });
      return false;
    }
    return true;
  }

  /* ═══════════════ Endpoints PUBLICS (avant authentification) ═══════════════ */

  router.get("/health", async (req, res) => {
    res.json({ module: "MaliLink Voyage", status: "ok", lot: "4A" });
  });

  router.get("/modes", async (req, res) => {
    if (!(await ensureEnabled(res))) return;
    res.json({ modes: await repo.listModes() });
  });

  router.get("/cities", async (req, res) => {
    if (!(await ensureEnabled(res))) return;
    res.json({ cities: await service.cities(String(req.query.q || "").slice(0, 40)) });
  });

  // Autocomplétion MONDIALE (référentiel local + géocodage Nominatim en repli).
  // Public : le client et le partenaire l'utilisent tous les deux.
  router.get("/geo/search", async (req, res) => {
    if (!(await ensureEnabled(res))) return;
    try {
      const q = String(req.query.q || "").slice(0, 80);
      if (q.trim().length < 2) return res.json({ results: [] });
      res.json({ results: await geo.searchPlaces(pool, q) });
    } catch (e) {
      console.error("ERREUR TRAVEL GEO SEARCH :", e.message);
      res.status(500).json({ error: "Erreur recherche de lieux." });
    }
  });

  router.get("/cities/:cityId/points", async (req, res) => {
    if (!(await ensureEnabled(res))) return;
    res.json({ points: await repo.listPoints(Number(req.params.cityId)) });
  });

  router.get("/companies", async (req, res) => {
    if (!(await ensureEnabled(res))) return;
    res.json({ companies: await service.companies() });
  });

  // Recherche d'offres — cœur de l'agrégateur.
  router.get("/search", async (req, res) => {
    if (!(await ensureEnabled(res))) return;
    if (!(await repo.getFlag("travel_search_enabled"))) {
      return res.status(503).json({ error: "La recherche est temporairement désactivée." });
    }
    const originLocationId = Number(req.query.origin);
    const destinationLocationId = Number(req.query.destination);
    if (!originLocationId || !destinationLocationId) {
      return res.status(400).json({ error: "Lieu de départ et destination obligatoires." });
    }
    if (originLocationId === destinationLocationId) {
      return res.status(400).json({ error: "Le départ et la destination doivent différer." });
    }
    try {
      const result = await service.search({
        originLocationId,
        destinationLocationId,
        date: req.query.date,
        adults: Number(req.query.adults || 1),
        children: Number(req.query.children || 0),
        modeCode: req.query.mode ? String(req.query.mode) : null
      });
      res.json(result);
    } catch (e) {
      console.error("ERREUR TRAVEL SEARCH :", e.message);
      res.status(500).json({ error: "Erreur lors de la recherche." });
    }
  });

  // Détail PUBLIC d'une offre du catalogue (page de réservation Marketplace).
  // Renvoie l'offre + la ligne + les départs (horaires/tarifs/places) +
  // coordonnées géo pour la carte. Réutilise catalog_offers → travel_routes.
  router.get("/offer/:catalogId", async (req, res) => {
    if (!(await ensureEnabled(res))) return;
    try {
      const offerRow = await pool.query(
        `SELECT * FROM catalog_offers WHERE id=$1 AND status='published' AND related_module='travel'`,
        [Number(req.params.catalogId)]
      );
      const offer = offerRow.rows[0];
      if (!offer) return res.status(404).json({ error: "Offre introuvable ou non publiée." });
      const routeId = offer.related_id;

      const routeRow = await pool.query(
        `SELECT r.id, r.mode_code, r.duration_minutes, r.distance_km, r.services,
                r.baggage_policy, r.cancellation_policy, r.description, r.currency,
                c.name AS company_name, c.logo_url, c.phone AS company_phone, c.rating, c.rating_count,
                ol.name AS origin, ol.latitude AS origin_lat, ol.longitude AS origin_lng, ol.country_name AS origin_country,
                dl.name AS destination, dl.latitude AS dest_lat, dl.longitude AS dest_lng, dl.country_name AS dest_country
           FROM travel_routes r
           JOIN travel_companies c ON c.id=r.travel_company_id
           JOIN geo_locations ol ON ol.id=r.origin_location_id
           JOIN geo_locations dl ON dl.id=r.destination_location_id
          WHERE r.id=$1`, [routeId]
      );
      const route = routeRow.rows[0];
      if (!route) return res.status(404).json({ error: "Ligne introuvable." });

      const departures = (await pool.query(
        `SELECT s.id AS schedule_id, s.departure_time, s.arrival_time, s.days_of_week, s.seats_total, s.status,
                (SELECT MIN(base_price) FROM travel_prices p WHERE p.route_id=r.id AND (p.schedule_id IS NULL OR p.schedule_id=s.id)) AS base_price,
                (SELECT MIN(child_price) FROM travel_prices p WHERE p.route_id=r.id AND (p.schedule_id IS NULL OR p.schedule_id=s.id)) AS child_price,
                (COALESCE(s.seats_total,0) - COALESCE((SELECT SUM(seats_count) FROM travel_bookings b WHERE b.schedule_id=s.id AND b.payment_status='paid'),0)) AS seats_available
           FROM travel_schedules s JOIN travel_routes r ON r.id=s.route_id
          WHERE s.route_id=$1 AND s.status='active' ORDER BY s.departure_time`, [routeId]
      )).rows;

      res.json({ offer, route, departures });
    } catch (e) {
      console.error("ERREUR TRAVEL OFFER DETAIL :", e.message);
      res.status(500).json({ error: "Erreur chargement de l'offre." });
    }
  });

  // Vérification PUBLIQUE d'un billet (scan QR / saisie du code) — AVANT auth.
  // Toujours interrogée côté serveur : ne jamais se fier à l'apparence du QR.
  router.get("/public/verify-ticket/:code", async (req, res) => {
    try {
      res.json(await booking.verifyTicket(pool, req.params.code));
    } catch (e) {
      res.status(500).json({ valid: false, result: "error" });
    }
  });

  /* ═══════════════ Espace PARTENAIRE (authentifié) ═══════════════ */
  router.use(authenticateToken);

  // Résout la compagnie de transport du partenaire courant.
  // super_admin : peut cibler explicitement via ?travel_company_id /
  // body.travel_company_id ; à défaut, on retombe sur le périmètre entreprise
  // puis sur la compagnie qu'il a lui-même créée (repli commun ci-dessous).
  async function resolveCompany(req) {
    if (isSuperAdminUser(req.user)) {
      const id = Number(req.body?.travel_company_id || req.query.travel_company_id);
      if (id) return repo.getCompany(id);
    }
    const companyId = getEffectiveCompanyId ? getEffectiveCompanyId(req) : null;
    if (companyId) {
      const byCompany = await repo.getCompanyByCompanyId(companyId);
      if (byCompany) return byCompany;
    }
    // Repli : compagnie créée par l'utilisateur.
    const { rows } = await pool.query(
      `SELECT * FROM travel_companies WHERE created_by=$1 ORDER BY id LIMIT 1`, [req.user.id]
    );
    return rows[0] || null;
  }

  // Enregistrer une compagnie de transport (devenir partenaire).
  router.post("/partner/company", async (req, res) => {
    if (!(await ensureEnabled(res))) return;
    const name = String(req.body?.name || "").trim();
    if (!name) return res.status(400).json({ error: "Nom de la compagnie obligatoire." });
    try {
      const companyId = getEffectiveCompanyId ? getEffectiveCompanyId(req) : null;
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") + "-" + Date.now().toString(36);
      const created = await repo.createCompany({
        companyId, name, slug,
        logoUrl: req.body?.logo_url, description: req.body?.description,
        phone: req.body?.phone, email: req.body?.email, createdBy: req.user.id
      });
      await repo.log("company", created.id, "created", req.user.id, name);
      res.status(201).json({ success: true, company: created });
    } catch (e) {
      console.error("ERREUR TRAVEL COMPANY :", e.message);
      res.status(500).json({ error: "Erreur création de la compagnie." });
    }
  });

  router.get("/partner/company", async (req, res) => {
    const c = await resolveCompany(req);
    if (!c) return res.status(404).json({ error: "Aucune compagnie de transport associée." });
    res.json({ company: c });
  });

  // Fabrique un handler CRUD « create + list » scopé à la compagnie du partenaire.
  function partnerResource(createFn, listFn, label) {
    return {
      create: async (req, res) => {
        if (!(await ensureEnabled(res))) return;
        const c = await resolveCompany(req);
        if (!c) return res.status(403).json({ error: "Devenez d'abord partenaire (créez votre compagnie)." });
        try {
          const created = await createFn(c.id, req);
          await repo.log(label, created.id, "created", req.user.id, "");
          res.status(201).json({ success: true, [label]: created });
        } catch (e) {
          console.error(`ERREUR TRAVEL ${label.toUpperCase()} :`, e.message);
          res.status(500).json({ error: `Erreur création ${label}.` });
        }
      },
      list: async (req, res) => {
        const c = await resolveCompany(req);
        if (!c) return res.json({ [label + "s"]: [] });
        res.json({ [label + "s"]: await listFn(c.id) });
      }
    };
  }

  const agencies = partnerResource(
    (companyId, req) => repo.createAgency(companyId, {
      cityId: req.body?.city_id, pointId: req.body?.point_id,
      name: req.body?.name, address: req.body?.address, phone: req.body?.phone
    }),
    (companyId) => repo.listAgencies(companyId),
    "agency"
  );
  router.post("/partner/agencies", agencies.create);
  router.get("/partner/agencies", agencies.list);

  const vehicles = partnerResource(
    (companyId, req) => repo.createVehicle(companyId, {
      name: req.body?.name, registration: req.body?.registration, modeCode: req.body?.mode_code,
      capacity: req.body?.capacity, photos: req.body?.photos,
      hasAc: req.body?.has_ac, hasWifi: req.body?.has_wifi, hasUsb: req.body?.has_usb,
      hasTv: req.body?.has_tv, hasToilet: req.body?.has_toilet, state: req.body?.state
    }),
    (companyId) => repo.listVehicles(companyId),
    "vehicle"
  );
  router.post("/partner/vehicles", vehicles.create);
  router.get("/partner/vehicles", vehicles.list);

  // Persister un lieu choisi (référentiel mondial) avant de créer une ligne.
  router.post("/geo/locations", async (req, res) => {
    try {
      const location = await geo.persistPlace(pool, {
        name: req.body?.name,
        country_code: req.body?.country_code,
        country_name: req.body?.country_name,
        region: req.body?.region,
        city: req.body?.city,
        latitude: req.body?.latitude,
        longitude: req.body?.longitude,
        location_type: req.body?.location_type,
        external_provider: req.body?.external_provider,
        external_place_id: req.body?.external_place_id,
      }, req.user.id);
      res.status(201).json({ success: true, location });
    } catch (e) {
      console.error("ERREUR TRAVEL GEO PERSIST :", e.message);
      res.status(400).json({ error: e.message || "Erreur enregistrement du lieu." });
    }
  });

  // Création d'une ligne — lieux issus du référentiel mondial geo_locations.
  // Distance/durée calculées automatiquement (corrigeables par le partenaire).
  router.post("/partner/routes", async (req, res) => {
    if (!(await ensureEnabled(res))) return;
    const c = await resolveCompany(req);
    if (!c) return res.status(403).json({ error: "Devenez d'abord partenaire (créez votre compagnie)." });
    const originLocationId = Number(req.body?.origin_location_id);
    const destinationLocationId = Number(req.body?.destination_location_id);
    if (!originLocationId || !destinationLocationId) {
      return res.status(400).json({ error: "Sélectionnez un lieu de départ et une destination." });
    }
    if (originLocationId === destinationLocationId) {
      return res.status(400).json({ error: "Le départ et la destination doivent être différents." });
    }
    try {
      const [origin, destination] = await Promise.all([geo.getById(pool, originLocationId), geo.getById(pool, destinationLocationId)]);
      if (!origin || !destination) return res.status(404).json({ error: "Lieu introuvable dans le référentiel." });

      const modeCode = String(req.body?.mode_code || "bus");
      const metrics = await geo.routeMetrics(pool, originLocationId, destinationLocationId, modeCode);
      const created = await repo.createRoute(c.id, {
        modeCode,
        originLocationId, destinationLocationId,
        // Distance/durée : valeurs fournies sinon calcul automatique.
        distanceKm: req.body?.distance_km != null && req.body.distance_km !== "" ? Number(req.body.distance_km) : metrics.distance_km,
        durationMinutes: req.body?.duration_minutes != null && req.body.duration_minutes !== "" ? Number(req.body.duration_minutes) : metrics.duration_min,
        baggagePolicy: req.body?.baggage_policy,
        cancellationPolicy: req.body?.cancellation_policy,
        description: req.body?.description,
        currency: req.body?.currency,
        services: req.body?.services,
      });
      await repo.log("route", created.id, "created", req.user.id, `${origin.name} → ${destination.name}`);
      res.status(201).json({
        success: true,
        route: { ...created, origin_city: origin.name, destination_city: destination.name },
      });
    } catch (e) {
      console.error("ERREUR TRAVEL ROUTE :", e.message);
      res.status(500).json({ error: "Erreur création de la ligne." });
    }
  });

  router.get("/partner/routes", async (req, res) => {
    const c = await resolveCompany(req);
    if (!c) return res.json({ routes: [] });
    res.json({ routes: await repo.listRoutes(c.id) });
  });

  // Horaires & prix rattachés à une ligne dont le partenaire est propriétaire.
  async function ownsRoute(req, routeId) {
    const c = await resolveCompany(req);
    if (!c) return false;
    const { rows } = await pool.query(
      `SELECT 1 FROM travel_routes WHERE id=$1 AND travel_company_id=$2`, [routeId, c.id]
    );
    return rows.length > 0;
  }

  router.post("/partner/routes/:routeId/schedules", async (req, res) => {
    if (!(await ensureEnabled(res))) return;
    const routeId = Number(req.params.routeId);
    if (!(await ownsRoute(req, routeId))) return res.status(403).json({ error: "Ligne non autorisée." });
    try {
      const created = await repo.createSchedule(routeId, {
        vehicleId: req.body?.vehicle_id, departureTime: req.body?.departure_time,
        arrivalTime: req.body?.arrival_time, daysOfWeek: req.body?.days_of_week,
        validFrom: req.body?.valid_from, validTo: req.body?.valid_to, seatsTotal: req.body?.seats_total
      });
      res.status(201).json({ success: true, schedule: created });
    } catch (e) {
      console.error("ERREUR TRAVEL SCHEDULE :", e.message);
      res.status(500).json({ error: "Erreur création de l'horaire." });
    }
  });

  router.post("/partner/routes/:routeId/prices", async (req, res) => {
    if (!(await ensureEnabled(res))) return;
    const routeId = Number(req.params.routeId);
    if (!(await ownsRoute(req, routeId))) return res.status(403).json({ error: "Ligne non autorisée." });
    if (!req.body?.base_price) return res.status(400).json({ error: "Prix de base obligatoire." });
    try {
      const created = await repo.createPrice(routeId, {
        scheduleId: req.body?.schedule_id, seatClass: req.body?.seat_class,
        basePrice: req.body?.base_price, childPrice: req.body?.child_price,
        currency: req.body?.currency, baggageIncludedKg: req.body?.baggage_included_kg,
        extraBaggagePrice: req.body?.extra_baggage_price
      });
      res.status(201).json({ success: true, price: created });
    } catch (e) {
      console.error("ERREUR TRAVEL PRICE :", e.message);
      res.status(500).json({ error: "Erreur création du prix." });
    }
  });

  /* ---------- Publication dans le catalogue central (Lot A) ---------- */
  // Publier une ligne → l'offre apparaît automatiquement dans Marketplace.
  router.post("/partner/routes/:routeId/publish", async (req, res) => {
    if (!(await ensureEnabled(res))) return;
    const routeId = Number(req.params.routeId);
    if (!(await ownsRoute(req, routeId))) return res.status(403).json({ error: "Ligne non autorisée." });
    try {
      const r = await repo.routeForCatalog(routeId);
      if (!r) return res.status(404).json({ error: "Ligne introuvable." });
      if (r.from_price == null) {
        return res.status(400).json({ error: "Ajoutez au moins un tarif avant de publier cette ligne." });
      }
      const offer = await catalog.upsertOffer(pool, {
        relatedModule: "travel",
        relatedId: routeId,
        relatedSubtype: "route",
        companyModule: "travel_companies",
        companyId: r.company_id,
        companyName: r.company_name,
        category: "voyage",
        subcategory: r.mode_code,
        title: `${r.origin_city} → ${r.destination_city}`,
        description: (r.services || []).join(", "),
        price: Number(r.from_price),
        currency: r.currency || "XOF",
        availability: r.seats != null ? Number(r.seats) : null,
        location: r.origin_city,
        photos: r.logo_url ? [r.logo_url] : [],
        status: "published",
      });
      await repo.log("route", routeId, "published", req.user.id, "catalogue");
      res.json({ success: true, offer });
    } catch (e) {
      console.error("ERREUR TRAVEL PUBLISH :", e.message);
      res.status(500).json({ error: "Erreur publication de la ligne." });
    }
  });

  // Dépublier (retire de Marketplace, conserve la donnée).
  router.post("/partner/routes/:routeId/unpublish", async (req, res) => {
    if (!(await ensureEnabled(res))) return;
    const routeId = Number(req.params.routeId);
    if (!(await ownsRoute(req, routeId))) return res.status(403).json({ error: "Ligne non autorisée." });
    try {
      const updated = await catalog.setStatus(pool, { relatedModule: "travel", relatedId: routeId, relatedSubtype: "route" }, "suspended");
      await repo.log("route", routeId, "unpublished", req.user.id, "catalogue");
      res.json({ success: true, offer: updated });
    } catch (e) {
      console.error("ERREUR TRAVEL UNPUBLISH :", e.message);
      res.status(500).json({ error: "Erreur retrait de la ligne." });
    }
  });

  /* ═══════════════ Réservation / Paiement Wallet / Billet ═══════════════ */

  async function bookingWithTicket(reference) {
    const b = (await pool.query(
      `SELECT b.*, c.name AS company_name, ol.name AS origin, dl.name AS destination
         FROM travel_bookings b
         LEFT JOIN travel_companies c ON c.id=b.travel_company_id
         LEFT JOIN travel_routes r ON r.id=b.route_id
         LEFT JOIN geo_locations ol ON ol.id=r.origin_location_id
         LEFT JOIN geo_locations dl ON dl.id=r.destination_location_id
        WHERE b.reference=$1`, [reference]
    )).rows[0];
    if (!b) return null;
    const ticket = (await pool.query(`SELECT * FROM travel_tickets WHERE booking_id=$1 ORDER BY id LIMIT 1`, [b.id])).rows[0] || null;
    const passengers = (await pool.query(`SELECT * FROM travel_booking_passengers WHERE booking_id=$1 ORDER BY id`, [b.id])).rows;
    return { booking: b, ticket, passengers };
  }

  // Client : créer une réservation (statut en attente de paiement).
  router.post("/bookings", async (req, res) => {
    if (!(await repo.getFlag("travel_bookings_enabled"))) {
      return res.status(503).json({ error: "La réservation est temporairement indisponible." });
    }
    try {
      const routeId = Number(req.body?.route_id);
      const r = await repo.routeForCatalog(routeId);
      if (!r) return res.status(404).json({ error: "Trajet introuvable." });
      const created = await booking.createBooking(pool, {
        userId: req.user.id, travelCompanyId: r.company_id, routeId,
        scheduleId: req.body?.schedule_id, travelDate: req.body?.travel_date,
        seatClass: req.body?.seat_class, adults: req.body?.adults, children: req.body?.children,
        passengers: Array.isArray(req.body?.passengers) ? req.body.passengers : [],
        channel: "online",
      });
      res.status(201).json({ success: true, booking: created });
    } catch (e) {
      console.error("ERREUR TRAVEL BOOKING :", e.message);
      res.status(400).json({ error: e.message || "Erreur création de la réservation." });
    }
  });

  // Client : payer une réservation via le Wallet MaliLink → émet le billet.
  router.post("/bookings/:reference/pay", async (req, res) => {
    if (!(await repo.getFlag("travel_payments_enabled"))) {
      return res.status(503).json({ error: "Le paiement est temporairement indisponible." });
    }
    try {
      const b0 = (await pool.query(`SELECT user_id FROM travel_bookings WHERE reference=$1`, [req.params.reference])).rows[0];
      if (!b0) return res.status(404).json({ error: "Réservation introuvable." });
      if (b0.user_id && Number(b0.user_id) !== Number(req.user.id) && !isSuperAdminUser(req.user)) {
        return res.status(403).json({ error: "Cette réservation n'est pas la vôtre." });
      }
      const r = await booking.payWithWallet(pool, { reference: req.params.reference, payerUserId: b0.user_id || req.user.id });
      if (r.error === "insufficient") return res.status(400).json({ error: `Solde Wallet insuffisant (disponible : ${r.available?.toLocaleString("fr-FR")} FCFA).` });
      if (r.error === "wallet_blocked") return res.status(403).json({ error: "Votre wallet est bloqué." });
      if (r.error === "not_found") return res.status(404).json({ error: "Réservation introuvable." });
      if (r.error) return res.status(400).json({ error: "Paiement impossible." });
      res.json({ success: true, duplicate: !!r.duplicate, booking: r.booking, ticket: r.ticket });
    } catch (e) {
      console.error("ERREUR TRAVEL PAY :", e.message);
      res.status(500).json({ error: "Erreur de paiement. Aucun montant débité." });
    }
  });

  // Client : mes réservations + billets.
  router.get("/bookings/mine", async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT b.reference, b.travel_date, b.total, b.currency, b.status, b.payment_status, b.created_at,
                c.name AS company_name, ol.name AS origin, dl.name AS destination,
                t.ticket_number, t.verification_code, t.qr_payload, t.status AS ticket_status
           FROM travel_bookings b
           LEFT JOIN travel_companies c ON c.id=b.travel_company_id
           LEFT JOIN travel_routes r ON r.id=b.route_id
           LEFT JOIN geo_locations ol ON ol.id=r.origin_location_id
           LEFT JOIN geo_locations dl ON dl.id=r.destination_location_id
           LEFT JOIN travel_tickets t ON t.booking_id=b.id
          WHERE b.user_id=$1 ORDER BY b.created_at DESC LIMIT 100`, [req.user.id]
      );
      res.json({ bookings: rows });
    } catch (e) {
      res.status(500).json({ error: "Erreur chargement de vos voyages." });
    }
  });

  router.get("/bookings/:reference", async (req, res) => {
    const bt = await bookingWithTicket(req.params.reference);
    if (!bt) return res.status(404).json({ error: "Réservation introuvable." });
    if (bt.booking.user_id && Number(bt.booking.user_id) !== Number(req.user.id) && !isSuperAdminUser(req.user)) {
      return res.status(403).json({ error: "Accès refusé." });
    }
    res.json(bt);
  });

  // Client : annuler une réservation non payée.
  router.post("/bookings/:reference/cancel", async (req, res) => {
    try {
      const { rows } = await pool.query(
        `UPDATE travel_bookings SET status='cancelled', updated_at=NOW()
          WHERE reference=$1 AND user_id=$2 AND payment_status<>'paid' RETURNING reference`,
        [req.params.reference, req.user.id]
      );
      if (!rows[0]) return res.status(400).json({ error: "Réservation introuvable ou déjà payée." });
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ error: "Erreur annulation." });
    }
  });

  /* ---------- Partenaire : réservations, stats, paiements, scan, POS ---------- */

  router.get("/partner/bookings", async (req, res) => {
    const c = await resolveCompany(req);
    if (!c) return res.json({ bookings: [] });
    try {
      const status = ["pending", "confirmed", "cancelled", "completed"].includes(req.query.status) ? req.query.status : null;
      const q = req.query.q ? String(req.query.q).slice(0, 60) : null;
      const { rows } = await pool.query(
        `SELECT b.reference, b.travel_date, b.seats_count, b.total, b.commission, b.currency,
                b.status, b.payment_status, b.channel, b.created_at,
                ol.name AS origin, dl.name AS destination,
                t.ticket_number, t.verification_code, t.status AS ticket_status,
                (SELECT first_name||' '||last_name FROM travel_booking_passengers WHERE booking_id=b.id ORDER BY id LIMIT 1) AS passenger,
                (SELECT phone FROM travel_booking_passengers WHERE booking_id=b.id ORDER BY id LIMIT 1) AS phone
           FROM travel_bookings b
           LEFT JOIN travel_routes r ON r.id=b.route_id
           LEFT JOIN geo_locations ol ON ol.id=r.origin_location_id
           LEFT JOIN geo_locations dl ON dl.id=r.destination_location_id
           LEFT JOIN travel_tickets t ON t.booking_id=b.id
          WHERE b.travel_company_id=$1
            AND ($2::text IS NULL OR b.status=$2)
            AND ($3::text IS NULL OR b.reference ILIKE '%'||$3||'%'
                 OR EXISTS (SELECT 1 FROM travel_booking_passengers p WHERE p.booking_id=b.id
                            AND (p.first_name||' '||p.last_name ILIKE '%'||$3||'%' OR p.phone ILIKE '%'||$3||'%')))
          ORDER BY b.created_at DESC LIMIT 200`,
        [c.id, status, q]
      );
      res.json({ bookings: rows });
    } catch (e) {
      console.error("ERREUR TRAVEL PARTNER BOOKINGS :", e.message);
      res.status(500).json({ error: "Erreur chargement des réservations." });
    }
  });

  router.get("/partner/stats", async (req, res) => {
    const c = await resolveCompany(req);
    if (!c) return res.json({ stats: null });
    try {
      res.json({ stats: await booking.partnerStats(pool, c.id) });
    } catch (e) {
      console.error("ERREUR TRAVEL STATS :", e.message);
      res.status(500).json({ error: "Erreur statistiques." });
    }
  });

  router.get("/partner/payments", async (req, res) => {
    const c = await resolveCompany(req);
    if (!c) return res.json({ payments: [] });
    try {
      const { rows } = await pool.query(
        `SELECT b.reference, b.total, b.commission, b.currency, b.payment_method, b.payment_status,
                b.paid_at, (b.total - b.commission) AS vendor_net, b.financial_operation_id,
                ol.name AS origin, dl.name AS destination
           FROM travel_bookings b
           LEFT JOIN travel_routes r ON r.id=b.route_id
           LEFT JOIN geo_locations ol ON ol.id=r.origin_location_id
           LEFT JOIN geo_locations dl ON dl.id=r.destination_location_id
          WHERE b.travel_company_id=$1 AND b.payment_status='paid'
          ORDER BY b.paid_at DESC NULLS LAST LIMIT 200`, [c.id]
      );
      res.json({ payments: rows });
    } catch (e) {
      res.status(500).json({ error: "Erreur chargement des paiements." });
    }
  });

  router.get("/partner/connectors", async (req, res) => {
    try {
      const { rows } = await pool.query(`SELECT code, label, enabled, is_real_money FROM travel_payment_connectors ORDER BY sort_order`);
      res.json({ connectors: rows });
    } catch (e) {
      res.status(500).json({ error: "Erreur connecteurs." });
    }
  });

  // Contrôle à l'embarquement (scan QR ou saisie du code).
  router.post("/partner/scan", async (req, res) => {
    const c = await resolveCompany(req);
    if (!c) return res.status(403).json({ error: "Compagnie requise." });
    try {
      const code = String(req.body?.code || "").trim();
      if (!code) return res.status(400).json({ error: "Code du billet requis." });
      // Un scan du QR renvoie "MLV|ticket|code|sig" → on extrait le code.
      const parsed = code.startsWith("MLV|") ? code.split("|")[2] : code;
      const result = await booking.scanTicket(pool, { codeOrNumber: parsed, scannedBy: req.user.id, device: "partner_app" });
      res.json(result);
    } catch (e) {
      console.error("ERREUR TRAVEL SCAN :", e.message);
      res.status(500).json({ error: "Erreur de contrôle du billet." });
    }
  });

  // POS : vente au comptoir — MÊME structure réservation/billet que le web.
  // L'agent enregistre un client (par téléphone) et encaisse via son Wallet.
  router.post("/partner/pos/sell", async (req, res) => {
    const c = await resolveCompany(req);
    if (!c) return res.status(403).json({ error: "Compagnie requise." });
    try {
      // Client résolu par téléphone (compte MaliLink requis pour le paiement Wallet).
      const digits = phoneVar(req.body?.customer_phone || "").map((v) => v.replace(/[^0-9]/g, ""));
      const found = await pool.query(
        `SELECT id, fullname FROM users WHERE regexp_replace(COALESCE(phone,''),'[^0-9]','','g') = ANY($1) LIMIT 1`, [digits]
      );
      const customer = found.rows[0];
      if (!customer) return res.status(404).json({ error: "Client introuvable (compte MaliLink requis pour l'encaissement Wallet)." });

      const routeId = Number(req.body?.route_id);
      const r = await repo.routeForCatalog(routeId);
      if (!r || r.company_id !== c.id) return res.status(403).json({ error: "Trajet non autorisé." });

      const created = await booking.createBooking(pool, {
        userId: customer.id, travelCompanyId: c.id, routeId,
        scheduleId: req.body?.schedule_id, travelDate: req.body?.travel_date,
        seatClass: req.body?.seat_class, adults: req.body?.adults || 1, children: req.body?.children || 0,
        passengers: [{ first_name: req.body?.first_name || customer.fullname, last_name: req.body?.last_name || "", phone: req.body?.customer_phone }],
        channel: "pos", soldBy: req.user.id,
      });
      const paid = await booking.payWithWallet(pool, { reference: created.reference, payerUserId: customer.id });
      if (paid.error === "insufficient") return res.status(400).json({ error: `Solde client insuffisant (${paid.available?.toLocaleString("fr-FR")} FCFA).` });
      if (paid.error) return res.status(400).json({ error: "Encaissement impossible." });
      res.status(201).json({ success: true, booking: paid.booking, ticket: paid.ticket });
    } catch (e) {
      console.error("ERREUR TRAVEL POS :", e.message);
      res.status(500).json({ error: e.message || "Erreur vente au comptoir." });
    }
  });

  return router;
};
