"use strict";

/**
 * MaliLink Éducation — documents imprimables : cartes scolaires (6 modèles,
 * recto-verso, planche A4) et bulletins de notes (6 modèles, A4), avec
 * aperçus SVG pour les paramètres. Les identités (logo, sceau, signature,
 * cachet, couleurs) viennent une seule fois des paramètres d'établissement.
 *
 * Chaque route reste bornée à l'établissement (schoolId) ; un parent ne
 * reçoit que les documents de ses enfants (assertStudentAccess).
 */

const fs = require("fs");
const { cheminFichier } = require("./education-parcours");
const { MODELES: MODELES_CARTE, carteSvg, cartesPdf } = require("../services/education/cartes");
const { MODELES: MODELES_BULLETIN, bulletinSvg, bulletinsPdf, appreciationAuto } = require("../services/education/bulletins");

const deux = (n) => String(n).padStart(2, "0");
function jourFr(v) {
  if (!v) return "";
  if (v instanceof Date) return `${deux(v.getDate())}/${deux(v.getMonth() + 1)}/${v.getFullYear()}`;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}
const aujourdhuiFr = () => jourFr(new Date());

function lireFichier(type, cle) {
  const chemin = cheminFichier(type, cle);
  if (!chemin) return null;
  try { return fs.readFileSync(chemin); } catch { return null; }
}

