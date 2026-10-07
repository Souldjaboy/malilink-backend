"use strict";

/**
 * MaliLink Éducation — documents : cartes scolaires (6 modèles, recto-verso,
 * planche A4, portrait), bulletins (6 modèles, rang ex aequo, statistiques de
 * classe, QR de vérification), changement d'année, isolation entre écoles.
 *
 *   scripts/test-integration.sh tests/education-documents.test.js
 */

const QRCode = require("qrcode");
const { q, appel, jeton, verifier, section, creerSociete, terminer, BASE } = require("./_outils");

const CARTES = ["academique", "moderne", "premium", "minimaliste", "institutionnel", "creatif"];
const BULLETINS = ["institutionnel", "academique", "moderne", "premium", "compact", "elegant"];

async function brut(chemin, token) {
  const r = await fetch(`${BASE}${chemin}`, { headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "x-tenant-id": "malilink" } });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, type: r.headers.get("content-type") || "", buf, texte: buf.toString("latin1") };
}
const pages = (pdf) => (pdf.texte.match(/\/Type\s*\/Page[^s]/g) || []).length;
const estPdf = (r) => r.status === 200 && r.type.includes("application/pdf") && r.texte.startsWith("%PDF");

async function envoyerImage(chemin, token, buf, nom, type) {
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type }), nom);
  const r = await fetch(`${BASE}${chemin}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "x-tenant-id": "malilink" }, body: fd });
  return { status: r.status, data: await r.json().catch(() => null) };
}

async function preparerEcole(nom, prefixe) {
  const e = await creerSociete({ nom, type: "ecole", modules: { education: true } });
  const t = e.token;
  const annee = (await appel("POST", "/education/school-years", t, { label: "2026-2027", start_date: "2026-10-01", end_date: "2027-07-15", is_active: true })).data;
  const periode = (await appel("POST", "/education/terms", t, { school_year_id: annee.id, label: "Trimestre 1", term_order: 1, start_date: "2026-10-01", end_date: "2026-12-20" })).data;
  const classe = (await appel("POST", "/education/classes", t, { name: "CM2 A", level: "CM2", school_year_id: annee.id })).data;
  await appel("PUT", "/education/etablissement", t, { official_name: `${nom}`, short_name: prefixe, matricule_prefix: prefixe, active_school_year_id: annee.id, slogan: "Savoir et discipline", phone: "+223 20 00 00 00" });
  return { ...e, annee, periode, classe };
}

async function main() {
  const a = await preparerEcole("École Fily Dabo Sissoko", "EFD");
  const b = await preparerEcole("Complexe Scolaire Niger", "CSN");
  const png = await QRCode.toBuffer("logo-ecole", { width: 240 });

  section("IDENTITÉ UNIQUE : LOGO, SCEAU, SIGNATURE, CACHET");
  {
    for (const n of ["logo", "sceau", "signature", "cachet"]) {
      const r = await envoyerImage(`/education/etablissement/fichiers/${n}`, a.token, png, `${n}.png`, "image/png");
      verifier(`${n} enregistré une fois (PNG)`, r.status === 201);
    }
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(32)]);
    const refus = await envoyerImage("/education/etablissement/fichiers/logo", a.token, webp, "logo.webp", "image/webp");
    verifier("WebP refusé (imprimé sur les PDF : JPEG ou PNG seulement)", refus.status === 415);
  }

  const eleves = [];
  section("CARTE : PDF RECTO-VERSO, PLANCHE A4, SIX MODÈLES, PORTRAIT");
  {
    for (const [prenom, nom] of [["Mariam", "Diallo"], ["Seydou", "Keïta"], ["Fatoumata", "Bâ"]]) {
      const r = await appel("POST", "/education/inscriptions", a.token, {
        eleve: { first_name: prenom, last_name: nom, gender: prenom === "Seydou" ? "M" : "F", guardian_name: "Tuteur", guardian_phone: "+223 70 00 00 00" },
        inscription: { school_year_id: a.annee.id, class_id: a.classe.id }, frais: { inscription: 10000, mois: 0 },
      });
      eleves.push(r.data);
      await envoyerImage(`/education/students/${r.data.eleve.id}/photo`, a.token, png, "photo.png", "image/png");
    }
    const id = eleves[0].eleve.id;
    const pdf = await brut(`/education/students/${id}/carte/pdf`, a.token);
    verifier("carte PDF : 2 pages (recto + verso) au format carte", estPdf(pdf) && pages(pdf) === 2, `${pdf.status} ${pdf.type} ${pages(pdf)}`);
    const planche = await brut(`/education/students/${id}/carte/pdf?format=planche`, a.token);
    verifier("planche A4 : recto puis verso", estPdf(planche) && pages(planche) === 2 && /MediaBox \[0 0 595\.28 841\.89\]/.test(planche.texte));
    const classe = await brut(`/education/classes/${a.classe.id}/cartes/pdf`, a.token);
    verifier("cartes de toute la classe sur une planche", estPdf(classe) && pages(classe) === 2);
    let tous = true;
    for (const m of CARTES) {
      const r = await brut(`/education/students/${id}/carte/pdf?modele=${m}`, a.token);
      const recto = await brut(`/education/students/${id}/carte/apercu?modele=${m}`, a.token);
      const verso = await brut(`/education/students/${id}/carte/apercu?modele=${m}&face=verso`, a.token);
      if (!estPdf(r) || !recto.texte.startsWith("<svg") || !verso.texte.startsWith("<svg") || recto.texte === verso.texte) { tous = false; console.log("   modèle en échec :", m, r.status, recto.status); }
    }
    verifier("les six modèles produisent PDF et aperçus recto/verso", tous);
    const signatures = new Set();
    for (const m of CARTES) signatures.add((await brut(`/cartes/apercu?modele=${m}`.replace(/^/, "/education"), a.token)).texte.replace(/d[a-z0-9]{6}-\d+/g, "").length);
    verifier("six rendus réellement différents", signatures.size === 6, [...signatures].join(","));
    const apercu = await brut("/education/cartes/apercu?modele=premium&couleur_principale=%23123456&afficher_photo=0", a.token);
    verifier("aperçu des paramètres : couleur appliquée, sans script", apercu.type.includes("image/svg+xml") && apercu.texte.includes("#123456") && !/<script/i.test(apercu.texte));
    await appel("PUT", "/education/etablissement", a.token, { card_template: "creatif", card_options: { orientation: "portrait" } });
    const portrait = await brut(`/education/students/${id}/carte/apercu`, a.token);
    verifier("orientation portrait enregistrée et appliquée", /viewBox="0 0 153\.07 242\.65"/.test(portrait.texte), portrait.texte.slice(0, 120));
    const etab = (await appel("GET", "/education/etablissement", a.token)).data;
    verifier("le modèle choisi est mémorisé", etab.card_template === "creatif" && etab.card_options.orientation === "portrait");
  }

  section("ACCÈS AUX CARTES : FAMILLE, AUTRE ÉCOLE");
  {
    const id = eleves[0].eleve.id;
    const parent = (await q(`INSERT INTO users (fullname, email, password, role, company_id) VALUES ('P','pd-${a.id}@x.test','x','parent',$1) RETURNING id, role, company_id`, [a.id]))[0];
    await q(`INSERT INTO edu_student_parents (student_id, parent_user_id, relation) VALUES ($1,$2,'mere')`, [id, parent.id]);
    const tp = jeton(parent);
    verifier("le parent télécharge la carte de son enfant", estPdf(await brut(`/education/students/${id}/carte/pdf`, tp)));
    verifier("…pas celle d'un autre enfant", (await brut(`/education/students/${eleves[1].eleve.id}/carte/pdf`, tp)).status === 404);
    verifier("…ni la planche de la classe", (await brut(`/education/classes/${a.classe.id}/cartes/pdf`, tp)).status === 403);
    verifier("une autre école n'obtient ni la carte ni son aperçu", (await brut(`/education/students/${id}/carte/pdf`, b.token)).status === 404
      && (await brut(`/education/students/${id}/carte/apercu`, b.token)).status === 404);
    verifier("ni la planche de la classe d'une autre école", (await brut(`/education/classes/${a.classe.id}/cartes/pdf`, b.token)).status === 404);
  }

  let bulletins;
  section("BULLETINS : RANG EX AEQUO, MOYENNE DE CLASSE, ASSIDUITÉ DE LA PÉRIODE");
  {
    const t = a.token;
    const maths = (await appel("POST", "/education/subjects", t, { name: "Mathématiques", coefficient: 4 })).data;
    const fr = (await appel("POST", "/education/subjects", t, { name: "Français", coefficient: 3 })).data;
    const ex1 = (await appel("POST", "/education/exams", t, { term_id: a.periode.id, class_id: a.classe.id, subject_id: maths.id, title: "Composition", max_score: 20 })).data;
    const ex2 = (await appel("POST", "/education/exams", t, { term_id: a.periode.id, class_id: a.classe.id, subject_id: fr.id, title: "Dictée", max_score: 20 })).data;
    const [e1, e2, e3] = eleves.map((x) => x.eleve.id);
    await appel("POST", `/education/exams/${ex1.id}/grades`, t, { grades: [{ student_id: e1, score: 15 }, { student_id: e2, score: 15 }, { student_id: e3, score: 9 }] });
    await appel("POST", `/education/exams/${ex2.id}/grades`, t, { grades: [{ student_id: e1, score: 12 }, { student_id: e2, score: 12 }, { student_id: e3, score: 10 }] });
    await q(`INSERT INTO edu_attendance (company_id, student_id, class_id, attendance_date, status, source) VALUES
      ($1,$2,$3,'2026-11-10','absent','appel'), ($1,$2,$3,'2026-11-12','retard','appel'), ($1,$2,$3,'2027-02-01','absent','appel')`, [a.id, e1, a.classe.id]);
    const g = await appel("POST", "/education/report-cards/generate", t, { term_id: a.periode.id, class_id: a.classe.id });
    verifier("génération : 3 bulletins", g.status === 200 && g.data.generated === 3, JSON.stringify(g.data));
    bulletins = await q(`SELECT * FROM edu_report_cards WHERE company_id=$1 AND term_id=$2 ORDER BY student_id`, [a.id, a.periode.id]);
    verifier("ex aequo : même rang (1er et 1er), le suivant est 3e", bulletins[0].rank_in_class === 1 && bulletins[1].rank_in_class === 1 && bulletins[2].rank_in_class === 3,
      bulletins.map((r) => r.rank_in_class).join(","));
    verifier("moyenne de classe et statistiques par matière enregistrées", Number(bulletins[0].class_average) > 0 && bulletins[0].class_stats?.matieres?.[maths.id]?.max === 15
      && bulletins[0].class_label === "CM2 A");
    verifier("absences et retards comptés sur la période seulement", bulletins[0].absences_count === 1 && bulletins[0].late_count === 1,
      `${bulletins[0].absences_count}/${bulletins[0].late_count}`);
    const jetons = await q(`SELECT report_card_id, token, reference FROM edu_document_verifications WHERE doc_type='bulletin' AND company_id=$1 ORDER BY report_card_id`, [a.id]);
    verifier("chaque bulletin a son jeton et sa référence", jetons.length === 3 && /^EFD-B\d{4}-0000\d$/.test(jetons[0].reference));
    await appel("POST", "/education/report-cards/generate", t, { term_id: a.periode.id, class_id: a.classe.id });
    const apres = await q(`SELECT token FROM edu_document_verifications WHERE doc_type='bulletin' AND company_id=$1 AND status='valide' ORDER BY report_card_id`, [a.id]);
    verifier("régénérer garde le même QR (jetons inchangés)", apres.length === 3 && apres.every((x, i) => x.token === jetons[i].token));
    await appel("PATCH", `/education/report-cards/${bulletins[0].id}`, t, { appreciation: "Très bon trimestre.", council_decision: "Félicitations" });

    const pdf = await brut(`/education/report-cards/${bulletins[0].id}/pdf`, t);
    verifier("bulletin PDF A4", estPdf(pdf) && pages(pdf) === 1);
    let ok = true;
    for (const m of BULLETINS) {
      if (!estPdf(await brut(`/education/report-cards/${bulletins[0].id}/pdf?modele=${m}`, t))) ok = false;
      const sv = await brut(`/education/bulletins/apercu?modele=${m}`, t);
      if (!sv.texte.startsWith("<svg") || /<script/i.test(sv.texte)) ok = false;
    }
    verifier("les six modèles de bulletin produisent PDF et aperçu", ok);
    const classe = await brut(`/education/classes/${a.classe.id}/report-cards/pdf?term_id=${a.periode.id}`, t);
    verifier("bulletins de toute la classe : une page par élève", estPdf(classe) && pages(classe) === 3);
    await appel("PUT", "/education/etablissement", t, { report_template: "elegant", report_options: { afficher_rang: false, afficher_photo: true } });
    const etab = (await appel("GET", "/education/etablissement", t)).data;
    verifier("modèle et options de bulletin mémorisés", etab.report_template === "elegant" && etab.report_options.afficher_rang === false && etab.report_options.afficher_photo === true);

    const v = await fetch(`${BASE}/verification/${jetons[0].token}`).then((r) => r.json());
    const brutV = JSON.stringify(v);
    verifier("QR du bulletin : authentique, type, période, classe", v.authentique === true && v.type_libelle === "Bulletin de notes" && v.periode === "Trimestre 1" && v.classe === "CM2 A");
    verifier("…sans note, moyenne, rang ni appréciation", !/15|12|13,|Très bon|Félicitations|rang|moyenne/i.test(brutV.replace(/Trimestre 1|2026-2027|EFD-B\d{4}-\d+/g, "")), brutV);

    const parent = (await q(`SELECT parent_user_id FROM edu_student_parents WHERE student_id=$1`, [e1]))[0];
    const tp = jeton({ id: parent.parent_user_id, role: "parent", company_id: a.id });
    verifier("le parent ouvre le bulletin de son enfant", estPdf(await brut(`/education/report-cards/${bulletins[0].id}/pdf`, tp)));
    verifier("…pas celui d'un autre élève", (await brut(`/education/report-cards/${bulletins[1].id}/pdf`, tp)).status === 404);
    verifier("une autre école n'ouvre aucun bulletin de A", (await brut(`/education/report-cards/${bulletins[0].id}/pdf`, b.token)).status === 404
      && (await brut(`/education/classes/${a.classe.id}/report-cards/pdf?term_id=${a.periode.id}`, b.token)).status === 404);
  }

  section("CHANGEMENT D'ANNÉE SCOLAIRE");
  {
    const t = a.token;
    const id = eleves[0].eleve.id;
    const carteAvant = (await q(`SELECT token, school_year_label FROM edu_document_verifications WHERE student_id=$1 AND doc_type='carte' AND status='valide'`, [id]))[0];
    const an2 = (await appel("POST", "/education/school-years", t, { label: "2027-2028", start_date: "2027-10-01", end_date: "2028-07-15" })).data;
    const sixieme = (await appel("POST", "/education/classes", t, { name: "6e A", level: "6e", school_year_id: an2.id })).data;
    await appel("PUT", "/education/etablissement", t, { active_school_year_id: an2.id });
    const r = await appel("POST", "/education/inscriptions", t, { eleve_id: id, inscription: { school_year_id: an2.id, class_id: sixieme.id }, frais: { inscription: 12000, mois: 0 } });
    verifier("réinscription dans l'année suivante", r.status === 201 && r.data.eleve.matricule === eleves[0].eleve.matricule, JSON.stringify(r.data).slice(0, 160));
    const tok2 = (r.data.carte?.verification_url || "").split("/").pop();
    const v2 = await fetch(`${BASE}/verification/${tok2}`).then((x) => x.json());
    verifier("nouvelle carte pour 2027-2028, classe 6e A", v2.annee_scolaire === "2027-2028" && v2.classe === "6e A" && tok2 !== carteAvant.token);
    await q(`UPDATE edu_document_verifications SET valid_until=CURRENT_DATE - 1 WHERE token=$1`, [carteAvant.token]);
    const v1 = await fetch(`${BASE}/verification/${carteAvant.token}`).then((x) => x.json());
    verifier("la carte de l'année passée apparaît « expirée » après sa date", v1.statut === "expire");
    const doublon = await appel("POST", "/education/inscriptions", t, { eleve_id: id, inscription: { school_year_id: an2.id, class_id: sixieme.id } });
    verifier("pas de seconde inscription la même année", doublon.status === 409);
    const etab = (await appel("GET", "/education/etablissement", t)).data;
    verifier("l'année active a changé", etab.active_school_year_id === an2.id && etab.active_year_label === "2027-2028");
  }

  await terminer();
}

main().catch(async (e) => { console.error(e); await terminer(); });
