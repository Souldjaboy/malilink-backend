"use strict";

/**
 * MaliLink Éducation — isolation entre deux écoles (A et B), sur une vraie
 * base et un vrai serveur. Chaque cas négatif présente à l'école A un
 * identifiant RÉEL de l'école B (jamais un identifiant inventé).
 *
 *   scripts/test-integration.sh tests/education-tenant-isolation.test.js
 */

const { q, appel, jeton, verifier, section, creerSociete, terminer } = require("./_outils");

const REFUS = [403, 404, 422];
const refuse = (titre, r) => verifier(titre, REFUS.includes(r.status), `HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
const horsEtablissement = (titre, r) =>
  verifier(titre, r.status === 404 && r.data?.code === "REFERENCE_HORS_ETABLISSEMENT", `HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);

async function preparerEcole(nom) {
  const e = await creerSociete({ nom, type: "ecole", modules: { education: true } });
  const t = e.token;
  const post = async (chemin, corps) => {
    const r = await appel("POST", chemin, t, corps);
    if (r.status >= 300) throw new Error(`${nom} ${chemin} → ${r.status} ${JSON.stringify(r.data)}`);
    return r.data;
  };
  const annee = await post("/education/school-years", { label: "2026-2027", start_date: "2026-10-01", end_date: "2027-07-15", is_active: true });
  const periode = await post("/education/terms", { school_year_id: annee.id, label: "Trimestre 1", term_order: 1, start_date: "2026-10-01", end_date: "2026-12-20" });
  const classe = await post("/education/classes", { name: "6e A", level: "6e", school_year_id: annee.id });
  const classe2 = await post("/education/classes", { name: "6e B", level: "6e", school_year_id: annee.id });
  const matiere = await post("/education/subjects", { name: "Mathématiques", coefficient: 4 });
  const profUser = (await q(`INSERT INTO users (fullname, email, password, role, company_id) VALUES ($1,$2,'x','teacher',$3) RETURNING id, role, company_id`,
    [`Prof ${nom}`, `prof-${e.id}@essai.test`, e.id]))[0];
  const parent = (await q(`INSERT INTO users (fullname, email, password, role, company_id) VALUES ($1,$2,'x','parent',$3) RETURNING id`,
    [`Parent ${nom}`, `parent-${e.id}@essai.test`, e.id]))[0];
  const prof = await post("/education/teachers", { first_name: "Awa", last_name: "Keïta", user_id: profUser.id, school_year_id: annee.id });
  const affectation = await post("/education/teacher-assignments", {
    teacher_id: prof.id, class_id: classe.id, subject_id: matiere.id, school_year_id: annee.id, term_id: periode.id,
  });
  const dossier = await post("/education/inscriptions", {
    eleve: { first_name: "Fanta", last_name: "Diarra", gender: "F", birth_date: "2014-05-01", guardian_name: "Parent", guardian_phone: "+223 70 00 00 00" },
    inscription: { school_year_id: annee.id, class_id: classe.id, date: "2026-10-02" },
    frais: { inscription: 20000, mensualite: 10000, mois: 3, premiere_echeance: "2026-11-05" },
    paiement: { montant: 20000, mode: "especes" },
  });
  const eleve = dossier.eleve;
  const echeances = await q(`SELECT id FROM edu_feeplan_installments WHERE plan_id=$1 ORDER BY seq`, [dossier.echeancier.id]);
  // Ancien parcours (inscription simple + versement) : encore lisible, donc encore à protéger.
  const ancienne = await post("/education/enrollments", { student_id: eleve.id, class_id: classe2.id, enrollment_fee: 5000, amount_paid: 2000, payment_method: "especes" });
  const versementAncien = (await q(`SELECT id FROM edu_enrollment_payments WHERE enrollment_id=$1`, [ancienne.id]))[0];
  const horaire = await post("/education/schedules", {
    class_id: classe.id, day_of_week: 1, start_time: "08:00", end_time: "09:00",
    subject_id: matiere.id, teacher_id: prof.id, assignment_id: affectation.id, school_year_id: annee.id,
  });
  const cours = await post("/education/courses", { class_id: classe.id, subject_id: matiere.id, title: "Fractions", course_type: "cours" });
  const devoir = await post("/education/assignments", { class_id: classe.id, subject_id: matiere.id, title: "Exercices 1" });
  const rendu = await post(`/education/assignments/${devoir.id}/submissions`, { student_id: eleve.id, content: "Réponses" });
  const examen = await post("/education/exams", { term_id: periode.id, class_id: classe.id, subject_id: matiere.id, title: "Composition", max_score: 20 });
  await post(`/education/exams/${examen.id}/grades`, { grades: [{ student_id: eleve.id, score: 14 }] });
  await post("/education/attendance/roll-call", { class_id: classe.id, entries: [{ student_id: eleve.id, status: "present" }] });
  await post("/education/report-cards/generate", { term_id: periode.id, class_id: classe.id });
  const bulletin = (await q(`SELECT id FROM edu_report_cards WHERE student_id=$1`, [eleve.id]))[0];
  const frais = await post("/education/fees", { label: "Cantine", fee_type: "autre", amount: 5000, class_id: classe.id, school_year_id: annee.id });
  return {
    ...e, annee, periode, classe, classe2, matiere, profUser, parent, prof, affectation, dossier, eleve, echeances,
    ancienne, versementAncien, horaire, cours, devoir, rendu, examen, bulletin, frais,
  };
}

