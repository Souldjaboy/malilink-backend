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
 *
 * Dans les trois modes : isolation A/B entre deux tenants (malilink / hafiya).
 */

const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { q, appel, jeton, verifier, section, terminer } = require("./_outils");

const MODE = process.env.MODE || "absent";
const TENANT_A = "malilink";
const TENANT_B = "hafiya";

async function personne(nom) {
  const u = (await q(
    `INSERT INTO users (fullname, email, password, role, company_id) VALUES ($1,$2,'x','customer',NULL) RETURNING id, role, company_id`,
    [nom, `${nom.toLowerCase().replace(/\W/g, "")}-${crypto.randomBytes(3).toString("hex")}@essai.test`]))[0];
  const token = jeton(u);
  const r = await appel("POST", "/social/profile", token, { display_name: nom, birth_date: "1995-03-10", photo_url: "/uploads/photo-essai.jpg", city: "Bamako", is_public: true });
  if (r.status >= 300) throw new Error(`profil ${nom} : ${JSON.stringify(r.data)}`);
  return { ...u, nom, token };
}
/* Membre rattaché à un tenant : jeton portant tenant_id, comme à la connexion. */
async function membre(nom, tenant, extra = {}) {
  const u = (await q(
    `INSERT INTO users (fullname, email, password, role, company_id, tenant_id, is_super_admin) VALUES ($1,$2,'x',$3,NULL,$4,$5) RETURNING id`,
    [nom, `${nom.toLowerCase().replace(/\W/g, "")}-${crypto.randomBytes(3).toString("hex")}@essai.test`, extra.superAdmin ? "super_admin" : "customer", tenant, Boolean(extra.superAdmin)]))[0];
  const token = jwt.sign({ id: u.id, role: extra.superAdmin ? "super_admin" : "customer", company_id: null, tenant_id: tenant, is_super_admin: Boolean(extra.superAdmin) },
    process.env.JWT_SECRET, { expiresIn: "2h" });
  const entetes = { "x-tenant-id": tenant };
  const r = await appel("POST", "/social/profile", token, { display_name: nom, birth_date: "1994-05-02", photo_url: "/uploads/photo-essai.jpg", city: "Bamako", is_public: true }, entetes);
  if (r.status >= 300) throw new Error(`profil ${nom} (${tenant}) : ${JSON.stringify(r.data)}`);
  return { id: u.id, nom, token, tenant, entetes };
}
async function directEnBase(hote, { vu = "NOW()" } = {}) {
  return (await q(
    `INSERT INTO social_lives (public_id, tenant_id, host_id, title, audience, room_name, host_seen_at)
     VALUES ($1,$2,$3,$4,'public',$5,${vu}) RETURNING id, public_id`,
    [crypto.randomBytes(12).toString("base64url"), hote.tenant, hote.id, `Direct ${hote.tenant} de ${hote.nom}`, `live-${crypto.randomBytes(12).toString("hex")}`]))[0];
}

/* Isolation A/B : un membre (ou un Super Admin) du tenant A ne trouve aucun
   direct du tenant B, même avec son identifiant, sur aucune route ; et
   réciproquement. Le nettoyage automatique reste limité au tenant. */
