"use strict";

/**
 * MaliLink Academy de bout en bout sur le vrai serveur et PostgreSQL :
 * choix de l'école par le Super Admin, activation/désactivation pour cette
 * école, accès de l'administrateur, élève limité à son école et à sa classe,
 * parcours, leçons, quiz (correction serveur) et progression.
 *
 *   scripts/test-integration.sh tests/academy.test.js
 */

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { q, verifier, section, creerSociete, terminer, BASE } = require("./_outils");

const MDP = "Ecole-2026-ok";
const HACHE = bcrypt.hashSync(MDP, 4);
const alea = () => crypto.randomBytes(3).toString("hex");

async function brut(methode, chemin, { token, corps, entetes = {} } = {}) {
  const r = await fetch(`${BASE}${chemin}`, {
    method: methode,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...entetes },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch { /* vide */ }
  return { status: r.status, data };
}
async function connexion(email, mdp = MDP) {
  const r = await brut("POST", "/login", { corps: { email, password: mdp } });
  if (r.status !== 200) throw new Error(`connexion ${email} : ${r.status} ${JSON.stringify(r.data)}`);
  return r.data.token;
}
async function utilisateur(nom, companyId, role) {
  return (await q(
    `INSERT INTO users (fullname, email, password, role, company_id, is_active, email_verified, account_status, verification_required)
     VALUES ($1,$2,$3,$4,$5,true,true,'active',false) RETURNING id, email`,
    [nom, `${nom.toLowerCase().replace(/\W/g, "")}-${alea()}@essai.test`, HACHE, role, companyId]))[0];
}
async function ecole(nom, espace = "malilink") {
  let id;
  if (espace === "malilink") id = (await creerSociete({ nom, type: "ecole", modules: { education: true } })).id;
  else id = (await q(`INSERT INTO companies (name, business_type, status, subscription_status, tenant_id) VALUES ($1,'ecole','active','active',$2) RETURNING id`, [nom, espace]))[0].id;
  await q(`UPDATE companies SET email_verified=true, account_status='active' WHERE id=$1`, [id]);
  return id;
}
async function classe(companyId, nom) {
  return (await q(`INSERT INTO edu_classes (company_id, name) VALUES ($1,$2) RETURNING id`, [companyId, nom]))[0].id;
}
async function eleve(companyId, classId, userId, prenom) {
  return (await q(
    `INSERT INTO edu_students (company_id, user_id, matricule, qr_code, first_name, last_name, class_id, status)
     VALUES ($1,$2,$3,$4,$5,'Essai',$6,'actif') RETURNING id`,
    [companyId, userId, `MAT-${alea()}`, `QR-${alea()}`, prenom, classId]))[0].id;
}
async function lecon(companyId, classId, titre, texte) {
  return (await q(`INSERT INTO edu_courses (company_id, class_id, title, content, is_published) VALUES ($1,$2,$3,$4,true) RETURNING id`,
    [companyId, classId, titre, texte]))[0].id;
}
const academy = (token, companyId, actif) => brut("PUT", `/super-admin/companies/${companyId}/modules`, { token, corps: { modules: { "education.learning": actif } } });

async function main() {
  const A = await ecole("École A (Academy)");
  const B = await ecole("École B (même espace)");
  const C = await ecole("École C (autre espace)", "hafiya");
  const a1 = await classe(A, "6ème A");
  const a2 = await classe(A, "6ème B");
  const b1 = await classe(B, "CM2");
  const l1 = await lecon(A, a1, "Leçon 1 — se présenter", "Bonjour, je m'appelle…");
  const l2 = await lecon(A, a1, "Leçon 2 — dialoguer", "Comment vas-tu ?");
  const lAutreClasse = await lecon(A, a2, "Leçon de la classe B", "Réservé à la 6ème B");
  const lAutreEcole = await lecon(B, b1, "Leçon de l'école B", "Ne doit pas fuiter");

  const directeur = await utilisateur("Directeur A", A, "admin");
  const uS1 = await utilisateur("Élève A1", A, "student");
  const uS2 = await utilisateur("Élève A2", A, "student");
  const uS3 = await utilisateur("Élève B1", B, "student");
  const s1 = await eleve(A, a1, uS1.id, "Awa");
  await eleve(A, a2, uS2.id, "Bakary");
  await eleve(B, b1, uS3.id, "Coumba");
  const sansCompte = await eleve(A, a1, null, "Djeneba");
  // Comme en production, le Super Admin a sa propre société dans l'espace
  // (le service Academy l'exige pour choisir une école).
  const plateforme = await ecole("Plateforme MaliLink");
  const sa = (await q(`INSERT INTO users (fullname, email, password, role, company_id, is_super_admin, is_active, email_verified, account_status, verification_required)
     VALUES ('Super Admin Academy', $1, $2, 'super_admin', $3, true, true, true, 'active', false) RETURNING id, email`, [`sa-academy-${alea()}@essai.test`, HACHE, plateforme]))[0];

  const tSA = await connexion(sa.email);
  const tDir = await connexion(directeur.email);

  section("1. ACTIVATION PAR LE SUPER ADMIN, ÉCOLE PAR ÉCOLE");
  verifier("Academy désactivée par défaut : l'administrateur de l'école est refusé", (await brut("GET", "/education/learning/programs", { token: tDir })).status === 403);
  const choixA = await brut("GET", "/education/learning/programs", { token: tSA, entetes: { "x-active-company-id": String(A) } });
  verifier("Super Admin + école A choisie, Academy inactive : refusé (activation requise)", choixA.status === 403);
  verifier("Super Admin active Academy pour l'école A", (await academy(tSA, A, true)).status === 200);
  const choixA2 = await brut("GET", "/education/learning/programs", { token: tSA, entetes: { "x-active-company-id": String(A) } });
  verifier("Super Admin dans le contexte de l'école A choisie : catalogue de A", choixA2.status === 200 && choixA2.data?.staff === true, JSON.stringify(choixA2.data).slice(0, 200));
  verifier("Super Admin et école d'un autre espace : refusé (SOCIETE_HORS_ESPACE)",
    (await brut("GET", "/education/learning/programs", { token: tSA, entetes: { "x-active-company-id": String(C) } })).data?.code === "SOCIETE_HORS_ESPACE");
  verifier("activer Academy pour une école d'un autre espace : introuvable", (await academy(tSA, C, true)).status === 404
    && (await q(`SELECT 1 FROM company_modules WHERE company_id=$1 AND module_key='education.learning' AND enabled=true`, [C])).length === 0);
  verifier("école B (non activée) : toujours refusée", (await brut("GET", "/education/learning/programs", { token: tSA, entetes: { "x-active-company-id": String(B) } })).status === 403);

  section("2. ADMINISTRATEUR DE L'ÉCOLE : PARCOURS, LEÇONS, QUIZ");
  const contenu = (units) => ({ title: "Anglais 6ème", class_id: a1, max_attempts: 3,
    units: units.map((course_id) => ({ course_id, questions: [{ prompt: "« Bonjour » en anglais ?", choices: ["Hello", "Bye"], answer: 0, explanation: "Hello = bonjour." }] })) });
  verifier("administrateur : accès au catalogue de son école", (await brut("GET", "/education/learning/programs", { token: tDir })).status === 200);
  verifier("leçon d'une autre classe dans le parcours : refusée", (await brut("POST", "/education/learning/programs", { token: tDir, corps: contenu([l1, lAutreClasse]) })).status >= 400);
  verifier("leçon d'une autre école : refusée", (await brut("POST", "/education/learning/programs", { token: tDir, corps: contenu([l1, lAutreEcole]) })).status >= 400);
  const cree = await brut("POST", "/education/learning/programs", { token: tDir, corps: contenu([l1, l2]) });
  const programme = cree.data?.id;
  verifier("parcours créé (2 leçons, quiz)", cree.status < 300 && Boolean(programme), JSON.stringify(cree.data).slice(0, 200));
  verifier("parcours publié", (await brut("POST", `/education/learning/programs/${programme}/publish`, { token: tDir })).status < 300);
  const compte = await brut("POST", `/education/learning/students/${sansCompte}/account`, { token: tDir, corps: { email: `djeneba-${alea()}@essai.test`, password: MDP } });
  verifier("compte élève créé par l'école : changement de mot de passe imposé, aucun mot de passe renvoyé",
    compte.status < 300 && compte.data?.force_password_change === true && !JSON.stringify(compte.data).includes(MDP) && !/\$2[aby]\$/.test(JSON.stringify(compte.data)));

  section("3. ÉLÈVE : SON ÉCOLE, SA CLASSE, PROGRESSION");
  const tS1 = await connexion(uS1.email);
  const tS2 = await connexion(uS2.email);
  const catalogue = await brut("GET", "/education/learning/programs", { token: tS1 });
  verifier("élève de la classe : le parcours apparaît", catalogue.status === 200 && (catalogue.data?.programs || []).some((p) => p.id === programme), JSON.stringify(catalogue.data).slice(0, 200));
  const detail = await brut("GET", `/education/learning/programs/${programme}`, { token: tS1 });
  const u0 = detail.data?.units?.[0];
  verifier("leçon 1 lisible, réponses et corrections jamais envoyées, leçon 2 verrouillée",
    detail.status === 200 && u0?.lesson && !("answer" in (u0.questions?.[0] || {})) && !("explanation" in (u0.questions?.[0] || {})) && detail.data.units[1].locked === true);
  verifier("leçon 2 verrouillée : tentative refusée", (await brut("POST", `/education/learning/programs/${programme}/start`, { token: tS1, corps: { unit_index: 1 } })).status === 403);
  const t1 = await brut("POST", `/education/learning/programs/${programme}/start`, { token: tS1, corps: { unit_index: 0 } });
  const faux = await brut("POST", `/education/learning/attempts/${t1.data?.id}/submit`, { token: tS1, corps: { answers: [1], score: 100, passed: true } });
  verifier("quiz corrigé par le serveur (score envoyé par l'élève ignoré)", faux.status < 300 && faux.data?.score === 0 && faux.data?.passed === false);
  const t2 = await brut("POST", `/education/learning/programs/${programme}/start`, { token: tS1, corps: { unit_index: 0 } });
  const bon = await brut("POST", `/education/learning/attempts/${t2.data?.id}/submit`, { token: tS1, corps: { answers: [0] } });
  verifier("bonne réponse : leçon réussie", bon.status < 300 && bon.data?.passed === true);
  const apres = await brut("GET", `/education/learning/programs/${programme}`, { token: tS1 });
  verifier("progression : leçon 2 débloquée", apres.data?.units?.[1]?.locked === false);
  verifier("élève d'une autre classe : parcours absent du catalogue et accès refusé",
    !((await brut("GET", "/education/learning/programs", { token: tS2 })).data?.programs || []).some((p) => p.id === programme)
    && [403, 404].includes((await brut("GET", `/education/learning/programs/${programme}`, { token: tS2 })).status));
  verifier("un élève ne soumet pas la tentative d'un autre", (await brut("POST", `/education/learning/attempts/${t2.data?.id}/submit`, { token: tS2, corps: { answers: [0] } })).status === 403);
  await academy(tSA, B, true);
  const tS3 = await connexion(uS3.email);
  verifier("élève d'une autre école (Academy active chez elle) : parcours de A introuvable",
    (await brut("GET", `/education/learning/programs/${programme}`, { token: tS3 })).status === 404);
  verifier("rapport de progression : réservé à l'école", (await brut("GET", `/education/learning/programs/${programme}/report`, { token: tS1 })).status === 403
    && (await brut("GET", `/education/learning/programs/${programme}/report`, { token: tDir })).status === 200);

  section("4. DÉSACTIVATION RÉVERSIBLE");
  verifier("Super Admin désactive Academy pour l'école A", (await academy(tSA, A, false)).status === 200);
  verifier("désactivée : administrateur et élève refusés", (await brut("GET", "/education/learning/programs", { token: tDir })).status === 403
    && (await brut("GET", `/education/learning/programs/${programme}`, { token: tS1 })).status === 403);
  verifier("l'école B garde Academy", (await brut("GET", "/education/learning/programs", { token: tS3 })).status === 200);
  await academy(tSA, A, true);
  verifier("réactivée : la progression de l'élève est conservée", (await brut("GET", `/education/learning/programs/${programme}`, { token: tS1 })).data?.units?.[1]?.locked === false);
  verifier("aucune modification de l'espace B (hafiya)", (await q(`SELECT COUNT(*)::int AS n FROM company_modules WHERE company_id=$1`, [C]))[0].n === 0);
  await terminer();
}

main().catch(async (e) => { console.error(e); await terminer(); });
