"use strict";

/**
 * MaliLink Social — découverte, swipe, matchs, follow, amitié,
 * blocage et signalement.
 *
 * Règles appliquées côté backend :
 * - jamais de profil bloqué (dans un sens ou l'autre) ;
 * - la section rencontres n'apparie que des adultes (18+) ayant
 *   explicitement opté pour la visibilité rencontre, des deux côtés ;
 * - l'algorithme n'utilise que les préférences déclarées.
 */

module.exports = function registerDiscoveryRoutes(router, { pool, helpers, createNotification }) {
  const {
    getProfile,
    getPrivacy,
    isBlockedEitherWay,
    areFriends,
    publicProfileView,
    ageFromBirthDate,
    REPORT_REASONS
  } = helpers;

  async function requireActivatedProfile(req, res) {
    const profile = await getProfile(req.user.id);
    if (!profile || profile.is_active === false) {
      res.status(400).json({ error: "Activez d'abord votre profil social." });
      return null;
    }
    return profile;
  }

  /* ---------- Découverte ---------- */
  router.get("/discover", async (req, res) => {
    try {
      const me = await requireActivatedProfile(req, res);
      if (!me) return;

      const section = String(req.query.section || "pour_vous");
      const myPrefs =
        (await pool.query("SELECT * FROM social_preferences WHERE user_id=$1", [req.user.id]))
          .rows[0] || {};
      const myPrivacy = await getPrivacy(req.user.id);
      const myAge = ageFromBirthDate(me.birth_date);

      const datingSection = section === "rencontres";
      if (datingSection) {
        const flags = await helpers.getFeatureFlags();
        if (flags.social_dating_enabled === false) {
          return res.status(503).json({ error: "Le mode rencontres est désactivé pour le moment." });
        }
        if (myAge === null || myAge < 18 || me.dating_opt_in !== true || myPrivacy?.dating_enabled !== true) {
          return res.status(403).json({
            error: "Le mode rencontres est réservé aux adultes ayant activé cette option."
          });
        }
      }

      const values = [req.user.id, req.tenant_id || "malilink"];
      let where = `
        p.deleted_at IS NULL
        AND p.is_active=true
        AND p.is_public=true
        AND p.tenant_id=$2
        AND p.user_id <> $1
        AND NOT EXISTS (
          SELECT 1 FROM social_blocks b
          WHERE (b.blocker_user_id=$1 AND b.blocked_user_id=p.user_id)
             OR (b.blocker_user_id=p.user_id AND b.blocked_user_id=$1)
        )
        AND NOT EXISTS (
          SELECT 1 FROM social_swipes s
          WHERE s.swiper_user_id=$1 AND s.target_user_id=p.user_id
        )
        AND COALESCE(pr.allow_suggestions, true) = true
      `;

      if (datingSection) {
        // Des deux côtés : adulte + opt-in + confidentialité rencontre active.
        where += `
          AND p.dating_opt_in=true
          AND COALESCE(pr.dating_enabled,false)=true
          AND p.birth_date IS NOT NULL
          AND date_part('year', age(p.birth_date)) >= 18
        `;
      }

      const genders = Array.isArray(myPrefs.discover_genders) ? myPrefs.discover_genders : [];
      if (genders.length > 0) {
        values.push(genders);
        where += ` AND p.gender = ANY($${values.length})`;
      }
      if (section === "meme_ville" || myPrefs.city) {
        const city = section === "meme_ville" ? me.city : myPrefs.city;
        if (city) {
          values.push(`%${city}%`);
          where += ` AND p.city ILIKE $${values.length}`;
        }
      }
      if (myPrefs.verified_only === true) {
        where += ` AND p.verified_level <> 'none'`;
      }
      const ageMin = Number(myPrefs.age_min) || 13;
      const ageMax = Number(myPrefs.age_max) || 99;
      values.push(ageMin, ageMax);
      where += ` AND (p.birth_date IS NULL OR date_part('year', age(p.birth_date))
        BETWEEN $${values.length - 1} AND $${values.length})`;

      // Score simple, explicable, non discriminatoire :
      // ville commune, langue commune, objectifs communs, intérêts communs,
      // profil vérifié, profil complet, activité récente.
      const { rows } = await pool.query(
        `SELECT p.*, pr.show_age, pr.show_city,
          (
            (CASE WHEN p.city <> '' AND p.city = $${values.push(me.city) && values.length} THEN 3 ELSE 0 END)
            + (CASE WHEN p.languages ?| ARRAY(SELECT jsonb_array_elements_text($${values.push(JSON.stringify(me.languages || [])) && values.length}::jsonb)) THEN 2 ELSE 0 END)
            + (CASE WHEN p.goals ?| ARRAY(SELECT jsonb_array_elements_text($${values.push(JSON.stringify(me.goals || [])) && values.length}::jsonb)) THEN 2 ELSE 0 END)
            + (CASE WHEN p.interests ?| ARRAY(SELECT jsonb_array_elements_text($${values.push(JSON.stringify(me.interests || [])) && values.length}::jsonb)) THEN 2 ELSE 0 END)
            + (CASE WHEN p.verified_level <> 'none' THEN 1 ELSE 0 END)
            + (CASE WHEN p.bio <> '' AND p.photo_url <> '' THEN 1 ELSE 0 END)
            + (CASE WHEN p.updated_at > NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END)
          ) AS match_score
         FROM social_profiles p
         LEFT JOIN social_privacy_settings pr ON pr.user_id=p.user_id
         WHERE ${where}
         ORDER BY match_score DESC, p.updated_at DESC
         LIMIT 30`,
        values
      );

      res.json(
        rows.map((row) =>
          publicProfileView(row, { show_age: row.show_age, show_city: row.show_city }, {
            match_score: row.match_score
          })
        )
      );
    } catch (error) {
      console.error("ERREUR SOCIAL DISCOVER :", error.message);
      res.status(500).json({ error: "Erreur chargement des suggestions." });
    }
  });

  /* ---------- Profil public d'un utilisateur ---------- */
  router.get("/profiles/:userId", async (req, res) => {
    try {
      const targetId = Number(req.params.userId);
      if (!targetId) return res.status(400).json({ error: "Profil invalide." });
      if (await isBlockedEitherWay(req.user.id, targetId)) {
        return res.status(404).json({ error: "Profil introuvable." });
      }
      const profile = await getProfile(targetId);
      if (!profile || profile.is_active === false) {
        return res.status(404).json({ error: "Profil introuvable." });
      }
      const privacy = await getPrivacy(targetId);
      const [friends, following, counts] = await Promise.all([
        areFriends(req.user.id, targetId),
        helpers.isFollowing(req.user.id, targetId),
        pool.query(
          `SELECT
             (SELECT COUNT(*)::int FROM social_follows WHERE followed_user_id=$1 AND status='active') AS followers,
             (SELECT COUNT(*)::int FROM social_follows WHERE follower_user_id=$1 AND status='active') AS following,
             (SELECT COUNT(*)::int FROM social_friendships WHERE user_a=LEAST($1,$2) AND user_b=GREATEST($1,$2)) AS _unused,
             (SELECT COUNT(*)::int FROM social_friendships WHERE user_a=$1 OR user_b=$1) AS friends`,
          [targetId, req.user.id]
        )
      ]);

      if (profile.is_public === false && !friends && targetId !== req.user.id) {
        return res.json({
          private: true,
          profile: {
            user_id: profile.user_id,
            display_name: profile.display_name,
            photo_url: profile.photo_url,
            is_public: false,
            verified_level: profile.verified_level
          }
        });
      }

      res.json({
        private: false,
        profile: publicProfileView(profile, privacy, {
          followers_count: counts.rows[0].followers,
          following_count: counts.rows[0].following,
          friends_count: privacy?.show_friends === false ? null : counts.rows[0].friends,
          is_friend: friends,
          is_following: following
        })
      });
    } catch (error) {
      console.error("ERREUR SOCIAL PROFILE VIEW :", error.message);
      res.status(500).json({ error: "Erreur chargement du profil." });
    }
  });

  /* ---------- Swipe + match réciproque ---------- */
  router.post("/swipes", async (req, res) => {
    try {
      const me = await requireActivatedProfile(req, res);
      if (!me) return;
      const targetId = Number(req.body?.target_user_id);
      const direction = req.body?.direction === "right" ? "right" : "left";
      if (!targetId || targetId === req.user.id) {
        return res.status(400).json({ error: "Cible invalide." });
      }
      if (await isBlockedEitherWay(req.user.id, targetId)) {
        return res.status(403).json({ error: "Interaction impossible avec ce profil." });
      }

      await pool.query(
        `INSERT INTO social_swipes (swiper_user_id, target_user_id, direction)
         VALUES ($1,$2,$3)
         ON CONFLICT (swiper_user_id, target_user_id)
         DO UPDATE SET direction=EXCLUDED.direction, created_at=NOW()`,
        [req.user.id, targetId, direction]
      );

      let matched = false;
      if (direction === "right") {
        const reciprocal = await pool.query(
          `SELECT 1 FROM social_swipes
           WHERE swiper_user_id=$1 AND target_user_id=$2 AND direction='right' LIMIT 1`,
          [targetId, req.user.id]
        );
        if (reciprocal.rows.length > 0) {
          const [a, b] = req.user.id < targetId ? [req.user.id, targetId] : [targetId, req.user.id];
          const inserted = await pool.query(
            `INSERT INTO social_matches (user_a, user_b) VALUES ($1,$2)
             ON CONFLICT (user_a, user_b) DO NOTHING RETURNING id`,
            [a, b]
          );
          matched = true;
          if (inserted.rows.length > 0 && createNotification) {
            for (const notifyId of [req.user.id, targetId]) {
              await createNotification({
                user_id: notifyId,
                title: "Nouveau match MaliLink Social 🤝",
                message: "Vous êtes connectés : vous vous êtes mutuellement trouvés intéressants.",
                type: "social_match",
                company_id: null
              }).catch(() => {});
            }
          }
        }
      }
      res.json({ success: true, matched });
    } catch (error) {
      console.error("ERREUR SOCIAL SWIPE :", error.message);
      res.status(500).json({ error: "Erreur enregistrement du swipe." });
    }
  });

  router.get("/matches", async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT m.id AS match_id, m.created_at,
                p.user_id, p.display_name, p.photo_url, p.city, p.verified_level
         FROM social_matches m
         JOIN social_profiles p
           ON p.user_id = CASE WHEN m.user_a=$1 THEN m.user_b ELSE m.user_a END
         WHERE (m.user_a=$1 OR m.user_b=$1) AND p.deleted_at IS NULL
         ORDER BY m.created_at DESC LIMIT 100`,
        [req.user.id]
      );
      res.json(rows);
    } catch (error) {
      console.error("ERREUR SOCIAL MATCHES :", error.message);
      res.status(500).json({ error: "Erreur chargement des matchs." });
    }
  });

  /* ---------- Suivre ---------- */
  router.post("/follows/:userId", async (req, res) => {
    try {
      const targetId = Number(req.params.userId);
      if (!targetId || targetId === req.user.id) return res.status(400).json({ error: "Cible invalide." });
      if (await isBlockedEitherWay(req.user.id, targetId)) {
        return res.status(403).json({ error: "Interaction impossible avec ce profil." });
      }
      const target = await getProfile(targetId);
      if (!target || target.is_active === false) return res.status(404).json({ error: "Profil introuvable." });
      const targetPrivacy = await getPrivacy(targetId);
      const needsApproval =
        target.is_public === false || targetPrivacy?.who_can_follow === "approval";

      await pool.query(
        `INSERT INTO social_follows (follower_user_id, followed_user_id, status)
         VALUES ($1,$2,$3)
         ON CONFLICT (follower_user_id, followed_user_id) DO NOTHING`,
        [req.user.id, targetId, needsApproval ? "pending" : "active"]
      );
      if (createNotification) {
        await createNotification({
          user_id: targetId,
          title: needsApproval ? "Demande d'abonnement" : "Nouvel abonné",
          message: needsApproval
            ? "Quelqu'un souhaite s'abonner à votre profil MaliLink Social."
            : "Vous avez un nouvel abonné sur MaliLink Social.",
          type: "social_follow",
          company_id: null
        }).catch(() => {});
      }
      res.json({ success: true, status: needsApproval ? "pending" : "active" });
    } catch (error) {
      console.error("ERREUR SOCIAL FOLLOW :", error.message);
      res.status(500).json({ error: "Erreur abonnement." });
    }
  });

  router.delete("/follows/:userId", async (req, res) => {
    try {
      await pool.query(
        `DELETE FROM social_follows WHERE follower_user_id=$1 AND followed_user_id=$2`,
        [req.user.id, Number(req.params.userId)]
      );
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Erreur désabonnement." });
    }
  });

  /* ---------- Amitié ---------- */
  router.post("/friend-requests", async (req, res) => {
    try {
      const targetId = Number(req.body?.to_user_id);
      if (!targetId || targetId === req.user.id) return res.status(400).json({ error: "Cible invalide." });
      if (await isBlockedEitherWay(req.user.id, targetId)) {
        return res.status(403).json({ error: "Interaction impossible avec ce profil." });
      }
      if (await areFriends(req.user.id, targetId)) {
        return res.status(400).json({ error: "Vous êtes déjà amis." });
      }
      const targetPrivacy = await getPrivacy(targetId);
      if (targetPrivacy?.who_can_friend === "nobody") {
        return res.status(403).json({ error: "Cette personne n'accepte pas de demandes d'amitié." });
      }

      await pool.query(
        `INSERT INTO social_friend_requests (from_user_id, to_user_id, message, status)
         VALUES ($1,$2,$3,'pending')
         ON CONFLICT (from_user_id, to_user_id)
         DO UPDATE SET status='pending', created_at=NOW(), responded_at=NULL`,
        [req.user.id, targetId, String(req.body?.message || "").slice(0, 300)]
      );
      if (createNotification) {
        await createNotification({
          user_id: targetId,
          title: "Demande d'amitié",
          message: "Vous avez reçu une demande d'amitié sur MaliLink Social.",
          type: "social_friend_request",
          company_id: null
        }).catch(() => {});
      }
      res.status(201).json({ success: true });
    } catch (error) {
      console.error("ERREUR SOCIAL FRIEND REQUEST :", error.message);
      res.status(500).json({ error: "Erreur demande d'amitié." });
    }
  });

  router.get("/friend-requests", async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT fr.id, fr.from_user_id, fr.message, fr.created_at,
                p.display_name, p.photo_url, p.city, p.verified_level
         FROM social_friend_requests fr
         JOIN social_profiles p ON p.user_id=fr.from_user_id AND p.deleted_at IS NULL
         WHERE fr.to_user_id=$1 AND fr.status='pending'
         ORDER BY fr.created_at DESC LIMIT 100`,
        [req.user.id]
      );
      res.json(rows);
    } catch (error) {
      res.status(500).json({ error: "Erreur chargement des demandes." });
    }
  });

  router.post("/friend-requests/:id/respond", async (req, res) => {
    try {
      const accept = req.body?.accept === true;
      const request = await pool.query(
        `UPDATE social_friend_requests
         SET status=$1, responded_at=NOW()
         WHERE id=$2 AND to_user_id=$3 AND status='pending'
         RETURNING from_user_id, to_user_id`,
        [accept ? "accepted" : "refused", Number(req.params.id), req.user.id]
      );
      if (!request.rows[0]) return res.status(404).json({ error: "Demande introuvable." });

      if (accept) {
        const { from_user_id, to_user_id } = request.rows[0];
        const [a, b] = from_user_id < to_user_id ? [from_user_id, to_user_id] : [to_user_id, from_user_id];
        await pool.query(
          `INSERT INTO social_friendships (user_a, user_b) VALUES ($1,$2)
           ON CONFLICT (user_a, user_b) DO NOTHING`,
          [a, b]
        );
        if (createNotification) {
          await createNotification({
            user_id: from_user_id,
            title: "Demande d'amitié acceptée 🎉",
            message: "Votre demande d'amitié a été acceptée sur MaliLink Social.",
            type: "social_friend_accepted",
            company_id: null
          }).catch(() => {});
        }
      }
      res.json({ success: true, accepted: accept });
    } catch (error) {
      console.error("ERREUR SOCIAL FRIEND RESPOND :", error.message);
      res.status(500).json({ error: "Erreur réponse à la demande." });
    }
  });

  router.get("/friends", async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT f.created_at,
                p.user_id, p.display_name, p.photo_url, p.city, p.verified_level
         FROM social_friendships f
         JOIN social_profiles p
           ON p.user_id = CASE WHEN f.user_a=$1 THEN f.user_b ELSE f.user_a END
         WHERE (f.user_a=$1 OR f.user_b=$1) AND p.deleted_at IS NULL
         ORDER BY p.display_name ASC LIMIT 500`,
        [req.user.id]
      );
      res.json(rows);
    } catch (error) {
      res.status(500).json({ error: "Erreur chargement des amis." });
    }
  });

  router.delete("/friends/:userId", async (req, res) => {
    try {
      const other = Number(req.params.userId);
      const [a, b] = req.user.id < other ? [req.user.id, other] : [other, req.user.id];
      await pool.query(`DELETE FROM social_friendships WHERE user_a=$1 AND user_b=$2`, [a, b]);
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Erreur retrait de l'ami." });
    }
  });

  /* ---------- Blocage ---------- */
  router.post("/blocks/:userId", async (req, res) => {
    try {
      const targetId = Number(req.params.userId);
      if (!targetId || targetId === req.user.id) return res.status(400).json({ error: "Cible invalide." });
      await pool.query(
        `INSERT INTO social_blocks (blocker_user_id, blocked_user_id) VALUES ($1,$2)
         ON CONFLICT (blocker_user_id, blocked_user_id) DO NOTHING`,
        [req.user.id, targetId]
      );
      // Le blocage coupe l'amitié, le suivi et le match dans les deux sens.
      const [a, b] = req.user.id < targetId ? [req.user.id, targetId] : [targetId, req.user.id];
      await pool.query(`DELETE FROM social_friendships WHERE user_a=$1 AND user_b=$2`, [a, b]);
      await pool.query(`DELETE FROM social_matches WHERE user_a=$1 AND user_b=$2`, [a, b]);
      await pool.query(
        `DELETE FROM social_follows
         WHERE (follower_user_id=$1 AND followed_user_id=$2)
            OR (follower_user_id=$2 AND followed_user_id=$1)`,
        [req.user.id, targetId]
      );
      res.json({ success: true, message: "Profil bloqué." });
    } catch (error) {
      console.error("ERREUR SOCIAL BLOCK :", error.message);
      res.status(500).json({ error: "Erreur blocage." });
    }
  });

  router.delete("/blocks/:userId", async (req, res) => {
    try {
      await pool.query(
        `DELETE FROM social_blocks WHERE blocker_user_id=$1 AND blocked_user_id=$2`,
        [req.user.id, Number(req.params.userId)]
      );
      res.json({ success: true, message: "Profil débloqué." });
    } catch (error) {
      res.status(500).json({ error: "Erreur déblocage." });
    }
  });

  router.get("/blocks", async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT b.blocked_user_id AS user_id, b.created_at, p.display_name, p.photo_url
         FROM social_blocks b
         LEFT JOIN social_profiles p ON p.user_id=b.blocked_user_id
         WHERE b.blocker_user_id=$1
         ORDER BY b.created_at DESC LIMIT 200`,
        [req.user.id]
      );
      res.json(rows);
    } catch (error) {
      res.status(500).json({ error: "Erreur chargement des blocages." });
    }
  });

  /* ---------- Signalement ---------- */
  router.post("/reports", async (req, res) => {
    try {
      const { target_user_id, target_type = "profile", target_id, reason, details = "", evidence_url = "" } =
        req.body || {};
      if (!REPORT_REASONS.includes(reason)) {
        return res.status(400).json({ error: "Motif de signalement invalide." });
      }
      await pool.query(
        `INSERT INTO social_reports
           (tenant_id, reporter_user_id, target_user_id, target_type, target_id,
            reason, details, evidence_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          req.tenant_id || "malilink",
          req.user.id,
          Number(target_user_id) || null,
          ["profile", "post", "comment", "message"].includes(target_type) ? target_type : "profile",
          Number(target_id) || null,
          reason,
          String(details).slice(0, 2000),
          String(evidence_url).slice(0, 500)
        ]
      );
      res.status(201).json({
        success: true,
        message: "Signalement envoyé. Notre équipe de modération va l'examiner."
      });
    } catch (error) {
      console.error("ERREUR SOCIAL REPORT :", error.message);
      res.status(500).json({ error: "Erreur envoi du signalement." });
    }
  });
};
