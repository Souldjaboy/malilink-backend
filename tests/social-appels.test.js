"use strict";

/**
 * MaliLink Social — appels audio/vidéo (signalisation + jetons LiveKit).
 *
 * Deux exécutions :
 *   scripts/test-integration.sh tests/social-appels.test.js
 *     → LiveKit non configuré : appels indisponibles, messagerie intacte.
 *   LIVEKIT_URL=wss://rtc.exemple.test LIVEKIT_API_KEY=cle-essai \
 *   LIVEKIT_API_SECRET=<32 caractères ou plus> scripts/test-integration.sh tests/social-appels.test.js
 *     → parcours complet : sonnerie, décrocher, raccrocher, refus, annulation,
 *       appel manqué, occupé, confidentialité, blocage, historique.
 */

const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { q, appel, jeton, verifier, section, terminer } = require("./_outils");

const LIVEKIT = Boolean(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && (process.env.LIVEKIT_API_SECRET || "").length >= 32);

async function personne(nom) {
  const u = (await q(
    `INSERT INTO users (fullname, email, password, role, company_id) VALUES ($1,$2,'x','customer',NULL) RETURNING id, role, company_id`,
    [nom, `${nom.toLowerCase().replace(/\W/g, "")}-${crypto.randomBytes(3).toString("hex")}@essai.test`]))[0];
  const token = jeton(u);
  const r = await appel("POST", "/social/profile", token, { display_name: nom, birth_date: "1994-02-10", photo_url: "/uploads/photo-essai.jpg", city: "Bamako", is_public: true });
  if (r.status >= 300) throw new Error(`profil ${nom} : ${JSON.stringify(r.data)}`);
  return { ...u, nom, token };
}
async function amis(a, b) {
  await appel("POST", "/social/friend-requests", a.token, { to_user_id: b.id });
  const d = (await appel("GET", "/social/friend-requests", b.token)).data.find((x) => x.from_user_id === a.id);
  await appel("POST", `/social/friend-requests/${d.id}/respond`, b.token, { accept: true });
}

