"use strict";

/**
 * MaliLink Éducation — paramètres d'établissement, carte scolaire émise
 * automatiquement, QR de vérification publique (URL + jeton aléatoire),
 * pointage par la carte, remplacement, révocation, isolation.
 *
 *   scripts/test-integration.sh tests/education-cartes.test.js
 */

const { q, appel, jeton, verifier, section, creerSociete, terminer, BASE } = require("./_outils");

async function preparerEcole(nom, prefixe) {
  const e = await creerSociete({ nom, type: "ecole", modules: { education: true } });
  const annee = (await appel("POST", "/education/school-years", e.token, { label: "2026-2027", start_date: "2026-10-01", end_date: "2027-07-15", is_active: true })).data;
  const classe = (await appel("POST", "/education/classes", e.token, { name: "5e A", level: "5e", school_year_id: annee.id })).data;
  const classe2 = (await appel("POST", "/education/classes", e.token, { name: "5e B", level: "5e", school_year_id: annee.id })).data;
  await appel("PUT", "/education/etablissement", e.token, { official_name: `${nom} (officiel)`, short_name: prefixe, matricule_prefix: prefixe, active_school_year_id: annee.id });
  return { ...e, annee, classe, classe2 };
}
const inscrire = (ecole, prenom, nom) => appel("POST", "/education/inscriptions", ecole.token, {
  eleve: { first_name: prenom, last_name: nom, gender: "F", birth_date: "2013-04-12", address: "Rue 12, porte 7, Hamdallaye",
    guardian_name: "Parent Secret", guardian_phone: "+223 70 11 22 33" },
  inscription: { school_year_id: ecole.annee.id, class_id: ecole.classe.id },
  frais: { inscription: 20000, mensualite: 10000, mois: 2 }, paiement: { montant: 20000, mode: "wave", reference: "WV-SECRET-42" },
});
const verifierPublic = async (token) => {
  const r = await fetch(`${BASE}/verification/${token}`);
  return { status: r.status, data: await r.json().catch(() => null), entetes: r.headers };
};
const jetonDe = (url) => (String(url || "").match(/\/verifier\/([A-Za-z0-9_-]+)$/) || [])[1];

