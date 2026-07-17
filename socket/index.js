"use strict";

/**
 * MaliLink — Socket.io temps réel (messagerie sociale, présence, frappe).
 *
 * Sécurité :
 * - authentification JWT obligatoire au handshake (handshake.auth.token) ;
 * - chaque socket rejoint uniquement SA room "user:<id>" — les événements
 *   de conversation sont émis serveur-side aux membres vérifiés en base ;
 * - limitation de fréquence basique par socket (anti-spam) ;
 * - aucun secret dans les logs.
 *
 * Le REST reste la source de vérité (envoi des messages via /social/messages) ;
 * les sockets ne servent qu'à pousser les événements — un client sans
 * websocket retombe automatiquement sur le polling.
 */

const { Server } = require("socket.io");

function createRealtime({ httpServer, jwt, jwtSecret, pool }) {
  const io = new Server(httpServer, {
    path: "/socket.io",
    cors: { origin: true, credentials: true },
    // Fallback long-polling intégré à socket.io
    transports: ["websocket", "polling"]
  });

  const onlineUsers = new Map(); // userId -> nombre de sockets actives

  io.use((socket, next) => {
    try {
      const token = socket.handshake?.auth?.token || "";
      if (!token) return next(new Error("Authentification requise"));
      const payload = jwt.verify(token, jwtSecret);
      socket.data.userId = Number(payload.id);
      if (!socket.data.userId) return next(new Error("Token invalide"));
      next();
    } catch {
      next(new Error("Token invalide"));
    }
  });

  io.on("connection", (socket) => {
    const userId = socket.data.userId;
    socket.join(`user:${userId}`);

    onlineUsers.set(userId, (onlineUsers.get(userId) || 0) + 1);
    io.emit("presence:online", { user_id: userId, online: true });

    // Anti-spam : max 30 événements client / 10 s / socket.
    let eventCount = 0;
    const resetInterval = setInterval(() => (eventCount = 0), 10000);
    const limited = (handler) => async (...args) => {
      eventCount += 1;
      if (eventCount > 30) return;
      try {
        await handler(...args);
      } catch {
        /* jamais de crash socket sur un événement client */
      }
    };

    // Indicateur « écrit... » : relayé uniquement aux membres réels.
    socket.on(
      "typing",
      limited(async ({ conversation_id, typing }) => {
        const conversationId = Number(conversation_id);
        if (!conversationId) return;
        const members = await pool.query(
          `SELECT user_id FROM social_conversation_members WHERE conversation_id=$1`,
          [conversationId]
        );
        const isMember = members.rows.some((row) => row.user_id === userId);
        if (!isMember) return;
        for (const row of members.rows) {
          if (row.user_id !== userId) {
            io.to(`user:${row.user_id}`).emit("typing", {
              conversation_id: conversationId,
              user_id: userId,
              typing: typing === true
            });
          }
        }
      })
    );

    socket.on("disconnect", () => {
      clearInterval(resetInterval);
      const remaining = (onlineUsers.get(userId) || 1) - 1;
      if (remaining <= 0) {
        onlineUsers.delete(userId);
        io.emit("presence:online", { user_id: userId, online: false });
        pool
          .query(
            `INSERT INTO social_user_presence (user_id, last_seen_at)
             VALUES ($1, NOW())
             ON CONFLICT (user_id) DO UPDATE SET last_seen_at=NOW()`,
            [userId]
          )
          .catch(() => {});
      } else {
        onlineUsers.set(userId, remaining);
      }
    });
  });

  return {
    io,
    isOnline: (userId) => onlineUsers.has(Number(userId)),
    /* Émet un événement aux membres d'une liste d'utilisateurs. */
    emitToUsers(userIds, event, payload) {
      for (const id of userIds) {
        io.to(`user:${id}`).emit(event, payload);
      }
    }
  };
}

module.exports = { createRealtime };
