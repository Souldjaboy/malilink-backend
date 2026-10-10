"use strict";

/**
 * MaliLink Social — directs (lives).
 *
 *   MODE=absent      : LiveKit non configuré           → indisponible, aucun direct
 *   MODE=injoignable : LiveKit configuré mais muet     → indisponible (vérification réelle)
 *   MODE=reel        : LiveKit en Docker (API serveur) → parcours complet
 *
 *   LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_API_KEY=... LIVEKIT_API_SECRET=... MODE=reel \
 *     scripts/test-integration.sh tests/social-lives.test.js
 */

const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { q, appel, jeton, verifier, section, terminer } = require("./_outils");

const MODE = process.env.MODE || "absent";

async function personne(nom) {
  const u = (await q(
    `INSERT INTO users (fullname, email, password, role, company_id) VALUES ($1,$2,'x','customer',NULL) RETURNING id, role, company_id`,
    [nom, `${nom.toLowerCase().replace(/\W/g, "")}-${crypto.randomBytes(3).toString("hex")}@essai.test`]))[0];
  const token = jeton(u);
  const r = await appel("POST", "/social/profile", token, { display_name: nom, birth_date: "1995-03-10", photo_url: "/uploads/photo-essai.jpg", city: "Bamako", is_public: true });
  if (r.status >= 300) throw new Error(`profil ${nom} : ${JSON.stringify(r.data)}`);
  return { ...u, nom, token };
}
async function amis(a, b) {
  await appel("POST", "/social/friend-requests", a.token, { to_user_id: b.id });
  const d = (await appel("GET", "/social/friend-requests", b.token)).data.find((x) => x.from_user_id === a.id);
  await appel("POST", `/social/friend-requests/${d.id}/respond`, b.token, { accept: true });
}