async function main() {
  const a = await preparerEcole("Lycée Mamadou Konaté", "LMK");
  const b = await preparerEcole("Collège Soundiata", "CSD");

  section("PARAMÈTRES D'ÉTABLISSEMENT : SAISIS UNE FOIS, JAMAIS EFFACÉS PAR UN ENVOI PARTIEL");
  {
    await appel("PUT", "/education/etablissement", a.token, { slogan: "Discipline et savoir", color_primary: "#123456", card_options: { afficher_photo: false } });
    const r = await appel("PUT", "/education/etablissement", a.token, { website: "https://lmk.example" });
    verifier("un envoi partiel garde le nom officiel, le slogan, la couleur et les options", r.status === 200
      && r.data.official_name === "Lycée Mamadou Konaté (officiel)" && r.data.slogan === "Discipline et savoir"
      && r.data.color_primary === "#123456" && r.data.card_options?.afficher_photo === false && r.data.website === "https://lmk.example",
      JSON.stringify(r.data).slice(0, 300));
    const lu = await appel("GET", "/education/etablissement", a.token);
    verifier("relu à l'identique", lu.data.short_name === "LMK" && lu.data.active_school_year_id === a.annee.id);
  }

  let d1;
  let tok1;
  section("CARTE ÉMISE AUTOMATIQUEMENT À L'INSCRIPTION");
  {
    const r = await inscrire(a, "Kadiatou", "Sangaré");
    d1 = r.data;
    tok1 = jetonDe(d1.carte?.verification_url);
    verifier("inscription : carte jointe avec URL de vérification", r.status === 201 && /\/verifier\/[A-Za-z0-9_-]{24}$/.test(d1.carte?.verification_url || ""),
      JSON.stringify(d1.carte));
    verifier("numéro de carte au préfixe de l'école", /^LMK-C\d{4}-00001$/.test(d1.carte?.reference || ""), d1.carte?.reference);
    const ligne = (await q(`SELECT * FROM edu_document_verifications WHERE token=$1`, [tok1]))[0];
    verifier("enregistrée : carte valide, classe et année, fin d'année scolaire", ligne?.status === "valide" && ligne.class_label === "5e A"
      && ligne.school_year_label === "2026-2027" && ligne.company_id === a.id);
    const deux = await inscrire(a, "Oumar", "Coulibaly");
    verifier("deuxième élève : numéro suivant, jeton différent", /-00002$/.test(deux.data.carte?.reference || "") && jetonDe(deux.data.carte?.verification_url) !== tok1);
  }

  section("VÉRIFICATION PUBLIQUE : AUTHENTICITÉ SEULEMENT, AUCUNE DONNÉE SENSIBLE");
  {
    const v = await verifierPublic(tok1);
    verifier("sans compte : document authentique et valide", v.status === 200 && v.data?.authentique === true && v.data.statut === "valide", JSON.stringify(v.data));
    verifier("établissement, élève, classe, année, type affichés", v.data.etablissement?.nom === "Lycée Mamadou Konaté (officiel)"
      && v.data.eleve === "Kadiatou Sangaré" && v.data.classe === "5e A" && v.data.annee_scolaire === "2026-2027" && v.data.type_libelle === "Carte scolaire");
    const brut = JSON.stringify(v.data);
    verifier("ni matricule, ni téléphone, ni adresse, ni naissance, ni paiement", !brut.includes(d1.eleve.matricule) && !brut.includes("+223")
      && !brut.includes("Hamdallaye") && !brut.includes("2013") && !brut.includes("Parent Secret") && !brut.includes("WV-SECRET")
      && !brut.includes("20000") && !brut.includes("photo"), brut);
    verifier("jamais mise en cache ni indexée", v.entetes.get("cache-control") === "no-store" && /noindex/.test(v.entetes.get("x-robots-tag") || ""));
    const faux = await verifierPublic("A".repeat(24));
    verifier("jeton inventé : non authentique", faux.status === 404 && faux.data?.authentique === false);
    const injection = await verifierPublic("x' OR '1'='1");
    verifier("jeton malformé : refusé sans requête", injection.status === 404);
    const compte = (await q(`SELECT checks_count FROM edu_document_verifications WHERE token=$1`, [tok1]))[0];
    verifier("chaque vérification est comptée", compte.checks_count >= 1);
  }

  section("CARTE DANS LE DOSSIER, RÉGÉNÉRATION, CHANGEMENT DE CLASSE, ARCHIVAGE");
  {
    const c = await appel("GET", `/education/students/${d1.eleve.id}/carte`, a.token);
    verifier("la direction lit la carte : QR image + URL + photo + établissement", c.status === 200 && c.data.carte?.qr?.startsWith("data:image/png")
      && c.data.carte.verification_url.endsWith(tok1) && c.data.etablissement?.official_name && c.data.carte.valid_until === "2027-07-15",
      JSON.stringify(c.data).slice(0, 200));
    const autreEcole = await appel("GET", `/education/students/${d1.eleve.id}/carte`, b.token);
    verifier("une autre école ne lit pas cette carte", autreEcole.status === 404);
    const regen = await appel("POST", `/education/students/${d1.eleve.id}/carte/regenerer`, a.token);
    const tok2 = jetonDe(regen.data?.carte?.verification_url);
    verifier("régénérer : nouvelle carte, nouveau jeton", regen.status === 201 && tok2 && tok2 !== tok1);
    const ancienne = await verifierPublic(tok1);
    const nouvelle = await verifierPublic(tok2);
    verifier("l'ancienne carte est « remplacée », la nouvelle « valide »", ancienne.data?.statut === "remplace" && nouvelle.data?.statut === "valide");
    await appel("PATCH", `/education/students/${d1.eleve.id}`, a.token, { class_id: a.classe2.id });
    const apres = await verifierPublic(tok2);
    verifier("changement de classe : la vérification montre la nouvelle classe", apres.data?.classe === "5e B", apres.data?.classe);

    const tProf = jeton((await q(`INSERT INTO users (fullname, email, password, role, company_id) VALUES ('P','p-${a.id}@x.test','x','teacher',$1) RETURNING id, role, company_id`, [a.id]))[0]);
    const refusProf = await appel("POST", `/education/students/${d1.eleve.id}/carte/regenerer`, tProf);
    verifier("un professeur ne régénère pas de carte", refusProf.status === 403);

    // Pointage de présence avec le QR de la carte.
    const scan = await appel("POST", "/education/attendance/scan", a.token, { qr_code: `https://malilinkglobal.com/verifier/${tok2}` });
    verifier("pointage par le QR de la carte (URL)", scan.status === 200 && scan.data?.student?.id === d1.eleve.id && !("photo_key" in (scan.data?.student || {})),
      JSON.stringify(scan.data).slice(0, 160));
    const scanAncien = await appel("POST", "/education/attendance/scan", a.token, { qr_code: tok1 });
    verifier("une carte remplacée ne pointe plus", scanAncien.status === 404);
    const scanB = await appel("POST", "/education/attendance/scan", b.token, { qr_code: tok2 });
    verifier("la carte de A est inconnue au portail de B", scanB.status === 404);

    await appel("POST", `/education/students/${d1.eleve.id}/archive`, a.token);
    const revoquee = await verifierPublic(tok2);
    verifier("archivage : la carte est révoquée", revoquee.data?.statut === "revoque");
    const regenArchive = await appel("POST", `/education/students/${d1.eleve.id}/carte/regenerer`, a.token);
    verifier("pas de carte pour un dossier archivé", regenArchive.status === 409);
    await appel("POST", `/education/students/${d1.eleve.id}/restore`, a.token);
    const retour = await appel("GET", `/education/students/${d1.eleve.id}/carte`, a.token);
    const tok3 = jetonDe(retour.data?.carte?.verification_url);
    verifier("restauration : nouvelle carte émise à la consultation", tok3 && tok3 !== tok2 && (await verifierPublic(tok3)).data?.statut === "valide");
  }

  section("ÉLÈVES INSCRITS AVANT LA CARTE AUTOMATIQUE");
  {
    const ancien = (await appel("POST", "/education/students", a.token, { first_name: "Ancien", last_name: "Élève", class_id: a.classe.id })).data;
    const c = await appel("GET", `/education/students/${ancien.id}/carte`, a.token);
    verifier("la carte est émise à la première consultation", c.status === 200 && Boolean(c.data.carte?.reference));
    const parent = (await q(`INSERT INTO users (fullname, email, password, role, company_id) VALUES ('Par','par-${a.id}@x.test','x','parent',$1) RETURNING id, role, company_id`, [a.id]))[0];
    await q(`INSERT INTO edu_student_parents (student_id, parent_user_id, relation) VALUES ($1,$2,'mere')`, [ancien.id, parent.id]);
    const tParent = jeton(parent);
    const sienne = await appel("GET", `/education/students/${ancien.id}/carte`, tParent);
    const autre = await appel("GET", `/education/students/${d1.eleve.id}/carte`, tParent);
    verifier("un parent lit la carte de son enfant, pas celle d'un autre", sienne.status === 200 && autre.status === 404);
  }

  await terminer();
}

main().catch(async (e) => { console.error(e); await terminer(); });
