"use strict";

/**
 * MaliLink Social — publications, fil, likes, commentaires, sauvegardes.
 * Audiences appliquées côté backend : public | friends | followers | me.
 * Suppression logique uniquement (deleted_at).
 */

module.exports = function registerPostRoutes(router, { pool, helpers, createNotification }) {
  const { isBlockedEitherWay, areFriends, getPrivacy, getProfile } = helpers;

  const LINKED_TYPES = ["", "product", "shop", "company", "service", "restaurant", "hotel", "vehicle", "property", "job", "event"];

  /* Fil personnalisé : mes posts + amis + suivis + publics récents,
     en respectant l'audience de chaque post et les blocages. */
  router.get("/feed", async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT po.*, p.display_name, p.photo_url AS author_photo, p.verified_level,
                EXISTS (SELECT 1 FROM social_post_likes l WHERE l.post_id=po.id AND l.user_id=$1) AS liked_by_me,
                EXISTS (SELECT 1 FROM social_saved_posts s WHERE s.post_id=po.id AND s.user_id=$1) AS saved_by_me
         FROM social_posts po
         JOIN social_profiles p ON p.user_id=po.user_id AND p.deleted_at IS NULL AND p.is_active=true
         WHERE po.deleted_at IS NULL
           AND po.tenant_id=$2
           AND NOT EXISTS (
             SELECT 1 FROM social_blocks b
             WHERE (b.blocker_user_id=$1 AND b.blocked_user_id=po.user_id)
                OR (b.blocker_user_id=po.user_id AND b.blocked_user_id=$1)
           )
           AND (
             po.user_id=$1
             OR (po.audience='public')
             OR (po.audience='friends' AND EXISTS (
                  SELECT 1 FROM social_friendships f
                  WHERE f.user_a=LEAST(po.user_id,$1) AND f.user_b=GREATEST(po.user_id,$1)))
             OR (po.audience='followers' AND EXISTS (
                  SELECT 1 FROM social_follows fo
                  WHERE fo.follower_user_id=$1 AND fo.followed_user_id=po.user_id AND fo.status='active'))
           )
         ORDER BY po.created_at DESC
         LIMIT 50`,
        [req.user.id, req.tenant_id || "malilink"]
      );
      res.json(rows);
    } catch (error) {
      console.error("ERREUR SOCIAL FEED :", error.message);
      res.status(500).json({ error: "Erreur chargement du fil." });
    }
  });

  router.post("/posts", async (req, res) => {
    try {
      const profile = await getProfile(req.user.id);
      if (!profile || profile.is_active === false) {
        return res.status(400).json({ error: "Activez d'abord votre profil social." });
      }
      const { content = "", media, audience = "public", linked_type = "", linked_id } = req.body || {};
      const cleanContent = String(content || "").trim().slice(0, 5000);
      const cleanMedia = Array.isArray(media)
        ? media
            .filter((item) => item && typeof item.url === "string")
            .slice(0, 6)
            .map((item) => ({
              type: ["image", "video", "audio"].includes(item.type) ? item.type : "image",
              url: String(item.url).slice(0, 500)
            }))
        : [];
      if (!cleanContent && cleanMedia.length === 0) {
        return res.status(400).json({ error: "Publication vide." });
      }
      const cleanAudience = helpers.AUDIENCES.includes(audience) ? audience : "public";
      const cleanLinkedType = LINKED_TYPES.includes(linked_type) ? linked_type : "";

      const { rows } = await pool.query(
        `INSERT INTO social_posts
           (tenant_id, user_id, content, media, audience, linked_type, linked_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING *`,
        [
          req.tenant_id || "malilink",
          req.user.id,
          cleanContent,
          JSON.stringify(cleanMedia),
          cleanAudience,
          cleanLinkedType,
          Number(linked_id) || null
        ]
      );
      res.status(201).json({ success: true, post: rows[0] });
    } catch (error) {
      console.error("ERREUR SOCIAL POST :", error.message);
      res.status(500).json({ error: "Erreur publication." });
    }
  });

  router.delete("/posts/:id", async (req, res) => {
    try {
      const { rows } = await pool.query(
        `UPDATE social_posts SET deleted_at=NOW(), updated_at=NOW()
         WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL
         RETURNING id`,
        [Number(req.params.id), req.user.id]
      );
      if (!rows[0]) return res.status(404).json({ error: "Publication introuvable." });
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Erreur suppression." });
    }
  });

  /* Vérifie que l'utilisateur a le droit de voir un post (audience + blocage). */
  async function canSeePost(userId, post) {
    if (!post || post.deleted_at) return false;
    if (post.user_id === userId) return true;
    if (await isBlockedEitherWay(userId, post.user_id)) return false;
    if (post.audience === "public") return true;
    if (post.audience === "friends") return areFriends(userId, post.user_id);
    if (post.audience === "followers") return helpers.isFollowing(userId, post.user_id);
    return false;
  }

  async function loadPost(postId) {
    const { rows } = await pool.query(`SELECT * FROM social_posts WHERE id=$1`, [Number(postId)]);
    return rows[0] || null;
  }

  router.post("/posts/:id/like", async (req, res) => {
    try {
      const post = await loadPost(req.params.id);
      if (!(await canSeePost(req.user.id, post))) {
        return res.status(404).json({ error: "Publication introuvable." });
      }
      const inserted = await pool.query(
        `INSERT INTO social_post_likes (post_id, user_id) VALUES ($1,$2)
         ON CONFLICT (post_id, user_id) DO NOTHING RETURNING id`,
        [post.id, req.user.id]
      );
      if (inserted.rows.length > 0) {
        await pool.query(`UPDATE social_posts SET likes_count=likes_count+1 WHERE id=$1`, [post.id]);
        if (post.user_id !== req.user.id && createNotification) {
          await createNotification({
            user_id: post.user_id,
            title: "Nouveau j'aime",
            message: "Quelqu'un a aimé votre publication MaliLink Social.",
            type: "social_like",
            company_id: null
          }).catch(() => {});
        }
      }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Erreur j'aime." });
    }
  });

  router.delete("/posts/:id/like", async (req, res) => {
    try {
      const removed = await pool.query(
        `DELETE FROM social_post_likes WHERE post_id=$1 AND user_id=$2 RETURNING id`,
        [Number(req.params.id), req.user.id]
      );
      if (removed.rows.length > 0) {
        await pool.query(
          `UPDATE social_posts SET likes_count=GREATEST(likes_count-1,0) WHERE id=$1`,
          [Number(req.params.id)]
        );
      }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Erreur retrait du j'aime." });
    }
  });

  router.get("/posts/:id/comments", async (req, res) => {
    try {
      const post = await loadPost(req.params.id);
      if (!(await canSeePost(req.user.id, post))) {
        return res.status(404).json({ error: "Publication introuvable." });
      }
      const { rows } = await pool.query(
        `SELECT c.id, c.user_id, c.parent_id, c.content, c.created_at,
                p.display_name, p.photo_url
         FROM social_comments c
         JOIN social_profiles p ON p.user_id=c.user_id AND p.deleted_at IS NULL
         WHERE c.post_id=$1 AND c.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM social_blocks b
             WHERE (b.blocker_user_id=$2 AND b.blocked_user_id=c.user_id)
                OR (b.blocker_user_id=c.user_id AND b.blocked_user_id=$2)
           )
         ORDER BY c.created_at ASC LIMIT 200`,
        [post.id, req.user.id]
      );
      res.json(rows);
    } catch (error) {
      res.status(500).json({ error: "Erreur chargement des commentaires." });
    }
  });

  router.post("/posts/:id/comments", async (req, res) => {
    try {
      const post = await loadPost(req.params.id);
      if (!(await canSeePost(req.user.id, post))) {
        return res.status(404).json({ error: "Publication introuvable." });
      }
      const authorPrivacy = await getPrivacy(post.user_id);
      if (authorPrivacy?.who_can_comment === "nobody" && post.user_id !== req.user.id) {
        return res.status(403).json({ error: "Les commentaires sont désactivés sur cette publication." });
      }
      if (
        authorPrivacy?.who_can_comment === "friends" &&
        post.user_id !== req.user.id &&
        !(await areFriends(req.user.id, post.user_id))
      ) {
        return res.status(403).json({ error: "Seuls les amis peuvent commenter cette publication." });
      }

      const content = String(req.body?.content || "").trim().slice(0, 2000);
      if (!content) return res.status(400).json({ error: "Commentaire vide." });

      const { rows } = await pool.query(
        `INSERT INTO social_comments (post_id, user_id, parent_id, content)
         VALUES ($1,$2,$3,$4) RETURNING *`,
        [post.id, req.user.id, Number(req.body?.parent_id) || null, content]
      );
      await pool.query(`UPDATE social_posts SET comments_count=comments_count+1 WHERE id=$1`, [post.id]);
      if (post.user_id !== req.user.id && createNotification) {
        await createNotification({
          user_id: post.user_id,
          title: "Nouveau commentaire",
          message: "Quelqu'un a commenté votre publication MaliLink Social.",
          type: "social_comment",
          company_id: null
        }).catch(() => {});
      }
      res.status(201).json({ success: true, comment: rows[0] });
    } catch (error) {
      console.error("ERREUR SOCIAL COMMENT :", error.message);
      res.status(500).json({ error: "Erreur commentaire." });
    }
  });

  router.delete("/comments/:id", async (req, res) => {
    try {
      const { rows } = await pool.query(
        `UPDATE social_comments SET deleted_at=NOW()
         WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL RETURNING post_id`,
        [Number(req.params.id), req.user.id]
      );
      if (!rows[0]) return res.status(404).json({ error: "Commentaire introuvable." });
      await pool.query(
        `UPDATE social_posts SET comments_count=GREATEST(comments_count-1,0) WHERE id=$1`,
        [rows[0].post_id]
      );
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Erreur suppression du commentaire." });
    }
  });

  router.post("/posts/:id/save", async (req, res) => {
    try {
      const post = await loadPost(req.params.id);
      if (!(await canSeePost(req.user.id, post))) {
        return res.status(404).json({ error: "Publication introuvable." });
      }
      await pool.query(
        `INSERT INTO social_saved_posts (post_id, user_id) VALUES ($1,$2)
         ON CONFLICT (post_id, user_id) DO NOTHING`,
        [post.id, req.user.id]
      );
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Erreur enregistrement." });
    }
  });

  router.delete("/posts/:id/save", async (req, res) => {
    try {
      await pool.query(
        `DELETE FROM social_saved_posts WHERE post_id=$1 AND user_id=$2`,
        [Number(req.params.id), req.user.id]
      );
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Erreur retrait." });
    }
  });

  router.get("/saved", async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT po.*, p.display_name, p.photo_url AS author_photo
         FROM social_saved_posts s
         JOIN social_posts po ON po.id=s.post_id AND po.deleted_at IS NULL
         JOIN social_profiles p ON p.user_id=po.user_id AND p.deleted_at IS NULL
         WHERE s.user_id=$1
         ORDER BY s.created_at DESC LIMIT 100`,
        [req.user.id]
      );
      res.json(rows);
    } catch (error) {
      res.status(500).json({ error: "Erreur chargement des enregistrements." });
    }
  });
};
