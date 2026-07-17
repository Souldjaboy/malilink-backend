"use strict";

/**
 * MaliLink Social — helpers partagés.
 * Toutes les vérifications de sécurité (blocage, confidentialité, âge)
 * se font ici, côté backend — jamais seulement côté frontend.
 */

const GOALS = [
  "amitie",
  "discussion",
  "reseau_professionnel",
  "partenariat_commercial",
  "activites_sorties",
  "collaborateurs",
  "suivre_createurs",
  "decouvrir",
  "rencontres" // réservé aux adultes (18+), opt-in explicite
];

const AUDIENCES = ["public", "friends", "followers", "me"];

const REPORT_REASONS = [
  "harcelement", "spam", "escroquerie", "faux_profil", "nudite",
  "contenu_sexuel", "menace", "violence", "haine", "usurpation",
  "comportement_dangereux", "mineur_en_danger", "vente_interdite", "contenu_illegal"
];

function createHelpers({ pool }) {
  let flagsCache = { at: 0, values: {} };

  async function getFeatureFlags() {
    if (Date.now() - flagsCache.at < 30000) return flagsCache.values;
    try {
      const { rows } = await pool.query("SELECT flag_key, enabled FROM social_feature_flags");
      flagsCache = {
        at: Date.now(),
        values: Object.fromEntries(rows.map((row) => [row.flag_key, row.enabled === true]))
      };
    } catch {
      flagsCache = { at: Date.now(), values: {} };
    }
    return flagsCache.values;
  }

  function requireFlag(flagKey) {
    return async (req, res, next) => {
      const flags = await getFeatureFlags();
      if (flags[flagKey] === false) {
        return res.status(503).json({
          error: "Cette fonctionnalité MaliLink Social est temporairement désactivée."
        });
      }
      next();
    };
  }

  function ageFromBirthDate(birthDate) {
    if (!birthDate) return null;
    const date = new Date(birthDate);
    if (Number.isNaN(date.getTime())) return null;
    const now = new Date();
    let age = now.getFullYear() - date.getFullYear();
    const beforeBirthday =
      now.getMonth() < date.getMonth() ||
      (now.getMonth() === date.getMonth() && now.getDate() < date.getDate());
    if (beforeBirthday) age -= 1;
    return age;
  }

  async function getProfile(userId) {
    const { rows } = await pool.query(
      `SELECT * FROM social_profiles WHERE user_id=$1 AND deleted_at IS NULL LIMIT 1`,
      [userId]
    );
    return rows[0] || null;
  }

  async function getPrivacy(userId) {
    const { rows } = await pool.query(
      `SELECT * FROM social_privacy_settings WHERE user_id=$1 LIMIT 1`,
      [userId]
    );
    return rows[0] || null;
  }

  /* Blocage dans un sens comme dans l'autre : aucune interaction possible. */
  async function isBlockedEitherWay(userIdA, userIdB) {
    const { rows } = await pool.query(
      `SELECT 1 FROM social_blocks
       WHERE (blocker_user_id=$1 AND blocked_user_id=$2)
          OR (blocker_user_id=$2 AND blocked_user_id=$1)
       LIMIT 1`,
      [userIdA, userIdB]
    );
    return rows.length > 0;
  }

  async function areFriends(userIdA, userIdB) {
    const [a, b] = userIdA < userIdB ? [userIdA, userIdB] : [userIdB, userIdA];
    const { rows } = await pool.query(
      `SELECT 1 FROM social_friendships WHERE user_a=$1 AND user_b=$2 LIMIT 1`,
      [a, b]
    );
    return rows.length > 0;
  }

  async function isFollowing(followerId, followedId) {
    const { rows } = await pool.query(
      `SELECT 1 FROM social_follows
       WHERE follower_user_id=$1 AND followed_user_id=$2 AND status='active' LIMIT 1`,
      [followerId, followedId]
    );
    return rows.length > 0;
  }

  /* Vue publique d'un profil : n'expose jamais le téléphone, ni la date
     de naissance complète ; respecte show_age / show_city. */
  function publicProfileView(profile, privacy, extras = {}) {
    if (!profile) return null;
    const age = ageFromBirthDate(profile.birth_date);
    return {
      user_id: profile.user_id,
      username: profile.username,
      display_name: profile.display_name,
      bio: profile.bio,
      photo_url: profile.photo_url,
      cover_url: profile.cover_url,
      city: privacy?.show_city === false ? "" : profile.city,
      country: profile.country,
      languages: profile.languages,
      profession: profile.profession,
      company_name: profile.company_name,
      goals: profile.goals,
      interests: profile.interests,
      is_public: profile.is_public,
      verified_level: profile.verified_level,
      age: privacy?.show_age === true ? age : null,
      created_at: profile.created_at,
      ...extras
    };
  }

  function sanitizeStringArray(value, { maxItems = 20, maxLength = 60 } = {}) {
    if (!Array.isArray(value)) return [];
    return value
      .filter((item) => typeof item === "string" && item.trim() !== "")
      .slice(0, maxItems)
      .map((item) => item.trim().slice(0, maxLength));
  }

  return {
    GOALS,
    AUDIENCES,
    REPORT_REASONS,
    getFeatureFlags,
    requireFlag,
    ageFromBirthDate,
    getProfile,
    getPrivacy,
    isBlockedEitherWay,
    areFriends,
    isFollowing,
    publicProfileView,
    sanitizeStringArray
  };
}

module.exports = { createHelpers, GOALS, AUDIENCES, REPORT_REASONS };
