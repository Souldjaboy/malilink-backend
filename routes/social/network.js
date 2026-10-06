"use strict";

/**
 * MaliLink Social — Réseau : tout ce qui relie deux personnes, regroupé
 * hors de la messagerie (demandes d'amitié reçues et envoyées, amis,
 * abonnés, abonnements, demandes d'abonnement, suggestions, publications
 * d'un profil) et les compteurs de la barre de navigation.
 *
 * Règles appliquées côté backend :
 * - jamais de profil bloqué, dans un sens ou dans l'autre ;
 * - les publications d'un profil respectent l'audience de chacune ;
 * - une demande n'est annulable que par son auteur, une demande
 *   d'abonnement n'est tranchée que par la personne suivie.
 */

module.exports = function registerNetworkRoutes(router, { pool, helpers, createNotification, media }) {
  const { isBlockedEitherWay, areFriends, getProfile, getPrivacy } = helpers;

  const PROFILE_COLUMNS = `p.user_id, p.display_name, p.username, p.photo_url, p.city,
                           p.profession, p.verified_level`;

  /* Exclut tout profil bloqué dans un sens ou dans l'autre ($1 = moi). */
  const NOT_BLOCKED = (column) => `NOT EXISTS (
      SELECT 1 FROM social_blocks b
      WHERE (b.blocker_user_id=$1 AND b.blocked_user_id=${column})
         OR (b.blocker_user_id=${column} AND b.blocked_user_id=$1))`;

  /* ---------- Compteurs (badges de navigation) ---------- */
  router.get("/network/summary", async (req, res) => {
    try {
      const me = req.user.id;
      const { rows } = await pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM social_friend_requests fr
             WHERE fr.to_user_id=$1 AND fr.status='pending' AND ${NOT_BLOCKED("fr.from_user_id")}) AS demandes_recues,
           (SELECT COUNT(*)::int FROM social_friend_requests fr
             WHERE fr.from_user_id=$1 AND fr.status='pending') AS demandes_envoyees,
           (SELECT COUNT(*)::int FROM social_follows fo
             WHERE fo.followed_user_id=$1 AND fo.status='pending' AND ${NOT_BLOCKED("fo.follower_user_id")}) AS demandes_abonnement,
           (SELECT COUNT(*)::int FROM social_friendships f WHERE f.user_a=$1 OR f.user_b=$1) AS amis,
           (SELECT COUNT(*)::int FROM social_follows fo
             WHERE fo.followed_user_id=$1 AND fo.status='active') AS abonnes,
           (SELECT COUNT(*)::int FROM social_follows fo
             WHERE fo.follower_user_id=$1 AND fo.status='active') AS abonnements,
           (SELECT COUNT(*)::int FROM social_matches m WHERE m.user_a=$1 OR m.user_b=$1) AS matchs,
           (SELECT COALESCE(SUM(x.n),0)::int FROM (
              SELECT (SELECT COUNT(*) FROM social_messages sm
                       WHERE sm.conversation_id=cm.conversation_id AND sm.deleted_at IS NULL
                         AND sm.sender_user_id <> $1
                         AND sm.id > COALESCE(cm.last_read_message_id,0)) AS n
              FROM social_conversation_members cm WHERE cm.user_id=$1) x) AS messages_non_lus`,
        [me]
      );
      res.json(rows[0]);
    } catch (error) {
      console.error("ERREUR SOCIAL NETWORK SUMMARY :", error.message);
      res.status(500).json({ error: "Erreur chargement du réseau." });
    }
  });

  /* ---------- Demandes d'amitié envoyées ---------- */
  router.get("/friend-requests/sent", async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT fr.id, fr.to_user_id AS user_id, fr.created_at, ${PROFILE_COLUMNS}
         FROM social_friend_requests fr
         JOIN social_profiles p ON p.user_id=fr.to_user_id AND p.deleted_at IS NULL
         WHERE fr.from_user_id=$1 AND fr.status='pending' AND ${NOT_BLOCKED("fr.to_user_id")}
         ORDER BY fr.created_at DESC LIMIT 200`,
        [req.user.id]
      );
      res.json(rows);
    } catch (error) {
      res.status(500).json({ error: "Erreur chargement des demandes envoyées." });
    }
  });

  router.delete("/friend-requests/:id", async (req, res) => {
    try {
      const { rows } = await pool.query(
        `UPDATE social_friend_requests SET status='cancelled', responded_at=NOW()
         WHERE id=$1 AND from_user_id=$2 AND status='pending' RETURNING id`,
        [Number(req.params.id), req.user.id]
      );
      if (!rows[0]) return res.status(404).json({ error: "Demande introuvable." });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Erreur annulation de la demande." });
    }
  });

  /* ---------- Abonnés / abonnements ---------- */
  router.get("/followers", async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT fo.created_at, ${PROFILE_COLUMNS},
                EXISTS (SELECT 1 FROM social_follows back
                        WHERE back.follower_user_id=$1 AND back.followed_user_id=fo.follower_user_id
                          AND back.status='active') AS je_le_suis,
                EXISTS (SELECT 1 FROM social_friendships f
                        WHERE f.user_a=LEAST($1, fo.follower_user_id)
                          AND f.user_b=GREATEST($1, fo.follower_user_id)) AS ami
         FROM social_follows fo
         JOIN social_profiles p ON p.user_id=fo.follower_user_id AND p.deleted_at IS NULL
         WHERE fo.followed_user_id=$1 AND fo.status='active' AND ${NOT_BLOCKED("fo.follower_user_id")}
         ORDER BY fo.created_at DESC LIMIT 500`,
        [req.user.id]
      );
      res.json(rows);
    } catch (error) {
      res.status(500).json({ error: "Erreur chargement des abonnés." });
    }
  });

  router.get("/following", async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT fo.created_at, ${PROFILE_COLUMNS},
                EXISTS (SELECT 1 FROM social_friendships f
                        WHERE f.user_a=LEAST($1, fo.followed_user_id)
                          AND f.user_b=GREATEST($1, fo.followed_user_id)) AS ami
         FROM social_follows fo
         JOIN social_profiles p ON p.user_id=fo.followed_user_id AND p.deleted_at IS NULL
         WHERE fo.follower_user_id=$1 AND fo.status='active' AND ${NOT_BLOCKED("fo.followed_user_id")}
         ORDER BY fo.created_at DESC LIMIT 500`,
        [req.user.id]
      );
      res.json(rows);
    } catch (error) {
      res.status(500).json({ error: "Erreur chargement des abonnements." });
    }
  });

  /* Retirer quelqu'un de ses abonnés (il pourra redemander). */
  router.delete("/followers/:userId", async (req, res) => {
    try {
      await pool.query(
        `DELETE FROM social_follows WHERE follower_user_id=$1 AND followed_user_id=$2`,
        [Number(req.params.userId), req.user.id]
      );
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Erreur retrait de l'abonné." });
    }
  });

  /* Demandes d'abonnement (profil privé ou validation exigée). */
  router.get("/follow-requests", async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT fo.follower_user_id AS user_id, fo.created_at, ${PROFILE_COLUMNS}
         FROM social_follows fo
         JOIN social_profiles p ON p.user_id=fo.follower_user_id AND p.deleted_at IS NULL
         WHERE fo.followed_user_id=$1 AND fo.status='pending' AND ${NOT_BLOCKED("fo.follower_user_id")}
         ORDER BY fo.created_at DESC LIMIT 200`,
        [req.user.id]
      );
      res.json(rows);
    } catch (error) {
      res.status(500).json({ error: "Erreur chargement des demandes d'abonnement." });
    }
  });

  router.post("/follow-requests/:userId/respond", async (req, res) => {
    try {
      const follower = Number(req.params.userId);
      const accept = req.body?.accept === true;
      const { rows } = accept
        ? await pool.query(
            `UPDATE social_follows SET status='active'
             WHERE follower_user_id=$1 AND followed_user_id=$2 AND status='pending' RETURNING follower_user_id`,
            [follower, req.user.id]
          )
        : await pool.query(
            `DELETE FROM social_follows
             WHERE follower_user_id=$1 AND followed_user_id=$2 AND status='pending' RETURNING follower_user_id`,
            [follower, req.user.id]
          );
      if (!rows[0]) return res.status(404).json({ error: "Demande introuvable." });
      if (accept && createNotification) {
        await createNotification({
          user_id: follower,
          title: "Demande d'abonnement acceptée",
          message: "Vous suivez désormais ce profil sur MaliLink Social.",
          type: "social_follow_accepted",
          company_id: null
        }).catch(() => {});
      }
      res.json({ success: true, accepted: accept });
    } catch (error) {
      res.status(500).json({ error: "Erreur réponse à la demande d'abonnement." });
    }
  });

  /* ---------- Suggestions ----------
     Personnes à rencontrer : profils publics actifs, jamais bloqués, que je
     ne connais pas encore (ni ami, ni suivi, ni demande en cours), classés
     par amis en commun, même ville, profil complet, activité récente. */
  router.get("/suggestions", async (req, res) => {
    try {
      const me = await getProfile(req.user.id);
      if (!me || me.is_active === false) return res.json([]);
      const { rows } = await pool.query(
        `SELECT ${PROFILE_COLUMNS},
                (SELECT COUNT(*)::int FROM social_friendships f1
                   JOIN social_friendships f2
                     ON (CASE WHEN f1.user_a=$1 THEN f1.user_b ELSE f1.user_a END)
                      = (CASE WHEN f2.user_a=p.user_id THEN f2.user_b ELSE f2.user_a END)
                  WHERE (f1.user_a=$1 OR f1.user_b=$1)
                    AND (f2.user_a=p.user_id OR f2.user_b=p.user_id)) AS amis_communs
         FROM social_profiles p
         LEFT JOIN social_privacy_settings pr ON pr.user_id=p.user_id
         WHERE p.deleted_at IS NULL AND p.is_active=true AND p.is_public=true
           AND p.tenant_id=$2 AND p.user_id <> $1
           AND COALESCE(pr.allow_suggestions, true)=true
           AND ${NOT_BLOCKED("p.user_id")}
           AND NOT EXISTS (SELECT 1 FROM social_friendships f
                           WHERE f.user_a=LEAST($1,p.user_id) AND f.user_b=GREATEST($1,p.user_id))
           AND NOT EXISTS (SELECT 1 FROM social_follows fo
                           WHERE fo.follower_user_id=$1 AND fo.followed_user_id=p.user_id)
           AND NOT EXISTS (SELECT 1 FROM social_friend_requests fr
                           WHERE fr.status='pending'
                             AND ((fr.from_user_id=$1 AND fr.to_user_id=p.user_id)
                               OR (fr.from_user_id=p.user_id AND fr.to_user_id=$1)))
         ORDER BY amis_communs DESC,
                  (CASE WHEN p.city <> '' AND p.city=$3 THEN 1 ELSE 0 END) DESC,
                  (CASE WHEN p.bio <> '' AND p.photo_url <> '' THEN 1 ELSE 0 END) DESC,
                  p.updated_at DESC
         LIMIT 30`,
        [req.user.id, req.tenant_id || "malilink", me.city || ""]
      );
      res.json(rows);
    } catch (error) {
      console.error("ERREUR SOCIAL SUGGESTIONS :", error.message);
      res.status(500).json({ error: "Erreur chargement des suggestions." });
    }
  });

  /* ---------- Relation avec un profil (boutons de la fiche) ---------- */
  router.get("/relations/:userId", async (req, res) => {
    try {
      const other = Number(req.params.userId);
      if (!other) return res.status(400).json({ error: "Profil invalide." });
      if (other !== req.user.id && (await isBlockedEitherWay(req.user.id, other))) {
        return res.status(404).json({ error: "Profil introuvable." });
      }
      const { rows } = await pool.query(
        `SELECT
           EXISTS (SELECT 1 FROM social_friendships f
                   WHERE f.user_a=LEAST($1::int,$2::int) AND f.user_b=GREATEST($1::int,$2::int)) AS ami,
           (SELECT status FROM social_follows WHERE follower_user_id=$1 AND followed_user_id=$2) AS abonnement,
           (SELECT status FROM social_follows WHERE follower_user_id=$2 AND followed_user_id=$1) AS abonne,
           (SELECT id FROM social_friend_requests
             WHERE from_user_id=$1 AND to_user_id=$2 AND status='pending') AS demande_envoyee_id,
           (SELECT id FROM social_friend_requests
             WHERE from_user_id=$2 AND to_user_id=$1 AND status='pending') AS demande_recue_id`,
        [req.user.id, other]
      );
      res.json(rows[0]);
    } catch (error) {
      res.status(500).json({ error: "Erreur chargement de la relation." });
    }
  });

  /* ---------- Publications d'un profil ----------
     Même règle que le fil : chaque publication n'est rendue que si son
     audience l'autorise pour MOI. Pagination par curseur (id décroissant). */
  router.get("/users/:userId/posts", async (req, res) => {
    try {
      const author = Number(req.params.userId);
      if (!author) return res.status(400).json({ error: "Profil invalide." });
      if (author !== req.user.id && (await isBlockedEitherWay(req.user.id, author))) {
        return res.status(404).json({ error: "Profil introuvable." });
      }
      const profile = await getProfile(author);
      if (!profile || profile.is_active === false) return res.status(404).json({ error: "Profil introuvable." });
      const friends = author === req.user.id ? true : await areFriends(req.user.id, author);
      if (profile.is_public === false && !friends) return res.json({ posts: [], next_cursor: null, prive: true });
      const following = author === req.user.id ? true : await helpers.isFollowing(req.user.id, author);
      const audiences = author === req.user.id
        ? ["public", "friends", "followers", "me"]
        : ["public", ...(friends ? ["friends"] : []), ...(following ? ["followers"] : [])];
      const limit = Math.min(Math.max(Number(req.query.limit) || 15, 1), 50);
      const before = Number(req.query.before) || null;
      const { rows } = await pool.query(
        `SELECT po.*, p.display_name, p.photo_url AS author_photo, p.verified_level,
                EXISTS (SELECT 1 FROM social_post_likes l WHERE l.post_id=po.id AND l.user_id=$1) AS liked_by_me,
                EXISTS (SELECT 1 FROM social_saved_posts s WHERE s.post_id=po.id AND s.user_id=$1) AS saved_by_me
         FROM social_posts po
         JOIN social_profiles p ON p.user_id=po.user_id
         WHERE po.user_id=$2 AND po.deleted_at IS NULL AND po.audience = ANY($3)
           AND ($4::bigint IS NULL OR po.id < $4)
         ORDER BY po.id DESC LIMIT $5`,
        [req.user.id, author, audiences, before, limit + 1]
      );
      const page = rows.slice(0, limit);
      const posts = media ? await media.attachToPosts(page) : page;
      res.json({ posts, next_cursor: rows.length > limit ? page[page.length - 1].id : null, prive: false });
    } catch (error) {
      console.error("ERREUR SOCIAL USER POSTS :", error.message);
      res.status(500).json({ error: "Erreur chargement des publications." });
    }
  });

  /* Confidentialité de la liste d'amis d'un autre profil. */
  router.get("/users/:userId/friends", async (req, res) => {
    try {
      const other = Number(req.params.userId);
      if (!other) return res.status(400).json({ error: "Profil invalide." });
      if (other !== req.user.id) {
        if (await isBlockedEitherWay(req.user.id, other)) return res.status(404).json({ error: "Profil introuvable." });
        const privacy = await getPrivacy(other);
        if (privacy?.show_friends === false) return res.json([]);
      }
      const { rows } = await pool.query(
        `SELECT ${PROFILE_COLUMNS}
         FROM social_friendships f
         JOIN social_profiles p ON p.user_id = CASE WHEN f.user_a=$2 THEN f.user_b ELSE f.user_a END
         WHERE (f.user_a=$2 OR f.user_b=$2) AND p.deleted_at IS NULL AND ${NOT_BLOCKED("p.user_id")}
         ORDER BY p.display_name LIMIT 300`,
        [req.user.id, other]
      );
      res.json(rows);
    } catch (error) {
      res.status(500).json({ error: "Erreur chargement des amis." });
    }
  });
};
