"use strict";

/**
 * MaliLink Social — directs (lives).
 *
 *   GET  /lives/config                 disponibilité RÉELLE (config + drapeau + serveur joignable)
 *   GET  /lives                        directs en cours visibles par moi
 *   POST /lives                        démarrer (titre, audience) → jeton « publier » court
 *   GET  /lives/:id                    détail + compteur réel
 *   POST /lives/:id/rejoindre          jeton « regarder seulement » court
 *   POST /lives/:id/jeton              renouveler son jeton (droits relus)
 *   POST /lives/:id/presence           présence (hôte : maintient le direct)
 *   GET  /lives/:id/commentaires       commentaires (?apres=<id>)
 *   POST /lives/:id/commentaires       commenter
 *   DELETE /lives/:id/commentaires/:cid  supprimer (hôte, auteur, Super Admin)
 *   GET  /lives/:id/spectateurs        spectateurs présents (hôte, Super Admin)
 *   POST /lives/:id/exclure/:userId    exclure un spectateur (hôte, Super Admin)
 *   POST /lives/:id/signaler           signaler le direct
 *   POST /lives/:id/terminer           terminer (hôte, Super Admin)
 *
 * Droits contrôlés côté serveur à chaque jeton : audience (public, amis,
 * abonnés), blocages, exclusion, direct encore en cours. Chaque direct
 * appartient au tenant de la requête qui l'a créé : toute recherche (et le
 * nettoyage automatique) est limitée au tenant de la requête ; un direct
 * d'un autre tenant répond « introuvable », même avec son identifiant. Jetons limités à
 * la salle, 10 minutes. Aucun enregistrement. Sans serveur média
 * fonctionnel, tout répond « indisponible » : aucun direct simulé.
 */

const crypto = require("crypto");
const livekit = require("./livekit");

const TTL_JETON = 600;
const HOTE_ABSENT_S = 60;
const SPECTATEUR_ABSENT_S = 45;
const AUDIENCES = ["public", "friends", "followers"];

