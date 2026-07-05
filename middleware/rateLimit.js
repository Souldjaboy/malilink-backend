"use strict";

/**
 * Rate limiter en mémoire, sans dépendance externe.
 * Protège les routes sensibles (login, réinitialisation mot de passe,
 * vérification, inscription) contre la force brute.
 *
 * Fenêtre glissante simple : max `max` requêtes par `windowMs` par clé (IP + chemin).
 * Nettoyage périodique pour éviter les fuites mémoire.
 */

const buckets = new Map();

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of buckets) {
    if (entry.resetAt <= now) {
      buckets.delete(key);
    }
  }
}, CLEANUP_INTERVAL_MS).unref();

function getClientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "")
    .split(",")[0]
    .trim();
  return forwarded || req.ip || req.socket?.remoteAddress || "unknown";
}

/**
 * Crée un middleware de rate limiting.
 * @param {Object} options
 * @param {number} options.windowMs - durée de la fenêtre en ms
 * @param {number} options.max - nombre max de requêtes par fenêtre
 * @param {string} [options.message] - message renvoyé en cas de dépassement
 */
function createRateLimiter({ windowMs, max, message }) {
  return function rateLimiter(req, res, next) {
    const key = `${getClientIp(req)}:${req.path}`;
    const now = Date.now();
    let entry = buckets.get(key);

    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      buckets.set(key, entry);
    }

    entry.count += 1;

    if (entry.count > max) {
      const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSec));
      return res.status(429).json({
        error: message || "Trop de tentatives. Veuillez réessayer plus tard.",
        retry_after_seconds: retryAfterSec
      });
    }

    return next();
  };
}

/**
 * Middleware global : applique un limiteur strict uniquement
 * aux chemins sensibles (après suppression du préfixe /api/).
 */
const SENSITIVE_PREFIXES = [
  "/login",
  "/client/login",
  "/register-saas",
  "/client/register",
  "/password-reset",
  "/verification",
  "/auth/social",
  "/support/contact"
];

const authLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: 30,
  message: "Trop de tentatives d'authentification. Réessayez dans quelques minutes."
});

function sensitiveRoutesRateLimit(req, res, next) {
  const isSensitive = SENSITIVE_PREFIXES.some(
    (prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`)
  );
  if (!isSensitive) return next();
  return authLimiter(req, res, next);
}

module.exports = { createRateLimiter, sensitiveRoutesRateLimit };
