"use strict";

/**
 * MaliLink Social — intégration (vrai serveur, vraie base).
 *
 *   scripts/test-integration.sh tests/social.test.js
 *
 * Réseau (demandes reçues / envoyées, amis, abonnés, abonnements, demandes
 * d'abonnement, suggestions, blocage), fil paginé et confidentialité des
 * audiences, publications d'un profil, médias (signature binaire, durée,
 * URL signées, lecture par plages, propriété, suppression).
 */

const crypto = require("crypto");
const { q, appel, jeton, verifier, section, terminer, BASE } = require("./_outils");

async function personne(nom, { publique = true } = {}) {
  const u = (await q(
    `INSERT INTO users (fullname, email, password, role, company_id)
     VALUES ($1,$2,'x','customer',NULL) RETURNING id, role, company_id`,
    [nom, `${nom.toLowerCase().replace(/\W/g, "")}-${crypto.randomBytes(3).toString("hex")}@essai.test`]))[0];
  const token = jeton(u);
  const r = await appel("POST", "/social/profile", token, {
    display_name: nom, birth_date: "1995-04-12", photo_url: "/uploads/photo-essai.jpg", city: "Bamako",
    is_public: publique,
  });
  if (r.status >= 300) throw new Error(`profil ${nom} : ${JSON.stringify(r.data)}`);
  return { ...u, nom, token };
}

/* ----- Fichiers fabriqués : seuls les premiers octets comptent ----- */
const boite = (type, contenu) => {
  const e = Buffer.alloc(8);
  e.writeUInt32BE(8 + contenu.length);
  e.write(type, 4, "latin1");
  return Buffer.concat([e, contenu]);
};
function mp4(secondes) {
  const ftyp = boite("ftyp", Buffer.concat([Buffer.from("isom"), Buffer.alloc(4), Buffer.from("isomiso2mp41")]));
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(Math.round(secondes * 1000), 16);
  // moov APRÈS mdat, comme un fichier de téléphone non optimisé.
  return Buffer.concat([ftyp, boite("mdat", crypto.randomBytes(4000)), boite("moov", boite("mvhd", mvhd))]);
}
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(3000), Buffer.from([0xff, 0xd9])]);
const heic = () => Buffer.concat([boite("ftyp", Buffer.concat([Buffer.from("heic"), Buffer.alloc(4), Buffer.from("mif1heic")])), crypto.randomBytes(500)]);