module.exports = function registerLiveRoutes(router, { pool, helpers, createNotification, realtime }) {
  const { getFeatureFlags, isBlockedEitherWay, areFriends, isFollowing, getProfile } = helpers;

  async function disponibilite() {
    const config = livekit.configuration();
    const flags = await getFeatureFlags();
    const drapeau = flags.social_lives_enabled === true;
    const sante = config ? await livekit.sante(config) : { ok: false, detail: "non_configure" };
    const enabled = Boolean(config) && drapeau && sante.ok;
    const raison = !config ? "serveur_media_non_configure" : !drapeau ? "fonction_desactivee" : !sante.ok ? sante.detail : "";
    return { enabled, raison, config, verifications: { configuration: Boolean(config), drapeau, serveur: sante.ok } };
  }
  const indisponible = (res, d) => res.status(503).json({ error: "Les directs sont indisponibles pour le moment.", code: "LIVES_INDISPONIBLES", raison: d.raison });

  async function estSuperAdmin(userId) {
    const { rows } = await pool.query(`SELECT is_super_admin, role, is_active FROM users WHERE id=$1`, [userId]);
    const u = rows[0];
    return Boolean(u && u.is_active !== false && (u.is_super_admin === true || String(u.role).toLowerCase() === "super_admin"));
  }

  // Tenant validé par authenticateToken (jeton et requête concordent).
  const tenantDe = (req) => req.tenant_id || "malilink";

  // Fin automatique des directs du tenant dont l'hôte ne donne plus signe de vie.
  async function nettoyer(req) {
    const { rows } = await pool.query(
      `UPDATE social_lives SET status='ended', ended_at=NOW(), end_reason='hote_deconnecte'
        WHERE status='live' AND tenant_id=$2 AND host_seen_at < NOW() - make_interval(secs => $1)
        RETURNING id, public_id, host_id, room_name`, [HOTE_ABSENT_S, tenantDe(req)]);
    const config = livekit.configuration();
    for (const r of rows) {
      if (config) livekit.api(config, "DeleteRoom", r.room_name, {}).catch(() => {});
      pousser(r, "live:termine", { raison: "hote_deconnecte" });
    }
  }

  async function liveDe(req, publicId = req.params.id) {
    const { rows } = await pool.query(
      `SELECT l.*, p.display_name AS host_name, p.photo_url AS host_photo
         FROM social_lives l LEFT JOIN social_profiles p ON p.user_id=l.host_id
        WHERE l.public_id=$1 AND l.tenant_id=$2`, [String(publicId || "").slice(0, 40), tenantDe(req)]);
    return rows[0] || null;
  }

  /* Peut-on regarder ? Hôte toujours ; sinon audience + blocage + exclusion. */
  async function peutRegarder(live, moi) {
    if (live.host_id === moi) return { ok: true };
    if (await isBlockedEitherWay(moi, live.host_id)) return { ok: false, status: 404, message: "Direct introuvable." };
    const exclu = (await pool.query(`SELECT banned_at FROM social_live_viewers WHERE live_id=$1 AND user_id=$2`, [live.id, moi])).rows[0];
    if (exclu?.banned_at) return { ok: false, status: 403, message: "Vous avez été exclu de ce direct.", code: "EXCLU" };
    if (live.audience === "friends" && !(await areFriends(moi, live.host_id))) return { ok: false, status: 403, message: "Direct réservé aux amis." };
    if (live.audience === "followers" && !(await isFollowing(moi, live.host_id)) && !(await areFriends(moi, live.host_id))) {
      return { ok: false, status: 403, message: "Direct réservé aux abonnés." };
    }
    return { ok: true };
  }

  /* Compteur réel : participants connectés à la salle LiveKit (hors hôte). */
  const cacheCompteur = new Map();
  async function compteur(live) {
    const memo = cacheCompteur.get(live.id);
    if (memo && Date.now() - memo.at < 5000) return memo.valeur;
    let valeur;
    const config = livekit.configuration();
    try {
      if (!config) throw new Error("non configuré");
      const r = await livekit.api(config, "ListParticipants", live.room_name, {});
      const spectateurs = (r.participants || []).filter((p) => p.identity !== `u${live.host_id}`);
      valeur = { spectateurs: spectateurs.length, source: "serveur_media", hote_connecte: (r.participants || []).some((p) => p.identity === `u${live.host_id}`) };
    } catch {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM social_live_viewers
          WHERE live_id=$1 AND banned_at IS NULL AND left_at IS NULL AND last_seen_at > NOW() - make_interval(secs => $2)`,
        [live.id, SPECTATEUR_ABSENT_S]);
      valeur = { spectateurs: rows[0].n, source: "presence", hote_connecte: null };
    }
    cacheCompteur.set(live.id, { at: Date.now(), valeur });
    if (valeur.spectateurs > (live.peak_viewers || 0)) {
      pool.query(`UPDATE social_lives SET peak_viewers=GREATEST(peak_viewers,$2) WHERE id=$1`, [live.id, valeur.spectateurs]).catch(() => {});
    }
    return valeur;
  }

  const vue = (l, extra = {}) => ({
    id: l.public_id, title: l.title, audience: l.audience, status: l.status, started_at: l.started_at, ended_at: l.ended_at,
    end_reason: l.end_reason || "", comments_enabled: l.comments_enabled,
    host: { user_id: l.host_id, display_name: l.host_name || "Membre MaliLink", photo_url: l.host_photo || null },
    ...extra,
  });

  async function pousser(live, evenement, donnees) {
    if (!realtime) return;
    try {
      const { rows } = await pool.query(
        `SELECT user_id FROM social_live_viewers WHERE live_id=$1 AND banned_at IS NULL AND left_at IS NULL AND last_seen_at > NOW() - INTERVAL '2 minutes'`, [live.id]);
      realtime.emitToUsers([live.host_id, ...rows.map((r) => r.user_id)], evenement, { live_id: live.public_id, ...donnees });
    } catch { /* confort */ }
  }

  router.get("/lives/config", async (req, res) => {
    const d = await disponibilite();
    res.json({ enabled: d.enabled, raison: d.raison, verifications: d.verifications, url: d.enabled ? d.config.url : null });
  });

  router.get("/lives", async (req, res) => {
    try {
      const d = await disponibilite();
      if (!d.enabled) return res.json({ enabled: false, raison: d.raison, lives: [] });
      await nettoyer(req);
      const moi = req.user.id;
      const { rows } = await pool.query(
        `SELECT l.*, p.display_name AS host_name, p.photo_url AS host_photo
           FROM social_lives l LEFT JOIN social_profiles p ON p.user_id=l.host_id
          WHERE l.status='live' AND l.tenant_id=$2
            AND (l.host_id=$1 OR l.audience='public'
                 OR EXISTS (SELECT 1 FROM social_friendships f WHERE f.user_a=LEAST($1::int,l.host_id) AND f.user_b=GREATEST($1::int,l.host_id))
                 OR (l.audience='followers' AND EXISTS (SELECT 1 FROM social_follows fo WHERE fo.follower_user_id=$1 AND fo.followed_user_id=l.host_id AND fo.status='active')))
            AND NOT EXISTS (SELECT 1 FROM social_blocks b WHERE (b.blocker_user_id=$1 AND b.blocked_user_id=l.host_id) OR (b.blocker_user_id=l.host_id AND b.blocked_user_id=$1))
            AND NOT EXISTS (SELECT 1 FROM social_live_viewers v WHERE v.live_id=l.id AND v.user_id=$1 AND v.banned_at IS NOT NULL)
          ORDER BY l.started_at DESC LIMIT 50`, [moi, tenantDe(req)]);
      const lives = [];
      for (const l of rows) lives.push(vue(l, { compteur: await compteur(l) }));
      res.json({ enabled: true, lives });
    } catch (e) {
      console.error("ERREUR LIVES LISTE :", e.message);
      res.status(500).json({ error: "Erreur chargement des directs." });
    }
  });

  router.post("/lives", async (req, res) => {
    try {
      const d = await disponibilite();
      if (!d.enabled) return indisponible(res, d);
      const moi = req.user.id;
      const titre = String(req.body?.title || "").trim().slice(0, 120);
      const audience = AUDIENCES.includes(req.body?.audience) ? req.body.audience : "public";
      if (titre.length < 3) return res.status(400).json({ error: "Donnez un titre à votre direct (3 caractères au moins)." });
      const profil = await getProfile(moi);
      if (!profil || profil.is_active === false) return res.status(403).json({ error: "Activez votre profil MaliLink Social pour lancer un direct." });
      await nettoyer(req);
      const recents = (await pool.query(`SELECT COUNT(*)::int AS n FROM social_lives WHERE host_id=$1 AND started_at > NOW() - INTERVAL '24 hours'`, [moi])).rows[0].n;
      if (recents >= 10) return res.status(429).json({ error: "Limite de 10 directs par 24 heures atteinte." });
      const publicId = crypto.randomBytes(12).toString("base64url");
      const salle = `live-${crypto.randomBytes(12).toString("hex")}`;
      try {
        await pool.query(
          `INSERT INTO social_lives (public_id, tenant_id, host_id, title, audience, room_name) VALUES ($1,$2,$3,$4,$5,$6)`,
          [publicId, tenantDe(req), moi, titre, audience, salle]);
      } catch (e) {
        if (e.code === "23505") return res.status(409).json({ error: "Vous avez déjà un direct en cours.", code: "DIRECT_EN_COURS" });
        throw e;
      }
      const live = await liveDe(req, publicId);
      // Prévenir amis et abonnés (200 au plus), sans bloquer le démarrage.
      // Amis toujours ; abonnés aussi sauf pour un direct réservé aux amis.
      pool.query(
        `SELECT DISTINCT u FROM (
           SELECT CASE WHEN user_a=$1 THEN user_b ELSE user_a END AS u FROM social_friendships WHERE user_a=$1 OR user_b=$1
           UNION SELECT follower_user_id FROM social_follows WHERE followed_user_id=$1 AND status='active' AND $2 <> 'friends') x LIMIT 200`, [moi, audience])
        .then(({ rows }) => Promise.all(rows.map((r) => createNotification({
          user_id: r.u, title: "Direct en cours", message: `${live.host_name || "Un membre"} est en direct : ${titre}`, type: "social_live",
          company_id: null, related_entity_type: "social_live",
        }).catch(() => {}))))
        .catch(() => {});
      res.status(201).json({
        live: vue(live), url: d.config.url, ttl: TTL_JETON,
        token: livekit.jetonAcces(d.config, { salle, identite: `u${moi}`, nom: live.host_name || "Hôte", publier: true, ttl: TTL_JETON, metadonnees: { role: "hote" } }),
      });
    } catch (e) {
      console.error("ERREUR LIVES DEMARRER :", e.message);
      res.status(500).json({ error: "Erreur démarrage du direct." });
    }
  });

  router.get("/lives/:id", async (req, res) => {
    try {
      await nettoyer(req);
      const live = await liveDe(req);
      if (!live) return res.status(404).json({ error: "Direct introuvable." });
      const droit = await peutRegarder(live, req.user.id);
      if (!droit.ok && !(await estSuperAdmin(req.user.id))) return res.status(droit.status).json({ error: droit.message, code: droit.code });
      res.json(vue(live, { compteur: live.status === "live" ? await compteur(live) : null, est_hote: live.host_id === req.user.id }));
    } catch (e) {
      console.error("ERREUR LIVES DETAIL :", e.message);
      res.status(500).json({ error: "Erreur." });
    }
  });

  async function delivrerJeton(req, res, rejoindre) {
    const d = await disponibilite();
    if (!d.enabled) return indisponible(res, d);
    await nettoyer(req);
    const live = await liveDe(req);
    if (!live) return res.status(404).json({ error: "Direct introuvable." });
    if (live.status !== "live") return res.status(410).json({ error: "Ce direct est terminé.", code: "DIRECT_TERMINE" });
    const moi = req.user.id;
    const droit = await peutRegarder(live, moi);
    if (!droit.ok) return res.status(droit.status).json({ error: droit.message, code: droit.code });
    const hote = live.host_id === moi;
    if (!hote && rejoindre) {
      await pool.query(
        `INSERT INTO social_live_viewers (live_id, user_id) VALUES ($1,$2)
         ON CONFLICT (live_id, user_id) DO UPDATE SET last_seen_at=NOW(), left_at=NULL`, [live.id, moi]);
    }
    const profil = await getProfile(moi).catch(() => null);
    res.json({
      live: vue(live), url: d.config.url, ttl: TTL_JETON,
      token: livekit.jetonAcces(d.config, {
        salle: live.room_name, identite: `u${moi}`, nom: profil?.display_name || "Spectateur", publier: hote, ttl: TTL_JETON,
        metadonnees: { role: hote ? "hote" : "spectateur" },
      }),
    });
  }
  router.post("/lives/:id/rejoindre", (req, res) => delivrerJeton(req, res, true).catch((e) => { console.error("ERREUR LIVES REJOINDRE :", e.message); res.status(500).json({ error: "Erreur." }); }));
  router.post("/lives/:id/jeton", (req, res) => delivrerJeton(req, res, false).catch((e) => { console.error("ERREUR LIVES JETON :", e.message); res.status(500).json({ error: "Erreur." }); }));

  router.post("/lives/:id/presence", async (req, res) => {
    try {
      const live = await liveDe(req);
      if (!live) return res.status(404).json({ error: "Direct introuvable." });
      const moi = req.user.id;
      if (live.host_id === moi) {
        await pool.query(`UPDATE social_lives SET host_seen_at=NOW() WHERE id=$1 AND status='live'`, [live.id]);
      } else {
        await pool.query(`UPDATE social_live_viewers SET last_seen_at=NOW(), left_at=NULL WHERE live_id=$1 AND user_id=$2 AND banned_at IS NULL`, [live.id, moi]);
      }
      if (req.body?.depart === true && live.host_id !== moi) {
        await pool.query(`UPDATE social_live_viewers SET left_at=NOW() WHERE live_id=$1 AND user_id=$2`, [live.id, moi]);
      }
      const exclu = (await pool.query(`SELECT banned_at FROM social_live_viewers WHERE live_id=$1 AND user_id=$2`, [live.id, moi])).rows[0]?.banned_at;
      res.json({ status: live.status, exclu: Boolean(exclu), compteur: live.status === "live" ? await compteur(live) : null });
    } catch (e) {
      console.error("ERREUR LIVES PRESENCE :", e.message);
      res.status(500).json({ error: "Erreur." });
    }
  });

  router.get("/lives/:id/commentaires", async (req, res) => {
    try {
      const live = await liveDe(req);
      if (!live) return res.status(404).json({ error: "Direct introuvable." });
      const droit = await peutRegarder(live, req.user.id);
      if (!droit.ok && !(await estSuperAdmin(req.user.id))) return res.status(droit.status).json({ error: droit.message });
      const { rows } = await pool.query(
        `SELECT c.id, c.user_id, c.content, c.created_at, p.display_name, p.photo_url
           FROM social_live_comments c LEFT JOIN social_profiles p ON p.user_id=c.user_id
          WHERE c.live_id=$1 AND c.deleted_at IS NULL AND c.id > $2 ORDER BY c.id DESC LIMIT 60`,
        [live.id, Number(req.query.apres) || 0]);
      res.json(rows.reverse());
    } catch (e) {
      console.error("ERREUR LIVES COMMENTAIRES :", e.message);
      res.status(500).json({ error: "Erreur." });
    }
  });

  router.post("/lives/:id/commentaires", async (req, res) => {
    try {
      const live = await liveDe(req);
      if (!live) return res.status(404).json({ error: "Direct introuvable." });
      if (live.status !== "live") return res.status(410).json({ error: "Ce direct est terminé." });
      if (!live.comments_enabled) return res.status(403).json({ error: "Les commentaires sont fermés." });
      const moi = req.user.id;
      const droit = await peutRegarder(live, moi);
      if (!droit.ok) return res.status(droit.status).json({ error: droit.message, code: droit.code });
      if (live.host_id !== moi) {
        const present = await pool.query(`SELECT 1 FROM social_live_viewers WHERE live_id=$1 AND user_id=$2 AND banned_at IS NULL`, [live.id, moi]);
        if (!present.rows[0]) return res.status(403).json({ error: "Rejoignez le direct pour commenter." });
      }
      const contenu = String(req.body?.content || "").replace(/\s+/g, " ").trim().slice(0, 300);
      if (!contenu) return res.status(400).json({ error: "Commentaire vide." });
      const recent = (await pool.query(
        `SELECT COUNT(*)::int AS n FROM social_live_comments WHERE live_id=$1 AND user_id=$2 AND created_at > NOW() - INTERVAL '10 seconds'`, [live.id, moi])).rows[0].n;
      if (recent >= 3) return res.status(429).json({ error: "Doucement : 3 commentaires toutes les 10 secondes au plus." });
      const c = (await pool.query(
        `INSERT INTO social_live_comments (live_id, user_id, content) VALUES ($1,$2,$3) RETURNING id, user_id, content, created_at`, [live.id, moi, contenu])).rows[0];
      const p = await getProfile(moi).catch(() => null);
      const commentaire = { ...c, display_name: p?.display_name || "Membre", photo_url: p?.photo_url || null };
      pousser(live, "live:commentaire", { commentaire });
      res.status(201).json(commentaire);
    } catch (e) {
      console.error("ERREUR LIVES COMMENTER :", e.message);
      res.status(500).json({ error: "Erreur." });
    }
  });

  router.delete("/lives/:id/commentaires/:cid", async (req, res) => {
    try {
      const live = await liveDe(req);
      if (!live) return res.status(404).json({ error: "Direct introuvable." });
      const moi = req.user.id;
      const moderateur = live.host_id === moi || (await estSuperAdmin(moi));
      const { rows } = await pool.query(
        `UPDATE social_live_comments SET deleted_at=NOW(), deleted_by=$3
          WHERE id=$1 AND live_id=$2 AND deleted_at IS NULL AND ($4 OR user_id=$3) RETURNING id`,
        [Number(req.params.cid) || 0, live.id, moi, moderateur]);
      if (!rows[0]) return res.status(404).json({ error: "Commentaire introuvable." });
      pousser(live, "live:commentaire_supprime", { commentaire_id: rows[0].id });
      res.json({ success: true });
    } catch (e) {
      console.error("ERREUR LIVES SUPPR COMMENTAIRE :", e.message);
      res.status(500).json({ error: "Erreur." });
    }
  });

  router.get("/lives/:id/spectateurs", async (req, res) => {
    try {
      const live = await liveDe(req);
      if (!live) return res.status(404).json({ error: "Direct introuvable." });
      if (live.host_id !== req.user.id && !(await estSuperAdmin(req.user.id))) return res.status(403).json({ error: "Réservé à l'hôte." });
      const { rows } = await pool.query(
        `SELECT v.user_id, p.display_name, p.photo_url, v.joined_at, v.banned_at,
                (v.left_at IS NULL AND v.last_seen_at > NOW() - make_interval(secs => $2)) AS present
           FROM social_live_viewers v LEFT JOIN social_profiles p ON p.user_id=v.user_id
          WHERE v.live_id=$1 ORDER BY present DESC, v.joined_at DESC LIMIT 200`, [live.id, SPECTATEUR_ABSENT_S]);
      res.json(rows);
    } catch (e) {
      console.error("ERREUR LIVES SPECTATEURS :", e.message);
      res.status(500).json({ error: "Erreur." });
    }
  });

  router.post("/lives/:id/exclure/:userId", async (req, res) => {
    try {
      const live = await liveDe(req);
      if (!live) return res.status(404).json({ error: "Direct introuvable." });
      const moi = req.user.id;
      if (live.host_id !== moi && !(await estSuperAdmin(moi))) return res.status(403).json({ error: "Réservé à l'hôte." });
      const cible = Number(req.params.userId);
      if (!cible || cible === live.host_id) return res.status(400).json({ error: "Spectateur invalide." });
      await pool.query(
        `INSERT INTO social_live_viewers (live_id, user_id, banned_at, banned_by, ban_reason) VALUES ($1,$2,NOW(),$3,$4)
         ON CONFLICT (live_id, user_id) DO UPDATE SET banned_at=NOW(), banned_by=$3, ban_reason=$4`,
        [live.id, cible, moi, String(req.body?.raison || "").slice(0, 200)]);
      let deconnecte = false;
      const config = livekit.configuration();
      if (config && live.status === "live") {
        deconnecte = await livekit.api(config, "RemoveParticipant", live.room_name, { identity: `u${cible}` }).then(() => true).catch(() => false);
      }
      cacheCompteur.delete(live.id);
      if (realtime) realtime.emitToUsers([cible], "live:exclu", { live_id: live.public_id });
      res.json({ success: true, deconnecte_du_serveur_media: deconnecte });
    } catch (e) {
      console.error("ERREUR LIVES EXCLURE :", e.message);
      res.status(500).json({ error: "Erreur." });
    }
  });

  router.post("/lives/:id/signaler", async (req, res) => {
    try {
      const live = await liveDe(req);
      if (!live) return res.status(404).json({ error: "Direct introuvable." });
      const moi = req.user.id;
      if (live.host_id === moi) return res.status(400).json({ error: "Vous ne pouvez pas signaler votre propre direct." });
      const raison = String(req.body?.raison || "").trim().slice(0, 80);
      if (!raison) return res.status(400).json({ error: "Choisissez un motif." });
      const deja = await pool.query(`SELECT 1 FROM social_reports WHERE reporter_user_id=$1 AND target_type='live' AND target_id=$2`, [moi, live.id]);
      if (deja.rows[0]) return res.json({ success: true, deja_signale: true });
      await pool.query(
        `INSERT INTO social_reports (tenant_id, reporter_user_id, target_user_id, target_type, target_id, reason, details)
         VALUES ($1,$2,$3,'live',$4,$5,$6)`,
        [live.tenant_id, moi, live.host_id, live.id, raison, String(req.body?.details || "").slice(0, 500)]);
      res.status(201).json({ success: true });
    } catch (e) {
      console.error("ERREUR LIVES SIGNALER :", e.message);
      res.status(500).json({ error: "Erreur." });
    }
  });

  router.post("/lives/:id/terminer", async (req, res) => {
    try {
      const live = await liveDe(req);
      if (!live) return res.status(404).json({ error: "Direct introuvable." });
      const moi = req.user.id;
      const superAdmin = live.host_id !== moi && (await estSuperAdmin(moi));
      if (live.host_id !== moi && !superAdmin) return res.status(403).json({ error: "Réservé à l'hôte." });
      const { rows } = await pool.query(
        `UPDATE social_lives SET status='ended', ended_at=NOW(), ended_by=$2, end_reason=$3 WHERE id=$1 AND status='live' RETURNING id`,
        [live.id, moi, superAdmin ? "moderation" : "hote"]);
      const config = livekit.configuration();
      if (rows[0] && config) await livekit.api(config, "DeleteRoom", live.room_name, {}).catch(() => {});
      if (rows[0]) pousser(live, "live:termine", { raison: superAdmin ? "moderation" : "hote" });
      res.json({ success: true, termine: Boolean(rows[0]) });
    } catch (e) {
      console.error("ERREUR LIVES TERMINER :", e.message);
      res.status(500).json({ error: "Erreur." });
    }
  });
};