async function main() {
  // Drapeaux posés avant toute requête Social (le serveur les garde 30 s en cache).
  await q(`UPDATE social_feature_flags SET enabled=true WHERE flag_key IN ('social_calls_enabled','social_video_calls_enabled','social_messages_enabled')`);
  const awa = await personne("Awa Sidibé");
  const moussa = await personne("Moussa Camara");
  const kadi = await personne("Kadi Doumbia");
  await amis(awa, moussa);
  await amis(kadi, moussa);

  if (!LIVEKIT) {
    section("LIVEKIT NON CONFIGURÉ : APPELS MASQUÉS, MESSAGES INTACTS");
    const c = await appel("GET", "/social/calls/config", awa.token);
    verifier("configuration : appels désactivés, aucune URL", c.status === 200 && c.data.enabled === false && c.data.url === null, JSON.stringify(c.data));
    const r = await appel("POST", "/social/calls", awa.token, { user_id: moussa.id, kind: "audio" });
    verifier("lancer un appel : 503 explicite", r.status === 503 && r.data?.code === "APPELS_INDISPONIBLES");
    const actifs = await appel("GET", "/social/calls/active", moussa.token);
    verifier("sondage des appels : réponse vide, sans erreur", actifs.status === 200 && actifs.data.entrant === null);
    const conv = await appel("POST", "/social/messages/conversations", awa.token, { user_id: moussa.id });
    const msg = await appel("POST", `/social/messages/conversations/${conv.data.conversation_id}`, awa.token, { content: "Bonjour Moussa" });
    verifier("la messagerie fonctionne normalement", [200, 201].includes(conv.status) && msg.status === 201, `${conv.status} ${msg.status}`);
    return terminer();
  }

  const decoder = (t) => jwt.verify(t, process.env.LIVEKIT_API_SECRET, { algorithms: ["HS256"] });

  section("CONFIGURATION ET CONFIDENTIALITÉ");
  {
    const c = await appel("GET", "/social/calls/config", awa.token);
    verifier("appels audio et vidéo actifs, URL LiveKit fournie", c.data.enabled === true && c.data.video === true && c.data.url === process.env.LIVEKIT_URL);
    const inconnu = await appel("POST", "/social/calls", awa.token, { user_id: kadi.id, kind: "audio" });
    verifier("appeler quelqu'un qui n'est pas un ami : refusé (règle par défaut « amis »)", inconnu.status === 403);
    const soi = await appel("POST", "/social/calls", awa.token, { user_id: awa.id });
    verifier("s'appeler soi-même : refusé", soi.status === 400);
  }

  let premier;
  section("APPEL AUDIO : SONNERIE, DÉCROCHER, RACCROCHER");
  {
    const r = await appel("POST", "/social/calls", awa.token, { user_id: moussa.id, kind: "audio" });
    premier = r.data.call;
    verifier("appel lancé : sonnerie", r.status === 201 && premier.status === "ringing" && premier.direction === "sortant");
    const t = decoder(r.data.token);
    verifier("jeton LiveKit de l'appelant : identité, salle, micro seul", t.iss === process.env.LIVEKIT_API_KEY && t.sub === `u${awa.id}`
      && /^ml-[0-9a-f]{24}$/.test(t.video.room) && t.video.roomJoin === true && JSON.stringify(t.video.canPublishSources) === '["microphone"]');
    const entrant = await appel("GET", "/social/calls/active", moussa.token);
    verifier("l'appelé voit l'appel entrant, avec le nom de l'appelant", entrant.data.entrant?.id === premier.id && entrant.data.entrant.other?.display_name === "Awa Sidibé");
    const sortant = await appel("GET", "/social/calls/active", awa.token);
    verifier("l'appelant voit son appel en cours", sortant.data.en_cours?.id === premier.id && sortant.data.entrant === null);
    const intrus = await appel("POST", `/social/calls/${premier.id}/accept`, kadi.token);
    verifier("un tiers ne peut pas décrocher", intrus.status === 409);
    const occupe = await appel("POST", "/social/calls", kadi.token, { user_id: moussa.id });
    verifier("appeler quelqu'un qui sonne déjà : occupé", occupe.status === 409 && occupe.data?.code === "OCCUPE");
    const d = await appel("POST", `/social/calls/${premier.id}/accept`, moussa.token);
    const tm = decoder(d.data.token);
    verifier("décroché : même salle, jeton de l'appelé", d.status === 200 && d.data.call.status === "accepted" && tm.video.room === t.video.room && tm.sub === `u${moussa.id}`);
    const deux = await appel("POST", `/social/calls/${premier.id}/accept`, moussa.token);
    verifier("décrocher deux fois : refusé proprement", deux.status === 409);
    await q(`UPDATE social_calls SET answered_at = NOW() - interval '75 seconds' WHERE public_id=$1`, [premier.id]);
    const fin = await appel("POST", `/social/calls/${premier.id}/end`, awa.token);
    verifier("raccroché : terminé, durée enregistrée", fin.data.call.status === "ended" && fin.data.call.duration_seconds >= 74, JSON.stringify(fin.data.call));
    const encore = await appel("POST", `/social/calls/${premier.id}/end`, moussa.token);
    verifier("raccrocher un appel déjà terminé : sans effet", encore.status === 200 && encore.data.modifie === false);
  }

  section("REFUS, ANNULATION, APPEL MANQUÉ, VIDÉO");
  {
    const r1 = (await appel("POST", "/social/calls", awa.token, { user_id: moussa.id })).data.call;
    const refus = await appel("POST", `/social/calls/${r1.id}/refuse`, moussa.token);
    verifier("refusé par l'appelé", refus.data.call.status === "refused");
    const r2 = (await appel("POST", "/social/calls", awa.token, { user_id: moussa.id })).data.call;
    const pasLui = await appel("POST", `/social/calls/${r2.id}/cancel`, moussa.token);
    verifier("seul l'appelant annule", pasLui.data?.modifie === false);
    const annule = await appel("POST", `/social/calls/${r2.id}/cancel`, awa.token);
    verifier("annulé par l'appelant pendant la sonnerie", annule.data.call.status === "cancelled");
    const r3 = (await appel("POST", "/social/calls", awa.token, { user_id: moussa.id, kind: "video" })).data;
    verifier("appel vidéo : caméra et micro autorisés", JSON.stringify(decoder(r3.token).video.canPublishSources) === '["camera","microphone"]');
    await q(`UPDATE social_calls SET created_at = NOW() - interval '60 seconds' WHERE public_id=$1`, [r3.call.id]);
    const apres = await appel("GET", "/social/calls/active", moussa.token);
    const ligne = (await q(`SELECT status FROM social_calls WHERE public_id=$1`, [r3.call.id]))[0];
    verifier("sans réponse après 45 s : appel manqué", apres.data.entrant === null && ligne.status === "missed");
    const tard = await appel("POST", `/social/calls/${r3.call.id}/accept`, moussa.token);
    verifier("on ne décroche pas un appel manqué", tard.status === 409);
  }

  section("BLOCAGE ET HISTORIQUE");
  {
    await appel("POST", `/social/blocks/${awa.id}`, moussa.token);
    const bloque = await appel("POST", "/social/calls", awa.token, { user_id: moussa.id });
    verifier("bloqué : impossible d'appeler", bloque.status === 403);
    await appel("DELETE", `/social/blocks/${awa.id}`, moussa.token);
    const h = await appel("GET", "/social/calls/history", moussa.token);
    const statuts = h.data.map((c) => c.status);
    verifier("historique de l'appelé : terminé, refusé, annulé, manqué", ["ended", "refused", "cancelled", "missed"].every((s) => statuts.includes(s))
      && h.data.every((c) => c.direction === "entrant" && c.other?.display_name === "Awa Sidibé"), JSON.stringify(statuts));
    const hk = await appel("GET", "/social/calls/history", kadi.token);
    verifier("un tiers ne voit pas les appels des autres", hk.data.length === 0);
    const brut = JSON.stringify(h.data);
    verifier("l'historique ne divulgue ni salle ni jeton", !brut.includes("room") && !brut.includes("ml-") && !brut.includes("token"));
  }

  await terminer();
}

main().catch(async (e) => { console.error(e); await terminer(); });
