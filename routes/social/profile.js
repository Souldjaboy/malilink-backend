"use strict";

/**
 * MaliLink Social — profil, préférences, confidentialité.
 * Un utilisateur MaliLink existant ACTIVE son profil social :
 * aucune duplication de compte, users.id reste l'identité centrale.
 */

module.exports = function registerProfileRoutes(router, { pool, helpers }) {
  const { ageFromBirthDate, getProfile, getPrivacy, sanitizeStringArray, GOALS } = helpers;

  /* Mon espace social : profil + préférences + confidentialité.
     activated=false → le frontend propose l'onboarding /social/profile/setup. */
  router.get("/me", async (req, res) => {
    try {
      const profile = await getProfile(req.user.id);
      if (!profile) {
        return res.json({ activated: false });
      }
      const [preferences, privacy] = await Promise.all([
        pool.query("SELECT * FROM social_preferences WHERE user_id=$1", [req.user.id]),
        pool.query("SELECT * FROM social_privacy_settings WHERE user_id=$1", [req.user.id])
      ]);
      res.json({
        activated: true,
        profile: { ...profile, age: ageFromBirthDate(profile.birth_date) },
        preferences: preferences.rows[0] || null,
        privacy: privacy.rows[0] || null
      });
    } catch (error) {
      console.error("ERREUR SOCIAL ME :", error.message);
      res.status(500).json({ error: "Erreur chargement du profil social." });
    }
  });

  /* Activation / mise à jour du profil social. */
  router.post("/profile", async (req, res) => {
    try {
      const {
        username,
        display_name,
        bio = "",
        photo_url = "",
        cover_url = "",
        birth_date,
        gender = "",
        city = "",
        country = "Mali",
        languages,
        profession = "",
        company_name = "",
        goals,
        interests,
        is_public = true,
        dating_opt_in = false
      } = req.body || {};

      const cleanDisplayName = String(display_name || "").trim().slice(0, 80);
      if (!cleanDisplayName) {
        return res.status(400).json({ error: "Le nom affiché est obligatoire." });
      }

      const cleanUsername = String(username || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, "")
        .slice(0, 30) || null;

      const age = ageFromBirthDate(birth_date);
      if (!birth_date || age === null) {
        return res.status(400).json({ error: "Date de naissance obligatoire (contrôle d'âge)." });
      }
      if (age < 13) {
        return res.status(403).json({ error: "MaliLink Social est réservé aux 13 ans et plus." });
      }

      // Rencontres : opt-in explicite ET 18 ans minimum, contrôlé ici.
      const cleanGoals = sanitizeStringArray(goals).filter((goal) => GOALS.includes(goal));
      const wantsDating = dating_opt_in === true || cleanGoals.includes("rencontres");
      if (wantsDating && age < 18) {
        return res.status(403).json({
          error: "Le mode rencontres est réservé aux personnes majeures (18 ans et plus)."
        });
      }
      const finalGoals = wantsDating && age >= 18
        ? cleanGoals
        : cleanGoals.filter((goal) => goal !== "rencontres");

      if (cleanUsername) {
        const taken = await pool.query(
          `SELECT 1 FROM social_profiles
           WHERE LOWER(username)=LOWER($1) AND user_id<>$2 AND deleted_at IS NULL LIMIT 1`,
          [cleanUsername, req.user.id]
        );
        if (taken.rows.length > 0) {
          return res.status(400).json({ error: "Ce pseudonyme est déjà utilisé." });
        }
      }

      const values = [
        req.user.id,
        req.tenant_id || "malilink",
        cleanUsername,
        cleanDisplayName,
        String(bio || "").slice(0, 1000),
        String(photo_url || "").slice(0, 500),
        String(cover_url || "").slice(0, 500),
        birth_date,
        String(gender || "").slice(0, 30),
        String(city || "").slice(0, 80),
        String(country || "Mali").slice(0, 80),
        JSON.stringify(sanitizeStringArray(languages, { maxItems: 8 })),
        String(profession || "").slice(0, 120),
        String(company_name || "").slice(0, 120),
        JSON.stringify(finalGoals),
        JSON.stringify(sanitizeStringArray(interests, { maxItems: 25 })),
        is_public !== false,
        wantsDating && age >= 18
      ];

      const { rows } = await pool.query(
        `INSERT INTO social_profiles
           (user_id, tenant_id, username, display_name, bio, photo_url, cover_url,
            birth_date, gender, city, country, languages, profession, company_name,
            goals, interests, is_public, dating_opt_in, is_active, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,true,NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           username=EXCLUDED.username,
           display_name=EXCLUDED.display_name,
           bio=EXCLUDED.bio,
           photo_url=EXCLUDED.photo_url,
           cover_url=EXCLUDED.cover_url,
           birth_date=EXCLUDED.birth_date,
           gender=EXCLUDED.gender,
           city=EXCLUDED.city,
           country=EXCLUDED.country,
           languages=EXCLUDED.languages,
           profession=EXCLUDED.profession,
           company_name=EXCLUDED.company_name,
           goals=EXCLUDED.goals,
           interests=EXCLUDED.interests,
           is_public=EXCLUDED.is_public,
           dating_opt_in=EXCLUDED.dating_opt_in,
           is_active=true,
           deleted_at=NULL,
           updated_at=NOW()
         RETURNING *`,
        values
      );

      // Confidentialité et préférences par défaut (visibilité minimale
      // pour la rencontre : dating_enabled suit l'opt-in explicite).
      await pool.query(
        `INSERT INTO social_privacy_settings (user_id, dating_enabled)
         VALUES ($1,$2)
         ON CONFLICT (user_id) DO UPDATE SET dating_enabled=$2, updated_at=NOW()`,
        [req.user.id, wantsDating && age >= 18]
      );
      await pool.query(
        `INSERT INTO social_preferences (user_id) VALUES ($1)
         ON CONFLICT (user_id) DO NOTHING`,
        [req.user.id]
      );

      res.status(201).json({
        success: true,
        message: "Profil social activé avec succès.",
        profile: { ...rows[0], age }
      });
    } catch (error) {
      console.error("ERREUR SOCIAL PROFILE :", error.message);
      res.status(500).json({ error: "Erreur enregistrement du profil social." });
    }
  });

  /* Préférences de découverte (uniquement déclarées par l'utilisateur). */
  router.put("/preferences", async (req, res) => {
    try {
      const {
        discover_genders,
        age_min,
        age_max,
        city = "",
        country = "",
        languages,
        goals,
        verified_only = false,
        online_only = false,
        profile_types
      } = req.body || {};

      const cleanAgeMin = Math.max(13, Math.min(99, Number(age_min) || 18));
      const cleanAgeMax = Math.max(cleanAgeMin, Math.min(99, Number(age_max) || 99));

      const { rows } = await pool.query(
        `INSERT INTO social_preferences
           (user_id, discover_genders, age_min, age_max, city, country,
            languages, goals, verified_only, online_only, profile_types, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           discover_genders=EXCLUDED.discover_genders,
           age_min=EXCLUDED.age_min,
           age_max=EXCLUDED.age_max,
           city=EXCLUDED.city,
           country=EXCLUDED.country,
           languages=EXCLUDED.languages,
           goals=EXCLUDED.goals,
           verified_only=EXCLUDED.verified_only,
           online_only=EXCLUDED.online_only,
           profile_types=EXCLUDED.profile_types,
           updated_at=NOW()
         RETURNING *`,
        [
          req.user.id,
          JSON.stringify(helpers.sanitizeStringArray(discover_genders, { maxItems: 3 })),
          cleanAgeMin,
          cleanAgeMax,
          String(city || "").slice(0, 80),
          String(country || "").slice(0, 80),
          JSON.stringify(helpers.sanitizeStringArray(languages, { maxItems: 8 })),
          JSON.stringify(helpers.sanitizeStringArray(goals, { maxItems: 10 })),
          verified_only === true,
          online_only === true,
          JSON.stringify(helpers.sanitizeStringArray(profile_types, { maxItems: 6 }))
        ]
      );
      res.json({ success: true, preferences: rows[0] });
    } catch (error) {
      console.error("ERREUR SOCIAL PREFERENCES :", error.message);
      res.status(500).json({ error: "Erreur enregistrement des préférences." });
    }
  });

  /* Confidentialité — appliquée côté backend à chaque interaction. */
  router.put("/privacy", async (req, res) => {
    try {
      const profile = await getProfile(req.user.id);
      if (!profile) return res.status(400).json({ error: "Activez d'abord votre profil social." });

      const body = req.body || {};
      const enumOr = (value, allowed, fallback) =>
        allowed.includes(value) ? value : fallback;
      const boolOr = (value, fallback) => (typeof value === "boolean" ? value : fallback);

      const current = (await getPrivacy(req.user.id)) || {};
      const age = ageFromBirthDate(profile.birth_date);
      const datingRequested = boolOr(body.dating_enabled, current.dating_enabled === true);
      const datingEnabled = datingRequested && age !== null && age >= 18 && profile.dating_opt_in === true;

      const { rows } = await pool.query(
        `INSERT INTO social_privacy_settings
           (user_id, who_can_follow, who_can_friend, who_can_message, who_can_call,
            who_can_comment, show_age, show_city, show_friends, show_online,
            show_last_seen, allow_suggestions, dating_enabled, random_video_enabled, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           who_can_follow=EXCLUDED.who_can_follow,
           who_can_friend=EXCLUDED.who_can_friend,
           who_can_message=EXCLUDED.who_can_message,
           who_can_call=EXCLUDED.who_can_call,
           who_can_comment=EXCLUDED.who_can_comment,
           show_age=EXCLUDED.show_age,
           show_city=EXCLUDED.show_city,
           show_friends=EXCLUDED.show_friends,
           show_online=EXCLUDED.show_online,
           show_last_seen=EXCLUDED.show_last_seen,
           allow_suggestions=EXCLUDED.allow_suggestions,
           dating_enabled=EXCLUDED.dating_enabled,
           random_video_enabled=EXCLUDED.random_video_enabled,
           updated_at=NOW()
         RETURNING *`,
        [
          req.user.id,
          enumOr(body.who_can_follow, ["everyone", "approval"], current.who_can_follow || "everyone"),
          enumOr(body.who_can_friend, ["everyone", "friends_of_friends", "nobody"], current.who_can_friend || "everyone"),
          enumOr(body.who_can_message, ["everyone", "friends", "nobody"], current.who_can_message || "friends"),
          enumOr(body.who_can_call, ["everyone", "friends", "nobody"], current.who_can_call || "friends"),
          enumOr(body.who_can_comment, ["everyone", "friends", "nobody"], current.who_can_comment || "everyone"),
          boolOr(body.show_age, current.show_age === true),
          boolOr(body.show_city, current.show_city !== false),
          boolOr(body.show_friends, current.show_friends !== false),
          boolOr(body.show_online, current.show_online !== false),
          boolOr(body.show_last_seen, current.show_last_seen === true),
          boolOr(body.allow_suggestions, current.allow_suggestions !== false),
          datingEnabled,
          false // vidéo aléatoire : désactivée tant que la phase 9 n'est pas auditée
        ]
      );
      res.json({ success: true, privacy: rows[0] });
    } catch (error) {
      console.error("ERREUR SOCIAL PRIVACY :", error.message);
      res.status(500).json({ error: "Erreur enregistrement de la confidentialité." });
    }
  });

  /* Désactivation du profil social (le compte MaliLink général reste intact). */
  router.delete("/profile", async (req, res) => {
    try {
      await pool.query(
        `UPDATE social_profiles
         SET is_active=false, deleted_at=NOW(), updated_at=NOW()
         WHERE user_id=$1`,
        [req.user.id]
      );
      res.json({
        success: true,
        message: "Profil social désactivé. Votre compte MaliLink reste actif."
      });
    } catch (error) {
      console.error("ERREUR SOCIAL PROFILE DELETE :", error.message);
      res.status(500).json({ error: "Erreur désactivation du profil social." });
    }
  });
};
