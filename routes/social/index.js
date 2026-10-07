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
const registerNetworkRoutes = require("./network");
const registerCallRoutes = require("./calls");
const { createSocialMedia } = require("./media");

module.exports = function createSocialRouter({ pool, authenticateToken, createNotification, realtime, media }) {
  const router = express.Router();
  const helpers = createHelpers({ pool });
  // Médias des publications : instance partagée avec la route de lecture
  // signée montée hors authentification dans server.js (/social-media).
  const socialMedia = media || createSocialMedia({ pool });

  router.use(authenticateToken);

  // Coupe tout le module si social_enabled=false.
  router.use(helpers.requireFlag("social_enabled"));

  // Compté PAR COMPTE (et non par IP) : derrière la NAT d'un opérateur
  // mobile, des milliers d'abonnés partagent une seule adresse.
  // Préfixe distinct par limiteur : ils partagent le même magasin, et une
  // clé commune comptait chaque écriture deux fois (15 / min au lieu de 30).
  const parCompte = (prefixe) => (req) =>
    (req.user?.id ? `social-${prefixe}-u${req.user.id}` : `social-${prefixe}-ip-${req.ip}`);

  // Anti-spam global : 120 requêtes / minute / compte+chemin.
  router.use(
    createRateLimiter({
      windowMs: 60 * 1000,
      max: 120,
      message: "Trop de requêtes MaliLink Social. Patientez un instant.",
      keyGenerator: parCompte("g")
    })
  );

  // Écritures plus strictes : 30 / minute / compte+chemin.
  const writeLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 30,
    message: "Vous allez trop vite. Patientez quelques secondes.",
    keyGenerator: parCompte("w")
  });
  router.use((req, res, next) => {
    if (req.method === "GET") return next();
    return writeLimiter(req, res, next);
  });

  const context = { pool, helpers, createNotification, realtime, media: socialMedia };

  registerProfileRoutes(router, context);
  registerDiscoveryRoutes(router, context);
  // Réseau (relations, abonnés, suggestions, compteurs) : séparé de la
  // messagerie, l'utilisateur n'a plus à passer par Messages.
  registerNetworkRoutes(router, context);

  // Messagerie : flag scopé sur /messages uniquement (coupable
  // instantanément sans impacter le reste du module).
  router.use("/messages", helpers.requireFlag("social_messages_enabled"));
  registerMessageRoutes(router, context);
  // Appels audio/vidéo : inactifs (sans erreur) tant que LiveKit et les drapeaux ne sont pas configurés.
  registerCallRoutes(router, context);

  // Publications derrière leur propre flag (routes /feed, /posts, /saved,
  // /comments — montées en dernier : le middleware ne gêne aucune route
  // déclarée avant).
  const postsRouter = express.Router();
  postsRouter.use("/media", helpers.requireFlag("social_media_uploads_enabled"));
  socialMedia.registerUploadRoutes(postsRouter);
  registerPostRoutes(postsRouter, context);
  router.use("/", helpers.requireFlag("social_posts_enabled"), postsRouter);

  return router;
};
