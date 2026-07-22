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

module.exports = function createTravelRouter({ pool, authenticateToken, isSuperAdminUser, getEffectiveCompanyId }) {
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
    const originCityId = Number(req.query.origin);
    const destinationCityId = Number(req.query.destination);
    if (!originCityId || !destinationCityId) {
      return res.status(400).json({ error: "Ville de départ et destination obligatoires." });
    }
    if (originCityId === destinationCityId) {
      return res.status(400).json({ error: "Le départ et la destination doivent différer." });
    }
    try {
      const result = await service.search({
        originCityId,
        destinationCityId,
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

  const routes = partnerResource(
    (companyId, req) => repo.createRoute(companyId, {
      modeCode: req.body?.mode_code,
      originCityId: req.body?.origin_city_id, destinationCityId: req.body?.destination_city_id,
      originPointId: req.body?.origin_point_id, destinationPointId: req.body?.destination_point_id,
      distanceKm: req.body?.distance_km, durationMinutes: req.body?.duration_minutes,
      baggagePolicy: req.body?.baggage_policy, services: req.body?.services
    }),
    (companyId) => repo.listRoutes(companyId),
    "route"
  );
  router.post("/partner/routes", routes.create);
  router.get("/partner/routes", routes.list);

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

  return router;
};