async function isolationTenants() {
  section(`ISOLATION ENTRE TENANTS (A=${TENANT_A}, B=${TENANT_B})`);
  const hoteA = await membre("Awa Tenant A", TENANT_A);
  const intrusA = await membre("Moussa Tenant A", TENANT_A);
  const saA = await membre("SA Tenant A", TENANT_A, { superAdmin: true });
  const hoteB = await membre("Binta Tenant B", TENANT_B);
  const spectB = await membre("Bakary Tenant B", TENANT_B);
  const intrusB = await membre("Sira Tenant B", TENANT_B);
  const liveA = await directEnBase(hoteA);
  let liveB = await directEnBase(hoteB);
  if (MODE === "reel") {
    // En mode réel, le direct B est créé par l'API (tenant de la requête).
    await q(`DELETE FROM social_lives WHERE id=$1`, [liveB.id]);
    const cree = await appel("POST", "/social/lives", hoteB.token, { title: "Direct du tenant B", audience: "public" }, hoteB.entetes);
    verifier("tenant B : direct créé par l'API, rattaché au tenant B", cree.status === 201
      && (await q(`SELECT tenant_id FROM social_lives WHERE public_id=$1`, [cree.data.live?.id]))[0]?.tenant_id === TENANT_B, JSON.stringify(cree.data));
    liveB = (await q(`SELECT id, public_id FROM social_lives WHERE public_id=$1`, [cree.data.live.id]))[0];
    const rej = await appel("POST", `/social/lives/${liveB.public_id}/rejoindre`, spectB.token, null, spectB.entetes);
    verifier("tenant B : un membre B rejoint le direct B (contrôle positif)", rej.status === 200 && Boolean(rej.data.token));
  } else {
    await q(`INSERT INTO social_live_viewers (live_id, user_id) VALUES ($1,$2)`, [liveB.id, spectB.id]);
  }
  const comB = (await q(`INSERT INTO social_live_comments (live_id, user_id, content) VALUES ($1,$2,'Bonjour B') RETURNING id`, [liveB.id, spectB.id]))[0];
  const comA = (await q(`INSERT INTO social_live_comments (live_id, user_id, content) VALUES ($1,$2,'Bonjour A') RETURNING id`, [liveA.id, hoteA.id]))[0];

  verifier("contrôle positif : l'hôte B voit son direct dans le tenant B",
    (await appel("GET", `/social/lives/${liveB.public_id}`, hoteB.token, null, hoteB.entetes)).status === 200);
  verifier("contrôle positif : l'hôte A voit son direct dans le tenant A",
    (await appel("GET", `/social/lives/${liveA.public_id}`, hoteA.token, null, hoteA.entetes)).status === 200);

  // Toutes les routes d'un direct, avec l'identifiant de l'autre tenant.
  const routes = (pid, cid, cible) => [
    ["GET", `/social/lives/${pid}`],
    ["POST", `/social/lives/${pid}/rejoindre`],
    ["POST", `/social/lives/${pid}/jeton`],
    ["POST", `/social/lives/${pid}/presence`, { depart: true }],
    ["GET", `/social/lives/${pid}/commentaires`],
    ["POST", `/social/lives/${pid}/commentaires`, { content: "intrusion" }],
    ["DELETE", `/social/lives/${pid}/commentaires/${cid}`],
    ["GET", `/social/lives/${pid}/spectateurs`],
    ["POST", `/social/lives/${pid}/exclure/${cible}`, { raison: "intrusion" }],
    ["POST", `/social/lives/${pid}/signaler`, { raison: "autre" }],
    ["POST", `/social/lives/${pid}/terminer`],
  ];
  // Sans serveur média, rejoindre/jeton répondent 503 avant toute recherche : aucun accès non plus.
  const attendu = (chemin) => (MODE !== "reel" && /\/(rejoindre|jeton)$/.test(chemin) ? [503] : [404]);
  const essayer = async (qui, pid, cid, cible) => {
    const ecarts = [];
    for (const [m, chemin, corps] of routes(pid, cid, cible)) {
      const r = await appel(m, chemin, qui.token, corps, qui.entetes);
      const fuite = r.data && (r.data.token || r.data.title || Array.isArray(r.data));
      if (!attendu(chemin).includes(r.status) || fuite) ecarts.push(`${m} ${chemin.replace(pid, ":id")} → ${r.status}`);
    }
    return ecarts;
  };
  const ab = await essayer(intrusA, liveB.public_id, comB.id, spectB.id);
  verifier("membre A sur le direct B : introuvable sur les 11 routes", ab.length === 0, ab.join(" ; "));
  const sa = await essayer(saA, liveB.public_id, comB.id, spectB.id);
  verifier("Super Admin du tenant A sur le direct B : introuvable aussi", sa.length === 0, sa.join(" ; "));
  const hoteSurB = await essayer(hoteA, liveB.public_id, comB.id, spectB.id);
  verifier("hôte A (qui a un direct) sur le direct B : introuvable", hoteSurB.length === 0, hoteSurB.join(" ; "));
  const ba = await essayer(intrusB, liveA.public_id, comA.id, hoteA.id);
  verifier("membre B sur le direct A : introuvable sur les 11 routes", ba.length === 0, ba.join(" ; "));
  const entete = await appel("GET", `/social/lives/${liveB.public_id}`, intrusA.token, null, { "x-tenant-id": TENANT_B });
  verifier("jeton A + en-tête « tenant B » : refusé à l'authentification", entete.status === 403);

  const etatB = (await q(`SELECT status FROM social_lives WHERE id=$1`, [liveB.id]))[0];
  const traces = (await q(
    `SELECT (SELECT COUNT(*)::int FROM social_live_viewers WHERE live_id=ANY($1::bigint[]) AND (user_id=ANY($2::int[]) OR banned_at IS NOT NULL)) AS spectateurs,
            (SELECT COUNT(*)::int FROM social_live_comments WHERE live_id=ANY($1::bigint[]) AND (deleted_at IS NOT NULL OR content='intrusion')) AS commentaires,
            (SELECT COUNT(*)::int FROM social_reports WHERE target_type='live' AND target_id=ANY($1::bigint[])) AS signalements`,
    [[liveA.id, liveB.id], [intrusA.id, saA.id, hoteA.id, intrusB.id]]))[0];
  verifier("aucune trace : direct B toujours en cours, ni spectateur, ni exclusion, ni commentaire, ni signalement croisé",
    etatB.status === "live" && traces.spectateurs === 0 && traces.commentaires === 0 && traces.signalements === 0, JSON.stringify({ etatB, traces }));

  if (MODE === "reel") {
    const listeA = await appel("GET", "/social/lives", intrusA.token, null, intrusA.entetes);
    const listeB = await appel("GET", "/social/lives", intrusB.token, null, intrusB.entetes);
    verifier("listes : chaque tenant ne voit que ses directs publics", listeA.data.lives.some((l) => l.id === liveA.public_id) && !listeA.data.lives.some((l) => l.id === liveB.public_id)
      && listeB.data.lives.some((l) => l.id === liveB.public_id) && !listeB.data.lives.some((l) => l.id === liveA.public_id));
  }

  // Nettoyage automatique : un appel du tenant A ne clôt que les directs du tenant A.
  const muetA = await directEnBase(await membre("Hôte muet A", TENANT_A), { vu: "NOW() - INTERVAL '2 minutes'" });
  const muetB = await directEnBase(await membre("Hôte muet B", TENANT_B), { vu: "NOW() - INTERVAL '2 minutes'" });
  await appel("GET", `/social/lives/${liveA.public_id}`, hoteA.token, null, hoteA.entetes);
  const apresA = await q(`SELECT public_id, status, end_reason FROM social_lives WHERE id = ANY($1::bigint[]) ORDER BY id`, [[muetA.id, muetB.id]]);
  verifier("nettoyage déclenché par A : direct muet A clos, direct muet B intact",
    apresA[0].status === "ended" && apresA[0].end_reason === "hote_deconnecte" && apresA[1].status === "live", JSON.stringify(apresA));
  await appel("GET", `/social/lives/${liveB.public_id}`, hoteB.token, null, hoteB.entetes);
  const apresB = (await q(`SELECT status, end_reason FROM social_lives WHERE id=$1`, [muetB.id]))[0];
  verifier("nettoyage déclenché par B : direct muet B clos à son tour", apresB.status === "ended" && apresB.end_reason === "hote_deconnecte");
  if (MODE === "reel") await appel("POST", `/social/lives/${liveB.public_id}/terminer`, hoteB.token, null, hoteB.entetes);
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
    await isolationTenants();
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

  await isolationTenants();
  await terminer();
}

main().catch(async (e) => { console.error(e); await terminer(); });
