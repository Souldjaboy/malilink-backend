"use strict";

/**
 * MaliLink — Socket.io temps réel (messagerie sociale, présence, frappe).
 *
 * Sécurité :
 * - authentification JWT obligatoire au handshake (handshake.auth.token),
 *   avec les MÊMES contrôles que l'API (verifierSession) : jeton portant un
 *   espace, session non révoquée, compte actif, appartenance prouvée à
 *   l'espace, espace de la connexion (domaine) identique à celui du jeton ;
 * - une session révoquée (mot de passe, changement d'email…) ou un compte
 *   désactivé referme ses connexions : immédiatement via
 *   reverifierUtilisateur(), et au plus tard à la revérification périodique ;
 * - chaque socket rejoint SA room "user:<id>" et la room de SON espace :
 *   la présence n'est diffusée qu'à l'espace autorisé ;
 * - limitation de fréquence basique par socket (anti-spam) ;
 * - aucun secret dans les logs.
 *
 * Le REST reste la source de vérité (envoi des messages via /social/messages) ;
 * les sockets ne servent qu'à pousser les événements — un client sans
 * websocket retombe automatiquement sur le polling.
 */

const { Server } = require("socket.io");

const REVERIFICATION_MS = 60000;

function createRealtime({ httpServer, jwt, jwtSecret, pool, verifierSession, espaceDeRequete }) {
  if (typeof verifierSession !== "function" || typeof espaceDeRequete !== "function") {
    throw new Error("createRealtime : verifierSession et espaceDeRequete sont obligatoires");
  }
  const io = new Server(httpServer, {
    path: "/socket.io",
    cors: { origin: true, credentials: true },
    // Fallback long-polling intégré à socket.io
    transports: ["websocket", "polling"]
  });

  const onlineUsers = new Map(); // userId -> nombre de sockets actives
  const salleEspace = (tenant) => `espace:${tenant}`;

  io.use(async (socket, next) => {
    let payload;
    try {
      const token = socket.handshake?.auth?.token || "";
      if (!token) return next(new Error("Authentification requise"));
      payload = jwt.verify(token, jwtSecret);
    } catch {
      return next(new Error("Token invalide"));
    }
    const espace = espaceDeRequete(socket.request);
    const session = await verifierSession(payload, espace).catch(() => ({ ok: false, code: "VERIFICATION_INDISPONIBLE" }));
    if (!session.ok) return next(new Error(session.code === "SESSION_SANS_ESPACE" ? "Session à renouveler" : session.code));
    socket.data.userId = Number(payload.id);
    socket.data.tenantId = session.tenant;
    socket.data.payload = payload;
    socket.data.espace = espace;
    next();
  });

  /* Revérifie une socket ; la ferme si la session n'est plus valable. */
  async function reverifier(socket) {
    const session = await verifierSession(socket.data.payload, socket.data.espace)
      .catch(() => ({ ok: true })); // base momentanément indisponible : on ne ferme pas sur une panne
    if (session.ok) return;
    socket.emit("session:fermee", { code: session.code, message: session.error || "Session fermée." });
    socket.disconnect(true);
  }
  const minuterie = setInterval(() => {
    for (const socket of io.of("/").sockets.values()) reverifier(socket).catch(() => {});
  }, REVERIFICATION_MS);
  minuterie.unref();

  io.on("connection", (socket) => {
    const userId = socket.data.userId;
    const espace = salleEspace(socket.data.tenantId);
    socket.join(`user:${userId}`);
    socket.join(espace);

    onlineUsers.set(userId, (onlineUsers.get(userId) || 0) + 1);
    io.to(espace).emit("presence:online", { user_id: userId, online: true });

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
        io.to(espace).emit("presence:online", { user_id: userId, online: false });
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
    },
    /* Session révoquée ou compte modifié : revérifie tout de suite ses connexions. */
    async reverifierUtilisateur(userId) {
      const sockets = await io.in(`user:${Number(userId)}`).fetchSockets().catch(() => []);
      for (const s of sockets) {
        const socket = io.of("/").sockets.get(s.id);
        if (socket) await reverifier(socket).catch(() => {});
      }
    }
  };
}

module.exports = { createRealtime };
