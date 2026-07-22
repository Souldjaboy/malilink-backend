"use strict";

/**
 * Travel Repository — accès données pur (aucune règle métier).
 * Toutes les requêtes SQL du module Voyage passent ici : le service et le
 * contrôleur ne connaissent pas la forme des tables. Requêtes 100 %
 * paramétrées (anti-injection).
 */

function createTravelRepository(pool) {
  return {
    /* ---------- Référentiels ---------- */
    async listModes() {
      const { rows } = await pool.query(
        `SELECT code, label, category, enabled FROM travel_modes ORDER BY sort_order, code`
      );
      return rows;
    },

    async searchCities(term, limit = 20) {
      const { rows } = await pool.query(
        `SELECT ci.id, ci.name, ci.region, co.iso2 AS country
           FROM travel_cities ci JOIN travel_countries co ON co.id=ci.country_id
          WHERE ($1='' OR lower(ci.name) LIKE lower($1)||'%')
          ORDER BY ci.name LIMIT $2`,
        [term || "", limit]
      );
      return rows;
    },

    async listPoints(cityId) {
      const { rows } = await pool.query(
        `SELECT id, city_id, point_type, name, address FROM travel_points
          WHERE city_id=$1 ORDER BY point_type, name`,
        [cityId]
      );
      return rows;
    },

    /* ---------- Partenaires ---------- */
    async createCompany(data) {
      const { rows } = await pool.query(
        `INSERT INTO travel_companies (company_id, name, slug, logo_url, description, phone, email, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [data.companyId || null, data.name, data.slug || null, data.logoUrl || "",
         data.description || "", data.phone || "", data.email || "", data.createdBy || null]
      );
      return rows[0];
    },
    async getCompany(id) {
      const { rows } = await pool.query(`SELECT * FROM travel_companies WHERE id=$1`, [id]);
      return rows[0] || null;
    },
    async getCompanyByCompanyId(companyId) {
      const { rows } = await pool.query(
        `SELECT * FROM travel_companies WHERE company_id=$1 ORDER BY id LIMIT 1`, [companyId]
      );
      return rows[0] || null;
    },
    async listCompanies() {
      const { rows } = await pool.query(
        `SELECT id, name, logo_url, rating, rating_count, verified, status FROM travel_companies
          WHERE status='active' ORDER BY rating DESC, name`
      );
      return rows;
    },

    async createAgency(companyId, data) {
      const { rows } = await pool.query(
        `INSERT INTO travel_agencies (travel_company_id, city_id, point_id, name, address, phone)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [companyId, data.cityId || null, data.pointId || null, data.name, data.address || "", data.phone || ""]
      );
      return rows[0];
    },
    async listAgencies(companyId) {
      const { rows } = await pool.query(
        `SELECT * FROM travel_agencies WHERE travel_company_id=$1 ORDER BY name`, [companyId]
      );
      return rows;
    },

    /* ---------- Véhicules ---------- */
    async createVehicle(companyId, data) {
      const { rows } = await pool.query(
        `INSERT INTO travel_vehicles
           (travel_company_id, name, registration, mode_code, capacity, photos,
            has_ac, has_wifi, has_usb, has_tv, has_toilet, state)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [companyId, data.name, data.registration || "", data.modeCode, Number(data.capacity || 0),
         JSON.stringify(data.photos || []), !!data.hasAc, !!data.hasWifi, !!data.hasUsb,
         !!data.hasTv, !!data.hasToilet, data.state || "bon"]
      );
      return rows[0];
    },
    async listVehicles(companyId) {
      const { rows } = await pool.query(
        `SELECT * FROM travel_vehicles WHERE travel_company_id=$1 ORDER BY name`, [companyId]
      );
      return rows;
    },

    /* ---------- Lignes / horaires / prix ---------- */
    async createRoute(companyId, data) {
      const { rows } = await pool.query(
        `INSERT INTO travel_routes
           (travel_company_id, mode_code, origin_location_id, destination_location_id,
            distance_km, duration_minutes, baggage_policy, cancellation_policy,
            description, currency, services, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [companyId, data.modeCode, data.originLocationId, data.destinationLocationId,
         data.distanceKm ?? null, data.durationMinutes ?? null,
         data.baggagePolicy || "", data.cancellationPolicy || "", data.description || "",
         data.currency || "XOF", JSON.stringify(data.services || []), data.status || "active"]
      );
      return rows[0];
    },
    async listRoutes(companyId) {
      // Noms de lieux issus du référentiel mondial ; `published` = offre publiée.
      const { rows } = await pool.query(
        `SELECT r.*, ol.name AS origin_city, dl.name AS destination_city,
                ol.country_name AS origin_country, dl.country_name AS destination_country,
                (co.status = 'published') AS published
           FROM travel_routes r
           JOIN geo_locations ol ON ol.id=r.origin_location_id
           JOIN geo_locations dl ON dl.id=r.destination_location_id
           LEFT JOIN catalog_offers co
             ON co.related_module='travel' AND co.related_subtype='route' AND co.related_id=r.id
          WHERE r.travel_company_id=$1 ORDER BY r.id DESC`,
        [companyId]
      );
      return rows;
    },

    // Détail d'une ligne pour composer une offre de catalogue.
    async routeForCatalog(routeId) {
      const { rows } = await pool.query(
        `SELECT r.id, r.mode_code, r.duration_minutes, r.distance_km, r.services,
                c.id AS company_id, c.name AS company_name, c.logo_url,
                ol.name AS origin_city, dl.name AS destination_city,
                ol.country_name AS origin_country, dl.country_name AS destination_country,
                (SELECT MIN(base_price) FROM travel_prices p WHERE p.route_id=r.id) AS from_price,
                (SELECT currency FROM travel_prices p WHERE p.route_id=r.id ORDER BY id LIMIT 1) AS currency,
                (SELECT MAX(seats_total) FROM travel_schedules s WHERE s.route_id=r.id AND s.status='active') AS seats
           FROM travel_routes r
           JOIN travel_companies c ON c.id=r.travel_company_id
           JOIN geo_locations ol ON ol.id=r.origin_location_id
           JOIN geo_locations dl ON dl.id=r.destination_location_id
          WHERE r.id=$1`,
        [routeId]
      );
      return rows[0] || null;
    },

    async createSchedule(routeId, data) {
      const { rows } = await pool.query(
        `INSERT INTO travel_schedules
           (route_id, vehicle_id, departure_time, arrival_time, days_of_week,
            valid_from, valid_to, seats_total)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [routeId, data.vehicleId || null, data.departureTime, data.arrivalTime || null,
         data.daysOfWeek || [0, 1, 2, 3, 4, 5, 6], data.validFrom || null, data.validTo || null,
         Number(data.seatsTotal || 0)]
      );
      return rows[0];
    },

    async createPrice(routeId, data) {
      const { rows } = await pool.query(
        `INSERT INTO travel_prices
           (route_id, schedule_id, seat_class, base_price, child_price, currency,
            baggage_included_kg, extra_baggage_price)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [routeId, data.scheduleId || null, data.seatClass || "standard", data.basePrice,
         data.childPrice || null, data.currency || "XOF", data.baggageIncludedKg || 0,
         data.extraBaggagePrice || 0]
      );
      return rows[0];
    },

    /* ---------- Recherche ---------- */
    // Retourne les offres (route + compagnie + horaire + prix) pour un trajet
    // et un jour de semaine donné. Filtrage métier délégué au service.
    async searchOffers({ originLocationId, destinationLocationId, dayOfWeek, modeCode }) {
      const { rows } = await pool.query(
        `SELECT
            r.id AS route_id, r.mode_code, r.duration_minutes, r.distance_km, r.services,
            c.id AS company_id, c.name AS company_name, c.logo_url, c.rating, c.rating_count,
            ol.name AS origin_city, dl.name AS destination_city,
            s.id AS schedule_id, s.departure_time, s.arrival_time, s.seats_total, s.days_of_week,
            p.seat_class, p.base_price, p.child_price, p.currency, p.baggage_included_kg
           FROM travel_routes r
           JOIN travel_companies c ON c.id=r.travel_company_id AND c.status='active'
           JOIN geo_locations ol ON ol.id=r.origin_location_id
           JOIN geo_locations dl ON dl.id=r.destination_location_id
           JOIN travel_schedules s ON s.route_id=r.id AND s.status='active'
           LEFT JOIN travel_prices p ON p.route_id=r.id
             AND (p.schedule_id IS NULL OR p.schedule_id=s.id)
          WHERE r.status='active'
            AND r.origin_location_id=$1 AND r.destination_location_id=$2
            AND ($3::int IS NULL OR $3 = ANY(s.days_of_week))
            AND ($4::text IS NULL OR r.mode_code=$4)
          ORDER BY p.base_price NULLS LAST, s.departure_time`,
        [originLocationId, destinationLocationId, dayOfWeek, modeCode || null]
      );
      return rows;
    },

    async activePromotions(routeIds) {
      if (!routeIds.length) return [];
      const { rows } = await pool.query(
        `SELECT route_id, discount_type, discount_value FROM travel_promotions
          WHERE active=true AND route_id = ANY($1)
            AND (starts_at IS NULL OR starts_at <= NOW())
            AND (ends_at IS NULL OR ends_at >= NOW())`,
        [routeIds]
      );
      return rows;
    },

    /* ---------- Flags & réglages ---------- */
    async getFlag(key) {
      const { rows } = await pool.query(
        `SELECT enabled FROM travel_feature_flags WHERE flag_key=$1`, [key]
      );
      return rows[0]?.enabled === true;
    },
    async getSetting(key, fallback = null) {
      const { rows } = await pool.query(`SELECT value FROM travel_settings WHERE key=$1`, [key]);
      return rows[0]?.value ?? fallback;
    },
    async log(entityType, entityId, action, actorUserId, details = "") {
      await pool.query(
        `INSERT INTO travel_logs (entity_type, entity_id, action, actor_user_id, details)
         VALUES ($1,$2,$3,$4,$5)`,
        [entityType, entityId || null, action, actorUserId || null, String(details).slice(0, 500)]
      ).catch(() => {});
    }
  };
}

module.exports = { createTravelRepository };
