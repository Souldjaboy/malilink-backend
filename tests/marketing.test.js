"use strict";

/**
 * P3 — Marketing & Réseaux sociaux : isolation, offres, droits, publication
 * manuelle tracée, cycle de vie des campagnes, médias. Rien n'est simulé.
 */

const { q, appel, jeton, jetonSuperAdmin, verifier, section, creerSociete, terminer, BASE } = require("./_outils");

async function envoyerFichier(chemin, token, nom, type, octets) {
  const form = new FormData();
  form.append("fichier", new Blob([octets], { type }), nom);
  const r = await fetch(`${BASE}${chemin}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "x-tenant-id": "malilink" }, body: form,
  });
  let data = null;
  try { data = await r.json(); } catch { /* vide */ }
  return { status: r.status, data };
}

async function main() {
  const tSuper = jetonSuperAdmin();
  const a = await creerSociete({ nom: "Boutique A", planCode: "business", modules: { marketing: true } });
  const b = await creerSociete({ nom: "Boutique B", planCode: "business", modules: { marketing: true } });
  const s = await creerSociete({ nom: "Boutique Starter", planCode: "starter" });

  section("OFFRES");
  {
    const r = await appel("GET", "/marketing/tableau-de-bord", s.token);
    verifier("Starter sans dérogation : 403 MODULE_DISABLED", r.status === 403 && r.data?.code === "MODULE_DISABLED", `statut ${r.status}`);
    await appel("PUT", `/super-admin/companies/${s.id}/modules`, tSuper, { modules: { marketing: true } });
    const r2 = await appel("GET", "/marketing/tableau-de-bord", s.token);
    verifier("Starter + dérogation : accès", r2.status === 200, `statut ${r2.status}`);
  }

  section("TABLEAU DE BORD — RIEN N'EST SIMULÉ");
  {
    const t = (await appel("GET", "/marketing/tableau-de-bord", a.token)).data;
    verifier("aucun connecteur annoncé comme actif", t.connecteurs_actifs === false && t.plateformes.every((p) => p.connecte === false));
    verifier("pas de statistiques inventées", t.statistiques_disponibles === false);
    verifier("les 8 plateformes sont préparées (dont Google Business Profile, Snapchat)",
      ["facebook", "instagram", "tiktok", "whatsapp", "linkedin", "x", "snapchat", "google_business"].every((k) => t.plateformes.some((p) => p.cle === k)));
    verifier("chaque régie publicitaire renvoie vers son site OFFICIEL en https",
      t.regies.length === 5 && t.regies.every((r) => /^https:\/\/[a-z.]*(facebook|google|tiktok|linkedin|snapchat)\.com\//.test(r.lien)),
      JSON.stringify(t.regies.map((r) => r.lien)));
  }

  section("COMPTES");
  let compteA, compteB;
  {
    const c = await appel("POST", "/marketing/comptes", a.token, { network: "facebook", display_name: "Boutique A", handle: "@boutiquea", profile_url: "https://facebook.com/boutiquea" });
    verifier("création d'un compte Facebook", c.status === 201, `statut ${c.status} ${c.data?.error || ""}`);
    compteA = c.data?.compte;
    verifier("un compte neuf n'est jamais « connecté »", compteA?.status === "non_connecte");
    const faux = await appel("POST", "/marketing/comptes", a.token, { network: "myspace", display_name: "X" });
    verifier("plateforme inconnue : refus", faux.status === 400 && faux.data?.code === "RESEAU_INCONNU");
    const lien = await appel("POST", "/marketing/comptes", a.token, { network: "x", display_name: "X", profile_url: "javascript:alert(1)" });
    verifier("un lien de profil non https est refusé", lien.status === 400 && lien.data?.code === "LIEN_INVALIDE");
    compteB = (await appel("POST", "/marketing/comptes", b.token, { network: "instagram", display_name: "Boutique B" })).data?.compte;
  }

  section("PUBLICATIONS");
  let postA;
  {
    const injection = await appel("POST", "/marketing/publications", a.token, { body: "Essai", account_id: compteB.id });
    verifier("publier vers le compte d'une AUTRE société : refus", injection.status === 400 && injection.data?.code === "ACCOUNT_NOT_ALLOWED");
    const force = await appel("POST", "/marketing/publications", a.token, { body: "Déjà publiée ?", status: "publie" });
    verifier("« publiée » ne se pose pas à la création", force.data?.publication?.status === "brouillon");
    const sansDate = await appel("POST", "/marketing/publications", a.token, { body: "X", status: "programme" });
    verifier("programmée sans date : refus", sansDate.status === 400);
    const p = await appel("POST", "/marketing/publications", a.token, {
      title: "Arrivage", body: "Nouveau matériel en magasin.", account_id: compteA.id, status: "programme", scheduled_for: "2026-10-05T09:00:00Z",
    });
    verifier("publication programmée sur le compte Facebook", p.status === 201 && p.data?.publication?.network === "facebook");
    verifier("l'heure programmée revient à l'identique (09:00 UTC, pas de décalage de fuseau)",
      new Date(p.data?.publication?.scheduled_for).toISOString() === "2026-10-05T09:00:00.000Z", String(p.data?.publication?.scheduled_for));
    postA = p.data.publication;
    const maj = await appel("PUT", `/marketing/publications/${postA.id}`, a.token, { status: "publie" });
    verifier("« publiée » ne se pose pas par modification", maj.status === 400 && maj.data?.code === "STATUT_INTERDIT");

    const sansLien = await appel("POST", `/marketing/publications/${postA.id}/publier`, a.token, {});
    verifier("marquer publiée SANS lien de preuve : refus", sansLien.status === 400 && sansLien.data?.code === "LIEN_PUBLICATION_REQUIS");
    const lienFaux = await appel("POST", `/marketing/publications/${postA.id}/publier`, a.token, { published_url: "http://facebook.com/x" });
    verifier("… un lien non https est refusé", lienFaux.status === 400);
    const ok = await appel("POST", `/marketing/publications/${postA.id}/publier`, a.token, { published_url: "https://facebook.com/boutiquea/posts/123" });
    verifier("publication déclarée, MARQUÉE « manuelle », avec son lien",
      ok.status === 200 && ok.data?.publication?.status === "publie" && ok.data.publication.published_manually === true
      && /MANUELLEMENT/.test(ok.data.precision || ""), `statut ${ok.status}`);
    const encore = await appel("PUT", `/marketing/publications/${postA.id}`, a.token, { body: "Réécrite" });
    verifier("une publication publiée ne se modifie plus", encore.status === 404);
  }

  section("MÉDIAS");
  {
    const p2 = (await appel("POST", "/marketing/publications", a.token, { body: "Avec image" })).data.publication;
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const image = await envoyerFichier(`/marketing/publications/${p2.id}/medias`, a.token, "photo.png", "image/png", png);
    verifier("une image s'ajoute à une publication", image.status === 201 && image.data?.media?.kind === "image", `statut ${image.status} ${image.data?.error || ""}`);
    verifier("le fichier reçoit un nom aléatoire (ni nom d'origine, ni société)",
      /^\/uploads\/marketing\/[a-f0-9]{32}\.png$/.test(image.data?.media?.url || ""), image.data?.media?.url);
    const svg = await envoyerFichier(`/marketing/publications/${p2.id}/medias`, a.token, "x.svg", "image/svg+xml", new TextEncoder().encode("<svg/>"));
    verifier("un SVG (vecteur de script) est refusé", svg.status === 400 && svg.data?.code === "MEDIA_REFUSE");
    const html = await envoyerFichier(`/marketing/publications/${p2.id}/medias`, a.token, "x.html", "text/html", new TextEncoder().encode("<b>"));
    verifier("un fichier HTML est refusé", html.status === 400);
    const autre = await envoyerFichier(`/marketing/publications/${p2.id}/medias`, b.token, "photo.png", "image/png", png);
    verifier("B ne joint pas de média à une publication de A (404)", autre.status === 404);
    const liste = await appel("GET", "/marketing/publications", a.token);
    verifier("les médias accompagnent la publication", (liste.data?.publications || []).find((x) => x.id === p2.id)?.medias?.length === 1);
  }

  section("CAMPAGNES — PRÉPARER ICI, LANCER ET PAYER SUR LA PLATEFORME OFFICIELLE");
  let camp;
  {
    const sansRegie = await appel("POST", "/marketing/campagnes", a.token, { name: "Rentrée" });
    verifier("sans régie : refus", sansRegie.status === 400);
    const dates = await appel("POST", "/marketing/campagnes", a.token, { name: "X", platform: "meta_ads", start_date: "2026-10-10", end_date: "2026-10-01" });
    verifier("fin avant début : refus", dates.status === 400);
    const lien = await appel("POST", "/marketing/campagnes", a.token, { name: "X", platform: "meta_ads", destination_url: "ftp://x" });
    verifier("lien de destination non https : refus", lien.status === 400);
    const c = await appel("POST", "/marketing/campagnes", a.token, { name: "Rentrée", platform: "meta_ads", objective: "trafic" });
    verifier("campagne créée en brouillon", c.status === 201 && c.data?.campagne?.status === "brouillon");
    camp = c.data.campagne;
    verifier("… avec la liste de ce qui manque", (camp.manques || []).includes("budget") && camp.manques.includes("lien de destination"));

    const tropTot = await appel("POST", `/marketing/campagnes/${camp.id}/statut`, a.token, { status: "pret" });
    verifier("« prête » refusée tant qu'elle est incomplète", tropTot.status === 400 && tropTot.data?.code === "CAMPAGNE_INCOMPLETE");
    const saut = await appel("POST", `/marketing/campagnes/${camp.id}/statut`, a.token, { status: "actif" });
    verifier("brouillon → actif directement : TRANSITION_INTERDITE", saut.status === 409 && saut.data?.code === "TRANSITION_INTERDITE");

    await appel("PUT", `/marketing/campagnes/${camp.id}`, a.token, {
      budget_total: 50000, start_date: "2026-10-01", end_date: "2026-10-15", destination_url: "https://boutiquea.ml/rentree",
      content: "Promo de rentrée", zone: "Bamako", audience: "25-45 ans",
    });
    const relue = (await appel("GET", "/marketing/campagnes", a.token)).data.campagnes.find((x) => x.id === camp.id);
    verifier("les dates reviennent telles que saisies (pas de décalage de fuseau)",
      relue?.start_date === "2026-10-01" && relue?.end_date === "2026-10-15", `${relue?.start_date} → ${relue?.end_date}`);
    const pret = await appel("POST", `/marketing/campagnes/${camp.id}/statut`, a.token, { status: "pret" });
    verifier("complète : « prête »", pret.status === 200 && pret.data?.campagne?.status === "pret", `statut ${pret.status} ${pret.data?.error || ""}`);

    const sansRef = await appel("POST", `/marketing/campagnes/${camp.id}/statut`, a.token, { status: "en_attente" });
    verifier("« en attente » exige la référence de la plateforme officielle, et fournit son lien",
      sansRef.status === 400 && sansRef.data?.code === "REFERENCE_PLATEFORME_REQUISE" && sansRef.data?.lien_officiel === "https://adsmanager.facebook.com/");
    const attente = await appel("POST", `/marketing/campagnes/${camp.id}/statut`, a.token, { status: "en_attente", external_ref: "https://adsmanager.facebook.com/campaign/987" });
    verifier("« en attente » déclarée MANUELLEMENT", attente.status === 200 && attente.data?.campagne?.declared_manually === true && /MANUELLEMENT/.test(attente.data?.precision || ""));
    const modif = await appel("PUT", `/marketing/campagnes/${camp.id}`, a.token, { budget_total: 1 });
    verifier("une campagne lancée ne se modifie plus ici", modif.status === 409);
    const actif = await appel("POST", `/marketing/campagnes/${camp.id}/statut`, a.token, { status: "actif" });
    verifier("en attente → active", actif.data?.campagne?.status === "actif");
    const supp = await appel("DELETE", `/marketing/campagnes/${camp.id}`, a.token);
    verifier("une campagne active se garde dans l'historique (pas de suppression)", supp.status === 409);
    const erreur = await appel("POST", `/marketing/campagnes/${camp.id}/statut`, a.token, { status: "erreur" });
    verifier("« erreur » exige une note", erreur.status === 400 && erreur.data?.code === "NOTE_REQUISE");
    const fin = await appel("POST", `/marketing/campagnes/${camp.id}/statut`, a.token, { status: "termine" });
    verifier("active → terminée", fin.data?.campagne?.status === "termine");
    const apres = await appel("POST", `/marketing/campagnes/${camp.id}/statut`, a.token, { status: "actif" });
    verifier("une campagne terminée n'a plus de transition", apres.status === 409);
  }

  section("ISOLATION");
  {
    const pubsB = await appel("GET", "/marketing/publications", b.token);
    verifier("B ne voit aucune publication de A", !(pubsB.data?.publications || []).some((p) => p.id === postA.id));
    const campsB = await appel("GET", "/marketing/campagnes", b.token);
    verifier("B ne voit aucune campagne de A", !(campsB.data?.campagnes || []).some((c) => c.id === camp.id));
    const comptesB = await appel("GET", "/marketing/comptes", b.token);
    verifier("B ne voit aucun compte de A", !(comptesB.data?.comptes || []).some((c) => c.id === compteA.id));
    const statutB = await appel("POST", `/marketing/campagnes/${camp.id}/statut`, b.token, { status: "erreur", note: "x" });
    verifier("B ne change pas le statut d'une campagne de A (404)", statutB.status === 404);
    const suppB = await appel("DELETE", `/marketing/comptes/${compteA.id}`, b.token);
    verifier("B ne supprime pas un compte de A (404)", suppB.status === 404);
    verifier("aucun jeton OAuth ne transite par l'API", !JSON.stringify(comptesB.data).includes("token_encrypted"));
  }

  section("DROITS — PUBLIER EXIGE « VALIDER »");
  {
    const caissier = (await q(`INSERT INTO users (fullname, email, password, role, company_id)
                               VALUES ('Caisse A','caisse-a@essai.test','x','caissier',$1) RETURNING id, role, company_id`, [a.id]))[0];
    const tC = jeton(caissier);
    const avant = await appel("GET", "/marketing/tableau-de-bord", tC);
    verifier("un caissier ne voit pas le marketing par défaut (403)", avant.status === 403, `statut ${avant.status}`);

    const cm = (await q(`INSERT INTO users (fullname, email, password, role, company_id)
                         VALUES ('Community A','cm-a@essai.test','x','community_manager',$1) RETURNING id, role, company_id`, [a.id]))[0];
    const tCm = jeton(cm);
    const p = await appel("POST", "/marketing/publications", tCm, { body: "Préparée par le community manager" });
    verifier("le community manager prépare une publication", p.status === 201, `statut ${p.status} ${p.data?.error || ""}`);
    const pub = await appel("POST", `/marketing/publications/${p.data?.publication?.id}/publier`, tCm, { published_url: "https://facebook.com/x/posts/1" });
    verifier("… mais ne peut pas la déclarer publiée sans « Valider » (403)", pub.status === 403, `statut ${pub.status}`);

    // La direction lui accorde « Valider » sur les publications.
    const droits = (await appel("GET", `/company/users/${cm.id}/permissions`, a.token)).data.effective;
    const envoi = Object.entries(droits).map(([cle, act]) => ({ module_key: cle, ...act }));
    envoi.find((e) => e.module_key === "marketing.publications").validate = true;
    await appel("PUT", `/company/users/${cm.id}/permissions`, a.token, { permissions: envoi });
    const pub2 = await appel("POST", `/marketing/publications/${p.data.publication.id}/publier`, tCm, { published_url: "https://facebook.com/x/posts/1" });
    verifier("après accord de « Valider » : publication déclarée", pub2.status === 200, `statut ${pub2.status} ${pub2.data?.error || ""}`);
  }

  await terminer();
}

main().catch(async (e) => {
  console.error(e);
  require("./_outils").bilan.echoues += 1;
  await terminer();
});
