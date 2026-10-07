"use strict";

/**
 * MaliLink Social — appels audio et vidéo.
 *
 * Signalisation et historique ici (sonnerie, accepter, refuser, annuler,
 * raccrocher) ; le média passe par LiveKit (rtc.malilinkglobal.com). Un
 * jeton LiveKit (JWT HS256 signé avec la clé de l'API) n'est remis qu'aux
 * deux participants, pour une salle propre à l'appel.
 *
 * Activation conditionnelle : variables LIVEKIT_* présentes ET drapeaux
 * social_calls_enabled (audio) / social_video_calls_enabled (vidéo). Sinon
 * GET /calls/config répond { enabled: false } et l'interface masque les
 * boutons : la messagerie n'en dépend jamais.
 */

const crypto = require("crypto");
const jwt = require("jsonwebtoken");

const SONNERIE_SECONDES = 45;
const DUREE_MAX_HEURES = 6;

function configurationLiveKit() {
  const url = String(process.env.LIVEKIT_URL || "").trim();
  const cle = String(process.env.LIVEKIT_API_KEY || "").trim();
  const secret = String(process.env.LIVEKIT_API_SECRET || "").trim();
  if (!/^wss?:\/\//.test(url) || !cle || secret.length < 32) return null;
  return { url, cle, secret };
}

/* Jeton d'accès LiveKit pour une salle (format officiel des « access tokens »). */
function jetonLiveKit(config, { salle, identite, nom, video }) {
  return jwt.sign(
    {
      name: nom,
      video: {
        room: salle, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false,
        canPublishSources: video ? ["camera", "microphone"] : ["microphone"],
      },
    },
    config.secret,
    { algorithm: "HS256", issuer: config.cle, subject: identite, jwtid: crypto.randomUUID(), expiresIn: "2h", notBefore: 0 }
  );
}

module.exports = function registerCallRoutes(router, { pool, helpers, realtime }) {
  const { getFeatureFlags, isBlockedEitherWay, areFriends, getProfile, getPrivacy } = helpers;

  // Poussée immédiate aux deux participants (le sondage de l'interface reste le filet de sécurité).
  async function pousser(publicId, evenement) {
    if (!realtime) return;
    try {
      const { rows } = await pool.query(`SELECT * FROM social_calls WHERE public_id=$1`, [publicId]);
      const c = rows[0];
      if (!c) return;
      for (const [moi] of [[c.caller_id], [c.callee_id]]) {
        const appel = await appelDe(publicId, moi);
        realtime.emitToUsers([moi], evenement === "call:incoming" && moi === c.caller_id ? "call:update" : evenement, { call: vue(appel, moi) });
      }
    } catch { /* la poussée est un confort, jamais bloquante */ }
  }

  async function etat() {
    const flags = await getFeatureFlags();
    const config = configurationLiveKit();
    const audio = Boolean(config) && flags.social_calls_enabled === true;
    return { config, audio, video: audio && flags.social_video_calls_enabled === true };
  }

  // Sonnerie sans réponse → manqué ; appel resté ouvert trop longtemps → terminé.
  async function expirer() {
    await pool.query(
      `UPDATE social_calls SET status='missed', ended_at=NOW(), end_reason='sans_reponse'
        WHERE status='ringing' AND created_at < NOW() - make_interval(secs => $1)`, [SONNERIE_SECONDES]);
    await pool.query(
      `UPDATE social_calls SET status='ended', ended_at=NOW(), end_reason='duree_max',
              duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM NOW() - COALESCE(answered_at, created_at))::int)
        WHERE status='accepted' AND COALESCE(answered_at, created_at) < NOW() - make_interval(hours => $1)`, [DUREE_MAX_HEURES]);
  }

  const vue = (c, moi) => ({
    id: c.public_id, kind: c.kind, status: c.status, direction: c.caller_id === moi ? "sortant" : "entrant",
    created_at: c.created_at, answered_at: c.answered_at, ended_at: c.ended_at, duration_seconds: c.duration_seconds,
    other: c.other_id ? { user_id: c.other_id, display_name: c.other_name || "Membre MaliLink", avatar_url: c.other_avatar || null } : undefined,
  });

  async function appelDe(publicId, moi) {
    const { rows } = await pool.query(
      `SELECT c.*, CASE WHEN c.caller_id=$2 THEN c.callee_id ELSE c.caller_id END AS other_id,
              p.display_name AS other_name, p.photo_url AS other_avatar
         FROM social_calls c
         LEFT JOIN social_profiles p ON p.user_id = CASE WHEN c.caller_id=$2 THEN c.callee_id ELSE c.caller_id END
        WHERE c.public_id=$1 AND (c.caller_id=$2 OR c.callee_id=$2)`, [String(publicId || "").slice(0, 40), moi]);
    return rows[0] || null;
  }

  async function nomAffiche(userId) {
    const p = await getProfile(userId).catch(() => null);
    return p?.display_name || "Membre MaliLink";
  }

  const indisponible = (res) => res.status(503).json({ error: "Les appels ne sont pas encore disponibles.", code: "APPELS_INDISPONIBLES" });

  router.get("/calls/config", async (req, res) => {
    const e = await etat();
    res.json({ enabled: e.audio, video: e.video, url: e.audio ? e.config.url : null, sonnerie_secondes: SONNERIE_SECONDES });
  });

  // Lancer un appel.
  router.post("/calls", async (req, res) => {
    try {
      const e = await etat();
      if (!e.audio) return indisponible(res);
      const moi = req.user.id;
      const autre = Number(req.body?.user_id);
      const kind = req.body?.kind === "video" ? "video" : "audio";
      if (kind === "video" && !e.video) return res.status(503).json({ error: "Les appels vidéo ne sont pas encore disponibles.", code: "VIDEO_INDISPONIBLE" });
      if (!autre || autre === moi) return res.status(400).json({ error: "Destinataire invalide." });
      if (await isBlockedEitherWay(moi, autre)) return res.status(403).json({ error: "Appel impossible avec ce profil." });
      const profil = await getProfile(autre);
      if (!profil || profil.is_active === false) return res.status(404).json({ error: "Profil introuvable." });
      const regle = (await getPrivacy(autre))?.who_can_call || "friends";
      if (regle === "nobody") return res.status(403).json({ error: "Cette personne n'accepte pas les appels." });
      if (regle === "friends" && !(await areFriends(moi, autre))) return res.status(403).json({ error: "Seuls ses amis peuvent appeler cette personne." });
      await expirer();
      const occupe = await pool.query(
        `SELECT caller_id, callee_id FROM social_calls
          WHERE status IN ('ringing','accepted') AND (caller_id = ANY($1::int[]) OR callee_id = ANY($1::int[])) LIMIT 1`, [[moi, autre]]);
      if (occupe.rows[0]) {
        const lui = [occupe.rows[0].caller_id, occupe.rows[0].callee_id].includes(autre);
        return res.status(409).json({ error: lui ? "Cette personne est déjà en communication." : "Vous avez déjà un appel en cours.", code: "OCCUPE" });
      }
      const publicId = crypto.randomBytes(12).toString("base64url");
      const salle = `ml-${crypto.randomBytes(12).toString("hex")}`;
      await pool.query(
        `INSERT INTO social_calls (public_id, tenant_id, caller_id, callee_id, kind, room_name) VALUES ($1,$2,$3,$4,$5,$6)`,
        [publicId, req.tenant_id || "malilink", moi, autre, kind, salle]);
      const appel = await appelDe(publicId, moi);
      pousser(publicId, "call:incoming");
      res.status(201).json({
        call: vue(appel, moi), url: e.config.url,
        token: jetonLiveKit(e.config, { salle, identite: `u${moi}`, nom: await nomAffiche(moi), video: kind === "video" }),
      });
    } catch (err) {
      console.error("ERREUR SOCIAL APPEL :", err.message);
      res.status(500).json({ error: "Erreur lancement de l'appel." });
    }
  });

  // Appel entrant qui sonne, appel en cours (sondé par l'interface).
  router.get("/calls/active", async (req, res) => {
    try {
      const e = await etat();
      if (!e.audio) return res.json({ entrant: null, en_cours: null });
      await expirer();
      const moi = req.user.id;
      const { rows } = await pool.query(
        `SELECT c.*, CASE WHEN c.caller_id=$1 THEN c.callee_id ELSE c.caller_id END AS other_id,
                p.display_name AS other_name, p.photo_url AS other_avatar
           FROM social_calls c
           LEFT JOIN social_profiles p ON p.user_id = CASE WHEN c.caller_id=$1 THEN c.callee_id ELSE c.caller_id END
          WHERE c.status IN ('ringing','accepted') AND (c.caller_id=$1 OR c.callee_id=$1)
          ORDER BY c.created_at DESC LIMIT 2`, [moi]);
      const entrant = rows.find((c) => c.status === "ringing" && c.callee_id === moi);
      const enCours = rows.find((c) => c !== entrant);
      res.json({ entrant: entrant ? vue(entrant, moi) : null, en_cours: enCours ? vue(enCours, moi) : null });
    } catch (err) {
      console.error("ERREUR SOCIAL APPELS ACTIFS :", err.message);
      res.status(500).json({ error: "Erreur appels." });
    }
  });

  router.get("/calls/history", async (req, res) => {
    try {
      const moi = req.user.id;
      await expirer();
      const { rows } = await pool.query(
        `SELECT c.*, CASE WHEN c.caller_id=$1 THEN c.callee_id ELSE c.caller_id END AS other_id,
                p.display_name AS other_name, p.photo_url AS other_avatar
           FROM social_calls c
           LEFT JOIN social_profiles p ON p.user_id = CASE WHEN c.caller_id=$1 THEN c.callee_id ELSE c.caller_id END
          WHERE c.caller_id=$1 OR c.callee_id=$1
          ORDER BY c.created_at DESC LIMIT $2`, [moi, Math.min(Math.max(Number(req.query.limit) || 30, 1), 100)]);
      res.json(rows.map((c) => vue(c, moi)));
    } catch (err) {
      console.error("ERREUR SOCIAL HISTORIQUE APPELS :", err.message);
      res.status(500).json({ error: "Erreur historique des appels." });
    }
  });

  // Décrocher : seul l'appelé, tant que ça sonne.
  router.post("/calls/:id/accept", async (req, res) => {
    try {
      const e = await etat();
      if (!e.audio) return indisponible(res);
      await expirer();
      const moi = req.user.id;
      const { rows } = await pool.query(
        `UPDATE social_calls SET status='accepted', answered_at=NOW()
          WHERE public_id=$1 AND callee_id=$2 AND status='ringing' RETURNING *`, [String(req.params.id).slice(0, 40), moi]);
      if (!rows[0]) return res.status(409).json({ error: "Cet appel n'est plus disponible.", code: "APPEL_TERMINE" });
      const appel = await appelDe(rows[0].public_id, moi);
      pousser(rows[0].public_id, "call:update");
      res.json({
        call: vue(appel, moi), url: e.config.url,
        token: jetonLiveKit(e.config, { salle: rows[0].room_name, identite: `u${moi}`, nom: await nomAffiche(moi), video: rows[0].kind === "video" }),
      });
    } catch (err) {
      console.error("ERREUR SOCIAL DECROCHER :", err.message);
      res.status(500).json({ error: "Erreur." });
    }
  });

  /* Refuser (appelé), annuler (appelant, pendant la sonnerie), raccrocher
     (l'un ou l'autre, appel décroché). Idempotent : un appel déjà clos
     n'est pas modifié. */
  async function clore(req, res, action) {
    try {
      const moi = req.user.id;
      const id = String(req.params.id).slice(0, 40);
      const regles = {
        refuse: [`callee_id=$2 AND status='ringing'`, "refused"],
        cancel: [`caller_id=$2 AND status='ringing'`, "cancelled"],
        end: [`(caller_id=$2 OR callee_id=$2) AND status IN ('ringing','accepted')`, null],
      };
      const [condition, statut] = regles[action];
      const { rows } = await pool.query(
        `UPDATE social_calls SET
            status = COALESCE($3, CASE WHEN status='accepted' THEN 'ended' WHEN caller_id=$2 THEN 'cancelled' ELSE 'refused' END),
            ended_at = NOW(), ended_by = $2, end_reason = $4,
            duration_seconds = CASE WHEN status='accepted' THEN GREATEST(0, EXTRACT(EPOCH FROM NOW() - answered_at)::int) ELSE 0 END
          WHERE public_id=$1 AND ${condition} RETURNING public_id`,
        [id, moi, statut, action === "end" ? String(req.body?.raison || "raccroche").slice(0, 40) : action]);
      const appel = await appelDe(id, moi);
      if (!appel) return res.status(404).json({ error: "Appel introuvable." });
      if (rows[0]) pousser(id, "call:update");
      res.json({ call: vue(appel, moi), modifie: Boolean(rows[0]) });
    } catch (err) {
      console.error("ERREUR SOCIAL FIN APPEL :", err.message);
      res.status(500).json({ error: "Erreur." });
    }
  }
  router.post("/calls/:id/refuse", (req, res) => clore(req, res, "refuse"));
  router.post("/calls/:id/cancel", (req, res) => clore(req, res, "cancel"));
  router.post("/calls/:id/end", (req, res) => clore(req, res, "end"));
};

module.exports.configurationLiveKit = configurationLiveKit;
module.exports.jetonLiveKit = jetonLiveKit;
