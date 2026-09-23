"use strict";

/**
 * P2 — Caméras & Sécurité : isolation, offres et dérogations, sites, connecteurs,
 * joignabilité (gardes anti-SSRF), secrets, droits.
 *
 * Lancé deux fois par scripts/test-cameras.sh : sans clé de chiffrement
 * (l'enregistrement d'un secret doit être REFUSÉ) puis avec (il doit être
 * chiffré). La variable WALLET_SECRET_ENC_KEY indique le cas en cours.
 */

const { q, appel, jeton, jetonSuperAdmin, verifier, section, creerSociete, terminer } = require("./_outils");

const AVEC_CLE = Boolean(process.env.WALLET_SECRET_ENC_KEY);

async function main() {
  const tSuper = jetonSuperAdmin();
  console.log(`\nChiffrement des secrets : ${AVEC_CLE ? "CONFIGURÉ" : "ABSENT"}`);

  const a = await creerSociete({ nom: "Boutique A", planCode: "business", modules: { cameras: true } });
  const b = await creerSociete({ nom: "Boutique B", planCode: "business", modules: { cameras: true } });
  const c = await creerSociete({ nom: "Boutique Starter", planCode: "starter" });

  section("OFFRES ET DÉROGATIONS");
  {
    const starter = await appel("GET", "/cameras", c.token);
    verifier("Starter sans dérogation : 403 MODULE_DISABLED", starter.status === 403 && starter.data?.code === "MODULE_DISABLED",
      `statut ${starter.status}`);
    // Même une ligne « activé » posée par la société ne passe pas l'offre.
    await q(`INSERT INTO company_modules (company_id, module_key, is_enabled, enabled, source) VALUES ($1,'cameras',TRUE,TRUE,'inscription')`, [c.id]);
    const parSociete = await appel("GET", "/cameras", c.token);
    verifier("… une activation qui ne vient pas du super-admin ne passe pas l'offre", parSociete.status === 403);
    await appel("PUT", `/super-admin/companies/${c.id}/modules`, tSuper, { modules: { cameras: true } });
    const derogation = await appel("GET", "/cameras", c.token);
    verifier("Starter + dérogation super-admin : accès (200)", derogation.status === 200, `statut ${derogation.status}`);
  }

  section("SITES");
  let siteA, bureauA, siteB;
  {
    siteA = (await q(`INSERT INTO warehouses (company_id, code, name, type) VALUES ($1,'A-MAG','Magasin A','magasin') RETURNING id`, [a.id]))[0].id;
    siteB = (await q(`INSERT INTO warehouses (company_id, code, name, type) VALUES ($1,'B-DEP','Dépôt B','depot') RETURNING id`, [b.id]))[0].id;
    const bureau = await appel("POST", "/cameras/sites", a.token, { name: "Bureau direction", type: "bureau", code: "A-BUR" });
    verifier("un site « bureau » se crée depuis le module", bureau.status === 201, `statut ${bureau.status} ${bureau.data?.error || ""}`);
    bureauA = bureau.data?.site?.id;
    const inconnu = await appel("POST", "/cameras/sites", a.token, { name: "X", type: "chateau" });
    verifier("un type de site inconnu est refusé", inconnu.status === 400);

    const stock = await appel("GET", "/warehouses", a.token);
    verifier("le bureau n'apparaît PAS dans les listes du stock", !(stock.data || []).some((w) => w.id === bureauA),
      JSON.stringify((stock.data || []).map((w) => w.name)));
    verifier("le magasin, lui, y apparaît", (stock.data || []).some((w) => w.id === siteA));
    const tous = await appel("GET", "/warehouses?tous=1", a.token);
    verifier("… mais il reste consultable sur demande explicite", (tous.data || []).some((w) => w.id === bureauA));
    const sites = await appel("GET", "/cameras/sites", a.token);
    verifier("les sites du module caméras incluent magasin et bureau",
      ["Magasin A", "Bureau direction"].every((n) => (sites.data?.sites || []).some((s) => s.name === n)));
    verifier("… et aucun site d'une autre société", !(sites.data?.sites || []).some((s) => s.id === siteB));
  }

  section("CAMÉRAS — CONNECTEURS ET VALIDATION");
  let camA;
  {
    const cree = await appel("POST", "/cameras", a.token, {
      name: "Caméra Entrée", code: "A-CAM-01", warehouse_id: siteA, connector_type: "hikvision", host: "cam-a.exemple.ml",
    });
    verifier("création d'une caméra Hikvision", cree.status === 201, `statut ${cree.status} ${cree.data?.error || ""}`);
    camA = cree.data?.camera;
    verifier("port par défaut du connecteur Hikvision : 8000", camA?.port === 8000, String(camA?.port));
    verifier("état réseau initial : « inconnu », jamais inventé", camA?.online_status === "inconnu");
    const rtsp = await appel("POST", "/cameras", a.token, { name: "Caméra Caisse", warehouse_id: bureauA, connector_type: "rtsp" });
    verifier("port par défaut RTSP : 554, rattachée au bureau", rtsp.data?.camera?.port === 554 && rtsp.data?.camera?.warehouse_id === bureauA);

    const portFaux = await appel("POST", "/cameras", a.token, { name: "X", port: 70000 });
    verifier("port hors 1–65535 : refus", portFaux.status === 400 && portFaux.data?.code === "PORT_INVALIDE");
    const hoteFaux = await appel("POST", "/cameras", a.token, { name: "X", host: "http://cam" });
    verifier("adresse mal formée : refus", hoteFaux.status === 400 && hoteFaux.data?.code === "ADRESSE_INVALIDE");
    const injection = await appel("POST", "/cameras", a.token, { name: "Pirate", warehouse_id: siteB });
    verifier("rattacher une caméra au site d'une AUTRE société : refus",
      injection.status === 400 && injection.data?.code === "WAREHOUSE_NOT_ALLOWED");
    const enrB = (await q(`INSERT INTO camera_recorders (company_id, name) VALUES ($1,'NVR B') RETURNING id`, [b.id]))[0].id;
    const injEnr = await appel("POST", "/cameras", a.token, { name: "Pirate", recorder_id: enrB });
    verifier("rattacher à l'enregistreur d'une AUTRE société : refus", injEnr.status === 400 && injEnr.data?.code === "RECORDER_NOT_ALLOWED");
  }

  section("ISOLATION");
  {
    const vueB = await appel("GET", "/cameras", b.token);
    verifier("B ne voit aucune caméra de A", !(vueB.data?.cameras || []).some((x) => x.id === camA.id));
    const majB = await appel("PUT", `/cameras/${camA.id}`, b.token, { name: "Détournée" });
    verifier("B ne modifie pas une caméra de A (404)", majB.status === 404, `statut ${majB.status}`);
    const supB = await appel("DELETE", `/cameras/${camA.id}`, b.token);
    verifier("B ne supprime pas une caméra de A (404)", supB.status === 404);
    const testB = await appel("POST", `/cameras/${camA.id}/verifier`, b.token);
    verifier("B ne teste pas une caméra de A (404)", testB.status === 404);
    const credB = await appel("PUT", `/cameras/${camA.id}/identifiants`, b.token, { password: "x" });
    verifier("B ne pose pas d'identifiants sur une caméra de A (404)", credB.status === 404);
    const intacte = (await q(`SELECT name FROM cameras WHERE id=$1`, [camA.id]))[0];
    verifier("la caméra de A est intacte", intacte.name === "Caméra Entrée");
  }

  section("JOIGNABILITÉ — LE SERVEUR NE SONDE PAS LE RÉSEAU INTERNE");
  {
    for (const [hote, port, code] of [["127.0.0.1", 554, "ADRESSE_PRIVEE"], ["10.1.2.3", 554, "ADRESSE_PRIVEE"],
      ["192.168.1.64", 8000, "ADRESSE_PRIVEE"], ["169.254.169.254", 80, "ADRESSE_PRIVEE"],
      ["41.73.105.2", 5432, "PORT_NON_AUTORISE"]]) {
      const pose = await appel("PUT", `/cameras/${camA.id}`, a.token, { host: hote, port });
      const r = await appel("POST", `/cameras/${camA.id}/verifier`, a.token);
      verifier(`sonde refusée : ${hote}:${port} → ${code}`, pose.status === 200 && r.status === 422 && r.data?.code === code,
        `pose ${pose.status}, sonde ${r.status} ${r.data?.code || ""}`);
    }
    const localhost = await appel("PUT", `/cameras/${camA.id}`, a.token, { host: "localhost" });
    verifier("« localhost » est refusé dès l'enregistrement", localhost.status === 400 && localhost.data?.code === "ADRESSE_INVALIDE");
    const etat = (await q(`SELECT online_status, last_check_error FROM cameras WHERE id=$1`, [camA.id]))[0];
    verifier("une sonde refusée n'invente pas « hors ligne »", etat.online_status === "inconnu", etat.online_status);
    verifier("… mais la raison du refus est conservée", etat.last_check_error.length > 10);
    await appel("PUT", `/cameras/${camA.id}`, a.token, { host: "", port: 8000 });
    const sansHote = await appel("POST", `/cameras/${camA.id}/verifier`, a.token);
    verifier("sans adresse : refus explicite", sansHote.status === 400 && sansHote.data?.code === "ADRESSE_ABSENTE");
    await appel("PUT", `/cameras/${camA.id}`, a.token, { host: "cam-a.exemple.ml" });
  }

  section(`IDENTIFIANTS — ${AVEC_CLE ? "CHIFFRÉS" : "REFUSÉS SANS CLÉ"}`);
  {
    const secret = "MotDePasseCamera#2026";
    const pose = await appel("PUT", `/cameras/${camA.id}/identifiants`, a.token, {
      username: "admin", password: secret, stream_path: "/Streaming/Channels/101",
    });
    const enBase = await q(`SELECT secret_format, secret_encrypted, stream_path_encrypted FROM camera_credentials WHERE camera_id=$1`, [camA.id]);
    if (AVEC_CLE) {
      verifier("les identifiants s'enregistrent", pose.status === 200, `statut ${pose.status} ${pose.data?.error || ""}`);
      verifier("en base : AES-256-GCM, aucun secret lisible",
        enBase[0]?.secret_format === "aes-256-gcm" && !enBase[0].secret_encrypted.includes(secret) && !enBase[0].stream_path_encrypted.includes("Streaming"));
      verifier("la réponse ne contient pas le secret", !JSON.stringify(pose.data).includes(secret));
      const liste = await appel("GET", "/cameras", a.token);
      verifier("la liste expose seulement « identifiants configurés »",
        !JSON.stringify(liste.data).includes(secret) && liste.data.cameras.find((x) => x.id === camA.id)?.identifiants_configures === true);
      await appel("PUT", `/cameras/${camA.id}/identifiants`, a.token, { username: "admin2", password: "Autre#2026" });
      const n = (await q(`SELECT COUNT(*)::int AS n FROM camera_credentials WHERE camera_id=$1`, [camA.id]))[0].n;
      verifier("réenregistrer ne crée pas de doublon", n === 1, `${n}`);
      const efface = await appel("DELETE", `/cameras/${camA.id}/identifiants`, a.token);
      const reste = (await q(`SELECT COUNT(*)::int AS n FROM camera_credentials WHERE camera_id=$1`, [camA.id]))[0].n;
      verifier("les identifiants s'effacent", efface.status === 200 && reste === 0);
    } else {
      verifier("sans clé : REFUS 503 SECRET_VAULT_DISABLED", pose.status === 503 && pose.data?.code === "SECRET_VAULT_DISABLED",
        `statut ${pose.status} ${pose.data?.code || ""}`);
      verifier("… et RIEN n'est stocké, pas même en clair", enBase.length === 0, JSON.stringify(enBase));
      const tdb = await appel("GET", "/cameras/tableau-de-bord", a.token);
      verifier("le tableau de bord le signale en alerte", tdb.data?.chiffrement_actif === false
        && (tdb.data?.alertes || []).some((x) => /Chiffrement/.test(x.message)));
    }
  }

  section("TABLEAU DE BORD");
  {
    const tdb = await appel("GET", "/cameras/tableau-de-bord", a.token);
    verifier("totaux : 2 caméras, 2 à l'état inconnu", tdb.data?.resume?.total === 2 && tdb.data?.resume?.inconnu === 2,
      JSON.stringify(tdb.data?.resume));
    verifier("alerte « jamais testée » pour chaque caméra", (tdb.data?.alertes || []).filter((x) => /jamais été testée/.test(x.message)).length === 2);
    verifier("la visualisation n'est pas simulée", tdb.data?.visualisation_disponible === false && /passerelle vidéo/.test(tdb.data?.message_visualisation || ""));
    verifier("les cinq connecteurs sont déclarés",
      ["onvif", "rtsp", "hikvision", "dahua", "other"].every((k) => (tdb.data?.connecteurs || []).some((x) => x.cle === k)));
  }

  section("DROITS — UN MAGASINIER NE VOIT PAS LES CAMÉRAS PAR DÉFAUT");
  {
    const mag = (await q(`INSERT INTO users (fullname, email, password, role, company_id)
                          VALUES ('Magasinier A','mag-a@essai.test','x','magasinier',$1) RETURNING id, role, company_id`, [a.id]))[0];
    const tMag = jeton(mag);
    const avant = await appel("GET", "/cameras", tMag);
    verifier("magasinier : 403 sans droit accordé", avant.status === 403 && avant.data?.code === "PERMISSION_DENIED", `statut ${avant.status}`);
    const me = await appel("GET", "/rbac/me", tMag);
    verifier("… et Caméras absent de son menu", me.data?.effective?.cameras?.view === false);

    // La direction lui accorde « Voir » sur Caméras, rien d'autre.
    const droits = (await appel("GET", `/company/users/${mag.id}/permissions`, a.token)).data.effective;
    const envoi = Object.entries(droits).map(([cle, act]) => ({ module_key: cle, ...act }));
    envoi.find((e) => e.module_key === "cameras").view = true;
    await appel("PUT", `/company/users/${mag.id}/permissions`, a.token, { permissions: envoi });
    const apres = await appel("GET", "/cameras", tMag);
    verifier("après accord de « Voir » : 200", apres.status === 200, `statut ${apres.status}`);
    const creation = await appel("POST", "/cameras", tMag, { name: "X" });
    verifier("… mais pas « Créer » (403)", creation.status === 403);
    const cred = await appel("PUT", `/cameras/${camA.id}/identifiants`, tMag, { password: "x" });
    verifier("… ni les identifiants (403)", cred.status === 403);
    const journal = await appel("GET", "/cameras/journal", tMag);
    verifier("… ni le journal d'accès (403)", journal.status === 403);
  }

  section("JOURNAL D'ACCÈS");
  {
    const j = await appel("GET", "/cameras/journal", a.token);
    const actions = (j.data?.journal || []).map((x) => x.action);
    verifier("création et tests de joignabilité sont tracés", actions.includes("creation") && actions.includes("modification"));
    if (AVEC_CLE) verifier("la pose et l'effacement d'identifiants sont tracés", actions.includes("identifiants_modifies") && actions.includes("identifiants_effaces"));
    const jB = await appel("GET", "/cameras/journal", b.token);
    verifier("B ne lit pas le journal de A", !(jB.data?.journal || []).some((x) => x.camera_id === camA.id));
  }

  await terminer();
}

main().catch(async (e) => {
  console.error(e);
  require("./_outils").bilan.echoues += 1;
  await terminer();
});
