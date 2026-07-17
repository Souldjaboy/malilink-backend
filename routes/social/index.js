"use strict";

/**
 * MaliLink Social — routeur principal.
 * Monté dans server.js : app.use("/social", createSocialRouter({...}))
 * Architecture séparée du monolithe (routes/social/*), pattern factory
 * identique à routes/delivery.js.
 *
 * Sécurité globale :
 * - JWT obligatoire sur toutes les routes ;
 * - rate limiting (anti-spam) ;
 * - feature flags (social_feature_flags) pour couper une fonction
 *   sensible immédiatement ;
 * - contrôles de blocage/confidentialité côté backend dans chaque module.
 */

const express = require("express");
const { createRateLimiter } = require("../../middleware/rateLimit");
const { createHelpers } = require("./helpers");
const registerProfileRoutes = require("./profile");
const registerDiscoveryRoutes = require("./discovery");
const registerPostRoutes = require("./posts");
const registerMessageRoutes = require("./messages");

module.exports = function createSocialRouter({ pool, authenticateToken, createNotification, realtime }) {
  const router = express.Router();
  const helpers = createHelpers({ pool });

  router.use(authenticateToken);

  // Coupe tout le module si social_enabled=false.
  router.use(helpers.requireFlag("social_enabled"));

  // Anti-spam global : 120 requêtes / minute / IP+chemin.
  router.use(
    createRateLimiter({
      windowMs: 60 * 1000,
      max: 120,
      message: "Trop de requêtes MaliLink Social. Patientez un instant."
    })
  );

  // Écritures plus strictes : 30 / minute.
  const writeLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 30,
    message: "Vous allez trop vite. Patientez quelques secondes."
  });
  router.use((req, res, next) => {
    if (req.method === "GET") return next();
    return writeLimiter(req, res, next);
  });

  const context = { pool, helpers, createNotification, realtime };

  registerProfileRoutes(router, context);
  registerDiscoveryRoutes(router, context);

  // Messagerie : flag scopé sur /messages uniquement (coupable
  // instantanément sans impacter le reste du module).
  router.use("/messages", helpers.requireFlag("social_messages_enabled"));
  registerMessageRoutes(router, context);

  // Publications derrière leur propre flag (routes /feed, /posts, /saved,
  // /comments — montées en dernier : le middleware ne gêne aucune route
  // déclarée avant).
  const postsRouter = express.Router();
  registerPostRoutes(postsRouter, context);
  router.use("/", helpers.requireFlag("social_posts_enabled"), postsRouter);

  return router;
};