async function main() {
  await q(`UPDATE social_feature_flags SET enabled=true WHERE flag_key='social_lives_enabled'`);
  const hote = await personne("Fanta Live");
  const ami = await personne("Issa Ami");
  const inconnu = await personne("Kady Inconnue");
  await amis(hote, ami);

  if (MODE !== "reel") {
    section(MODE === "absent" ? "LIVEKIT NON CONFIGURÉ" : "LIVEKIT CONFIGURÉ MAIS INJOIGNABLE");
    const c = await appel("GET", "/social/lives/config", hote.token);
    verifier("configuration : indisponible, raison exacte, aucune URL", c.status === 200 && c.data.enabled === false && c.data.url === null
      && c.data.raison === (MODE === "absent" ? "serveur_media_non_configure" : "serveur_injoignable"), JSON.stringify(c.data));
    const d = await appel("POST", "/social/lives", hote.token, { title: "Mon direct", audience: "public" });
    verifier("démarrer : 503 « indisponible », aucun direct créé", d.status === 503 && d.data.code === "LIVES_INDISPONIBLES"
      && (await q(`SELECT COUNT(*)::int AS n FROM social_lives`))[0].n === 0);
    const l = await appel("GET", "/social/lives", ami.token);
    verifier("liste : vide, aucun direct simulé", l.status === 200 && l.data.enabled === false && l.data.lives.length === 0);
    return terminer();
  }

  const decoder = (t) => jwt.verify(t, process.env.LIVEKIT_API_SECRET, { algorithms: ["HS256"] });
  let live;
  section("DÉMARRER UN DIRECT (serveur média réel)");
  {
    const c = await appel("GET", "/social/lives/config", hote.token);
    verifier("configuration : disponible après vérification réelle du serveur", c.data.enabled === true && c.data.verifications.serveur === true && c.data.url === process.env.LIVEKIT_URL);
    verifier("titre obligatoire", (await appel("POST", "/social/lives", hote.token, { title: "ab" })).status === 400);
    const d = await appel("POST", "/social/lives", hote.token, { title: "Cours de maths en direct", audience: "friends" });
    live = d.data.live;
    const t = decoder(d.data.token);
    verifier("direct créé, jeton hôte : publier caméra+micro, une seule salle, 10 min", d.status === 201 && t.video.canPublish === true
      && /^live-[0-9a-f]{24}$/.test(t.video.room) && t.sub === `u${hote.id}` && t.exp - t.iat === 600 && !JSON.stringify(d.data).includes(process.env.LIVEKIT_API_SECRET));
    verifier("un seul direct à la fois", (await appel("POST", "/social/lives", hote.token, { title: "Deuxième" })).status === 409);
  }

  section("REGARDER : DROITS CONTRÔLÉS CÔTÉ SERVEUR");
  {
    const voit = await appel("GET", "/social/lives", ami.token);
    verifier("l'ami voit le direct « amis » avec un compteur", voit.data.lives.some((l) => l.id === live.id && l.compteur && l.compteur.source === "serveur_media"));
    const pasVu = await appel("GET", "/social/lives", inconnu.token);
    verifier("un non-ami ne le voit pas dans la liste", !pasVu.data.lives.some((l) => l.id === live.id));
    const refuse = await appel("POST", `/social/lives/${live.id}/rejoindre`, inconnu.token);
    verifier("un non-ami ne peut pas rejoindre (403)", refuse.status === 403);
    const j = await appel("POST", `/social/lives/${live.id}/rejoindre`, ami.token);
    const t = decoder(j.data.token);
    verifier("jeton spectateur : regarder seulement, même salle", j.status === 200 && t.video.canPublish === false && t.video.canSubscribe === true && t.video.canPublishData === false && t.sub === `u${ami.id}`);
    const detail = await appel("GET", `/social/lives/${live.id}`, ami.token);
    verifier("compteur réel issu du serveur média (0 connecté en WebRTC dans ce test)", detail.data.compteur?.source === "serveur_media" && detail.data.compteur.spectateurs === 0);
  }

  section("COMMENTAIRES, MODÉRATION, EXCLUSION, SIGNALEMENT");
  {
    const c1 = await appel("POST", `/social/lives/${live.id}/commentaires`, ami.token, { content: "Bonjour à tous !" });
    verifier("commentaire publié", c1.status === 201 && c1.data.content === "Bonjour à tous !");
    const xss = await appel("POST", `/social/lives/${live.id}/commentaires`, ami.token, { content: "<img src=x onerror=alert(1)>" });
    verifier("contenu stocké tel quel (affiché en texte, jamais interprété)", xss.status === 201);
    await appel("POST", `/social/lives/${live.id}/commentaires`, ami.token, { content: "trois" });
    const flood = await appel("POST", `/social/lives/${live.id}/commentaires`, ami.token, { content: "quatre" });
    verifier("anti-flood : 3 commentaires / 10 s", flood.status === 429);
    const liste = await appel("GET", `/social/lives/${live.id}/commentaires`, hote.token);
    verifier("l'hôte lit les commentaires", liste.data.length === 3);
    const pasHote = await appel("DELETE", `/social/lives/${live.id}/commentaires/${c1.data.id}`, inconnu.token);
    verifier("un tiers ne supprime pas un commentaire", pasHote.status === 404);
    const suppr = await appel("DELETE", `/social/lives/${live.id}/commentaires/${xss.data.id}`, hote.token);
    verifier("l'hôte supprime un commentaire", suppr.status === 200);
    const specs = await appel("GET", `/social/lives/${live.id}/spectateurs`, hote.token);
    verifier("l'hôte voit ses spectateurs", specs.data.some((s) => s.user_id === ami.id));
    verifier("un spectateur ne voit pas la liste", (await appel("GET", `/social/lives/${live.id}/spectateurs`, ami.token)).status === 403);
    const sig = await appel("POST", `/social/lives/${live.id}/signaler`, ami.token, { raison: "contenu_inapproprie" });
    verifier("signalement enregistré (social_reports, type live)", sig.status === 201 && (await q(`SELECT 1 FROM social_reports WHERE target_type='live' AND reporter_user_id=$1`, [ami.id])).length === 1);
    const excl = await appel("POST", `/social/lives/${live.id}/exclure/${ami.id}`, hote.token, { raison: "propos déplacés" });
    verifier("exclusion : demandée au serveur média (non connecté ici → false)", excl.status === 200 && excl.data.deconnecte_du_serveur_media === false);
    verifier("exclu : plus de jeton", (await appel("POST", `/social/lives/${live.id}/rejoindre`, ami.token)).data?.code === "EXCLU");
    verifier("exclu : plus de commentaire", (await appel("POST", `/social/lives/${live.id}/commentaires`, ami.token, { content: "re" })).status === 403);
    verifier("exclu : le direct disparaît de sa liste", !(await appel("GET", `/social/lives`, ami.token)).data.lives.some((l) => l.id === live.id));
  }

  section("FIN ET DÉCONNEXIONS");
  {
    const pasLui = await appel("POST", `/social/lives/${live.id}/terminer`, inconnu.token);
    verifier("seul l'hôte termine", pasLui.status === 403);
    const fin = await appel("POST", `/social/lives/${live.id}/terminer`, hote.token);
    verifier("direct terminé", fin.data.termine === true && (await q(`SELECT status, end_reason FROM social_lives WHERE public_id=$1`, [live.id]))[0].end_reason === "hote");
    verifier("plus de jeton après la fin (410)", (await appel("POST", `/social/lives/${live.id}/jeton`, hote.token)).status === 410);
    const d2 = await appel("POST", "/social/lives", hote.token, { title: "Second direct public", audience: "public" });
    verifier("nouveau direct possible ensuite", d2.status === 201);
    await q(`UPDATE social_lives SET host_seen_at = NOW() - INTERVAL '2 minutes' WHERE public_id=$1`, [d2.data.live.id]);
    await appel("GET", "/social/lives", inconnu.token);
    const etat = (await q(`SELECT status, end_reason FROM social_lives WHERE public_id=$1`, [d2.data.live.id]))[0];
    verifier("hôte déconnecté depuis 60 s : direct clos automatiquement", etat.status === "ended" && etat.end_reason === "hote_deconnecte");
    const sa = (await q(`INSERT INTO users (fullname, email, password, role, is_super_admin) VALUES ('SA','sa-live@essai.test','x','super_admin',true) RETURNING id, role, company_id, is_super_admin`))[0];
    const d3 = await appel("POST", "/social/lives", ami.token, { title: "Direct à modérer", audience: "public" });
    const mod = await appel("POST", `/social/lives/${d3.data.live.id}/terminer`, jeton(sa));
    verifier("le Super Admin peut couper un direct (modération)", mod.data.termine === true
      && (await q(`SELECT end_reason FROM social_lives WHERE public_id=$1`, [d3.data.live.id]))[0].end_reason === "moderation");
    verifier("aucun enregistrement : aucune table ni appel d'egress", (await q(`SELECT to_regclass('social_live_recordings') AS t`))[0].t === null);
  }

  await terminer();
}

main().catch(async (e) => { console.error(e); await terminer(); });
