"use strict";

/**
 * MaliLink Éducation — parcours d'inscription unique, frais, comptabilité,
 * photo privée, isolation entre deux écoles.
 *
 *   scripts/test-integration.sh tests/education-parcours.test.js
 */

const crypto = require("crypto");
const { q, appel, jeton, verifier, section, creerSociete, terminer, BASE } = require("./_outils");

const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(2000), Buffer.from([0xff, 0xd9])]);

async function envoyerFichier(chemin, token, contenu, nom, type) {
  const fd = new FormData();
  fd.append("file", new Blob([contenu], { type }), nom);
  const r = await fetch(`${BASE}${chemin}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "x-tenant-id": "malilink" }, body: fd });
  return { status: r.status, data: await r.json().catch(() => null) };
}

async function preparerEcole(nom) {
  const ecole = await creerSociete({ nom, type: "ecole", modules: { education: true } });
  const annee = (await appel("POST", "/education/school-years", ecole.token, { label: "2026-2027", start_date: "2026-10-01", end_date: "2027-07-15", is_active: true })).data;
  const classe = (await appel("POST", "/education/classes", ecole.token, { name: "6e A", level: "6e", school_year_id: annee.id })).data;
  return { ...ecole, annee, classe };
}

async function main() {
  const a = await preparerEcole("Lycée Sankoré");
  const b = await preparerEcole("École Djoliba");
  const prof = (await q(`INSERT INTO users (fullname, email, password, role, company_id) VALUES ('Prof Diakité','prof-${a.id}@essai.test','x','teacher',$1) RETURNING id, role, company_id`, [a.id]))[0];
  const tProf = jeton(prof);

  section("RÔLES : L'ADMINISTRATEUR D'UNE ÉCOLE A ACCÈS À SON MODULE");
  {
    verifier("année et classe créées par le compte « admin » de l'école", Boolean(a.annee?.id && a.classe?.id), JSON.stringify([a.annee, a.classe]));
    const o = await appel("GET", "/education/inscriptions/options", a.token);
    verifier("formulaire d'inscription accessible", o.status === 200 && o.data?.annee_active_id === a.annee.id, JSON.stringify(o.data).slice(0, 200));
    const refus = await appel("POST", "/education/inscriptions", tProf, { eleve: { first_name: "X", last_name: "Y" } });
    verifier("un professeur ne crée pas d'inscription", refus.status === 403);
  }

  section("ÉTABLISSEMENT : SAISI UNE FOIS");
  {
    const r = await appel("PUT", "/education/etablissement", a.token, {
      official_name: "Lycée Privé Sankoré de Bamako", short_name: "LPS", slogan: "Savoir et rigueur", matricule_prefix: "lps",
      phone: "+223 20 00 00 00", director_name: "M. Traoré", color_primary: "#123456", color_secondary: "#abcdef",
      active_school_year_id: a.annee.id, card_template: "premium", report_template: "elegant",
      card_options: { afficher_photo: true, orientation: "portrait" },
    });
    verifier("paramètres enregistrés (préfixe en majuscules, modèles)", r.status === 200 && r.data?.matricule_prefix === "LPS"
      && r.data.card_template === "premium" && r.data.card_options?.orientation === "portrait", JSON.stringify(r.data).slice(0, 300));
    const couleur = await appel("PUT", "/education/etablissement", a.token, { color_primary: "red;}", card_template: "pirate" });
    verifier("couleur et modèle invalides : valeurs sûres par défaut", couleur.data?.color_primary === "#0f1b3d" && couleur.data?.card_template === "academique");
    await appel("PUT", "/education/etablissement", a.token, { official_name: "Lycée Privé Sankoré de Bamako", short_name: "LPS", matricule_prefix: "LPS", active_school_year_id: a.annee.id, card_template: "premium" });
    const logo = await envoyerFichier("/education/etablissement/fichiers/logo", a.token, jpeg(), "logo.jpg", "image/jpeg");
    verifier("logo enregistré, servi par URL signée", logo.status === 201 && /\/education-fichiers\/etablissement\//.test(logo.data?.url || ""));
    const faux = await envoyerFichier("/education/etablissement/fichiers/cachet", a.token, Buffer.from("<svg onload=alert(1)>"), "cachet.png", "image/png");
    verifier("un faux PNG est refusé", faux.status === 415);
  }

  let dossier;
  section("INSCRIPTION : UN SEUL DOSSIER, UNE SEULE TRANSACTION");
  {
    const corps = {
      eleve: {
        first_name: "Aminata", last_name: "Coulibaly", gender: "F", birth_date: "2014-03-09", birth_place: "Ségou",
        address: "Hamdallaye ACI", guardian_name: "Moussa Coulibaly", guardian_relation: "pere", guardian_phone: "+223 76 00 00 00",
      },
      inscription: { school_year_id: a.annee.id, class_id: a.classe.id, serie: "", date: "2026-10-02" },
      frais: { inscription: 25000, mensualite: 15000, mois: 9, autres: 5000, autres_libelle: "Tenue", reduction: 10000, bourse: 5000, premiere_echeance: "2026-11-05" },
      paiement: { montant: 30000, mode: "wave", reference: "WV-ESSAI-001" },
    };
    const r = await appel("POST", "/education/inscriptions", a.token, corps);
    dossier = r.data;
    verifier("dossier créé", r.status === 201, JSON.stringify(r.data).slice(0, 300));
    verifier("matricule automatique avec le préfixe de l'école", /^LPS-\d{4}-0001$/.test(dossier.eleve?.matricule || ""), dossier.eleve?.matricule);
    verifier("échéancier : 25 000 + 5 000 + (135 000 − 15 000) = 150 000", Number(dossier.echeancier?.total_amount) === 150000,
      JSON.stringify(dossier.echeancier));
    const echeances = await q(`SELECT kind, amount::float AS montant, amount_paid::float AS paye, status FROM edu_feeplan_installments WHERE plan_id=$1 ORDER BY seq`, [dossier.echeancier.id]);
    verifier("inscription puis autres frais puis 9 mensualités", echeances.length === 11 && echeances[0].kind === "inscription"
      && echeances[1].kind === "autre" && echeances.slice(2).every((x) => x.kind === "mensualite"), JSON.stringify(echeances.map((x) => x.kind)));
    verifier("les 30 000 versés soldent l'inscription et la tenue", echeances[0].status === "paid" && echeances[1].status === "paid"
      && echeances[2].status === "pending");
    verifier("l'inscription est réglée", dossier.inscription?.status === "paid" && Number(dossier.inscription.amount_paid) === 25000,
      JSON.stringify(dossier.inscription));
    verifier("reçu numéroté", /^MLK-REC-\d{4}-\d{5}$/.test(dossier.paiement?.receipt_number || ""));
    const compta = await q(`SELECT amount::float AS montant, direction, source_type, category FROM accounting_transactions WHERE source_type='education' AND company_id=$1`, [a.id]);
    verifier("écriture comptable « encaissement scolarité » de 30 000", compta.length === 1 && compta[0].montant === 30000
      && compta[0].direction === "entrée", JSON.stringify(compta));
    verifier("élève affecté à sa classe", (await q(`SELECT class_id FROM edu_students WHERE id=$1`, [dossier.eleve.id]))[0].class_id === a.classe.id);

    const doublon = await appel("POST", "/education/inscriptions", a.token, { ...corps, eleve_id: dossier.eleve.id });
    verifier("deuxième inscription la même année : 409", doublon.status === 409 && doublon.data?.code === "DEJA_INSCRIT");
    const trop = await appel("POST", "/education/inscriptions", a.token, { ...corps, eleve: { ...corps.eleve, first_name: "Trop" }, paiement: { montant: 999999, mode: "especes" } });
    verifier("paiement supérieur au dû : refusé, rien n'est créé", trop.status === 400
      && (await q(`SELECT COUNT(*)::int AS n FROM edu_students WHERE company_id=$1 AND first_name='Trop'`, [a.id]))[0].n === 0);
    const manuel = await appel("POST", "/education/inscriptions", a.token, { ...corps, eleve: { ...corps.eleve, first_name: "Manuel", matricule: "X-1" } });
    verifier("matricule manuel refusé si non autorisé", manuel.status === 403);
    const sansNom = await appel("POST", "/education/inscriptions", a.token, { ...corps, eleve: { first_name: "Seul" } });
    verifier("nom obligatoire", sansNom.status === 400);
  }

  section("PAIEMENTS : PARTIEL, RESTE, ANNULATION");
  {
    const plan = dossier.echeancier.id;
    const p = await appel("POST", `/education/fee-plans/${plan}/encaissements`, a.token, { montant: 20000, mode: "orange_money", reference: "OM-77" });
    verifier("paiement partiel de 20 000", p.status === 201 && /^MLK-REC-/.test(p.data?.paiement?.receipt_number || ""), JSON.stringify(p.data).slice(0, 200));
    const trop = await appel("POST", `/education/fee-plans/${plan}/encaissements`, a.token, { montant: 200000, mode: "especes" });
    verifier("au-delà du reste : refusé", trop.status === 400 && trop.data?.code === "MONTANT_EXCEDENTAIRE");
    const mode = await appel("POST", `/education/fee-plans/${plan}/encaissements`, a.token, { montant: 1000, mode: "bitcoin" });
    verifier("mode de paiement hors liste : refusé", mode.status === 400);
    const situation = (await appel("GET", "/education/finances/eleves", a.token)).data.find((x) => x.id === dossier.eleve.id);
    verifier("reste à payer = 150 000 − 50 000", situation?.reste === 100000, JSON.stringify(situation));
    const ancien = await appel("POST", `/education/enrollments/${dossier.inscription.id}/payments`, a.token, { amount: 1000, method: "especes" });
    verifier("l'ancien circuit renvoie vers l'échéancier unique", ancien.status === 409 && ancien.data?.code === "ECHEANCIER_UNIQUE");
    const annul = await appel("PATCH", `/education/fee-payments/${p.data.paiement.id}/cancel`, a.token);
    verifier("annulation du reçu", annul.status === 200);
    const inverse = await q(`SELECT amount::float AS montant FROM accounting_transactions WHERE company_id=$1 AND direction='sortie' AND source_type='education'`, [a.id]);
    verifier("…laisse une écriture comptable inverse", inverse.length === 1 && inverse[0].montant === 20000);
    const tdb = await appel("GET", "/education/finances/tableau-de-bord", a.token);
    verifier("tableau de bord : encaissé aujourd'hui (paiements valides seulement)", tdb.status === 200 && tdb.data?.encaisse_aujourdhui === 30000,
      JSON.stringify(tdb.data).slice(0, 300));
    verifier("…reste à encaisser 120 000", tdb.data?.reste_a_encaisser === 120000);
    const dash = await appel("GET", "/education/dashboard", a.token);
    verifier("l'ancien tableau de bord ne tombe plus (500 corrigé)", dash.status === 200 && dash.data?.unpaid_total === 120000, JSON.stringify(dash.data));
    const fin = await appel("GET", `/education/students/${dossier.eleve.id}/finances`, a.token);
    verifier("situation financière de l'élève (500 corrigé)", fin.status === 200 && fin.data?.payments?.length === 2);
    const frais = (await appel("POST", "/education/fees", a.token, { label: "Cantine", amount: 3000 })).data;
    const ancienFrais = await appel("POST", "/education/fee-payments", a.token, { fee_id: frais.id, student_id: dossier.eleve.id, amount: 3000 });
    verifier("ancien paiement de frais (500 corrigé)", ancienFrais.status === 201, JSON.stringify(ancienFrais.data));
  }

  section("DOSSIER, PHOTO PRIVÉE, ARCHIVAGE");
  {
    const ph = await envoyerFichier(`/education/students/${dossier.eleve.id}/photo`, a.token, jpeg(), "photo.jpg", "image/jpeg");
    verifier("photo de l'élève enregistrée", ph.status === 201 && Boolean(ph.data?.photo_url));
    const lue = await fetch(`${BASE}${ph.data.photo_url}`);
    verifier("…lue par URL signée", lue.status === 200 && lue.headers.get("content-type") === "image/jpeg");
    const falsifiee = await fetch(`${BASE}${ph.data.photo_url.replace(/s=[^&]+/, `s=${"B".repeat(32)}`)}`);
    verifier("signature falsifiée : 404", falsifiee.status === 404);
    const statique = await fetch(`${BASE}/uploads/eleves/${a.id}/x.jpg`);
    verifier("jamais par le dossier public", statique.status === 404);
    const d = await appel("GET", `/education/students/${dossier.eleve.id}/dossier`, a.token);
    verifier("dossier complet : élève, inscription, échéancier", d.status === 200 && d.data?.inscriptions?.length === 1
      && d.data?.echeanciers?.[0]?.echeances?.length === 11 && Boolean(d.data.eleve.photo_url) && !("photo_key" in d.data.eleve));
    const m = await appel("PATCH", `/education/students/${dossier.eleve.id}`, a.token, { guardian_phone: "+223 66 11 22 33", class_id: a.classe.id });
    verifier("modifier le dossier", m.status === 200 && m.data?.eleve?.guardian_phone === "+223 66 11 22 33");
    const ar = await appel("POST", `/education/students/${dossier.eleve.id}/archive`, a.token);
    const liste = (await appel("GET", "/education/students", a.token)).data;
    verifier("élève archivé : absent de la liste courante", ar.status === 200 && !liste.some((x) => x.id === dossier.eleve.id));
    const archives = (await appel("GET", "/education/students?archives=1", a.token)).data;
    verifier("…présent dans les archives", archives.some((x) => x.id === dossier.eleve.id));
    await appel("POST", `/education/students/${dossier.eleve.id}/restore`, a.token);
  }

  section("ISOLATION ENTRE DEUX ÉCOLES (IDENTIFIANTS DEVINÉS)");
  {
    const vu = await appel("GET", `/education/students/${dossier.eleve.id}/dossier`, b.token);
    verifier("école B : dossier d'un élève de A → 404", vu.status === 404);
    const modif = await appel("PATCH", `/education/students/${dossier.eleve.id}`, b.token, { first_name: "Pirate" });
    verifier("école B : modifier un élève de A → 404", modif.status === 404);
    const photo = await envoyerFichier(`/education/students/${dossier.eleve.id}/photo`, b.token, jpeg(), "x.jpg", "image/jpeg");
    verifier("école B : photo d'un élève de A → 404", photo.status === 404);
    const pay = await appel("POST", `/education/fee-plans/${dossier.echeancier.id}/encaissements`, b.token, { montant: 1000, mode: "especes" });
    verifier("école B : encaisser sur l'échéancier de A → 404", pay.status === 404);
    const classeA = await appel("POST", "/education/inscriptions", b.token, {
      eleve: { first_name: "Intrus", last_name: "B" }, inscription: { school_year_id: b.annee.id, class_id: a.classe.id }, frais: {},
    });
    verifier("école B : inscrire dans une classe de A → 404", classeA.status === 404);
    const anneeA = await appel("POST", "/education/classes", b.token, { name: "X", school_year_id: a.annee.id });
    verifier("école B : classe rattachée à une année de A → 404", anneeA.status === 404);
    const finB = (await appel("GET", "/education/finances/eleves", b.token)).data;
    verifier("école B ne voit aucune situation de A", Array.isArray(finB) && !finB.some((x) => x.id === dossier.eleve.id));
    const listeB = (await appel("GET", "/education/students", b.token)).data;
    verifier("école B ne voit aucun élève de A", !listeB.some((x) => x.id === dossier.eleve.id));
    const recu = await fetch(`${BASE}/education/fee-payments/${dossier.paiement.id}/receipt`, { headers: { Authorization: `Bearer ${b.token}`, "x-tenant-id": "malilink" } });
    verifier("école B : reçu de A → 404", recu.status === 404);
    const tdbB = (await appel("GET", "/education/finances/tableau-de-bord", b.token)).data;
    verifier("tableau de bord de B vierge", tdbB?.encaisse_aujourdhui === 0 && tdbB?.reste_a_encaisser === 0);
  }

  await terminer();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
