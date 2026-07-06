"use strict";

/**
 * Module Livreurs / Coursiers / Taxis — MaliLink Global
 * Router Express monté dans server.js via une factory qui reçoit
 * pool + middlewares d'auth existants (pas de duplication de logique).
 *
 * Fonctionnement type Uber / Uber Eats :
 * - inscription livreur, profil, documents, disponibilité
 * - création de mission (client, entreprise ou C2C) avec calcul
 *   distance (Haversine) + prix (tarification en BDD)
 * - matching : missions en attente proches du livreur
 * - cycle de vie : en_attente → acceptee → recuperee → en_route → livree → terminee
 * - suivi position temps quasi réel (polling), notes, revenus
 */

const express = require("express");
const { createRateLimiter } = require("../middleware/rateLimit");

function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

module.exports = function createDeliveryRouter({
  pool,
  authenticateToken,
  authorizeRoles,
  publicRegistration
}) {
  const router = express.Router();

  /* ---------- Inscription livreur PUBLIQUE (une étape, sans compte) ----------
     Crée le compte utilisateur (rôle livreur, identifiant = téléphone,
     email optionnel) + le profil livreur, puis renvoie un token JWT :
     le nouveau livreur arrive directement sur /livreur.
     Déclarée AVANT router.use(authenticateToken). */
  if (publicRegistration) {
    const { bcrypt, jwt, jwtSecret, bcryptRounds, normalizePhone, phoneVariants } =
      publicRegistration;
    const publicRegisterLimiter = createRateLimiter({
      windowMs: 10 * 60 * 1000,
      max: 15,
      message: "Trop de tentatives d’inscription. Réessayez dans quelques minutes."
    });

    router.post("/drivers/public-register", publicRegisterLimiter, async (req, res) => {
      const client = await pool.connect();
      try {
        const {
          fullname,
          phone,
          email,
          password,
          driver_type = "livreur",
          vehicle_type = "moto",
          vehicle_plate,
          license_number,
          city = ""
        } = req.body || {};

        const cleanFullname = String(fullname || "").trim();
        const cleanPhone = normalizePhone(phone);
        const cleanEmail = String(email || "").trim().toLowerCase();
        const cleanPassword = String(password || "");

        if (!cleanFullname || !cleanPhone || !cleanPassword) {
          return res.status(400).json({
            error: "Nom complet, numéro de téléphone et mot de passe obligatoires."
          });
        }
        if (cleanPassword.length < 6) {
          return res.status(400).json({
            error: "Le mot de passe doit contenir au moins 6 caractères."
          });
        }
        if (!["livreur", "coursier", "taxi", "transporteur"].includes(driver_type)) {
          return res.status(400).json({ error: "Type de livreur invalide" });
        }

        const phoneDigits = phoneVariants(cleanPhone).map((variant) =>
          variant.replace(/[^0-9]/g, "")
        );
        const existingPhone = await client.query(
          `SELECT id FROM users
           WHERE regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g') = ANY($1)
           LIMIT 1`,
          [phoneDigits]
        );
        if (existingPhone.rows.length > 0) {
          return res.status(400).json({
            error: "Numéro de téléphone déjà utilisé. Connectez-vous avec votre numéro de téléphone."
          });
        }

        if (cleanEmail) {
          const existingEmail = await client.query(
            `SELECT id FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1`,
            [cleanEmail]
          );
          if (existingEmail.rows.length > 0) {
            return res.status(400).json({ error: "Cet email existe déjà." });
          }
        }

        const storedEmail =
          cleanEmail ||
          `driver-${Date.now()}-${Math.floor(Math.random() * 100000)}@pending.trianglewmspro.local`;
        const passwordHash = await bcrypt.hash(cleanPassword, bcryptRounds);

        await client.query("BEGIN");

        // phone_verified=true : pas de vérification SMS pour l'instant,
        // téléphone + mot de passe suffisent (le login exige un contact vérifié).
        const userResult = await client.query(
          `INSERT INTO users
             (fullname, email, phone, password, role, is_active, account_status,
              verification_required, phone_verified, created_at)
           VALUES ($1,$2,$3,$4,'livreur',true,'active',false,true,NOW())
           RETURNING id, fullname, email, phone, role`,
          [cleanFullname, storedEmail, cleanPhone, passwordHash]
        );
        const user = userResult.rows[0];

        const driverResult = await client.query(
          `INSERT INTO delivery_drivers
             (tenant_id, user_id, driver_type, vehicle_type, vehicle_plate,
              license_number, phone)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING *`,
          [
            req.tenant_id || "malilink",
            user.id,
            driver_type,
            vehicle_type,
            vehicle_plate || null,
            license_number || null,
            cleanPhone
          ]
        );

        await client.query("COMMIT");

        const token = jwt.sign(
          {
            id: user.id,
            email: user.email,
            role: "livreur",
            company_id: null,
            is_super_admin: false,
            tenant_id: req.tenant_id || "malilink"
          },
          jwtSecret,
          { expiresIn: "1d" }
        );

        res.status(201).json({
          success: true,
          message:
            "Compte créé avec succès. Votre demande est en attente de validation par MaliLink.",
          token,
          user: { ...user, city },
          driver: driverResult.rows[0]
        });
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        console.error("ERREUR INSCRIPTION LIVREUR PUBLIQUE :", error.message);
        res.status(500).json({ error: "Erreur inscription livreur. Réessayez." });
      } finally {
        client.release();
      }
    });
  }

  // Toutes les routes livraison exigent une authentification
  router.use(authenticateToken);

  async function getDriverByUser(userId) {
    const { rows } = await pool.query(
      "SELECT * FROM delivery_drivers WHERE user_id = $1",
      [userId]
    );
    return rows[0] || null;
  }

  async function getPricing(tenantId, missionType) {
    const { rows } = await pool.query(
      `SELECT * FROM delivery_pricing_settings
       WHERE tenant_id = $1 AND mission_type = $2`,
      [tenantId || "malilink", missionType]
    );
    return (
      rows[0] || {
        base_fee: 500,
        per_km_fee: 200,
        minimum_price: 500,
        commission_percent: 15
      }
    );
  }

  function computePrice(pricing, distanceKm) {
    const raw =
      Number(pricing.base_fee) + Number(pricing.per_km_fee) * (distanceKm || 0);
    const price = Math.max(raw, Number(pricing.minimum_price));
    return Math.round(price / 25) * 25; // arrondi commercial 25 FCFA
  }

  // ---------- LIVREURS ----------

  // Devenir livreur / coursier / taxi
  router.post("/drivers/register", async (req, res) => {
    try {
      const {
        driver_type = "livreur",
        vehicle_type = "moto",
        vehicle_plate,
        license_number,
        phone
      } = req.body || {};

      if (!["livreur", "coursier", "taxi", "transporteur"].includes(driver_type)) {
        return res.status(400).json({ error: "Type de livreur invalide" });
      }

      const existing = await getDriverByUser(req.user.id);
      if (existing) {
        return res.status(409).json({ error: "Profil livreur déjà existant", driver: existing });
      }

      const { rows } = await pool.query(
        `INSERT INTO delivery_drivers
           (tenant_id, user_id, driver_type, vehicle_type, vehicle_plate, license_number, phone)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
        [
          req.tenant_id || "malilink",
          req.user.id,
          driver_type,
          vehicle_type,
          vehicle_plate || null,
          license_number || null,
          phone || null
        ]
      );
      res.status(201).json(rows[0]);
    } catch (error) {
      console.error("delivery register:", error);
      res.status(500).json({ error: "Erreur inscription livreur" });
    }
  });

  // Mon profil livreur
  router.get("/drivers/me", async (req, res) => {
    try {
      const driver = await getDriverByUser(req.user.id);
      if (!driver) return res.status(404).json({ error: "Pas de profil livreur" });
      res.json(driver);
    } catch (error) {
      console.error("delivery me:", error);
      res.status(500).json({ error: "Erreur profil livreur" });
    }
  });

  // Mise à jour profil / documents
  router.put("/drivers/me", async (req, res) => {
    try {
      const driver = await getDriverByUser(req.user.id);
      if (!driver) return res.status(404).json({ error: "Pas de profil livreur" });

      const {
        vehicle_type,
        vehicle_plate,
        license_number,
        phone,
        id_document_url,
        vehicle_document_url,
        photo_url
      } = req.body || {};

      const { rows } = await pool.query(
        `UPDATE delivery_drivers SET
           vehicle_type = COALESCE($1, vehicle_type),
           vehicle_plate = COALESCE($2, vehicle_plate),
           license_number = COALESCE($3, license_number),
           phone = COALESCE($4, phone),
           id_document_url = COALESCE($5, id_document_url),
           vehicle_document_url = COALESCE($6, vehicle_document_url),
           photo_url = COALESCE($7, photo_url),
           updated_at = NOW()
         WHERE id = $8
         RETURNING *`,
        [
          vehicle_type,
          vehicle_plate,
          license_number,
          phone,
          id_document_url,
          vehicle_document_url,
          photo_url,
          driver.id
        ]
      );
      res.json(rows[0]);
    } catch (error) {
      console.error("delivery update me:", error);
      res.status(500).json({ error: "Erreur mise à jour profil" });
    }
  });

  // Disponibilité + position
  router.put("/drivers/me/availability", async (req, res) => {
    try {
      const driver = await getDriverByUser(req.user.id);
      if (!driver) return res.status(404).json({ error: "Pas de profil livreur" });
      if (driver.status !== "active") {
        return res.status(403).json({ error: "Compte livreur suspendu" });
      }

      const { is_available, lat, lng } = req.body || {};
      const { rows } = await pool.query(
        `UPDATE delivery_drivers SET
           is_available = COALESCE($1, is_available),
           current_lat = COALESCE($2, current_lat),
           current_lng = COALESCE($3, current_lng),
           last_position_at = CASE WHEN $2 IS NOT NULL THEN NOW() ELSE last_position_at END,
           updated_at = NOW()
         WHERE id = $4
         RETURNING *`,
        [
          typeof is_available === "boolean" ? is_available : null,
          Number.isFinite(Number(lat)) ? Number(lat) : null,
          Number.isFinite(Number(lng)) ? Number(lng) : null,
          driver.id
        ]
      );
      res.json(rows[0]);
    } catch (error) {
      console.error("delivery availability:", error);
      res.status(500).json({ error: "Erreur disponibilité" });
    }
  });

  // Ping position (pendant une mission)
  router.post("/drivers/me/position", async (req, res) => {
    try {
      const driver = await getDriverByUser(req.user.id);
      if (!driver) return res.status(404).json({ error: "Pas de profil livreur" });

      const lat = Number(req.body?.lat);
      const lng = Number(req.body?.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return res.status(400).json({ error: "Coordonnées invalides" });
      }

      await pool.query(
        `UPDATE delivery_drivers
         SET current_lat=$1, current_lng=$2, last_position_at=NOW(), updated_at=NOW()
         WHERE id=$3`,
        [lat, lng, driver.id]
      );

      // Trace sur la mission active éventuelle
      const active = await pool.query(
        `SELECT id FROM delivery_missions
         WHERE driver_id=$1 AND status IN ('acceptee','recuperee','en_route')
         ORDER BY accepted_at DESC LIMIT 1`,
        [driver.id]
      );
      if (active.rows[0]) {
        await pool.query(
          `INSERT INTO delivery_mission_events (mission_id, event_type, lat, lng)
           VALUES ($1, 'position', $2, $3)`,
          [active.rows[0].id, lat, lng]
        );
      }
      res.json({ ok: true });
    } catch (error) {
      console.error("delivery position:", error);
      res.status(500).json({ error: "Erreur position" });
    }
  });

  // Revenus + historique
  router.get("/drivers/me/earnings", async (req, res) => {
    try {
      const driver = await getDriverByUser(req.user.id);
      if (!driver) return res.status(404).json({ error: "Pas de profil livreur" });

      const { rows } = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status IN ('livree','terminee')) AS missions_terminees,
           COALESCE(SUM(price_final - COALESCE(commission_amount,0))
             FILTER (WHERE status IN ('livree','terminee')), 0) AS revenus_nets,
           COALESCE(SUM(commission_amount)
             FILTER (WHERE status IN ('livree','terminee')), 0) AS commissions
         FROM delivery_missions WHERE driver_id = $1`,
        [driver.id]
      );
      res.json({ ...rows[0], rating_avg: driver.rating_avg, rating_count: driver.rating_count });
    } catch (error) {
      console.error("delivery earnings:", error);
      res.status(500).json({ error: "Erreur revenus" });
    }
  });

  // ---------- MISSIONS ----------

  // Créer une demande (client, entreprise, C2C)
  router.post("/missions", async (req, res) => {
    try {
      const {
        mission_type = "livraison",
        pickup_address,
        pickup_lat,
        pickup_lng,
        dropoff_address,
        dropoff_lat,
        dropoff_lng,
        package_description,
        recipient_name,
        recipient_phone,
        payment_method = "especes",
        marketplace_order_id,
        notes
      } = req.body || {};

      if (!["livraison", "coursier", "taxi"].includes(mission_type)) {
        return res.status(400).json({ error: "Type de mission invalide" });
      }
      if (!pickup_address || !dropoff_address) {
        return res.status(400).json({ error: "Adresses de départ et d'arrivée requises" });
      }

      let distanceKm = null;
      const pLat = Number(pickup_lat), pLng = Number(pickup_lng);
      const dLat = Number(dropoff_lat), dLng = Number(dropoff_lng);
      if ([pLat, pLng, dLat, dLng].every(Number.isFinite)) {
        distanceKm = Math.round(haversineKm(pLat, pLng, dLat, dLng) * 100) / 100;
      }

      const pricing = await getPricing(req.tenant_id, mission_type);
      const priceEstimate = computePrice(pricing, distanceKm || 3); // 3 km par défaut si pas de GPS
      const commission = Math.round((priceEstimate * Number(pricing.commission_percent)) / 100);

      const { rows } = await pool.query(
        `INSERT INTO delivery_missions
           (tenant_id, mission_type, client_user_id, marketplace_order_id,
            pickup_address, pickup_lat, pickup_lng,
            dropoff_address, dropoff_lat, dropoff_lng,
            distance_km, price_estimate, commission_amount,
            payment_method, package_description, recipient_name, recipient_phone, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         RETURNING *`,
        [
          req.tenant_id || "malilink",
          mission_type,
          req.user.id,
          marketplace_order_id || null,
          pickup_address,
          Number.isFinite(pLat) ? pLat : null,
          Number.isFinite(pLng) ? pLng : null,
          dropoff_address,
          Number.isFinite(dLat) ? dLat : null,
          Number.isFinite(dLng) ? dLng : null,
          distanceKm,
          priceEstimate,
          commission,
          payment_method,
          package_description || null,
          recipient_name || null,
          recipient_phone || null,
          notes || null
        ]
      );

      await pool.query(
        `INSERT INTO delivery_mission_events (mission_id, event_type, details)
         VALUES ($1, 'creee', 'Mission créée')`,
        [rows[0].id]
      );

      res.status(201).json(rows[0]);
    } catch (error) {
      console.error("delivery create mission:", error);
      res.status(500).json({ error: "Erreur création mission" });
    }
  });

  // Missions proches (livreur disponible) — matching par distance
  router.get("/missions/nearby", async (req, res) => {
    try {
      const driver = await getDriverByUser(req.user.id);
      if (!driver) return res.status(404).json({ error: "Pas de profil livreur" });

      const radiusKm = Math.min(Number(req.query.radius_km) || 10, 50);
      const { rows } = await pool.query(
        `SELECT * FROM delivery_missions
         WHERE tenant_id = $1 AND status = 'en_attente' AND driver_id IS NULL
           AND (mission_type = $2 OR $2 = 'transporteur')
         ORDER BY requested_at ASC
         LIMIT 50`,
        [
          req.tenant_id || "malilink",
          driver.driver_type === "taxi" ? "taxi" : driver.driver_type === "coursier" ? "coursier" : "livraison"
        ]
      );

      const withDistance = rows.map((m) => {
        let distance_to_pickup_km = null;
        if (
          [driver.current_lat, driver.current_lng, m.pickup_lat, m.pickup_lng].every(
            (v) => v !== null && Number.isFinite(Number(v))
          )
        ) {
          distance_to_pickup_km =
            Math.round(
              haversineKm(
                Number(driver.current_lat),
                Number(driver.current_lng),
                Number(m.pickup_lat),
                Number(m.pickup_lng)
              ) * 100
            ) / 100;
        }
        return { ...m, distance_to_pickup_km };
      });

      const filtered = withDistance
        .filter((m) => m.distance_to_pickup_km === null || m.distance_to_pickup_km <= radiusKm)
        .sort((a, b) => (a.distance_to_pickup_km ?? 999) - (b.distance_to_pickup_km ?? 999));

      res.json(filtered);
    } catch (error) {
      console.error("delivery nearby:", error);
      res.status(500).json({ error: "Erreur missions proches" });
    }
  });

  // Accepter une mission (verrou anti-double acceptation)
  router.post("/missions/:id/accept", async (req, res) => {
    try {
      const driver = await getDriverByUser(req.user.id);
      if (!driver) return res.status(404).json({ error: "Pas de profil livreur" });
      if (driver.status !== "active") {
        return res.status(403).json({ error: "Compte livreur suspendu" });
      }

      const { rows } = await pool.query(
        `UPDATE delivery_missions
         SET driver_id=$1, status='acceptee', accepted_at=NOW(), updated_at=NOW()
         WHERE id=$2 AND status='en_attente' AND driver_id IS NULL
         RETURNING *`,
        [driver.id, req.params.id]
      );
      if (!rows[0]) {
        return res.status(409).json({ error: "Mission déjà prise ou indisponible" });
      }

      await pool.query(
        `INSERT INTO delivery_mission_events (mission_id, event_type, details)
         VALUES ($1, 'acceptee', $2)`,
        [rows[0].id, `Acceptée par livreur #${driver.id}`]
      );
      res.json(rows[0]);
    } catch (error) {
      console.error("delivery accept:", error);
      res.status(500).json({ error: "Erreur acceptation" });
    }
  });

  // Transitions de statut par le livreur assigné
  async function driverTransition(req, res, fromStatuses, toStatus, timestampCol) {
    const driver = await getDriverByUser(req.user.id);
    if (!driver) return res.status(404).json({ error: "Pas de profil livreur" });

    const { rows } = await pool.query(
      `UPDATE delivery_missions
       SET status=$1,
           ${timestampCol ? `${timestampCol}=NOW(),` : ""}
           updated_at=NOW()
       WHERE id=$2 AND driver_id=$3 AND status = ANY($4)
       RETURNING *`,
      [toStatus, req.params.id, driver.id, fromStatuses]
    );
    if (!rows[0]) {
      return res.status(409).json({ error: "Transition impossible (statut ou livreur invalide)" });
    }
    await pool.query(
      `INSERT INTO delivery_mission_events (mission_id, event_type)
       VALUES ($1, $2)`,
      [rows[0].id, toStatus]
    );
    return res.json(rows[0]);
  }

  router.post("/missions/:id/pickup", (req, res) =>
    driverTransition(req, res, ["acceptee"], "recuperee", "picked_up_at").catch((e) => {
      console.error(e);
      res.status(500).json({ error: "Erreur" });
    })
  );

  router.post("/missions/:id/start", (req, res) =>
    driverTransition(req, res, ["recuperee"], "en_route", null).catch((e) => {
      console.error(e);
      res.status(500).json({ error: "Erreur" });
    })
  );

  router.post("/missions/:id/deliver", async (req, res) => {
    try {
      const driver = await getDriverByUser(req.user.id);
      if (!driver) return res.status(404).json({ error: "Pas de profil livreur" });

      const { rows } = await pool.query(
        `UPDATE delivery_missions
         SET status='livree', delivered_at=NOW(),
             price_final=COALESCE(price_final, price_estimate),
             updated_at=NOW()
         WHERE id=$1 AND driver_id=$2 AND status IN ('recuperee','en_route')
         RETURNING *`,
        [req.params.id, driver.id]
      );
      if (!rows[0]) return res.status(409).json({ error: "Transition impossible" });

      await pool.query(
        `INSERT INTO delivery_mission_events (mission_id, event_type) VALUES ($1, 'livree')`,
        [rows[0].id]
      );
      res.json(rows[0]);
    } catch (error) {
      console.error("delivery deliver:", error);
      res.status(500).json({ error: "Erreur livraison" });
    }
  });

  // Annulation (client créateur ou livreur assigné)
  router.post("/missions/:id/cancel", async (req, res) => {
    try {
      const reason = String(req.body?.reason || "").slice(0, 500);
      const driver = await getDriverByUser(req.user.id);

      const { rows } = await pool.query(
        `UPDATE delivery_missions
         SET status='annulee', cancelled_reason=$1, updated_at=NOW()
         WHERE id=$2
           AND status IN ('en_attente','acceptee')
           AND (client_user_id=$3 OR driver_id=$4)
         RETURNING *`,
        [reason || null, req.params.id, req.user.id, driver ? driver.id : -1]
      );
      if (!rows[0]) return res.status(409).json({ error: "Annulation impossible" });

      await pool.query(
        `INSERT INTO delivery_mission_events (mission_id, event_type, details)
         VALUES ($1, 'annulee', $2)`,
        [rows[0].id, reason || null]
      );
      res.json(rows[0]);
    } catch (error) {
      console.error("delivery cancel:", error);
      res.status(500).json({ error: "Erreur annulation" });
    }
  });

  // Mes missions (livreur)
  router.get("/missions/me", async (req, res) => {
    try {
      const driver = await getDriverByUser(req.user.id);
      if (!driver) return res.status(404).json({ error: "Pas de profil livreur" });
      const { rows } = await pool.query(
        `SELECT * FROM delivery_missions
         WHERE driver_id=$1 ORDER BY requested_at DESC LIMIT 100`,
        [driver.id]
      );
      res.json(rows);
    } catch (error) {
      console.error("delivery my missions:", error);
      res.status(500).json({ error: "Erreur missions" });
    }
  });

  // Mes demandes (client)
  router.get("/missions/client", async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT m.*, d.phone AS driver_phone, d.vehicle_type AS driver_vehicle,
                d.rating_avg AS driver_rating
         FROM delivery_missions m
         LEFT JOIN delivery_drivers d ON d.id = m.driver_id
         WHERE m.client_user_id=$1
         ORDER BY m.requested_at DESC LIMIT 100`,
        [req.user.id]
      );
      res.json(rows);
    } catch (error) {
      console.error("delivery client missions:", error);
      res.status(500).json({ error: "Erreur demandes" });
    }
  });

  // Détail + position livreur (client créateur, livreur assigné ou super admin)
  router.get("/missions/:id", async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT m.*, d.current_lat AS driver_lat, d.current_lng AS driver_lng,
                d.last_position_at, d.phone AS driver_phone, d.vehicle_type AS driver_vehicle
         FROM delivery_missions m
         LEFT JOIN delivery_drivers d ON d.id = m.driver_id
         WHERE m.id=$1`,
        [req.params.id]
      );
      const mission = rows[0];
      if (!mission) return res.status(404).json({ error: "Mission introuvable" });

      const driver = await getDriverByUser(req.user.id);
      const isClient = mission.client_user_id === req.user.id;
      const isDriver = driver && mission.driver_id === driver.id;
      const isSuperAdmin = req.user.role === "super_admin";
      if (!isClient && !isDriver && !isSuperAdmin) {
        return res.status(403).json({ error: "Accès refusé" });
      }
      res.json(mission);
    } catch (error) {
      console.error("delivery mission detail:", error);
      res.status(500).json({ error: "Erreur détail mission" });
    }
  });

  // Noter le livreur après livraison (client créateur uniquement)
  router.post("/missions/:id/rating", async (req, res) => {
    try {
      const rating = Number(req.body?.rating);
      const comment = String(req.body?.comment || "").slice(0, 1000);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        return res.status(400).json({ error: "Note invalide (1 à 5)" });
      }

      const { rows } = await pool.query(
        `SELECT * FROM delivery_missions
         WHERE id=$1 AND client_user_id=$2 AND status IN ('livree','terminee') AND driver_id IS NOT NULL`,
        [req.params.id, req.user.id]
      );
      const mission = rows[0];
      if (!mission) return res.status(409).json({ error: "Notation impossible" });

      await pool.query(
        `INSERT INTO delivery_ratings (mission_id, driver_id, client_user_id, rating, comment)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (mission_id) DO UPDATE SET rating=EXCLUDED.rating, comment=EXCLUDED.comment`,
        [mission.id, mission.driver_id, req.user.id, rating, comment || null]
      );

      await pool.query(
        `UPDATE delivery_drivers d SET
           rating_avg = sub.avg, rating_count = sub.cnt, updated_at=NOW()
         FROM (SELECT AVG(rating)::numeric(3,2) AS avg, COUNT(*) AS cnt
               FROM delivery_ratings WHERE driver_id=$1) sub
         WHERE d.id=$1`,
        [mission.driver_id]
      );
      res.json({ ok: true });
    } catch (error) {
      console.error("delivery rating:", error);
      res.status(500).json({ error: "Erreur notation" });
    }
  });

  // ---------- ADMINISTRATION ----------

  router.get(
    "/admin/drivers",
    authorizeRoles("super_admin", "admin"),
    async (req, res) => {
      try {
        const { rows } = await pool.query(
          `SELECT d.*, u.name AS user_name, u.email AS user_email
           FROM delivery_drivers d JOIN users u ON u.id = d.user_id
           WHERE d.tenant_id=$1 ORDER BY d.created_at DESC LIMIT 200`,
          [req.tenant_id || "malilink"]
        );
        res.json(rows);
      } catch (error) {
        console.error("delivery admin drivers:", error);
        res.status(500).json({ error: "Erreur liste livreurs" });
      }
    }
  );

  router.put(
    "/admin/drivers/:id/verify",
    authorizeRoles("super_admin", "admin"),
    async (req, res) => {
      try {
        const { is_verified = true, status } = req.body || {};
        const { rows } = await pool.query(
          `UPDATE delivery_drivers
           SET is_verified=$1, status=COALESCE($2, status), updated_at=NOW()
           WHERE id=$3 RETURNING *`,
          [Boolean(is_verified), status || null, req.params.id]
        );
        if (!rows[0]) return res.status(404).json({ error: "Livreur introuvable" });
        res.json(rows[0]);
      } catch (error) {
        console.error("delivery verify:", error);
        res.status(500).json({ error: "Erreur vérification" });
      }
    }
  );

  router.get(
    "/admin/missions",
    authorizeRoles("super_admin", "admin"),
    async (req, res) => {
      try {
        const { rows } = await pool.query(
          `SELECT * FROM delivery_missions
           WHERE tenant_id=$1 ORDER BY requested_at DESC LIMIT 200`,
          [req.tenant_id || "malilink"]
        );
        res.json(rows);
      } catch (error) {
        console.error("delivery admin missions:", error);
        res.status(500).json({ error: "Erreur missions admin" });
      }
    }
  );

  return router;
};