const vrai = (v) => v === true || v === "1" || v === "true";
const hex = (v) => (/^#[0-9A-Fa-f]{6}$/.test(String(v || "")) ? String(v) : undefined);

/* Options enregistrées (afficher_*) → options de rendu, avec surcharge par
   la requête pour les aperçus des paramètres (rien n'est enregistré). */
function optionsCarte(enregistrees = {}, q = {}) {
  const val = (cle) => (q[cle] !== undefined ? vrai(q[cle]) : enregistrees[cle]);
  return {
    logo: val("afficher_logo") !== false,
    photo: val("afficher_photo") !== false,
    niveau: val("afficher_niveau") !== false,
    naissance: val("afficher_naissance") === true,
    signature: val("afficher_signature") !== false,
    slogan: val("afficher_slogan") !== false,
    orientation: (q.orientation || enregistrees.orientation) === "portrait" ? "portrait" : "paysage",
    couleur_principale: hex(q.couleur_principale) || hex(enregistrees.couleur_principale),
    couleur_secondaire: hex(q.couleur_secondaire) || hex(enregistrees.couleur_secondaire),
  };
}
function optionsBulletin(enregistrees = {}, q = {}) {
  const val = (cle) => (q[cle] !== undefined ? vrai(q[cle]) : enregistrees[cle]);
  return {
    logo: val("afficher_logo") !== false,
    photo: val("afficher_photo") === true,
    rang: val("afficher_rang") !== false,
    moyenne_classe: val("afficher_moyenne_classe") !== false,
    appreciations: val("afficher_appreciations") !== false,
    signature: val("afficher_signature") !== false,
    cachet: val("afficher_cachet") !== false,
    couleur_principale: hex(q.couleur_principale) || hex(enregistrees.couleur_principale),
    couleur_secondaire: hex(q.couleur_secondaire) || hex(enregistrees.couleur_secondaire),
  };
}

module.exports = function registerDocumentsRoutes(router, ctx) {
  const { pool, schoolId, requireRoles, STAFF_ROLES, GRADE_ROLES, assertStudentAccess, teacherClassIds, parcours } = ctx;

  /* Identité de l'établissement, fichiers compris, pour un document. */
  async function identite(cid) {
    const e = await parcours.etablissement(pool, cid);
    return {
      brut: e,
      ecole: {
        nom: e.official_name, nomCourt: e.short_name || e.official_name, slogan: e.slogan, adresse: e.address, ville: e.city,
        telephone: e.phone, whatsapp: e.whatsapp, email: e.email, site: e.website, directeur: e.director_name,
        logo: lireFichier("etablissement", e.logo_key), sceau: lireFichier("etablissement", e.seal_key),
        signature: lireFichier("etablissement", e.signature_key), cachet: lireFichier("etablissement", e.stamp_key),
      },
      couleurs: { principale: e.color_primary, secondaire: e.color_secondary },
    };
  }

  /* ------------------------------ Cartes ------------------------------ */
  async function eleveComplet(cid, id) {
    return (await pool.query(
      `SELECT s.*, c.name AS class_name, c.level AS class_level
         FROM edu_students s LEFT JOIN edu_classes c ON c.id=s.class_id AND c.company_id=s.company_id
        WHERE s.id=$1 AND s.company_id=$2`, [Number(id) || 0, cid])).rows[0] || null;
  }

  async function carteDe(req, eleve) {
    const cid = schoolId(req);
    let carte = await parcours.carteValide(cid, eleve.id);
    if (!carte && STAFF_ROLES.includes(req.eduRole) && !eleve.archived_at) {
      carte = await parcours.emettreCarte(pool, { companyId: cid, studentId: eleve.id, userId: req.user.id })
        .catch(async (e) => { if (e.code === "23505") return parcours.carteValide(cid, eleve.id); throw e; });
    }
    return carte;
  }

  function donneesCarte(req, id, eleve, carte, options) {
    return {
      ecole: id.ecole,
      couleurs: id.couleurs,
      eleve: {
        prenom: eleve.first_name, nom: eleve.last_name, matricule: eleve.matricule, classe: eleve.class_name || carte?.class_label || "",
        niveau: eleve.class_level || "", naissance: jourFr(eleve.birth_date), photo: lireFichier("eleve", eleve.photo_key),
      },
      carte: {
        numero: carte?.reference || "—", annee: carte?.school_year_label || id.brut.active_year_label || "",
        validite: jourFr(carte?.valid_until), url: carte ? parcours.urlVerification(req, carte.token) : `${parcours.publicBaseUrl(req)}/verifier`,
      },
      options,
    };
  }

  const modeleCarte = (q, enregistre) => (MODELES_CARTE[q] ? q : MODELES_CARTE[enregistre] ? enregistre : "academique");
  const modeleBulletin = (q, enregistre) => (MODELES_BULLETIN[q] ? q : MODELES_BULLETIN[enregistre] ? enregistre : "institutionnel");
  const enteteePdf = (res, nom) => {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${nom.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf"`);
    res.setHeader("Cache-Control", "private, no-store");
  };
  const envoyerSvg = (res, svg) => {
    res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'");
    res.send(svg);
  };

  router.get("/documents/modeles", (req, res) => {
    res.json({
      cartes: Object.entries(MODELES_CARTE).map(([code, libelle]) => ({ code, libelle })),
      bulletins: Object.entries(MODELES_BULLETIN).map(([code, libelle]) => ({ code, libelle })),
    });
  });

  // Carte d'un élève : PDF recto-verso (format carte) ou planche A4.
  router.get("/students/:id/carte/pdf", async (req, res) => {
    try {
      const cid = schoolId(req);
      if (!(await assertStudentAccess(req, req.params.id))) return res.status(404).json({ error: "Élève introuvable." });
      const eleve = await eleveComplet(cid, req.params.id);
      const carte = await carteDe(req, eleve);
      if (!carte) return res.status(404).json({ error: "Aucune carte valide pour cet élève." });
      const id = await identite(cid);
      const modele = STAFF_ROLES.includes(req.eduRole) ? modeleCarte(req.query.modele, id.brut.card_template) : modeleCarte(null, id.brut.card_template);
      enteteePdf(res, `carte-${eleve.matricule}`);
      cartesPdf(res, [donneesCarte(req, id, eleve, carte, optionsCarte(id.brut.card_options))], { modele, format: req.query.format === "planche" ? "planche" : "carte" });
    } catch (e) {
      console.error("ERREUR EDU CARTE PDF :", e.message);
      if (!res.headersSent) res.status(500).json({ error: "Erreur génération de la carte." });
    }
  });

  // Aperçu SVG d'une face de la carte d'un élève (données réelles).
  router.get("/students/:id/carte/apercu", async (req, res) => {
    try {
      const cid = schoolId(req);
      if (!(await assertStudentAccess(req, req.params.id))) return res.status(404).json({ error: "Élève introuvable." });
      const eleve = await eleveComplet(cid, req.params.id);
      const carte = await carteDe(req, eleve);
      const id = await identite(cid);
      const q = STAFF_ROLES.includes(req.eduRole) ? req.query : {};
      envoyerSvg(res, carteSvg(donneesCarte(req, id, eleve, carte, optionsCarte(id.brut.card_options, q)),
        modeleCarte(q.modele, id.brut.card_template), req.query.face === "verso" ? "verso" : "recto"));
    } catch (e) {
      console.error("ERREUR EDU CARTE APERCU :", e.message);
      res.status(500).json({ error: "Erreur aperçu de la carte." });
    }
  });

  // Cartes de toute une classe : planche A4 (par défaut) ou format carte.
  router.get("/classes/:id/cartes/pdf", requireRoles(STAFF_ROLES), async (req, res) => {
    try {
      const cid = schoolId(req);
      const classe = (await pool.query(`SELECT id, name FROM edu_classes WHERE id=$1 AND company_id=$2`, [Number(req.params.id) || 0, cid])).rows[0];
      if (!classe) return res.status(404).json({ error: "Classe introuvable." });
      const { rows: eleves } = await pool.query(
        `SELECT s.*, c.name AS class_name, c.level AS class_level FROM edu_students s
           JOIN edu_classes c ON c.id=s.class_id AND c.company_id=s.company_id
          WHERE s.company_id=$1 AND s.class_id=$2 AND s.archived_at IS NULL AND s.status='actif'
          ORDER BY s.last_name, s.first_name LIMIT 300`, [cid, classe.id]);
      if (!eleves.length) return res.status(404).json({ error: "Aucun élève actif dans cette classe." });
      const id = await identite(cid);
      const options = optionsCarte(id.brut.card_options);
      const liste = [];
      for (const e of eleves) liste.push(donneesCarte(req, id, e, await carteDe(req, e), options));
      enteteePdf(res, `cartes-${classe.name}`);
      cartesPdf(res, liste, { modele: modeleCarte(req.query.modele, id.brut.card_template), format: req.query.format === "carte" ? "carte" : "planche" });
    } catch (e) {
      console.error("ERREUR EDU CARTES CLASSE :", e.message);
      if (!res.headersSent) res.status(500).json({ error: "Erreur génération des cartes." });
    }
  });

  // Aperçu des paramètres (élève fictif, identité réelle de l'école).
  router.get("/cartes/apercu", requireRoles(STAFF_ROLES), async (req, res) => {
    try {
      const id = await identite(schoolId(req));
      const annee = id.brut.active_year_label || `${new Date().getFullYear()}-${new Date().getFullYear() + 1}`;
      const fin = `${new Date().getFullYear() + 1}-07-15`;
      const donnees = {
        ecole: id.ecole, couleurs: id.couleurs,
        eleve: { prenom: "Aminata", nom: "Traoré", matricule: `${id.brut.matricule_prefix || "ML"}-${new Date().getFullYear()}-0042`, classe: "6e A", niveau: "6e", naissance: "12/03/2014", photo: null },
        carte: { numero: `${(id.brut.short_name || "CS").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "CS"}-C${new Date().getFullYear()}-00042`, annee, validite: jourFr(fin), url: `${parcours.publicBaseUrl(req)}/verifier/exemple-de-jeton-aleatoire` },
        options: optionsCarte(id.brut.card_options, req.query),
      };
      envoyerSvg(res, carteSvg(donnees, modeleCarte(req.query.modele, id.brut.card_template), req.query.face === "verso" ? "verso" : "recto"));
    } catch (e) {
      console.error("ERREUR EDU APERCU CARTE :", e.message);
      res.status(500).json({ error: "Erreur aperçu." });
    }
  });

  /* ----------------------------- Bulletins ----------------------------- */
  async function donneesBulletin(req, id, rc) {
    const cid = schoolId(req);
    let details = [];
    try { details = Array.isArray(rc.details) ? rc.details : JSON.parse(rc.details || "[]"); } catch { details = []; }
    const stats = rc.class_stats?.matieres || {};
    const matieres = details.map((d) => {
      const moyenne = d.subject_average == null ? null : Number(d.subject_average);
      const coef = Number(d.coefficient) || 0;
      const st = stats[d.subject_id] || {};
      return {
        nom: d.subject_name, coef, moyenne, points: moyenne == null ? null : moyenne * coef,
        moyenne_classe: st.moyenne ?? null, min: st.min ?? null, max: st.max ?? null, appreciation: appreciationAuto(moyenne),
      };
    });
    const totalCoef = matieres.reduce((s, m) => s + (m.moyenne == null ? 0 : m.coef), 0);
    const totalPoints = matieres.reduce((s, m) => s + (m.points || 0), 0);
    const verif = (await pool.query(
      `SELECT token, reference FROM edu_document_verifications WHERE company_id=$1 AND report_card_id=$2 AND doc_type='bulletin' AND status='valide' LIMIT 1`,
      [cid, rc.id])).rows[0];
    return {
      ecole: id.ecole, couleurs: id.couleurs,
      eleve: {
        prenom: rc.first_name, nom: rc.last_name, matricule: rc.student_matricule, classe: rc.class_label || rc.current_class || "—",
        naissance: jourFr(rc.birth_date), sexe: rc.gender === "F" ? "F" : rc.gender === "M" ? "M" : "", photo: lireFichier("eleve", rc.photo_key),
      },
      periode: { libelle: rc.term_label || "Période", annee: rc.year_label || "" },
      matieres,
      synthese: {
        total_coef: totalCoef, total_points: totalPoints, moyenne: rc.general_average == null ? null : Number(rc.general_average),
        rang: rc.rank_in_class, effectif: rc.class_size, moyenne_classe: rc.class_average == null ? null : Number(rc.class_average),
        plus_forte: rc.class_stats?.plus_forte ?? null, plus_faible: rc.class_stats?.plus_faible ?? null,
        absences: rc.absences_count ?? 0, retards: rc.late_count ?? 0, conduite: rc.conduct || "",
        appreciation: rc.appreciation || "", decision: rc.council_decision || "",
      },
      reference: verif?.reference || rc.reference || `BUL-${rc.id}`,
      url: verif ? parcours.urlVerification(req, verif.token) : `${parcours.publicBaseUrl(req)}/verifier`,
      date: jourFr(rc.generated_at) || aujourdhuiFr(),
    };
  }

  const SELECT_BULLETIN = `
    SELECT rc.*, s.first_name, s.last_name, s.matricule AS student_matricule, s.gender, s.birth_date, s.photo_key,
           cur.name AS current_class, t.label AS term_label, y.label AS year_label
      FROM edu_report_cards rc
      JOIN edu_students s ON s.id=rc.student_id AND s.company_id=rc.company_id
      LEFT JOIN edu_classes cur ON cur.id=s.class_id
      JOIN edu_terms t ON t.id=rc.term_id
      LEFT JOIN edu_school_years y ON y.id=t.school_year_id`;

  // Un bulletin (le contrôle d'accès famille/direction est fait en amont).
  async function envoyerBulletin(req, res) {
    try {
      const cid = schoolId(req);
      const rc = (await pool.query(`${SELECT_BULLETIN} WHERE rc.id=$1 AND rc.company_id=$2`, [Number(req.params.id) || 0, cid])).rows[0];
      if (!rc) return res.status(404).json({ error: "Bulletin introuvable" });
      const id = await identite(cid);
      const q = STAFF_ROLES.includes(req.eduRole) ? req.query : {};
      const donnees = { ...(await donneesBulletin(req, id, rc)), options: optionsBulletin(id.brut.report_options, q) };
      enteteePdf(res, `bulletin-${rc.student_matricule}-${rc.term_label || rc.term_id}`);
      bulletinsPdf(res, [donnees], modeleBulletin(q.modele, id.brut.report_template));
    } catch (e) {
      console.error("ERREUR EDU BULLETIN PDF :", e.message);
      if (!res.headersSent) res.status(500).json({ error: "Erreur génération du bulletin PDF" });
    }
  }

  // Tous les bulletins d'une classe pour une période, dans un seul PDF.
  router.get("/classes/:id/report-cards/pdf", requireRoles(GRADE_ROLES), async (req, res) => {
    try {
      const cid = schoolId(req);
      const classId = Number(req.params.id) || 0;
      const termId = Number(req.query.term_id) || 0;
      if (req.eduRole === "teacher" && !(await teacherClassIds(req)).includes(classId)) return res.status(403).json({ error: "Classe non affectée" });
      const { rows } = await pool.query(
        `${SELECT_BULLETIN} WHERE rc.company_id=$1 AND COALESCE(rc.class_id, s.class_id)=$2 AND rc.term_id=$3
          ORDER BY rc.rank_in_class NULLS LAST, s.last_name`, [cid, classId, termId]);
      if (!rows.length) return res.status(404).json({ error: "Aucun bulletin généré pour cette classe et cette période." });
      const id = await identite(cid);
      const options = optionsBulletin(id.brut.report_options, req.query);
      const liste = [];
      for (const rc of rows) liste.push({ ...(await donneesBulletin(req, id, rc)), options });
      enteteePdf(res, `bulletins-${rows[0].class_label || "classe"}-${rows[0].term_label || termId}`);
      bulletinsPdf(res, liste, modeleBulletin(req.query.modele, id.brut.report_template));
    } catch (e) {
      console.error("ERREUR EDU BULLETINS CLASSE :", e.message);
      if (!res.headersSent) res.status(500).json({ error: "Erreur génération des bulletins." });
    }
  });

  // Aperçu des paramètres : bulletin fictif avec l'identité réelle de l'école.
  router.get("/bulletins/apercu", requireRoles(STAFF_ROLES), async (req, res) => {
    try {
      const id = await identite(schoolId(req));
      const lignes = [["Mathématiques", 4, 14.5, 11.2], ["Français", 4, 12.25, 10.8], ["Anglais", 2, 15, 12.1], ["Histoire-Géographie", 2, 11, 10.2],
        ["Sciences de la Vie et de la Terre", 2, 13.75, 11.5], ["Physique-Chimie", 3, 9.5, 9.8], ["Éducation civique et morale", 1, 16, 13.4], ["Éducation physique et sportive", 1, 17, 14.9]];
      const matieres = lignes.map(([nom, coef, moyenne, mc]) => ({ nom, coef, moyenne, points: moyenne * coef, moyenne_classe: mc, min: mc - 4, max: mc + 5, appreciation: appreciationAuto(moyenne) }));
      const tc = lignes.reduce((s, l) => s + l[1], 0);
      const tp = matieres.reduce((s, m) => s + m.points, 0);
      const donnees = {
        ecole: id.ecole, couleurs: id.couleurs,
        eleve: { prenom: "Aminata", nom: "Traoré", matricule: `${id.brut.matricule_prefix || "ML"}-${new Date().getFullYear()}-0042`, classe: "6e A", naissance: "12/03/2014", sexe: "F", photo: null },
        periode: { libelle: "Trimestre 1", annee: id.brut.active_year_label || `${new Date().getFullYear()}-${new Date().getFullYear() + 1}` },
        matieres,
        synthese: { total_coef: tc, total_points: tp, moyenne: tp / tc, rang: 3, effectif: 32, moyenne_classe: 11.24, plus_forte: 16.8, plus_faible: 6.3, absences: 2, retards: 1, conduite: "Très bonne", appreciation: "Bon trimestre. Élève sérieuse et appliquée ; doit consolider ses acquis en physique-chimie.", decision: "" },
        reference: "EXEMPLE", url: `${parcours.publicBaseUrl(req)}/verifier/exemple-de-jeton-aleatoire`, date: aujourdhuiFr(),
        options: optionsBulletin(id.brut.report_options, req.query),
      };
      envoyerSvg(res, bulletinSvg(donnees, modeleBulletin(req.query.modele, id.brut.report_template)));
    } catch (e) {
      console.error("ERREUR EDU APERCU BULLETIN :", e.message);
      res.status(500).json({ error: "Erreur aperçu." });
    }
  });

  return { envoyerBulletin };
};