async function main() {
  const A = await preparerEcole("Lycée Askia");
  const B = await preparerEcole("Collège Kankou Moussa");
  const tA = A.token;
  verifier("deux écoles complètes préparées (année, période, classe, élève, échéancier, bulletin…)",
    Boolean(A.bulletin?.id && B.bulletin?.id && B.versementAncien?.id && B.rendu?.id));

  section("ACCÈS DIRECT : A PRÉSENTE DES IDENTIFIANTS RÉELS DE B");
  {
    const id = B.eleve.id;
    refuse("A ne lit pas le dossier d'un élève de B", await appel("GET", `/education/students/${id}/dossier`, tA));
    refuse("A ne lit pas le badge d'un élève de B", await appel("GET", `/education/students/${id}/badge`, tA));
    refuse("A ne modifie pas un élève de B", await appel("PATCH", `/education/students/${id}`, tA, { first_name: "Piraté" }));
    refuse("A n'archive (ne supprime) pas un élève de B", await appel("POST", `/education/students/${id}/archive`, tA));
    refuse("A ne lit pas les finances d'un élève de B", await appel("GET", `/education/students/${id}/finances`, tA));
    refuse("A ne lit pas les moyennes d'un élève de B", await appel("GET", `/education/students/${id}/averages`, tA));
    refuse("A ne lit pas les bulletins d'un élève de B", await appel("GET", `/education/students/${id}/report-cards`, tA));
    refuse("A ne lit pas la conduite d'un élève de B", await appel("GET", `/education/students/${id}/conduct`, tA));
    refuse("A ne lie pas un parent à un élève de B", await appel("POST", `/education/students/${id}/parents`, tA, { parent_user_id: A.parent.id }));
    refuse("A ne lit pas un professeur de B", await appel("GET", `/education/teachers/${B.prof.id}`, tA));
    refuse("A ne modifie pas un professeur de B", await appel("PATCH", `/education/teachers/${B.prof.id}`, tA, { phone: "0" }));
    refuse("A ne modifie pas une affectation de B", await appel("PATCH", `/education/teacher-assignments/${B.affectation.id}`, tA, { coefficient: 9 }));
    refuse("A ne supprime pas une affectation de B", await appel("DELETE", `/education/teacher-assignments/${B.affectation.id}`, tA));
    refuse("A ne lit pas une inscription de B", await appel("GET", `/education/enrollments/${B.dossier.inscription.id}`, tA));
    refuse("A ne génère pas le PDF d'inscription de B", await appel("GET", `/education/enrollments/${B.dossier.inscription.id}/pdf`, tA));
    refuse("A ne lit pas les versements d'une inscription de B", await appel("GET", `/education/enrollments/${B.ancienne.id}/payments`, tA));
    refuse("A n'encaisse pas sur une inscription de B", await appel("POST", `/education/enrollments/${B.ancienne.id}/payments`, tA, { amount: 100 }));
    refuse("A ne génère pas le reçu d'un versement de B", await appel("GET", `/education/enrollment-payments/${B.versementAncien.id}/receipt`, tA));
    refuse("A n'annule pas un versement de B", await appel("PATCH", `/education/enrollment-payments/${B.versementAncien.id}/cancel`, tA));
    refuse("A ne lit pas un échéancier de B", await appel("GET", `/education/fee-plans/${B.dossier.echeancier.id}`, tA));
    refuse("A ne génère pas l'échéancier PDF de B", await appel("GET", `/education/fee-plans/${B.dossier.echeancier.id}/schedule/pdf`, tA));
    refuse("A n'encaisse pas sur l'échéancier de B (ancien point d'entrée)", await appel("POST", `/education/fee-plans/${B.dossier.echeancier.id}/payments`, tA, { amount: 100 }));
    refuse("A n'encaisse pas sur l'échéancier de B (parcours)", await appel("POST", `/education/fee-plans/${B.dossier.echeancier.id}/encaissements`, tA, { montant: 100, mode: "especes" }));
    refuse("A ne génère pas le reçu de mensualité de B", await appel("GET", `/education/fee-payments/${B.dossier.paiement.id}/receipt`, tA));
    refuse("A n'annule pas un paiement de B", await appel("PATCH", `/education/fee-payments/${B.dossier.paiement.id}/cancel`, tA));
    refuse("A ne lit pas les présences d'un élève de B", await appel("GET", `/education/attendance?student_id=${id}`, tA));
    refuse("A ne lit pas le PDF du bulletin de B", await appel("GET", `/education/report-cards/${B.bulletin.id}/pdf`, tA));
    refuse("A ne modifie pas un bulletin de B", await appel("PATCH", `/education/report-cards/${B.bulletin.id}`, tA, { appreciation: "Piraté" }));
    refuse("A ne modifie pas un horaire de B", await appel("PATCH", `/education/schedules/${B.horaire.id}`, tA, { room: "Z" }));
    refuse("A ne supprime pas un horaire de B", await appel("DELETE", `/education/schedules/${B.horaire.id}`, tA));
    refuse("A ne modifie pas un cours de B", await appel("PATCH", `/education/courses/${B.cours.id}`, tA, { title: "Piraté" }));
    refuse("A ne supprime pas un cours de B", await appel("DELETE", `/education/courses/${B.cours.id}`, tA));
    refuse("A ne lit pas les rendus d'un devoir de B", await appel("GET", `/education/assignments/${B.devoir.id}/submissions`, tA));
    refuse("A ne rend pas un devoir de B", await appel("POST", `/education/assignments/${B.devoir.id}/submissions`, tA, { student_id: A.eleve.id }));
    refuse("A ne note pas un rendu de B", await appel("PATCH", `/education/submissions/${B.rendu.id}/grade`, tA, { score: 20 }));
    refuse("A ne saisit pas de notes sur une évaluation de B", await appel("POST", `/education/exams/${B.examen.id}/grades`, tA, { grades: [] }));
    refuse("A ne téléverse pas la photo d'un élève de B", await appel("POST", `/education/students/${id}/photo`, tA));

    const tt = await appel("GET", `/education/timetables/class/${B.classe.id}`, tA);
    verifier("emploi du temps d'une classe de B : vide pour A", tt.status !== 200 || (Array.isArray(tt.data) && tt.data.length === 0), JSON.stringify(tt.data).slice(0, 120));
    const rc = await appel("GET", `/education/classes/${B.classe.id}/report-cards`, tA);
    verifier("bulletins d'une classe de B : vides pour A", rc.status !== 200 || (Array.isArray(rc.data) && rc.data.length === 0), JSON.stringify(rc.data).slice(0, 120));
    const liste = await appel("GET", "/education/students?archives=1", tA);
    verifier("la liste des élèves de A ne contient aucun élève de B",
      liste.status === 200 && !JSON.stringify(liste.data).includes(B.eleve.matricule), JSON.stringify(liste.data).slice(0, 120));

    const intacts = await q(`SELECT
        (SELECT first_name FROM edu_students WHERE id=$1) AS prenom,
        (SELECT archived_at FROM edu_students WHERE id=$1) AS archive,
        (SELECT COUNT(*)::int FROM edu_schedules WHERE id=$2) AS horaire,
        (SELECT COUNT(*)::int FROM edu_courses WHERE id=$3) AS cours,
        (SELECT COUNT(*)::int FROM edu_teacher_assignments WHERE id=$4) AS affectation,
        (SELECT status FROM edu_feeplan_payments WHERE id=$5) AS paiement,
        (SELECT appreciation FROM edu_report_cards WHERE id=$6) AS appreciation`,
      [B.eleve.id, B.horaire.id, B.cours.id, B.affectation.id, B.dossier.paiement.id, B.bulletin.id]);
    const x = intacts[0];
    verifier("les données de B sont intactes après toutes ces tentatives",
      x.prenom === "Fanta" && !x.archive && x.horaire === 1 && x.cours === 1 && x.affectation === 1 && x.paiement === "paid" && x.appreciation !== "Piraté",
      JSON.stringify(x));
  }

  section("INJECTION DE CLÉS ÉTRANGÈRES : A ÉCRIT AVEC DES IDENTIFIANTS DE B");
  {
    horsEtablissement("classe avec l'année scolaire de B", await appel("POST", "/education/classes", tA, { name: "X", school_year_id: B.annee.id }));
    horsEtablissement("classe avec un professeur principal de B", await appel("POST", "/education/classes", tA, { name: "X", school_year_id: A.annee.id, main_teacher_user_id: B.profUser.id }));
    horsEtablissement("période avec l'année de B", await appel("POST", "/education/terms", tA, { school_year_id: B.annee.id, label: "T9", term_order: 9 }));
    horsEtablissement("professeur lié à un compte de B", await appel("POST", "/education/teachers", tA, { first_name: "X", last_name: "Y", user_id: B.profUser.id }));
    horsEtablissement("professeur rattaché à l'année de B", await appel("POST", "/education/teachers", tA, { first_name: "X", last_name: "Y", school_year_id: B.annee.id }));
    horsEtablissement("élève (ancien formulaire) dans une classe de B", await appel("POST", "/education/students", tA, { first_name: "X", last_name: "Y", class_id: B.classe.id }));
    horsEtablissement("inscription dans une classe de B", await appel("POST", "/education/inscriptions", tA, {
      eleve: { first_name: "X", last_name: "Y" }, inscription: { school_year_id: A.annee.id, class_id: B.classe.id } }));
    horsEtablissement("réinscription d'un élève de B", await appel("POST", "/education/inscriptions", tA, {
      eleve_id: B.eleve.id, inscription: { school_year_id: A.annee.id, class_id: A.classe.id } }));
    horsEtablissement("parent de B rattaché à un élève de A", await appel("POST", `/education/students/${A.eleve.id}/parents`, tA, { parent_user_id: B.parent.id }));
    horsEtablissement("inscription (ancienne) d'un élève de A dans une classe de B", await appel("POST", "/education/enrollments", tA, { student_id: A.eleve.id, class_id: B.classe.id }));
    horsEtablissement("inscription (ancienne) d'un élève de A sur l'année de B", await appel("POST", "/education/enrollments", tA, { student_id: A.eleve.id, school_year_id: B.annee.id }));
    horsEtablissement("échéancier avec la classe de B", await appel("POST", "/education/fee-plans", tA, { student_id: A.eleve.id, total_amount: 1000, class_id: B.classe.id }));
    horsEtablissement("échéancier avec l'année de B", await appel("POST", "/education/fee-plans", tA, { student_id: A.eleve.id, total_amount: 1000, school_year_id: B.annee.id }));
    horsEtablissement("paiement de l'échéancier de A sur une échéance de B", await appel("POST", `/education/fee-plans/${A.dossier.echeancier.id}/payments`, tA, { amount: 100, installment_id: B.echeances[0].id }));
    const autrePlan = (await appel("POST", "/education/fee-plans", tA, { student_id: A.eleve.id, total_amount: 3000, installments_count: 1 })).data;
    const echAutre = (await q(`SELECT id FROM edu_feeplan_installments WHERE plan_id=$1`, [autrePlan.id]))[0];
    const croise = await appel("POST", `/education/fee-plans/${A.dossier.echeancier.id}/payments`, tA, { amount: 100, installment_id: echAutre.id });
    verifier("paiement sur une échéance d'un AUTRE plan de A : refusé", croise.status === 422 && croise.data?.code === "ECHEANCE_HORS_PLAN", JSON.stringify(croise.data));
    const base = { teacher_id: A.prof.id, class_id: A.classe2.id, subject_id: A.matiere.id, school_year_id: A.annee.id, term_id: A.periode.id };
    for (const [cle, val, nom] of [["teacher_id", B.prof.id, "professeur"], ["class_id", B.classe.id, "classe"], ["subject_id", B.matiere.id, "matière"],
      ["school_year_id", B.annee.id, "année"], ["term_id", B.periode.id, "période"]]) {
      horsEtablissement(`affectation avec ${nom} de B`, await appel("POST", "/education/teacher-assignments", tA, { ...base, [cle]: val }));
    }
    horsEtablissement("modification d'affectation vers une matière de B", await appel("PATCH", `/education/teacher-assignments/${A.affectation.id}`, tA, { subject_id: B.matiere.id }));
    horsEtablissement("modification d'affectation vers une période de B", await appel("PATCH", `/education/teacher-assignments/${A.affectation.id}`, tA, { term_id: B.periode.id }));
    const h = { class_id: A.classe.id, day_of_week: 2, start_time: "10:00", end_time: "11:00" };
    for (const [cle, val, nom] of [["assignment_id", B.affectation.id, "affectation"], ["teacher_id", B.prof.id, "professeur"], ["class_id", B.classe.id, "classe"],
      ["subject_id", B.matiere.id, "matière"], ["school_year_id", B.annee.id, "année"]]) {
      horsEtablissement(`horaire avec ${nom} de B`, await appel("POST", "/education/schedules", tA, { ...h, [cle]: val }));
    }
    horsEtablissement("modification d'horaire vers un professeur de B", await appel("PATCH", `/education/schedules/${A.horaire.id}`, tA, { teacher_id: B.prof.id }));
    horsEtablissement("modification d'horaire vers une matière de B", await appel("PATCH", `/education/schedules/${A.horaire.id}`, tA, { subject_id: B.matiere.id }));
    const ex = { term_id: A.periode.id, class_id: A.classe.id, subject_id: A.matiere.id, title: "Interro" };
    horsEtablissement("évaluation dans une classe de B", await appel("POST", "/education/exams", tA, { ...ex, class_id: B.classe.id }));
    horsEtablissement("évaluation dans une matière de B", await appel("POST", "/education/exams", tA, { ...ex, subject_id: B.matiere.id }));
    horsEtablissement("évaluation sur une période de B", await appel("POST", "/education/exams", tA, { ...ex, term_id: B.periode.id }));
    horsEtablissement("frais pour une classe de B", await appel("POST", "/education/fees", tA, { label: "X", amount: 1, class_id: B.classe.id }));
    horsEtablissement("frais sur l'année de B", await appel("POST", "/education/fees", tA, { label: "X", amount: 1, school_year_id: B.annee.id }));
    horsEtablissement("paiement d'un frais de B", await appel("POST", "/education/fee-payments", tA, { fee_id: B.frais.id, student_id: A.eleve.id, amount: 100 }));
    horsEtablissement("cours dans une classe de B", await appel("POST", "/education/courses", tA, { class_id: B.classe.id, title: "X" }));
    horsEtablissement("cours dans une matière de B", await appel("POST", "/education/courses", tA, { class_id: A.classe.id, subject_id: B.matiere.id, title: "X" }));
    horsEtablissement("devoir dans une classe de B", await appel("POST", "/education/assignments", tA, { class_id: B.classe.id, title: "X" }));
    horsEtablissement("devoir dans une matière de B", await appel("POST", "/education/assignments", tA, { class_id: A.classe.id, subject_id: B.matiere.id, title: "X" }));
    horsEtablissement("message à un utilisateur de B", await appel("POST", "/education/messages", tA, { body: "Bonjour", recipient_user_id: B.parent.id }));
    horsEtablissement("message sur un élève de B", await appel("POST", "/education/messages", tA, { body: "Bonjour", student_id: B.eleve.id }));
    horsEtablissement("annonce à une classe de B", await appel("POST", "/education/messages", tA, { body: "Bonjour", class_id: B.classe.id, is_announcement: true }));
    horsEtablissement("incident de conduite sur un élève de B", await appel("POST", "/education/conduct", tA, { student_id: B.eleve.id, conduct_type: "retard", description: "X" }));
    horsEtablissement("année active de l'établissement = année de B", await appel("PUT", "/education/etablissement", tA, { active_school_year_id: B.annee.id }));
    horsEtablissement("génération de bulletins pour une classe de B", await appel("POST", "/education/report-cards/generate", tA, { term_id: A.periode.id, class_id: B.classe.id }));
    const invalide = await appel("POST", "/education/classes", tA, { name: "X", school_year_id: "1 OR 1=1" });
    verifier("identifiant non numérique : 400", invalide.status === 400 && invalide.data?.code === "REFERENCE_INVALIDE");
  }

  section("LOTS : UN SEUL IDENTIFIANT ÉTRANGER REJETTE TOUT LE LOT");
  {
    await q(`DELETE FROM edu_attendance WHERE student_id=$1`, [A.eleve.id]);
    const appelMixte = await appel("POST", "/education/attendance/roll-call", tA, {
      class_id: A.classe.id, entries: [{ student_id: A.eleve.id, status: "absent" }, { student_id: B.eleve.id, status: "absent" }],
    });
    horsEtablissement("appel contenant un élève de B : rejeté", appelMixte);
    const presences = await q(`SELECT COUNT(*)::int AS n FROM edu_attendance WHERE student_id=$1`, [A.eleve.id]);
    verifier("…et rien n'a été enregistré pour l'élève de A", presences[0].n === 0);

    const avant = await q(`SELECT score FROM edu_grades WHERE exam_id=$1 AND student_id=$2`, [A.examen.id, A.eleve.id]);
    const notesMixtes = await appel("POST", `/education/exams/${A.examen.id}/grades`, tA, {
      grades: [{ student_id: A.eleve.id, score: 3 }, { student_id: B.eleve.id, score: 3 }],
    });
    horsEtablissement("saisie de notes contenant un élève de B : rejetée", notesMixtes);
    const apres = await q(`SELECT score FROM edu_grades WHERE exam_id=$1 AND student_id=$2`, [A.examen.id, A.eleve.id]);
    verifier("…et la note de l'élève de A n'a pas bougé", Number(apres[0].score) === Number(avant[0].score));

    // Élève de A dans une autre classe de A : le devoir de la classe 6e A ne lui est pas destiné.
    const autre = (await appel("POST", "/education/inscriptions", tA, {
      eleve: { first_name: "Ousmane", last_name: "Sidibé" }, inscription: { school_year_id: A.annee.id, class_id: A.classe2.id },
    })).data;
    const horsClasse = await appel("POST", `/education/assignments/${A.devoir.id}/submissions`, tA, { student_id: autre.eleve.id });
    verifier("rendu d'un élève qui n'est pas dans la classe du devoir : refusé", horsClasse.status === 422 && horsClasse.data?.code === "ELEVE_HORS_CLASSE", JSON.stringify(horsClasse.data));
    const appelHorsClasse = await appel("POST", "/education/attendance/roll-call", tA, { class_id: A.classe.id, entries: [{ student_id: autre.eleve.id }] });
    verifier("appel d'un élève d'une autre classe de A : refusé", appelHorsClasse.status === 422);
    const notesHorsClasse = await appel("POST", `/education/exams/${A.examen.id}/grades`, tA, { grades: [{ student_id: autre.eleve.id, score: 10 }] });
    verifier("note d'un élève hors de la classe de l'évaluation : refusée", notesHorsClasse.status === 422);
  }

  section("CAS POSITIFS : A TRAVAILLE NORMALEMENT AVEC SES PROPRES DONNÉES");
  {
    const lu = await appel("GET", `/education/students/${A.eleve.id}/dossier`, tA);
    verifier("A lit son élève", lu.status === 200 && lu.data?.eleve?.id === A.eleve.id);
    const maj = await appel("PATCH", `/education/students/${A.eleve.id}`, tA, { birth_place: "Tombouctou" });
    verifier("A modifie son élève", maj.status === 200, JSON.stringify(maj.data).slice(0, 160));
    verifier("A a inscrit son élève dans sa classe et son année",
      A.dossier.inscription?.class_id === A.classe.id && A.dossier.inscription?.school_year_id === A.annee.id);
    const aff = await appel("POST", "/education/teacher-assignments", tA, {
      teacher_id: A.prof.id, class_id: A.classe2.id, subject_id: A.matiere.id, school_year_id: A.annee.id, term_id: A.periode.id,
    });
    verifier("A affecte son professeur à sa classe/matière/année/période", aff.status === 201, JSON.stringify(aff.data).slice(0, 160));
    const ap = await appel("POST", "/education/attendance/roll-call", tA, { class_id: A.classe.id, entries: [{ student_id: A.eleve.id, status: "retard" }] });
    verifier("A fait l'appel de sa classe", ap.status === 200 && ap.data?.count === 1);
    const ex = await appel("POST", "/education/exams", tA, { term_id: A.periode.id, class_id: A.classe.id, subject_id: A.matiere.id, title: "Devoir 2" });
    const notes = await appel("POST", `/education/exams/${ex.data?.id}/grades`, tA, { grades: [{ student_id: A.eleve.id, score: 16 }] });
    verifier("A crée une évaluation et saisit les notes de sa classe", ex.status === 201 && notes.status === 200 && notes.data?.count === 1);
    const enc = await appel("POST", `/education/fee-plans/${A.dossier.echeancier.id}/payments`, tA, { amount: 1000, installment_id: A.echeances[1].id, method: "wave" });
    const recu = await appel("GET", `/education/fee-payments/${enc.data?.payment?.id || enc.data?.id}/receipt`, tA);
    verifier("A encaisse sur son échéancier et produit le reçu", enc.status === 201 && recu.status === 200, `${enc.status} ${recu.status} ${JSON.stringify(enc.data).slice(0, 160)}`);
    const pdf = await appel("GET", `/education/fee-plans/${A.dossier.echeancier.id}/schedule/pdf`, tA);
    verifier("A produit l'échéancier PDF", pdf.status === 200);
    const hor = await appel("PATCH", `/education/schedules/${A.horaire.id}`, tA, { room: "Salle 3" });
    const co = await appel("PATCH", `/education/courses/${A.cours.id}`, tA, { title: "Fractions (suite)" });
    verifier("A modifie son horaire et son cours", hor.status === 200 && co.status === 200, `${hor.status} ${co.status}`);
    const note = await appel("PATCH", `/education/submissions/${A.rendu.id}/grade`, tA, { score: 15 });
    verifier("A note le rendu de son élève", note.status === 200, JSON.stringify(note.data).slice(0, 160));
    const etab = await appel("PUT", "/education/etablissement", tA, { active_school_year_id: A.annee.id });
    verifier("A choisit son année active", etab.status === 200 && etab.data?.active_school_year_id === A.annee.id);
    const tProfA = jeton(A.profUser);
    const vuProf = await appel("GET", `/education/students/${B.eleve.id}/dossier`, tProfA);
    refuse("le professeur de A ne lit pas un élève de B", vuProf);
  }

  section("INVARIANT : AUCUNE LIGNE NE RELIE DEUX ÉCOLES");
  {
    const paires = [
      ["edu_classes", "school_year_id", "edu_school_years"], ["edu_classes", "main_teacher_user_id", "users"],
      ["edu_terms", "school_year_id", "edu_school_years"], ["edu_teachers", "user_id", "users"], ["edu_teachers", "school_year_id", "edu_school_years"],
      ["edu_students", "class_id", "edu_classes"], ["edu_enrollments", "student_id", "edu_students"], ["edu_enrollments", "class_id", "edu_classes"],
      ["edu_enrollments", "school_year_id", "edu_school_years"], ["edu_feeplans", "student_id", "edu_students"], ["edu_feeplans", "class_id", "edu_classes"],
      ["edu_feeplan_payments", "installment_id", "edu_feeplan_installments"], ["edu_feeplan_payments", "plan_id", "edu_feeplans"],
      ["edu_teacher_assignments", "teacher_id", "edu_teachers"], ["edu_teacher_assignments", "class_id", "edu_classes"],
      ["edu_teacher_assignments", "subject_id", "edu_subjects"], ["edu_teacher_assignments", "term_id", "edu_terms"],
      ["edu_schedules", "assignment_id", "edu_teacher_assignments"], ["edu_schedules", "teacher_id", "edu_teachers"],
      ["edu_schedules", "class_id", "edu_classes"], ["edu_schedules", "subject_id", "edu_subjects"], ["edu_exams", "class_id", "edu_classes"],
      ["edu_exams", "subject_id", "edu_subjects"], ["edu_exams", "term_id", "edu_terms"], ["edu_fees", "class_id", "edu_classes"],
      ["edu_fee_payments", "fee_id", "edu_fees"], ["edu_fee_payments", "student_id", "edu_students"], ["edu_courses", "class_id", "edu_classes"],
      ["edu_courses", "subject_id", "edu_subjects"], ["edu_messages", "recipient_user_id", "users"], ["edu_messages", "student_id", "edu_students"],
      ["edu_messages", "class_id", "edu_classes"], ["edu_attendance", "student_id", "edu_students"], ["edu_conduct", "student_id", "edu_students"],
      ["edu_assignment_submissions", "student_id", "edu_students"], ["edu_assignment_submissions", "course_id", "edu_courses"],
      ["edu_report_cards", "student_id", "edu_students"], ["edu_report_cards", "term_id", "edu_terms"],
    ];
    const fuites = [];
    for (const [t, col, cible] of paires) {
      const r = await q(`SELECT COUNT(*)::int AS n FROM ${t} x JOIN ${cible} c ON c.id = x.${col}
                          WHERE x.company_id IN ($1,$2) AND c.company_id IS DISTINCT FROM x.company_id`, [A.id, B.id]);
      if (r[0].n) fuites.push(`${t}.${col}:${r[0].n}`);
    }
    const parents = await q(`SELECT COUNT(*)::int AS n FROM edu_student_parents sp JOIN edu_students s ON s.id=sp.student_id
                              JOIN users u ON u.id=sp.parent_user_id WHERE s.company_id IN ($1,$2) AND u.company_id IS DISTINCT FROM s.company_id`, [A.id, B.id]);
    if (parents[0].n) fuites.push(`edu_student_parents:${parents[0].n}`);
    const notes = await q(`SELECT COUNT(*)::int AS n FROM edu_grades g JOIN edu_exams e ON e.id=g.exam_id JOIN edu_students s ON s.id=g.student_id
                            WHERE e.company_id IN ($1,$2) AND s.company_id <> e.company_id`, [A.id, B.id]);
    if (notes[0].n) fuites.push(`edu_grades:${notes[0].n}`);
    verifier(`${paires.length + 2} relations contrôlées : aucune ne traverse deux écoles`, fuites.length === 0, fuites.join(", "));
  }

  await terminer();
}

main().catch(async (e) => { console.error(e); await terminer(); });
