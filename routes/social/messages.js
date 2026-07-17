"use strict";

/**
 * MaliLink Social — messagerie privée.
 * REST = source de vérité ; le temps réel (socket) ne fait que pousser.
 *
 * Sécurité appliquée côté backend à chaque requête :
 * - appartenance à la conversation vérifiée en base (anti-IDOR) ;
 * - blocage : aucune conversation ni message entre profils bloqués ;
 * - confidentialité who_can_message (everyone | friends | nobody) ;
 * - suppression logique uniquement.
 */

module.exports = function registerMessageRoutes(router, { pool, helpers, createNotification, realtime }) {
  const { isBlockedEitherWay, areFriends, getPrivacy, getProfile } = helpers;

  const MESSAGE_TYPES = ["text", "image", "video", "document", "voice"];

  async function getMembership(conversationId, userId) {
    const { rows } = await pool.query(
      `SELECT m.*, c.kind, c.tenant_id
       FROM social_conversation_members m
       JOIN social_conversations c ON c.id=m.conversation_id
       WHERE m.conversation_id=$1 AND m.user_id=$2
       LIMIT 1`,
      [Number(conversationId), userId]
    );
    return rows[0] || null;
  }

  async function conversationMemberIds(conversationId) {
    const { rows } = await pool.query(
      `SELECT user_id FROM social_conversation_members WHERE conversation_id=$1`,
      [Number(conversationId)]
    );
    return rows.map((row) => row.user_id);
  }

  /* Liste des conversations avec dernier message, non-lus et interlocuteur. */
  router.get("/messages/conversations", async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT c.id, c.kind, c.title, c.last_message_at,
                m.last_read_message_id,
                other.user_id AS other_user_id,
                p.display_name AS other_display_name,
                p.photo_url AS other_photo_url,
                lm.content AS last_content,
                lm.message_type AS last_type,
                lm.sender_user_id AS last_sender_id,
                (SELECT COUNT(*)::int FROM social_messages sm
                  WHERE sm.conversation_id=c.id
                    AND sm.deleted_at IS NULL
                    AND sm.sender_user_id <> $1
                    AND sm.id > COALESCE(m.last_read_message_id, 0)) AS unread_count
         FROM social_conversation_members m
         JOIN social_conversations c ON c.id=m.conversation_id
         LEFT JOIN social_conversation_members other
           ON other.conversation_id=c.id AND other.user_id <> $1 AND c.kind='direct'
         LEFT JOIN social_profiles p ON p.user_id=other.user_id AND p.deleted_at IS NULL
         LEFT JOIN LATERAL (
           SELECT content, message_type, sender_user_id FROM social_messages sm
           WHERE sm.conversation_id=c.id AND sm.deleted_at IS NULL
           ORDER BY sm.id DESC LIMIT 1
         ) lm ON true
         WHERE m.user_id=$1
           AND (other.user_id IS NULL OR NOT EXISTS (
             SELECT 1 FROM social_blocks b
             WHERE (b.blocker_user_id=$1 AND b.blocked_user_id=other.user_id)
                OR (b.blocker_user_id=other.user_id AND b.blocked_user_id=$1)))
         ORDER BY c.last_message_at DESC NULLS LAST
         LIMIT 100`,
        [req.user.id]
      );
      const withPresence = rows.map((row) => ({
        ...row,
        other_online: realtime ? realtime.isOnline(row.other_user_id) : false
      }));
      res.json(withPresence);
    } catch (error) {
      console.error("ERREUR SOCIAL CONVERSATIONS :", error.message);
      res.status(500).json({ error: "Erreur chargement des conversations." });
    }
  });

  /* Ouvre (ou retrouve) la conversation directe avec un utilisateur. */
  router.post("/messages/conversations", async (req, res) => {
    try {
      const otherId = Number(req.body?.user_id);
      if (!otherId || otherId === req.user.id) {
        return res.status(400).json({ error: "Destinataire invalide." });
      }
      if (await isBlockedEitherWay(req.user.id, otherId)) {
        return res.status(403).json({ error: "Conversation impossible avec ce profil." });
      }
      const otherProfile = await getProfile(otherId);
      if (!otherProfile || otherProfile.is_active === false) {
        return res.status(404).json({ error: "Profil introuvable." });
      }
      const privacy = await getPrivacy(otherId);
      const rule = privacy?.who_can_message || "friends";
      if (rule === "nobody") {
        return res.status(403).json({ error: "Cette personne n'accepte pas de messages." });
      }
      if (rule === "friends" && !(await areFriends(req.user.id, otherId))) {
        return res.status(403).json({ error: "Seuls ses amis peuvent écrire à cette personne." });
      }

      const existing = await pool.query(
        `SELECT c.id FROM social_conversations c
         JOIN social_conversation_members a ON a.conversation_id=c.id AND a.user_id=$1
         JOIN social_conversation_members b ON b.conversation_id=c.id AND b.user_id=$2
         WHERE c.kind='direct' LIMIT 1`,
        [req.user.id, otherId]
      );
      if (existing.rows[0]) {
        return res.json({ conversation_id: existing.rows[0].id, existing: true });
      }

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const conversation = await client.query(
          `INSERT INTO social_conversations (tenant_id, kind, created_by, last_message_at)
           VALUES ($1,'direct',$2,NOW()) RETURNING id`,
          [req.tenant_id || "malilink", req.user.id]
        );
        const conversationId = conversation.rows[0].id;
        await client.query(
          `INSERT INTO social_conversation_members (conversation_id, user_id)
           VALUES ($1,$2), ($1,$3)`,
          [conversationId, req.user.id, otherId]
        );
        await client.query("COMMIT");
        res.status(201).json({ conversation_id: conversationId, existing: false });
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error("ERREUR SOCIAL NEW CONVERSATION :", error.message);
      res.status(500).json({ error: "Erreur création de la conversation." });
    }
  });

  /* Messages d'une conversation, paginés (?before=<message_id>). */
  router.get("/messages/conversations/:id", async (req, res) => {
    try {
      const membership = await getMembership(req.params.id, req.user.id);
      if (!membership) return res.status(404).json({ error: "Conversation introuvable." });

      const before = Number(req.query.before) || null;
      const values = [membership.conversation_id];
      let filter = "";
      if (before) {
        values.push(before);
        filter = `AND sm.id < $2`;
      }
      const { rows } = await pool.query(
        `SELECT sm.id, sm.sender_user_id, sm.message_type, sm.content, sm.media_url,
                sm.reply_to_id, sm.deleted_at, sm.created_at,
                p.display_name AS sender_name, p.photo_url AS sender_photo
         FROM social_messages sm
         LEFT JOIN social_profiles p ON p.user_id=sm.sender_user_id
         WHERE sm.conversation_id=$1 ${filter}
         ORDER BY sm.id DESC LIMIT 50`,
        values
      );
      // Accusés de lecture : dernier message lu par les autres membres.
      const reads = await pool.query(
        `SELECT user_id, last_read_message_id FROM social_conversation_members
         WHERE conversation_id=$1 AND user_id <> $2`,
        [membership.conversation_id, req.user.id]
      );
      res.json({
        messages: rows
          .map((row) =>
            row.deleted_at
              ? { ...row, content: "", media_url: "", message_type: "deleted" }
              : row
          )
          .reverse(),
        reads: reads.rows
      });
    } catch (error) {
      console.error("ERREUR SOCIAL MESSAGES :", error.message);
      res.status(500).json({ error: "Erreur chargement des messages." });
    }
  });

  /* Envoi d'un message. */
  router.post("/messages/conversations/:id", async (req, res) => {
    try {
      const membership = await getMembership(req.params.id, req.user.id);
      if (!membership) return res.status(404).json({ error: "Conversation introuvable." });

      const { content = "", message_type = "text", media_url = "", reply_to_id } = req.body || {};
      const cleanType = MESSAGE_TYPES.includes(message_type) ? message_type : "text";
      const cleanContent = String(content || "").trim().slice(0, 5000);
      const cleanMedia = String(media_url || "").slice(0, 500);
      if (!cleanContent && !cleanMedia) {
        return res.status(400).json({ error: "Message vide." });
      }

      const memberIds = await conversationMemberIds(membership.conversation_id);
      // Blocage survenu après la création de la conversation : refuser.
      for (const otherId of memberIds) {
        if (otherId !== req.user.id && (await isBlockedEitherWay(req.user.id, otherId))) {
          return res.status(403).json({ error: "Conversation bloquée." });
        }
      }

      const { rows } = await pool.query(
        `INSERT INTO social_messages
           (conversation_id, sender_user_id, message_type, content, media_url, reply_to_id)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [
          membership.conversation_id,
          req.user.id,
          cleanType,
          cleanContent,
          cleanMedia,
          Number(reply_to_id) || null
        ]
      );
      const message = rows[0];
      await pool.query(
        `UPDATE social_conversations SET last_message_at=NOW() WHERE id=$1`,
        [membership.conversation_id]
      );
      // Ma propre lecture est à jour.
      await pool.query(
        `UPDATE social_conversation_members
         SET last_read_message_id=$1, last_read_at=NOW()
         WHERE conversation_id=$2 AND user_id=$3`,
        [message.id, membership.conversation_id, req.user.id]
      );

      const sender = await getProfile(req.user.id);
      const payload = {
        ...message,
        sender_name: sender?.display_name || "",
        sender_photo: sender?.photo_url || ""
      };
      if (realtime) {
        realtime.emitToUsers(memberIds, "message:new", {
          conversation_id: membership.conversation_id,
          message: payload
        });
      }
      for (const otherId of memberIds) {
        if (otherId !== req.user.id && createNotification) {
          await createNotification({
            user_id: otherId,
            title: "Nouveau message",
            message: `${sender?.display_name || "Quelqu'un"} vous a écrit sur MaliLink Social.`,
            type: "social_message",
            company_id: null
          }).catch(() => {});
        }
      }
      res.status(201).json({ success: true, message: payload });
    } catch (error) {
      console.error("ERREUR SOCIAL SEND MESSAGE :", error.message);
      res.status(500).json({ error: "Erreur envoi du message." });
    }
  });

  /* Marquer comme lu (accusé de lecture poussé aux autres membres). */
  router.post("/messages/conversations/:id/read", async (req, res) => {
    try {
      const membership = await getMembership(req.params.id, req.user.id);
      if (!membership) return res.status(404).json({ error: "Conversation introuvable." });
      const lastId = Number(req.body?.last_message_id) || null;
      await pool.query(
        `UPDATE social_conversation_members
         SET last_read_message_id=GREATEST(COALESCE(last_read_message_id,0), COALESCE($1,0)),
             last_read_at=NOW()
         WHERE conversation_id=$2 AND user_id=$3`,
        [lastId, membership.conversation_id, req.user.id]
      );
      if (realtime) {
        const memberIds = await conversationMemberIds(membership.conversation_id);
        realtime.emitToUsers(
          memberIds.filter((id) => id !== req.user.id),
          "message:read",
          { conversation_id: membership.conversation_id, user_id: req.user.id, last_message_id: lastId }
        );
      }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Erreur accusé de lecture." });
    }
  });

  /* Suppression pour tous (logique) — uniquement mes propres messages. */
  router.delete("/messages/:messageId", async (req, res) => {
    try {
      const { rows } = await pool.query(
        `UPDATE social_messages SET deleted_at=NOW()
         WHERE id=$1 AND sender_user_id=$2 AND deleted_at IS NULL
         RETURNING conversation_id, id`,
        [Number(req.params.messageId), req.user.id]
      );
      if (!rows[0]) return res.status(404).json({ error: "Message introuvable." });
      if (realtime) {
        const memberIds = await conversationMemberIds(rows[0].conversation_id);
        realtime.emitToUsers(memberIds, "message:deleted", {
          conversation_id: rows[0].conversation_id,
          message_id: rows[0].id
        });
      }
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Erreur suppression du message." });
    }
  });

  /* Recherche dans mes conversations. */
  router.get("/messages/search", async (req, res) => {
    try {
      const query = String(req.query.q || "").trim();
      if (query.length < 2) return res.json([]);
      const { rows } = await pool.query(
        `SELECT sm.id, sm.conversation_id, sm.content, sm.created_at,
                p.display_name AS sender_name
         FROM social_messages sm
         JOIN social_conversation_members m
           ON m.conversation_id=sm.conversation_id AND m.user_id=$1
         LEFT JOIN social_profiles p ON p.user_id=sm.sender_user_id
         WHERE sm.deleted_at IS NULL AND sm.content ILIKE $2
         ORDER BY sm.id DESC LIMIT 30`,
        [req.user.id, `%${query}%`]
      );
      res.json(rows);
    } catch (error) {
      res.status(500).json({ error: "Erreur recherche." });
    }
  });
};