async function televerser(token, contenu, nom, type, extra = {}) {
  const fd = new FormData();
  fd.append("file", new Blob([contenu], { type }), nom);
  for (const [k, v] of Object.entries(extra)) {
    if (v instanceof Buffer) fd.append(k, new Blob([v], { type: "image/jpeg" }), `${k}.jpg`);
    else fd.append(k, String(v));
  }
  const r = await fetch(`${BASE}/social/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "x-tenant-id": "malilink" },
    body: fd,
  });
  return { status: r.status, data: await r.json().catch(() => null) };
}

async function lireMedia(src, entetes = {}) {
  const r = await fetch(`${BASE}${src}`, { headers: entetes });
  const corps = Buffer.from(await r.arrayBuffer());
  return { status: r.status, type: r.headers.get("content-type"), plage: r.headers.get("content-range"), corps };
}

async function main() {
  const awa = await personne("Awa");
  const bakary = await personne("Bakary");
  const coumba = await personne("Coumba");
  const drissa = await personne("Drissa", { publique: false });
  const etranger = await personne("Etranger");

  section("RÉSEAU : DEMANDES D'AMITIÉ REÇUES ET ENVOYÉES");
  {
    const d = await appel("POST", "/social/friend-requests", awa.token, { to_user_id: bakary.id });
    verifier("Awa envoie une demande à Bakary", d.status === 201, JSON.stringify(d.data));
    const envoyees = await appel("GET", "/social/friend-requests/sent", awa.token);
    verifier("…visible dans SES demandes envoyées", envoyees.data?.some((x) => x.user_id === bakary.id));
    const recues = await appel("GET", "/social/friend-requests", bakary.token);
    const demande = recues.data?.find((x) => x.from_user_id === awa.id);
    verifier("…et dans les demandes reçues de Bakary", Boolean(demande));
    const resume = await appel("GET", "/social/network/summary", bakary.token);
    verifier("compteur de demandes reçues pour la navigation", resume.data?.demandes_recues === 1, JSON.stringify(resume.data));
    const vol = await appel("POST", `/social/friend-requests/${demande.id}/respond`, coumba.token, { accept: true });
    verifier("un tiers ne peut pas accepter la demande d'un autre", vol.status === 404);
    const ok = await appel("POST", `/social/friend-requests/${demande.id}/respond`, bakary.token, { accept: true });
    verifier("Bakary accepte", ok.status === 200 && ok.data?.accepted === true);
    const amis = await appel("GET", "/social/friends", awa.token);
    verifier("Awa et Bakary sont amis", amis.data?.some((x) => x.user_id === bakary.id));

    const versCoumba = await appel("POST", "/social/friend-requests", awa.token, { to_user_id: coumba.id });
    const idDemande = (await appel("GET", "/social/friend-requests/sent", awa.token)).data.find((x) => x.user_id === coumba.id)?.id;
    const annulParAutre = await appel("DELETE", `/social/friend-requests/${idDemande}`, coumba.token);
    verifier("seul l'auteur peut annuler sa demande", annulParAutre.status === 404, String(versCoumba.status));
    const annul = await appel("DELETE", `/social/friend-requests/${idDemande}`, awa.token);
    verifier("Awa annule sa demande à Coumba", annul.status === 200);
    verifier("…qui disparaît des demandes reçues de Coumba",
      !(await appel("GET", "/social/friend-requests", coumba.token)).data.some((x) => x.from_user_id === awa.id));
  }

  section("RÉSEAU : ABONNÉS, ABONNEMENTS, DEMANDES D'ABONNEMENT");
  {
    const f = await appel("POST", `/social/follows/${coumba.id}`, awa.token);
    verifier("Awa suit Coumba (profil public : immédiat)", f.data?.status === "active");
    verifier("Coumba voit Awa dans ses abonnés",
      (await appel("GET", "/social/followers", coumba.token)).data.some((x) => x.user_id === awa.id));
    verifier("Awa voit Coumba dans ses abonnements",
      (await appel("GET", "/social/following", awa.token)).data.some((x) => x.user_id === coumba.id));
    const p = await appel("POST", `/social/follows/${drissa.id}`, awa.token);
    verifier("profil privé : l'abonnement reste en attente", p.data?.status === "pending");
    const dem = await appel("GET", "/social/follow-requests", drissa.token);
    verifier("Drissa voit la demande d'abonnement", dem.data?.some((x) => x.user_id === awa.id));
    const intrus = await appel("POST", `/social/follow-requests/${awa.id}/respond`, bakary.token, { accept: true });
    verifier("un tiers ne peut pas l'accepter", intrus.status === 404);
    const acc = await appel("POST", `/social/follow-requests/${awa.id}/respond`, drissa.token, { accept: true });
    verifier("Drissa accepte", acc.status === 200);
    const rel = await appel("GET", `/social/relations/${drissa.id}`, awa.token);
    verifier("relation : Awa est abonnée à Drissa", rel.data?.abonnement === "active", JSON.stringify(rel.data));
    const retrait = await appel("DELETE", `/social/followers/${awa.id}`, coumba.token);
    verifier("Coumba retire Awa de ses abonnés", retrait.status === 200
      && !(await appel("GET", "/social/followers", coumba.token)).data.some((x) => x.user_id === awa.id));
    await appel("POST", `/social/follows/${coumba.id}`, awa.token);
  }

  section("RÉSEAU : SUGGESTIONS ET BLOCAGE");
  {
    const s = await appel("GET", "/social/suggestions", awa.token);
    const ids = (s.data || []).map((x) => x.user_id);
    verifier("les suggestions excluent amis, profils suivis et soi-même",
      !ids.includes(bakary.id) && !ids.includes(coumba.id) && !ids.includes(awa.id), JSON.stringify(ids));
    verifier("…et proposent un inconnu", ids.includes(etranger.id));
    verifier("…mais jamais un profil privé", !ids.includes(drissa.id));
    await appel("POST", `/social/blocks/${awa.id}`, etranger.token);
    const s2 = await appel("GET", "/social/suggestions", awa.token);
    verifier("un profil qui m'a bloqué n'est plus suggéré", !(s2.data || []).some((x) => x.user_id === etranger.id));
    const rel = await appel("GET", `/social/relations/${etranger.id}`, awa.token);
    verifier("ni consultable", rel.status === 404);
    await appel("DELETE", `/social/blocks/${awa.id}`, etranger.token);
  }

  section("FIL : AUDIENCES RESPECTÉES CÔTÉ SERVEUR");
  const publier = async (u, corps) => (await appel("POST", "/social/posts", u.token, corps)).data?.post;
  const pAmis = await publier(bakary, { content: "Réservé à mes amis", audience: "friends" });
  const pAbonnes = await publier(coumba, { content: "Pour mes abonnés", audience: "followers" });
  const pPublic = await publier(etranger, { content: "Bonjour à tous", audience: "public" });
  const pEtrangerAmis = await publier(etranger, { content: "Amis d'Etranger seulement", audience: "friends" });
  const pMoi = await publier(bakary, { content: "Note pour moi", audience: "me" });
  {
    const fil = (await appel("GET", "/social/feed?scope=tout&limit=50", awa.token)).data?.posts || [];
    const ids = fil.map((p) => p.id);
    verifier("Awa voit la publication « amis » de son ami Bakary", ids.includes(pAmis.id));
    verifier("…la publication « abonnés » de Coumba qu'elle suit", ids.includes(pAbonnes.id));
    verifier("…la publication publique d'un inconnu", ids.includes(pPublic.id));
    verifier("…jamais la publication « amis » d'un inconnu", !ids.includes(pEtrangerAmis.id));
    verifier("…jamais la note « moi uniquement » de Bakary", !ids.includes(pMoi.id));
    const reseau = (await appel("GET", "/social/feed?scope=reseau&limit=50", awa.token)).data?.posts || [];
    verifier("« Mon réseau » écarte les publications d'inconnus", !reseau.some((p) => p.id === pPublic.id)
      && reseau.some((p) => p.id === pAmis.id));
    const direct = await appel("GET", `/social/posts/${pEtrangerAmis.id}`, awa.token);
    verifier("accès direct à une publication non autorisée : 404", direct.status === 404);
    const like = await appel("POST", `/social/posts/${pMoi.id}/like`, awa.token);
    verifier("aimer une publication invisible : 404", like.status === 404);
    const com = await appel("POST", `/social/posts/${pEtrangerAmis.id}/comments`, awa.token, { content: "!" });
    verifier("commenter une publication invisible : 404", com.status === 404);
    const sup = await appel("DELETE", `/social/posts/${pAmis.id}`, awa.token);
    verifier("supprimer la publication d'un autre : 404", sup.status === 404);
    const xss = await publier(awa, { content: "<script>alert(1)</script>", audience: "public" });
    verifier("le texte est stocké tel quel (échappé à l'affichage, jamais interprété)",
      xss?.content === "<script>alert(1)</script>");
    const vide = await appel("POST", "/social/posts", awa.token, { media: [{ type: "image", url: "https://exemple.invalid/x.png" }] });
    verifier("une URL externe en guise de média est ignorée : publication vide refusée", vide.status === 400);
    const ignoree = await publier(awa, { content: "Texte", media: [{ type: "image", url: "https://exemple.invalid/x.png" }] });
    verifier("…et n'apparaît jamais dans la publication", Array.isArray(ignoree?.media) && ignoree.media.length === 0);
  }

  section("FIL : PAGINATION PAR CURSEUR");
  {
    for (let i = 0; i < 12; i += 1) await publier(awa, { content: `Publication n° ${i}`, audience: "public" });
    const p1 = (await appel("GET", "/social/feed?scope=tout&limit=5", awa.token)).data;
    verifier("page 1 : 5 publications et un curseur", p1?.posts?.length === 5 && Boolean(p1.next_cursor));
    const p2 = (await appel("GET", `/social/feed?scope=tout&limit=5&before=${p1.next_cursor}`, awa.token)).data;
    const commun = p2.posts.filter((p) => p1.posts.some((x) => x.id === p.id));
    verifier("page 2 : aucune publication répétée, ordre décroissant",
      p2.posts.length === 5 && commun.length === 0 && p2.posts[0].id < p1.posts[4].id);
    const ancien = await appel("GET", "/social/feed", awa.token);
    verifier("compatibilité : sans paramètre, le fil reste un tableau", Array.isArray(ancien.data));
  }

  section("PROFIL : PUBLICATIONS D'UNE PERSONNE");
  {
    const deBakary = (await appel("GET", `/social/users/${bakary.id}/posts`, awa.token)).data;
    verifier("Awa (amie) voit la publication « amis » de Bakary, pas sa note privée",
      deBakary.posts.some((p) => p.id === pAmis.id) && !deBakary.posts.some((p) => p.id === pMoi.id));
    const parEtranger = (await appel("GET", `/social/users/${bakary.id}/posts`, etranger.token)).data;
    verifier("un inconnu ne voit pas la publication « amis »", !parEtranger.posts.some((p) => p.id === pAmis.id));
    const siennes = (await appel("GET", `/social/users/${bakary.id}/posts`, bakary.token)).data;
    verifier("Bakary voit toutes les siennes, note privée comprise", siennes.posts.some((p) => p.id === pMoi.id));
    const prive = (await appel("GET", `/social/users/${drissa.id}/posts`, bakary.token)).data;
    verifier("profil privé, non ami : rien n'est rendu", prive.prive === true && prive.posts.length === 0);
  }

  section("MÉDIAS : TYPE RÉEL, DURÉE, LIMITES");
  let photo1, photo2, video;
  {
    const faux = await televerser(awa.token, Buffer.from("<script>alert(1)</script>"), "photo.jpg", "image/jpeg");
    verifier("un faux JPEG (texte renommé) est refusé : 415", faux.status === 415, JSON.stringify(faux.data));
    const h = await televerser(awa.token, heic(), "IMG_0001.HEIC", "image/heic");
    verifier("HEIC refusé avec un message clair", h.status === 415 && /HEIC/.test(h.data?.error || ""));
    const j1 = await televerser(awa.token, jpeg(), "photo.png", "image/png", { width: 1200, height: 800 });
    photo1 = j1.data?.media;
    verifier("photo acceptée, type lu dans le fichier (JPEG malgré « .png »)", j1.status === 201 && photo1?.type === "image",
      JSON.stringify(j1.data));
    const lue = await lireMedia(photo1.src);
    verifier("lue par URL signée, Content-Type image/jpeg", lue.status === 200 && lue.type === "image/jpeg");
    photo2 = (await televerser(awa.token, jpeg(), "b.jpg", "image/jpeg")).data?.media;
    const longue = await televerser(awa.token, mp4(180), "longue.mp4", "video/mp4");
    verifier("vidéo de 3 minutes refusée (2 min max)", longue.status === 422 && longue.data?.code === "VIDEO_TROP_LONGUE",
      JSON.stringify(longue.data));
    const v = await televerser(awa.token, mp4(42), "clip.mov", "video/quicktime", { poster: jpeg(), width: 720, height: 1280 });
    video = v.data?.media;
    verifier("vidéo de 42 s acceptée, durée lue dans le fichier, miniature conservée",
      v.status === 201 && video?.type === "video" && video.duration_seconds === 42 && Boolean(video.poster), JSON.stringify(v.data));
  }

  section("MÉDIAS : PUBLICATION, PROPRIÉTÉ, RÈGLES");
  let postPhotos, postVideo;
  {
    const autreMedia = (await televerser(bakary.token, jpeg(), "c.jpg", "image/jpeg")).data?.media;
    const vol = await appel("POST", "/social/posts", awa.token, { content: "Je prends sa photo", media_ids: [autreMedia.id] });
    verifier("utiliser le média d'un autre : refusé", vol.status === 400, JSON.stringify([vol.status, vol.data, autreMedia]));
    const mix = await appel("POST", "/social/posts", awa.token, { content: "mix", media_ids: [photo1.id, video.id] });
    verifier("photos et vidéo mélangées : refusé", mix.status === 400);
    const ok = await appel("POST", "/social/posts", awa.token, { content: "Deux photos", audience: "friends", media_ids: [photo2.id, photo1.id] });
    postPhotos = ok.data?.post;
    verifier("publication avec 2 photos, ordre respecté", ok.status === 201 && postPhotos?.media?.length === 2
      && postPhotos.media[0].id === photo2.id, JSON.stringify(ok.data));
    const encore = await appel("POST", "/social/posts", awa.token, { content: "re", media_ids: [photo1.id] });
    verifier("un média déjà publié ne se réutilise pas", encore.status === 400);
    postVideo = (await appel("POST", "/social/posts", awa.token, { content: "Ma vidéo", audience: "public", media_ids: [video.id] })).data?.post;
    verifier("publication texte + vidéo", postVideo?.media?.[0]?.type === "video");
    const fil = (await appel("GET", "/social/feed?scope=tout&limit=50", bakary.token)).data.posts;
    const vu = fil.find((p) => p.id === postPhotos.id);
    verifier("l'ami voit les photos dans son fil, par URL signée", vu?.media?.length === 2 && /\/social-media\//.test(vu.media[0].src));
    const parEtranger = (await appel("GET", "/social/feed?scope=tout&limit=50", etranger.token)).data.posts;
    verifier("un inconnu ne reçoit jamais l'URL d'une photo réservée aux amis", !parEtranger.some((p) => p.id === postPhotos.id));
  }

  section("MÉDIAS : LECTURE SÉCURISÉE ET PROGRESSIVE");
  {
    const src = postVideo.media[0].src;
    const plage = await lireMedia(src, { Range: "bytes=0-99" });
    verifier("lecture par plage : 206 et 100 octets", plage.status === 206 && plage.corps.length === 100 && /^bytes 0-99\//.test(plage.plage || ""));
    verifier("Content-Type issu du contenu (MP4), pas du nom « .mov »", plage.type === "video/mp4", plage.type);
    const affiche = await lireMedia(postVideo.media[0].poster);
    verifier("miniature lisible", affiche.status === 200 && affiche.type === "image/jpeg");
    const falsifiee = src.replace(/s=[^&]+/, "s=" + "A".repeat(32));
    verifier("signature falsifiée : 404", (await lireMedia(falsifiee)).status === 404);
    const expiree = src.replace(/e=\d+/, "e=1700000000");
    verifier("URL expirée : 404", (await lireMedia(expiree)).status === 404);
    const autreVariante = src.replace("v=o", "v=p");
    verifier("signature d'une variante non transposable à une autre : 404", (await lireMedia(autreVariante)).status === 404);
    const statique = await fetch(`${BASE}/uploads/social/tmp/x`);
    verifier("le dossier des médias n'est jamais servi en accès direct", statique.status === 404);
    await appel("DELETE", `/social/posts/${postVideo.id}`, awa.token);
    verifier("publication supprimée : ses médias ne se lisent plus", (await lireMedia(src)).status === 404);
  }

  section("ENREGISTREMENTS : L'AUDIENCE S'APPLIQUE ENCORE");
  {
    await appel("POST", `/social/posts/${postPhotos.id}/save`, bakary.token);
    verifier("Bakary enregistre la publication de son amie",
      (await appel("GET", "/social/saved", bakary.token)).data.some((p) => p.id === postPhotos.id));
    await appel("DELETE", `/social/friends/${awa.id}`, bakary.token);
    verifier("amitié rompue : la publication « amis » n'est plus rendue, même enregistrée",
      !(await appel("GET", "/social/saved", bakary.token)).data.some((p) => p.id === postPhotos.id));
  }

  section("MÉDIAS : RETRAIT AVANT PUBLICATION");
  {
    const m = (await televerser(coumba.token, jpeg(), "d.jpg", "image/jpeg")).data?.media;
    const parAutre = await appel("DELETE", `/social/media/${m.id}`, awa.token);
    verifier("on ne retire pas le média d'un autre", parAutre.status === 404);
    const r = await appel("DELETE", `/social/media/${m.id}`, coumba.token);
    verifier("retrait du média en attente", r.status === 200 && (await lireMedia(m.src)).status === 404);
  }

  await terminer();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
