"use strict";

/**
 * MaliLink Social — publications, fil, likes, commentaires, sauvegardes.
 * Audiences appliquées côté backend : public | friends | followers | me.
 * Suppression logique uniquement (deleted_at).
 */

module.exports = function registerPostRoutes(router, { pool, helpers, createNotification, media }) {
  const { isBlockedEitherWay, areFriends, getPrivacy, getProfile } = helpers;

  const LINKED_TYPES = ["", "product", "shop", "company", "service", "restaurant", "hotel", "vehicle", "property", "job", "event"];

  /* Visibilité d'une publication pour $1 (moi), réutilisée par le fil, les
     enregistrements et la fiche d'une publication : audience + blocage,
     vérifiés en base, jamais seulement à l'écran. */
  const VISIBLE_POUR_MOI = `
    po.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM social_blocks b
      WHERE (b.blocker_user_id=$1 AND b.blocked_user_id=po.user_id)
         OR (b.blocker_user_id=po.user_id AND b.blocked_user_id=$1))
    AND (
      po.user_id=$1
      OR po.audience='public'
      OR (po.audience='friends' AND EXISTS (
           SELECT 1 FROM social_friendships f
           WHERE f.user_a=LEAST(po.user_id,$1) AND f.user_b=GREATEST(po.user_id,$1)))
      OR (po.audience='followers' AND EXISTS (
           SELECT 1 FROM social_follows fo
           WHERE fo.follower_user_id=$1 AND fo.followed_user_id=po.user_id AND fo.status='active'))
    )`;

  const COLONNES_POST = `po.*, p.display_name, p.photo_url AS author_photo, p.verified_level,
    EXISTS (SELECT 1 FROM social_post_likes l WHERE l.post_id=po.id AND l.user_id=$1) AS liked_by_me,
    EXISTS (SELECT 1 FROM social_saved_posts s WHERE s.post_id=po.id AND s.user_id=$1) AS saved_by_me`;

  /* Fil d'actualité, paginé par curseur (id décroissant).
     - « pour_vous » (défaut) : mes publications, celles de mes amis et de
       mes abonnements, puis les publications publiques de la communauté ;
     - « reseau » : uniquement moi, mes amis et les profils que je suis. */
  router.get("/feed", async (req, res) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 15, 1), 50);
      const before = Number(req.query.before) || null;
      const reseauSeul = req.query.scope === "reseau";
      const { rows } = await pool.query(
        `SELECT ${COLONNES_POST}
         FROM social_posts po
         JOIN social_profiles p ON p.user_id=po.user_id AND p.deleted_at IS NULL AND p.is_active=true
         WHERE po.tenant_id=$2
           AND ${VISIBLE_POUR_MOI}
           AND ($3::bigint IS NULL OR po.id < $3)
           AND (NOT $4::boolean OR po.user_id=$1
                OR EXISTS (SELECT 1 FROM social_friendships f
                           WHERE f.user_a=LEAST(po.user_id,$1) AND f.user_b=GREATEST(po.user_id,$1))
                OR EXISTS (SELECT 1 FROM social_follows fo
                           WHERE fo.follower_user_id=$1 AND fo.followed_user_id=po.user_id AND fo.status='active'))
         ORDER BY po.id DESC
         LIMIT $5`,
        [req.user.id, req.tenant_id || "malilink", before, reseauSeul, limit + 1]
      );
      const page = rows.slice(0, limit);
      const posts = media ? await media.attachToPosts(page) : page;
      // Ancien format (tableau) conservé si aucun curseur n'est demandé par
      // un client qui ne connaît pas la pagination.
      if (req.query.format === "page" || req.query.before || req.query.scope) {
        return res.json({ posts, next_cursor: rows.length > limit ? page[page.length - 1].id : null });
      }
      res.json(posts);
    } catch (error) {
      console.error("ERREUR SOCIAL FEED :", error.message);
      res.status(500).json({ error: "Erreur chargement du fil." });
    }
  });

  /* Une publication (après un j'aime, un commentaire, un lien partagé). */
  router.get("/posts/:id", async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT ${COLONNES_POST}
         FROM social_posts po
         JOIN social_profiles p ON p.user_id=po.user_id AND p.deleted_at IS NULL
         WHERE po.id=$2 AND ${VISIBLE_POUR_MOI}`,
        [req.user.id, Number(req.params.id)]
      );
      if (!rows[0]) return res.status(404).json({ error: "Publication introuvable." });
      const [post] = media ? await media.attachToPosts(rows) : rows;
      res.json(post);
    } catch (error) {
      res.status(500).json({ error: "Erreur chargement de la publication." });
    }
  });

  router.post("/posts", async (req, res) => {
    const client = await pool.connect();
    try {
      const profile = await getProfile(req.user.id);
      if (!profile || profile.is_active === false) {
        return res.status(400).json({ error: "Activez d'abord votre profil social." });
      }
      const { content = "", media_ids, audience = "public", linked_type = "", linked_id } = req.body || {};
      const cleanContent = String(content || "").trim().slice(0, 5000);
      const ids = Array.isArray(media_ids) ? media_ids.filter((id) => typeof id === "string" && id.length <= 40) : [];
      /* Le champ historique `media` (URL libres) n'est plus accepté : une URL
         saisie par un client pourrait viser n'importe quel site. Les médias
         passent par POST /social/media et sont désignés par leur identifiant. */
      if (!cleanContent && ids.length === 0) {
        return res.status(400).json({ error: "Publication vide." });
      }
      const cleanAudience = helpers.AUDIENCES.includes(audience) ? audience : "public";
      const cleanLinkedType = LINKED_TYPES.includes(linked_type) ? linked_type : "";

      await client.query("BEGIN");
      const { rows } = await client.query(
        `INSERT INTO social_posts
           (tenant_id, user_id, content, media, audience, linked_type, linked_id)
         VALUES ($1,$2,$3,'[]'::jsonb,$4,$5,$6)
         RETURNING *`,
        [
          req.tenant_id || "malilink",
          req.user.id,
          cleanContent,
          cleanAudience,
          cleanLinkedType,
          Number(linked_id) || null
        ]
      );
      if (ids.length > 0) {
        if (!media) {
          const e = new Error("Les médias ne sont pas disponibles.");
          e.status = 503;
          throw e;
        }
        await media.attachToPost(client, {
          userId: req.user.id, tenantId: req.tenant_id || "malilink", postId: rows[0].id, mediaIds: ids,
        });
      }
      await client.query("COMMIT");
      const [post] = media ? await media.attachToPosts(rows) : rows;
      res.status(201).json({
        success: true,
        post: { ...post, display_name: profile.display_name, author_photo: profile.photo_url,
          verified_level: profile.verified_level, liked_by_me: false, saved_by_me: false },
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (error.status) return res.status(error.status).json({ error: error.message });
      console.error("ERREUR SOCIAL POST :", error.message);
      res.status(500).json({ error: "Erreur publication." });
    } finally {
      client.release();
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
        `SELECT ${COLONNES_POST}
         FROM social_saved_posts sv
         JOIN social_posts po ON po.id=sv.post_id
         JOIN social_profiles p ON p.user_id=po.user_id AND p.deleted_at IS NULL
         WHERE sv.user_id=$1 AND ${VISIBLE_POUR_MOI}
         ORDER BY sv.created_at DESC LIMIT 100`,
        [req.user.id]
      );
      // Une publication dont l'audience ne m'inclut plus n'est plus rendue,
      // même si je l'avais enregistrée.
      const posts = media ? await media.attachToPosts(rows) : rows;
      if (req.query.format === "page") return res.json({ posts, next_cursor: null });
      res.json(posts);
    } catch (error) {
      res.status(500).json({ error: "Erreur chargement des enregistrements." });
    }
  });
};
