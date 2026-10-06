"use strict";

/**
 * MaliLink Education — gestion d'établissements scolaires.
 * Router monté sur /education dans server.js.
 *
 * Isolation stricte :
 * - toutes les données sont liées à company_id (= établissement)
 * - un parent ne voit que ses enfants (edu_student_parents)
 * - un professeur ne voit que ses classes (edu_teacher_assignments)
 * - un élève ne voit que ses propres données
 */

const express = require("express");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const QRCode = require("qrcode");
const edupdf = require("../services/education/pdf");

// Stockage des pièces jointes de cours (uploads/education/).
const EDU_UPLOAD_DIR = path.join(__dirname, "..", "uploads", "education");
try { fs.mkdirSync(EDU_UPLOAD_DIR, { recursive: true }); } catch { /* déjà présent */ }
const eduUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, EDU_UPLOAD_DIR),
    filename: (req, file, cb) => {
      const safe = (file.originalname || "fichier").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-60);
      cb(null, `${Date.now()}_${crypto.randomBytes(4).toString("hex")}_${safe}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 Mo
});

const STAFF_ROLES = ["super_admin", "school_admin", "director", "secretary", "supervisor"];
const GRADE_ROLES = [...STAFF_ROLES, "teacher"];
const MONEY_ROLES = ["super_admin", "school_admin", "director", "accountant", "secretary"];

module.exports = function createEducationRouter({ pool, authenticateToken, authorizeRoles }) {
  const router = express.Router();
  router.use(authenticateToken);

  /* Dates calendaires (naissance, échéance, inscription…). Le pilote pg en
     fait des objets Date à minuit local, que JSON convertit en UTC : une
     date de naissance du 18 février partait « 2014-02-17T23:00:00Z » et
     s'affichait la veille. Elles repartent en « AAAA-MM-JJ », sans fuseau. */
  const COLONNES_JOUR = new Set([
    "attendance_date", "birth_date", "conduct_date", "due_date", "end_date", "enrollment_date", "exam_date",
    "hire_date", "start_date", "valid_from", "valid_to", "valid_until", "first_due_date",
  ]);
  const deux = (n) => String(n).padStart(2, "0");
  function datesEnJours(valeur, profondeur = 0) {
    if (profondeur > 6 || valeur == null || typeof valeur !== "object" || valeur instanceof Date || Buffer.isBuffer(valeur)) return valeur;
    if (Array.isArray(valeur)) return valeur.map((v) => datesEnJours(v, profondeur + 1));
    const copie = {};
    for (const [cle, v] of Object.entries(valeur)) {
      copie[cle] = v instanceof Date && COLONNES_JOUR.has(cle) && !Number.isNaN(v.getTime())
        ? `${v.getFullYear()}-${deux(v.getMonth() + 1)}-${deux(v.getDate())}`
        : datesEnJours(v, profondeur + 1);
    }
    return copie;
  }
  router.use((req, res, next) => {
    const json = res.json.bind(res);
    res.json = (corps) => json(datesEnJours(corps));
    next();
  });
  // Parcours d'inscription (routes/education-parcours.js), branché en fin de fichier.
  let parcours = null;

  /* Rôle effectif dans le module. Les comptes d'administration d'une société
     (« admin », « direction »…, créés à l'inscription MaliLink) valent
     direction d'établissement : sans cette équivalence, l'administrateur
     d'une école se voyait refuser son propre module (« rôle insuffisant »). */
  const ADMIN_ENTREPRISE = new Set([
    "admin", "administrateur", "administrateur_entreprise", "direction", "directeur", "gerant", "manager",
  ]);
  router.use((req, res, next) => {
    const brut = String(req.user?.role || "").trim().toLowerCase();
    req.eduRole = req.user?.is_super_admin === true || brut === "super_admin"
      ? "super_admin"
      : ADMIN_ENTREPRISE.has(brut) ? "school_admin" : brut;
    next();
  });

  // Établissement effectif de l'utilisateur (super_admin peut cibler via ?company_id)
  function schoolId(req) {
    if (req.eduRole === "super_admin" && req.query.company_id) {
      return Number(req.query.company_id);
    }
    return Number(req.user.company_id);
  }

  /* Cloisonnement des écritures. Tout identifiant reçu dans le corps d'une
     création ou d'une modification (classe, année, matière, période,
     professeur, élève, frais, échéance, utilisateur…) doit appartenir à
     l'établissement, y compris dans les listes (appel, notes). Un seul
     identifiant étranger rejette toute la requête : on ne relie jamais une
     donnée de l'école A à un enregistrement de l'école B. */
  const REFERENCES_CORPS = {
    school_year_id: "edu_school_years", active_school_year_id: "edu_school_years",
    class_id: "edu_classes", subject_id: "edu_subjects", term_id: "edu_terms",
    teacher_id: "edu_teachers", assignment_id: "edu_teacher_assignments",
    student_id: "edu_students", eleve_id: "edu_students",
    fee_id: "edu_fees", installment_id: "edu_feeplan_installments",
    plan_id: "edu_feeplans", fee_plan_id: "edu_feeplans",
    course_id: "edu_courses", exam_id: "edu_exams", enrollment_id: "edu_enrollments",
    user_id: "users", parent_user_id: "users", main_teacher_user_id: "users",
    teacher_user_id: "users", recipient_user_id: "users", paid_by_user_id: "users",
  };
  function collecterReferences(valeur, acc, profondeur = 0) {
    if (profondeur > 4 || valeur == null || typeof valeur !== "object") return acc;
    if (Array.isArray(valeur)) {
      for (const v of valeur.slice(0, 500)) collecterReferences(v, acc, profondeur + 1);
      return acc;
    }
    for (const [cle, v] of Object.entries(valeur)) {
      const table = REFERENCES_CORPS[cle];
      if (table && v !== null && v !== undefined && v !== "") {
        const id = Number(v);
        if (!Number.isInteger(id) || id <= 0) { acc.invalide = cle; continue; }
        (acc.tables[table] ||= new Set()).add(id);
      } else if (v && typeof v === "object") {
        collecterReferences(v, acc, profondeur + 1);
      }
    }
    return acc;
  }
  router.use(async (req, res, next) => {
    if (!["POST", "PUT", "PATCH"].includes(req.method) || !req.body || typeof req.body !== "object") return next();
    const refs = collecterReferences(req.body, { tables: {}, invalide: null });
    if (refs.invalide) return res.status(400).json({ error: `Identifiant invalide (${refs.invalide}).`, code: "REFERENCE_INVALIDE" });
    try {
      const cid = schoolId(req);
      for (const [table, ids] of Object.entries(refs.tables)) {
        const liste = [...ids];
        const { rows } = await pool.query(
          `SELECT COUNT(*)::int AS n FROM ${table} WHERE id = ANY($1::int[]) AND company_id = $2`, [liste, cid]
        );
        if (rows[0].n !== liste.length) {
          return res.status(404).json({
            error: "Une référence n'appartient pas à votre établissement.", code: "REFERENCE_HORS_ETABLISSEMENT",
          });
        }
      }
      next();
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur de vérification des références" }); }
  });

  function requireRoles(roles) {
    return (req, res, next) => {
      if (!roles.includes(req.eduRole)) {
        return res.status(403).json({ error: "Accès refusé (rôle insuffisant)" });
      }
      next();
    };
  }

  // Vrai si chaque élève de la liste est dans la classe (et l'établissement).
  async function elevesDeLaClasse(companyId, classId, studentIds) {
    const ids = [...new Set(studentIds.map(Number))];
    if (ids.some((id) => !Number.isInteger(id) || id <= 0)) return false;
    if (ids.length === 0) return true;
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM edu_students WHERE company_id=$1 AND class_id=$2 AND id = ANY($3::int[])`,
      [companyId, Number(classId), ids]
    );
    return rows[0].n === ids.length;
  }

  async function teacherClassIds(req) {
    const { rows } = await pool.query(
      `SELECT DISTINCT class_id FROM edu_teacher_assignments
       WHERE teacher_user_id=$1 AND company_id=$2`,
      [req.user.id, schoolId(req)]
    );
    return rows.map((r) => r.class_id);
  }

  async function parentStudentIds(req) {
    const { rows } = await pool.query(
      `SELECT sp.student_id FROM edu_student_parents sp
       JOIN edu_students s ON s.id = sp.student_id
       WHERE sp.parent_user_id=$1 AND s.company_id=$2`,
      [req.user.id, schoolId(req)]
    );
    return rows.map((r) => r.student_id);
  }

  async function assertStudentAccess(req, studentId) {
    const sid = Number(studentId);
    const { rows } = await pool.query(
      "SELECT * FROM edu_students WHERE id=$1 AND company_id=$2",
      [sid, schoolId(req)]
    );
    const student = rows[0];
    if (!student) return null;

    const role = req.eduRole;
    if (STAFF_ROLES.includes(role) || MONEY_ROLES.includes(role)) return student;
    if (role === "teacher") {
      const classes = await teacherClassIds(req);
      return classes.includes(student.class_id) ? student : null;
    }
    if (role === "parent") {
      const children = await parentStudentIds(req);
      return children.includes(sid) ? student : null;
    }
    if (role === "student") {
      return student.user_id === req.user.id ? student : null;
    }
    return null;
  }

  /* Documents d'un élève (inscription, échéancier, reçus, bulletin) : la
     direction et la comptabilité voient tout l'établissement ; un parent,
     un élève ou un professeur seulement les dossiers auxquels il a droit. */
  const ROLES_GESTION = [...new Set([...STAFF_ROLES, ...MONEY_ROLES])];
  const PROPRIETAIRE_DOCUMENT = {
    inscription: `SELECT student_id FROM edu_enrollments WHERE id=$1 AND company_id=$2`,
    versement_inscription: `SELECT e.student_id FROM edu_enrollment_payments p JOIN edu_enrollments e ON e.id=p.enrollment_id
                             WHERE p.id=$1 AND p.company_id=$2`,
    echeancier: `SELECT student_id FROM edu_feeplans WHERE id=$1 AND company_id=$2`,
    paiement: `SELECT p.student_id FROM edu_feeplan_payments fp JOIN edu_feeplans p ON p.id=fp.plan_id
                WHERE fp.id=$1 AND fp.company_id=$2`,
    bulletin: `SELECT student_id FROM edu_report_cards WHERE id=$1 AND company_id=$2`,
  };
  function reserveAuDossier(nature) {
    return async (req, res, next) => {
      if (ROLES_GESTION.includes(req.eduRole)) return next();
      try {
        const { rows } = await pool.query(PROPRIETAIRE_DOCUMENT[nature], [Number(req.params.id) || 0, schoolId(req)]);
        if (rows[0] && (await assertStudentAccess(req, rows[0].student_id))) return next();
        return res.status(404).json({ error: "Document introuvable" });
      } catch (e) { console.error(e); return res.status(500).json({ error: "Erreur d'accès au document" }); }
    };
  }

  // ---------- ÉTABLISSEMENT / ANNÉES / PÉRIODES ----------

  router.get("/school", async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT s.*, c.name AS company_name FROM edu_schools s
         JOIN companies c ON c.id = s.company_id WHERE s.company_id=$1`,
        [schoolId(req)]
      );
      res.json(rows[0] || null);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur école" }); }
  });

  router.put("/school", requireRoles(STAFF_ROLES), async (req, res) => {
    try {
      const { school_type, grading_system, grade_max, logo_url, director_name, address, phone } = req.body || {};
      const { rows } = await pool.query(
        `INSERT INTO edu_schools (company_id, school_type, grading_system, grade_max, logo_url, director_name, address, phone)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (company_id) DO UPDATE SET
           school_type=COALESCE($2, edu_schools.school_type),
           grading_system=COALESCE($3, edu_schools.grading_system),
           grade_max=COALESCE($4, edu_schools.grade_max),
           logo_url=COALESCE($5, edu_schools.logo_url),
           director_name=COALESCE($6, edu_schools.director_name),
           address=COALESCE($7, edu_schools.address),
           phone=COALESCE($8, edu_schools.phone)
         RETURNING *`,
        [schoolId(req), school_type || 'ecole', grading_system || 'malien',
         grade_max || 20, logo_url || null, director_name || null, address || null, phone || null]
      );
      res.json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur école" }); }
  });

  router.get("/school-years", async (req, res) => {
    try {
      const { rows } = await pool.query(
        "SELECT * FROM edu_school_years WHERE company_id=$1 ORDER BY start_date DESC NULLS LAST",
        [schoolId(req)]
      );
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur années" }); }
  });

  router.post("/school-years", requireRoles(STAFF_ROLES), async (req, res) => {
    try {
      const { label, start_date, end_date, is_active } = req.body || {};
      if (!label) return res.status(400).json({ error: "Libellé requis" });
      if (is_active) {
        await pool.query("UPDATE edu_school_years SET is_active=false WHERE company_id=$1", [schoolId(req)]);
      }
      const { rows } = await pool.query(
        `INSERT INTO edu_school_years (company_id, label, start_date, end_date, is_active)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [schoolId(req), label, start_date || null, end_date || null, Boolean(is_active)]
      );
      res.status(201).json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur année" }); }
  });

  router.get("/terms", async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT t.* FROM edu_terms t WHERE t.company_id=$1
         ORDER BY t.school_year_id DESC, t.term_order`,
        [schoolId(req)]
      );
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur périodes" }); }
  });

  router.post("/terms", requireRoles(STAFF_ROLES), async (req, res) => {
    try {
      const { school_year_id, label, term_order, start_date, end_date } = req.body || {};
      if (!school_year_id || !label) return res.status(400).json({ error: "Année et libellé requis" });
      const { rows } = await pool.query(
        `INSERT INTO edu_terms (company_id, school_year_id, label, term_order, start_date, end_date)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [schoolId(req), school_year_id, label, term_order || 1, start_date || null, end_date || null]
      );
      res.status(201).json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur période" }); }
  });

  // ---------- CLASSES / MATIÈRES / AFFECTATIONS ----------

  router.get("/classes", async (req, res) => {
    try {
      if (req.eduRole === "teacher") {
        const ids = await teacherClassIds(req);
        if (ids.length === 0) return res.json([]);
        const { rows } = await pool.query(
          `SELECT c.*, (SELECT COUNT(*) FROM edu_students s WHERE s.class_id=c.id AND s.status='actif') AS student_count
           FROM edu_classes c WHERE c.id = ANY($1) ORDER BY c.name`,
          [ids]
        );
        return res.json(rows);
      }
      const { rows } = await pool.query(
        `SELECT c.*, (SELECT COUNT(*) FROM edu_students s WHERE s.class_id=c.id AND s.status='actif') AS student_count
         FROM edu_classes c WHERE c.company_id=$1 ORDER BY c.name`,
        [schoolId(req)]
      );
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur classes" }); }
  });

  router.post("/classes", requireRoles(STAFF_ROLES), async (req, res) => {
    try {
      const { name, level, school_year_id, main_teacher_user_id } = req.body || {};
      if (!name) return res.status(400).json({ error: "Nom requis" });
      if (school_year_id) await parcours.verifierReferences(pool, schoolId(req), { yearId: Number(school_year_id) });
      if (main_teacher_user_id) {
        const prof = await pool.query(`SELECT 1 FROM users WHERE id=$1 AND company_id=$2`, [Number(main_teacher_user_id), schoolId(req)]);
        if (!prof.rows[0]) return res.status(404).json({ error: "Professeur introuvable dans votre établissement." });
      }
      const { rows } = await pool.query(
        `INSERT INTO edu_classes (company_id, name, level, school_year_id, main_teacher_user_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [schoolId(req), name, level || null, school_year_id || null, main_teacher_user_id || null]
      );
      res.status(201).json(rows[0]);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      console.error(e); res.status(500).json({ error: "Erreur classe" });
    }
  });

  router.get("/subjects", async (req, res) => {
    try {
      const { rows } = await pool.query(
        "SELECT * FROM edu_subjects WHERE company_id=$1 ORDER BY name",
        [schoolId(req)]
      );
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur matières" }); }
  });

  router.post("/subjects", requireRoles(STAFF_ROLES), async (req, res) => {
    try {
      const { name, coefficient } = req.body || {};
      if (!name) return res.status(400).json({ error: "Nom requis" });
      const { rows } = await pool.query(
        `INSERT INTO edu_subjects (company_id, name, coefficient)
         VALUES ($1,$2,$3) RETURNING *`,
        [schoolId(req), name, coefficient || 1]
      );
      res.status(201).json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur matière" }); }
  });

  // Liste des affectations (professeur ↔ matière ↔ classe) — §6.
  router.get("/teacher-assignments", async (req, res) => {
    try {
      const teacherId = req.query.teacher_id ? Number(req.query.teacher_id) : null;
      const classId = req.query.class_id ? Number(req.query.class_id) : null;
      const { rows } = await pool.query(
        `SELECT a.*, t.first_name AS teacher_first, t.last_name AS teacher_last, t.matricule,
                c.name AS class_name, s.name AS subject_name
           FROM edu_teacher_assignments a
           LEFT JOIN edu_teachers t ON t.id=a.teacher_id
           LEFT JOIN edu_classes c ON c.id=a.class_id
           LEFT JOIN edu_subjects s ON s.id=a.subject_id
          WHERE a.company_id=$1
            AND ($2::int IS NULL OR a.teacher_id=$2)
            AND ($3::int IS NULL OR a.class_id=$3)
          ORDER BY a.id DESC`,
        [schoolId(req), teacherId, classId]
      );
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur affectations" }); }
  });

  // Créer une affectation complète (§6) : coefficient, volume horaire, permissions…
  router.post("/teacher-assignments", requireRoles(STAFF_ROLES), async (req, res) => {
    try {
      const b = req.body || {};
      const teacherId = b.teacher_id ? Number(b.teacher_id) : null;
      if (!teacherId || !b.class_id) return res.status(400).json({ error: "Professeur et classe requis" });
      // Vérifie l'appartenance à l'établissement (isolation school_id).
      const own = await pool.query(
        `SELECT (SELECT 1 FROM edu_teachers WHERE id=$1 AND company_id=$3) AS t,
                (SELECT 1 FROM edu_classes WHERE id=$2 AND company_id=$3) AS c`,
        [teacherId, b.class_id, schoolId(req)]
      );
      if (!own.rows[0].t || !own.rows[0].c) return res.status(403).json({ error: "Professeur ou classe hors de votre établissement." });
      // Anti-doublon (professeur + classe + matière).
      const dup = await pool.query(
        `SELECT 1 FROM edu_teacher_assignments WHERE company_id=$1 AND teacher_id=$2 AND class_id=$3 AND COALESCE(subject_id,0)=COALESCE($4,0)`,
        [schoolId(req), teacherId, b.class_id, b.subject_id || null]
      );
      if (dup.rows[0]) return res.status(409).json({ error: "Cette affectation existe déjà." });
      const { rows } = await pool.query(
        `INSERT INTO edu_teacher_assignments
           (company_id, teacher_id, class_id, subject_id, school_year_id, term_id, coefficient,
            weekly_hours, start_date, end_date, status, is_main_teacher, can_enter_grades,
            can_take_attendance, can_publish_courses)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
        [schoolId(req), teacherId, b.class_id, b.subject_id || null, b.school_year_id || null,
         b.term_id || null, b.coefficient != null ? Number(b.coefficient) : null,
         b.weekly_hours != null ? Number(b.weekly_hours) : null, b.start_date || null, b.end_date || null,
         b.status || "actif", Boolean(b.is_main_teacher), b.can_enter_grades !== false,
         b.can_take_attendance !== false, b.can_publish_courses !== false]
      );
      res.status(201).json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur affectation" }); }
  });

  // Modifier une affectation ; l'évolution du coefficient est journalisée (§6).
  router.patch("/teacher-assignments/:id", requireRoles(STAFF_ROLES), async (req, res) => {
    try {
      const b = req.body || {};
      const current = await pool.query(`SELECT * FROM edu_teacher_assignments WHERE id=$1 AND company_id=$2`, [req.params.id, schoolId(req)]);
      if (!current.rows[0]) return res.status(404).json({ error: "Affectation introuvable" });
      const fields = ["subject_id", "coefficient", "weekly_hours", "start_date", "end_date", "status",
        "is_main_teacher", "can_enter_grades", "can_take_attendance", "can_publish_courses", "term_id"];
      const set = []; const vals = [];
      for (const f of fields) { if (b[f] !== undefined) { vals.push(b[f]); set.push(`${f}=$${vals.length}`); } }
      if (set.length === 0) return res.status(400).json({ error: "Aucune modification" });
      vals.push(req.params.id, schoolId(req));
      const { rows } = await pool.query(
        `UPDATE edu_teacher_assignments SET ${set.join(", ")} WHERE id=$${vals.length - 1} AND company_id=$${vals.length} RETURNING *`,
        vals
      );
      // Historique du coefficient si modifié.
      if (b.coefficient !== undefined && Number(b.coefficient) !== Number(current.rows[0].coefficient)) {
        await pool.query(
          `INSERT INTO edu_coefficient_history (company_id, assignment_id, old_value, new_value, changed_by)
           VALUES ($1,$2,$3,$4,$5)`,
          [schoolId(req), req.params.id, current.rows[0].coefficient, Number(b.coefficient), req.user.id]
        ).catch(() => {});
      }
      res.json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur modification affectation" }); }
  });

  router.delete("/teacher-assignments/:id", requireRoles(STAFF_ROLES), async (req, res) => {
    try {
      const { rowCount } = await pool.query(`DELETE FROM edu_teacher_assignments WHERE id=$1 AND company_id=$2`, [req.params.id, schoolId(req)]);
      if (!rowCount) return res.status(404).json({ error: "Affectation introuvable" });
      res.json({ ok: true });
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur suppression affectation" }); }
  });

  // ---------- PROFESSEURS (fiches professionnelles, §4) ----------

  // Génère un matricule PROF-AAAA-NNNNN unique par établissement/année.
  async function nextTeacherMatricule(companyId) {
    const year = new Date().getFullYear();
    const { rows } = await pool.query(
      `INSERT INTO edu_teacher_counters (company_id, year, last_seq)
       VALUES ($1,$2,1)
       ON CONFLICT (company_id, year) DO UPDATE SET last_seq = edu_teacher_counters.last_seq + 1
       RETURNING last_seq`,
      [companyId, year]
    );
    return `PROF-${year}-${String(rows[0].last_seq).padStart(5, "0")}`;
  }

  router.get("/teachers", async (req, res) => {
    try {
      const q = req.query.q ? `%${String(req.query.q)}%` : null;
      const status = ["actif", "inactif"].includes(req.query.status) ? req.query.status : null;
      // Hors direction : nom et spécialité seulement (pas de téléphone,
      // d'adresse ni de date de naissance des professeurs).
      const colonnes = ROLES_GESTION.includes(req.eduRole)
        ? "t.*"
        : "t.id, t.first_name, t.last_name, t.specialty, t.photo_url, t.status";
      const { rows } = await pool.query(
        `SELECT ${colonnes},
                (SELECT COUNT(*) FROM edu_teacher_assignments a WHERE a.teacher_id=t.id) AS assignment_count
           FROM edu_teachers t
          WHERE t.company_id=$1
            AND ($2::text IS NULL OR (t.first_name||' '||t.last_name ILIKE $2 OR t.matricule ILIKE $2 OR t.phone ILIKE $2))
            AND ($3::text IS NULL OR t.status=$3)
          ORDER BY t.last_name, t.first_name`,
        [schoolId(req), q, status]
      );
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur professeurs" }); }
  });

  router.post("/teachers", requireRoles(STAFF_ROLES), async (req, res) => {
    try {
      const b = req.body || {};
      if (!b.first_name || !b.last_name) return res.status(400).json({ error: "Prénom et nom requis" });
      const matricule = b.matricule && String(b.matricule).trim() ? String(b.matricule).trim() : await nextTeacherMatricule(schoolId(req));
      const { rows } = await pool.query(
        `INSERT INTO edu_teachers
           (company_id, user_id, matricule, first_name, last_name, gender, photo_url, phone, email,
            address, birth_date, diploma, specialty, hire_date, contract_type, signature_url, status,
            school_year_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
        [schoolId(req), b.user_id || null, matricule, b.first_name, b.last_name, b.gender || "",
         b.photo_url || "", b.phone || "", b.email || "", b.address || "", b.birth_date || null,
         b.diploma || "", b.specialty || "", b.hire_date || null, b.contract_type || "",
         b.signature_url || "", b.status || "actif", b.school_year_id || null, req.user.id]
      );
      res.status(201).json(rows[0]);
    } catch (e) {
      if (String(e.message).includes("edu_teachers_company_id_matricule")) {
        return res.status(409).json({ error: "Ce matricule existe déjà dans cet établissement." });
      }
      console.error(e); res.status(500).json({ error: "Erreur création professeur" });
    }
  });

  router.get("/teachers/:id", requireRoles(ROLES_GESTION), async (req, res) => {
    try {
      const t = await pool.query(`SELECT * FROM edu_teachers WHERE id=$1 AND company_id=$2`, [req.params.id, schoolId(req)]);
      if (!t.rows[0]) return res.status(404).json({ error: "Professeur introuvable" });
      const assignments = await pool.query(
        `SELECT a.*, c.name AS class_name, s.name AS subject_name
           FROM edu_teacher_assignments a
           LEFT JOIN edu_classes c ON c.id=a.class_id
           LEFT JOIN edu_subjects s ON s.id=a.subject_id
          WHERE a.teacher_id=$1 ORDER BY a.id DESC`,
        [req.params.id]
      );
      res.json({ ...t.rows[0], assignments: assignments.rows });
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur professeur" }); }
  });

  router.patch("/teachers/:id", requireRoles(STAFF_ROLES), async (req, res) => {
    try {
      const b = req.body || {};
      const fields = ["first_name", "last_name", "gender", "photo_url", "phone", "email", "address",
        "birth_date", "diploma", "specialty", "hire_date", "contract_type", "signature_url", "status"];
      const set = [];
      const vals = [];
      for (const f of fields) {
        if (b[f] !== undefined) { vals.push(b[f]); set.push(`${f}=$${vals.length}`); }
      }
      if (set.length === 0) return res.status(400).json({ error: "Aucune modification" });
      vals.push(req.params.id, schoolId(req));
      const { rows } = await pool.query(
        `UPDATE edu_teachers SET ${set.join(", ")}, updated_at=NOW()
          WHERE id=$${vals.length - 1} AND company_id=$${vals.length} RETURNING *`,
        vals
      );
      if (!rows[0]) return res.status(404).json({ error: "Professeur introuvable" });
      res.json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur modification professeur" }); }
  });

  // ---------- INSCRIPTIONS + FICHE PDF (§10-11) ----------

  async function nextEnrollmentRef(companyId) {
    const year = new Date().getFullYear();
    const { rows } = await pool.query(
      `INSERT INTO edu_enrollment_counters (company_id, year, last_seq) VALUES ($1,$2,1)
       ON CONFLICT (company_id, year) DO UPDATE SET last_seq = edu_enrollment_counters.last_seq + 1
       RETURNING last_seq`,
      [companyId, year]
    );
    return `MLK-INS-${year}-${String(rows[0].last_seq).padStart(5, "0")}`;
  }

  function enrollmentStatus(fee, paid) {
    if (paid <= 0) return "pending";
    if (paid >= fee) return "paid";
    return "partially_paid";
  }

  router.get("/enrollments", requireRoles(ROLES_GESTION), async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT e.*, s.first_name, s.last_name, s.matricule AS student_matricule, c.name AS class_name
           FROM edu_enrollments e
           JOIN edu_students s ON s.id=e.student_id
           LEFT JOIN edu_classes c ON c.id=e.class_id
          WHERE e.company_id=$1 ORDER BY e.created_at DESC LIMIT 300`,
        [schoolId(req)]
      );
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur inscriptions" }); }
  });

  router.post("/enrollments", requireRoles(STAFF_ROLES), async (req, res) => {
    try {
      const b = req.body || {};
      if (!b.student_id) return res.status(400).json({ error: "Élève requis" });
      const own = await pool.query(`SELECT 1 FROM edu_students WHERE id=$1 AND company_id=$2`, [b.student_id, schoolId(req)]);
      if (!own.rows[0]) return res.status(403).json({ error: "Élève hors de votre établissement." });
      const fee = Number(b.enrollment_fee || 0);
      const paid = Number(b.amount_paid || 0);
      const reference = await nextEnrollmentRef(schoolId(req));
      const signature = edupdf.signRef(["INSCRIPTION", reference]);
      const { rows } = await pool.query(
        `INSERT INTO edu_enrollments
           (company_id, reference, student_id, school_year_id, class_id, enrollment_fee, amount_paid,
            currency, payment_method, status, signature, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [schoolId(req), reference, b.student_id, b.school_year_id || null, b.class_id || null, fee, paid,
         b.currency || "FCFA", b.payment_method || "", enrollmentStatus(fee, paid), signature, b.notes || "", req.user.id]
      );
      // Trace le premier versement s'il y en a un.
      if (paid > 0) {
        await pool.query(
          `INSERT INTO edu_enrollment_payments (company_id, enrollment_id, amount, method, recorded_by)
           VALUES ($1,$2,$3,$4,$5)`,
          [schoolId(req), rows[0].id, paid, b.payment_method || "", req.user.id]
        ).catch(() => {});
      }
      res.status(201).json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur création inscription" }); }
  });

  async function enrollmentDetail(companyId, id) {
    const { rows } = await pool.query(
      `SELECT e.*, s.first_name, s.last_name, s.matricule AS student_matricule, s.gender, s.birth_date,
              c.name AS class_name, y.label AS year_label
         FROM edu_enrollments e
         JOIN edu_students s ON s.id=e.student_id
         LEFT JOIN edu_classes c ON c.id=e.class_id
         LEFT JOIN edu_school_years y ON y.id=e.school_year_id
        WHERE e.company_id=$1 AND e.id=$2`,
      [companyId, id]
    );
    return rows[0] || null;
  }

  router.get("/enrollments/:id", reserveAuDossier("inscription"), async (req, res) => {
    const d = await enrollmentDetail(schoolId(req), req.params.id);
    if (!d) return res.status(404).json({ error: "Inscription introuvable" });
    res.json(d);
  });

  // Fiche d'inscription PDF (§11) — QR de vérification signé.
  router.get("/enrollments/:id/pdf", reserveAuDossier("inscription"), async (req, res) => {
    try {
      const d = await enrollmentDetail(schoolId(req), req.params.id);
      if (!d) return res.status(404).json({ error: "Inscription introuvable" });
      const school = (await pool.query(
        `SELECT co.name, es.address, es.phone, es.director_name, es.logo_url
           FROM companies co LEFT JOIN edu_schools es ON es.company_id=co.id
          WHERE co.id=$1 LIMIT 1`,
        [schoolId(req)]
      )).rows[0] || {};
      const parent = (await pool.query(
        `SELECT COALESCE(u.fullname, '') AS name, sp.relation, COALESCE(u.phone,'') AS phone
           FROM edu_student_parents sp LEFT JOIN users u ON u.id=sp.parent_user_id
          WHERE sp.student_id=$1 ORDER BY sp.id LIMIT 1`,
        [d.student_id]
      )).rows[0] || {};
      const rest = Math.max(0, Number(d.enrollment_fee) - Number(d.amount_paid));
      await edupdf.renderDocument(res, {
        filename: `fiche-inscription-${d.reference}`,
        title: "Fiche d'inscription",
        reference: d.reference,
        qrText: edupdf.docToken("INSCRIPTION", d.reference),
        school,
        sections: [
          { title: "Élève", rows: [
            { label: "Nom complet", value: `${d.first_name} ${d.last_name}` },
            { label: "Matricule", value: d.student_matricule },
            { label: "Sexe", value: d.gender === "F" ? "Féminin" : d.gender === "M" ? "Masculin" : "—" },
            { label: "Date de naissance", value: d.birth_date || "—" },
            { label: "Classe", value: d.class_name || "—" },
            { label: "Année scolaire", value: d.year_label || "—" },
          ] },
          { title: "Parent / Tuteur", rows: [
            { label: "Nom", value: parent.name || "—" },
            { label: "Relation", value: parent.relation || "—" },
            { label: "Téléphone", value: parent.phone || "—" },
          ] },
          { title: "Paiement", rows: [
            { label: "Frais d'inscription", value: `${Number(d.enrollment_fee).toLocaleString("fr-FR")} ${d.currency}` },
            { label: "Montant payé", value: `${Number(d.amount_paid).toLocaleString("fr-FR")} ${d.currency}` },
            { label: "Reste à payer", value: `${rest.toLocaleString("fr-FR")} ${d.currency}` },
            { label: "Moyen de paiement", value: d.payment_method || "—" },
            { label: "Statut", value: d.status },
          ] },
        ],
        footerNote: `Fiche générée par MaliLink Éducation le ${new Date().toLocaleDateString("fr-FR")}. Authenticité vérifiable par le QR code.`,
      });
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur génération de la fiche PDF" }); }
  });

  // Vérification publique d'un document (référence + signature). Info limitée.
  router.get("/verify/:type/:reference", async (req, res) => {
    try {
      const sig = String(req.query.sig || "");
      const valid = edupdf.verifyToken(String(req.params.type).toUpperCase(), req.params.reference, sig);
      res.json({ valid, reference: req.params.reference, type: req.params.type, issuer: "MaliLink Éducation" });
    } catch { res.status(500).json({ valid: false }); }
  });

  // ---------- PAIEMENTS D'INSCRIPTION + REÇUS PDF (§12) ----------

  async function nextReceiptRef(companyId) {
    const year = new Date().getFullYear();
    const { rows } = await pool.query(
      `INSERT INTO edu_receipt_counters (company_id, year, last_seq) VALUES ($1,$2,1)
       ON CONFLICT (company_id, year) DO UPDATE SET last_seq = edu_receipt_counters.last_seq + 1
       RETURNING last_seq`,
      [companyId, year]
    );
    return `MLK-REC-${year}-${String(rows[0].last_seq).padStart(5, "0")}`;
  }

  // Recalcule montant payé + statut d'une inscription à partir de ses paiements actifs.
  async function recomputeEnrollment(companyId, enrollmentId) {
    const agg = await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS paid
         FROM edu_enrollment_payments
        WHERE company_id=$1 AND enrollment_id=$2 AND status='paid'`,
      [companyId, enrollmentId]
    );
    const paid = Number(agg.rows[0].paid);
    const enr = await pool.query(
      `SELECT enrollment_fee FROM edu_enrollments WHERE company_id=$1 AND id=$2`,
      [companyId, enrollmentId]
    );
    if (!enr.rows[0]) return null;
    const fee = Number(enr.rows[0].enrollment_fee);
    const { rows } = await pool.query(
      `UPDATE edu_enrollments SET amount_paid=$3, status=$4, updated_at=NOW()
        WHERE company_id=$1 AND id=$2 RETURNING *`,
      [companyId, enrollmentId, paid, enrollmentStatus(fee, paid)]
    );
    return rows[0];
  }

  // Historique des versements d'une inscription.
  router.get("/enrollments/:id/payments", reserveAuDossier("inscription"), async (req, res) => {
    try {
      const own = await pool.query(
        `SELECT 1 FROM edu_enrollments WHERE id=$1 AND company_id=$2`,
        [req.params.id, schoolId(req)]
      );
      if (!own.rows[0]) return res.status(404).json({ error: "Inscription introuvable" });
      const { rows } = await pool.query(
        `SELECT p.*, COALESCE(u.fullname,'') AS recorded_by_name
           FROM edu_enrollment_payments p
           LEFT JOIN users u ON u.id=p.recorded_by
          WHERE p.company_id=$1 AND p.enrollment_id=$2
          ORDER BY p.created_at DESC`,
        [schoolId(req), req.params.id]
      );
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur paiements" }); }
  });

  // Enregistre un nouveau versement (génère un numéro de reçu, met à jour l'inscription).
  router.post("/enrollments/:id/payments", requireRoles(MONEY_ROLES), async (req, res) => {
    try {
      const b = req.body || {};
      const amount = Number(b.amount || 0);
      if (!(amount > 0)) return res.status(400).json({ error: "Montant invalide." });
      const enr = await pool.query(
        `SELECT id, enrollment_fee, amount_paid, fee_plan_id FROM edu_enrollments WHERE id=$1 AND company_id=$2`,
        [req.params.id, schoolId(req)]
      );
      if (!enr.rows[0]) return res.status(404).json({ error: "Inscription introuvable" });
      if (enr.rows[0].fee_plan_id) {
        // Inscription récente : un seul échéancier porte tous les paiements.
        return res.status(409).json({
          error: "Ce dossier se règle par son échéancier unique (Frais & paiements).",
          code: "ECHEANCIER_UNIQUE", fee_plan_id: enr.rows[0].fee_plan_id,
        });
      }
      const receipt = await nextReceiptRef(schoolId(req));
      const signature = edupdf.signRef(["RECU", receipt]);
      const { rows } = await pool.query(
        `INSERT INTO edu_enrollment_payments
           (company_id, enrollment_id, receipt_number, amount, method, reference, status, signature, notes, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,'paid',$7,$8,$9) RETURNING *`,
        [schoolId(req), req.params.id, receipt, amount, b.method || "", b.reference || "", signature, b.notes || "", req.user.id]
      );
      const enrollment = await recomputeEnrollment(schoolId(req), req.params.id);
      const ecriture = await parcours?.ecrireCompta(pool, {
        companyId: schoolId(req), montant: amount, sens: "entrée", libelle: `Reçu ${receipt} — inscription`,
        sourceId: rows[0].id, methode: b.method, userId: req.user.id,
      });
      if (ecriture) await pool.query(`UPDATE edu_enrollment_payments SET accounting_transaction_id=$1 WHERE id=$2`, [ecriture, rows[0].id]);
      res.status(201).json({ payment: rows[0], enrollment });
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur enregistrement du paiement" }); }
  });

  // Annule un versement (statut cancelled) et recalcule l'inscription.
  router.patch("/enrollment-payments/:id/cancel", requireRoles(MONEY_ROLES), async (req, res) => {
    try {
      const { rows } = await pool.query(
        `UPDATE edu_enrollment_payments SET status='cancelled'
          WHERE id=$1 AND company_id=$2 AND status='paid' RETURNING id, enrollment_id, amount, method, receipt_number`,
        [req.params.id, schoolId(req)]
      );
      if (!rows[0]) return res.status(404).json({ error: "Paiement introuvable ou déjà annulé." });
      await parcours?.ecrireCompta(pool, {
        companyId: schoolId(req), montant: Number(rows[0].amount), sens: "sortie",
        libelle: `Annulation du reçu ${rows[0].receipt_number || rows[0].id}`, sourceId: rows[0].id,
        methode: rows[0].method, userId: req.user.id,
      });
      const enrollment = await recomputeEnrollment(schoolId(req), rows[0].enrollment_id);
      res.json({ ok: true, enrollment });
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur annulation du paiement" }); }
  });

  // Reçu de paiement PDF (§12) — QR de vérification signé.
  router.get("/enrollment-payments/:id/receipt", reserveAuDossier("versement_inscription"), async (req, res) => {
    try {
      const pay = (await pool.query(
        `SELECT p.*, e.reference AS enrollment_ref, e.enrollment_fee, e.amount_paid,
                s.first_name, s.last_name, s.matricule AS student_matricule,
                c.name AS class_name, y.label AS year_label,
                COALESCE(u.fullname,'') AS recorded_by_name
           FROM edu_enrollment_payments p
           JOIN edu_enrollments e ON e.id=p.enrollment_id
           JOIN edu_students s ON s.id=e.student_id
           LEFT JOIN edu_classes c ON c.id=e.class_id
           LEFT JOIN edu_school_years y ON y.id=e.school_year_id
           LEFT JOIN users u ON u.id=p.recorded_by
          WHERE p.id=$1 AND p.company_id=$2`,
        [req.params.id, schoolId(req)]
      )).rows[0];
      if (!pay) return res.status(404).json({ error: "Reçu introuvable" });
      const school = (await pool.query(
        `SELECT co.name, es.address, es.phone, es.director_name, es.logo_url
           FROM companies co LEFT JOIN edu_schools es ON es.company_id=co.id
          WHERE co.id=$1 LIMIT 1`,
        [schoolId(req)]
      )).rows[0] || {};
      const ref = pay.receipt_number || `PAY-${pay.id}`;
      const rest = Math.max(0, Number(pay.enrollment_fee) - Number(pay.amount_paid));
      await edupdf.renderDocument(res, {
        filename: `recu-${ref}`,
        title: pay.status === "cancelled" ? "Reçu (ANNULÉ)" : "Reçu de paiement",
        reference: ref,
        qrText: edupdf.docToken("RECU", ref),
        school,
        sections: [
          { title: "Élève", rows: [
            { label: "Nom complet", value: `${pay.first_name} ${pay.last_name}` },
            { label: "Matricule", value: pay.student_matricule },
            { label: "Classe", value: pay.class_name || "—" },
            { label: "Année scolaire", value: pay.year_label || "—" },
            { label: "Inscription", value: pay.enrollment_ref },
          ] },
          { title: "Versement", rows: [
            { label: "Numéro de reçu", value: ref },
            { label: "Date", value: new Date(pay.created_at).toLocaleDateString("fr-FR") },
            { label: "Montant reçu", value: `${Number(pay.amount).toLocaleString("fr-FR")} FCFA` },
            { label: "Moyen de paiement", value: pay.method || "—" },
            { label: "Référence transaction", value: pay.reference || "—" },
            { label: "Encaissé par", value: pay.recorded_by_name || "—" },
          ] },
          { title: "Situation de l'inscription", rows: [
            { label: "Frais total", value: `${Number(pay.enrollment_fee).toLocaleString("fr-FR")} FCFA` },
            { label: "Total payé", value: `${Number(pay.amount_paid).toLocaleString("fr-FR")} FCFA` },
            { label: "Reste à payer", value: `${rest.toLocaleString("fr-FR")} FCFA` },
          ] },
        ],
        footerNote: `Reçu généré par MaliLink Éducation le ${new Date().toLocaleDateString("fr-FR")}. Authenticité vérifiable par le QR code.`,
      });
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur génération du reçu PDF" }); }
  });

  // ---------- PLANS DE MENSUALITÉS + ÉCHÉANCIER & REÇUS PDF (§13) ----------

  // Répartit un montant total en N échéances mensuelles à partir d'une date.
  // Dates calculées en UTC pour éviter toute dérive de fuseau horaire.
  function buildInstallments(total, count, firstDue) {
    const n = Math.max(1, Number(count) || 1);
    const cents = Math.round(Number(total) * 100);
    const base = Math.floor(cents / n);
    let y, m, d;
    if (firstDue && /^\d{4}-\d{2}-\d{2}/.test(String(firstDue))) {
      [y, m, d] = String(firstDue).slice(0, 10).split("-").map(Number);
    } else {
      const now = new Date();
      y = now.getFullYear(); m = now.getMonth() + 1; d = now.getDate();
    }
    const out = [];
    for (let i = 0; i < n; i++) {
      const amountCents = i === n - 1 ? cents - base * (n - 1) : base;
      const due = new Date(Date.UTC(y, m - 1 + i, d));
      out.push({
        seq: i + 1,
        label: `Mensualité ${i + 1}`,
        due_date: due.toISOString().slice(0, 10),
        amount: (amountCents / 100).toFixed(2),
      });
    }
    return out;
  }

  function installmentStatus(amount, paid) {
    if (paid <= 0) return "pending";
    if (paid >= amount) return "paid";
    return "partial";
  }

  // Réaffecte en cascade le total payé (versements actifs) sur les échéances.
  async function recomputeFeePlan(companyId, planId) {
    const plan = (await pool.query(
      `SELECT * FROM edu_feeplans WHERE company_id=$1 AND id=$2`, [companyId, planId]
    )).rows[0];
    if (!plan) return null;
    const totalPaid = Number((await pool.query(
      `SELECT COALESCE(SUM(amount),0) AS s FROM edu_feeplan_payments
        WHERE company_id=$1 AND plan_id=$2 AND status='paid'`, [companyId, planId]
    )).rows[0].s);
    const insts = (await pool.query(
      `SELECT * FROM edu_feeplan_installments WHERE company_id=$1 AND plan_id=$2 ORDER BY seq`,
      [companyId, planId]
    )).rows;
    let remaining = totalPaid;
    for (const inst of insts) {
      const amt = Number(inst.amount);
      const paid = Math.min(remaining, amt);
      remaining -= paid;
      await pool.query(
        `UPDATE edu_feeplan_installments SET amount_paid=$3, status=$4 WHERE id=$1 AND company_id=$2`,
        [inst.id, companyId, paid.toFixed(2), installmentStatus(amt, paid)]
      );
    }
    const status = plan.status === "cancelled" ? "cancelled"
      : totalPaid >= Number(plan.total_amount) ? "completed" : "active";
    const { rows } = await pool.query(
      `UPDATE edu_feeplans SET status=$3, updated_at=NOW() WHERE id=$1 AND company_id=$2 RETURNING *`,
      [planId, companyId, status]
    );
    return { ...rows[0], total_paid: totalPaid.toFixed(2) };
  }

  router.get("/fee-plans", requireRoles(ROLES_GESTION), async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT p.*, s.first_name, s.last_name, s.matricule AS student_matricule, c.name AS class_name,
                COALESCE((SELECT SUM(amount) FROM edu_feeplan_payments fp
                          WHERE fp.plan_id=p.id AND fp.status='paid'),0) AS total_paid
           FROM edu_feeplans p
           JOIN edu_students s ON s.id=p.student_id
           LEFT JOIN edu_classes c ON c.id=p.class_id
          WHERE p.company_id=$1 ORDER BY p.created_at DESC LIMIT 300`,
        [schoolId(req)]
      );
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur plans" }); }
  });

  router.post("/fee-plans", requireRoles(MONEY_ROLES), async (req, res) => {
    const client = await pool.connect();
    try {
      const b = req.body || {};
      if (!b.student_id) return res.status(400).json({ error: "Élève requis" });
      const total = Number(b.total_amount || 0);
      const count = Math.max(1, Math.min(24, Number(b.installments_count || 1)));
      if (!(total > 0)) return res.status(400).json({ error: "Montant total invalide." });
      const own = await client.query(`SELECT 1 FROM edu_students WHERE id=$1 AND company_id=$2`, [b.student_id, schoolId(req)]);
      if (!own.rows[0]) return res.status(403).json({ error: "Élève hors de votre établissement." });
      await client.query("BEGIN");
      const plan = (await client.query(
        `INSERT INTO edu_feeplans
           (company_id, student_id, school_year_id, class_id, label, total_amount, installments_count, currency, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [schoolId(req), b.student_id, b.school_year_id || null, b.class_id || null,
         b.label || "Scolarité", total, count, b.currency || "FCFA", b.notes || "", req.user.id]
      )).rows[0];
      for (const inst of buildInstallments(total, count, b.first_due_date)) {
        await client.query(
          `INSERT INTO edu_feeplan_installments (company_id, plan_id, seq, label, due_date, amount)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [schoolId(req), plan.id, inst.seq, inst.label, inst.due_date, inst.amount]
        );
      }
      await client.query("COMMIT");
      res.status(201).json(plan);
    } catch (e) { await client.query("ROLLBACK").catch(() => {}); console.error(e); res.status(500).json({ error: "Erreur création du plan" }); }
    finally { client.release(); }
  });

  async function feePlanDetail(companyId, id) {
    const plan = (await pool.query(
      `SELECT p.*, s.first_name, s.last_name, s.matricule AS student_matricule,
              c.name AS class_name, y.label AS year_label
         FROM edu_feeplans p
         JOIN edu_students s ON s.id=p.student_id
         LEFT JOIN edu_classes c ON c.id=p.class_id
         LEFT JOIN edu_school_years y ON y.id=p.school_year_id
        WHERE p.company_id=$1 AND p.id=$2`, [companyId, id]
    )).rows[0];
    if (!plan) return null;
    plan.installments = (await pool.query(
      `SELECT id, company_id, plan_id, seq, label, due_date::text AS due_date, amount, amount_paid, status, created_at
         FROM edu_feeplan_installments WHERE company_id=$1 AND plan_id=$2 ORDER BY seq`, [companyId, id]
    )).rows;
    plan.payments = (await pool.query(
      `SELECT fp.*, COALESCE(u.fullname,'') AS recorded_by_name
         FROM edu_feeplan_payments fp LEFT JOIN users u ON u.id=fp.recorded_by
        WHERE fp.company_id=$1 AND fp.plan_id=$2 ORDER BY fp.created_at DESC`, [companyId, id]
    )).rows;
    plan.total_paid = plan.payments.filter((p) => p.status === "paid")
      .reduce((s, p) => s + Number(p.amount), 0).toFixed(2);
    return plan;
  }

  router.get("/fee-plans/:id", reserveAuDossier("echeancier"), async (req, res) => {
    const d = await feePlanDetail(schoolId(req), req.params.id);
    if (!d) return res.status(404).json({ error: "Plan introuvable" });
    res.json(d);
  });

  // Enregistre un versement sur un plan (affectation en cascade), génère le reçu.
  router.post("/fee-plans/:id/payments", requireRoles(MONEY_ROLES), async (req, res) => {
    try {
      const b = req.body || {};
      const amount = Number(b.amount || 0);
      if (!(amount > 0)) return res.status(400).json({ error: "Montant invalide." });
      const plan = (await pool.query(
        `SELECT id FROM edu_feeplans WHERE id=$1 AND company_id=$2 AND status<>'cancelled'`,
        [req.params.id, schoolId(req)]
      )).rows[0];
      if (!plan) return res.status(404).json({ error: "Plan introuvable" });
      if (b.installment_id) {
        const ech = await pool.query(
          `SELECT 1 FROM edu_feeplan_installments WHERE id=$1 AND plan_id=$2 AND company_id=$3`,
          [b.installment_id, plan.id, schoolId(req)]
        );
        if (!ech.rows[0]) return res.status(422).json({ error: "Cette échéance n'appartient pas à ce plan.", code: "ECHEANCE_HORS_PLAN" });
      }
      const receipt = await nextReceiptRef(schoolId(req));
      const signature = edupdf.signRef(["RECU", receipt]);
      const pay = (await pool.query(
        `INSERT INTO edu_feeplan_payments
           (company_id, plan_id, installment_id, receipt_number, amount, method, reference, status, signature, notes, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'paid',$8,$9,$10) RETURNING *`,
        [schoolId(req), req.params.id, b.installment_id || null, receipt, amount,
         b.method || "", b.reference || "", signature, b.notes || "", req.user.id]
      )).rows[0];
      const planState = await recomputeFeePlan(schoolId(req), req.params.id);
      const ecriture = await parcours?.ecrireCompta(pool, {
        companyId: schoolId(req), montant: amount, sens: "entrée", libelle: `Reçu ${receipt} — scolarité`,
        sourceId: pay.id, methode: b.method, userId: req.user.id,
      });
      if (ecriture) await pool.query(`UPDATE edu_feeplan_payments SET accounting_transaction_id=$1 WHERE id=$2`, [ecriture, pay.id]);
      await parcours?.synchroniserInscription(pool, schoolId(req), req.params.id);
      res.status(201).json({ payment: pay, plan: planState });
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur enregistrement du paiement" }); }
  });

  router.patch("/fee-payments/:id/cancel", requireRoles(MONEY_ROLES), async (req, res) => {
    try {
      const { rows } = await pool.query(
        `UPDATE edu_feeplan_payments SET status='cancelled'
          WHERE id=$1 AND company_id=$2 AND status='paid' RETURNING id, plan_id, amount, method, receipt_number`,
        [req.params.id, schoolId(req)]
      );
      if (!rows[0]) return res.status(404).json({ error: "Paiement introuvable ou déjà annulé." });
      const plan = await recomputeFeePlan(schoolId(req), rows[0].plan_id);
      // Un encaissement annulé laisse une trace comptable inverse, jamais un effacement.
      await parcours?.ecrireCompta(pool, {
        companyId: schoolId(req), montant: Number(rows[0].amount), sens: "sortie",
        libelle: `Annulation du reçu ${rows[0].receipt_number || rows[0].id}`, sourceId: rows[0].id,
        methode: rows[0].method, userId: req.user.id,
      });
      await parcours?.synchroniserInscription(pool, schoolId(req), rows[0].plan_id);
      res.json({ ok: true, plan });
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur annulation" }); }
  });

  async function feeSchoolHeader(companyId) {
    return (await pool.query(
      `SELECT co.name, es.address, es.phone, es.director_name, es.logo_url
         FROM companies co LEFT JOIN edu_schools es ON es.company_id=co.id WHERE co.id=$1 LIMIT 1`,
      [companyId]
    )).rows[0] || {};
  }

  // Échéancier PDF (§13) — tableau des mensualités.
  router.get("/fee-plans/:id/schedule/pdf", reserveAuDossier("echeancier"), async (req, res) => {
    try {
      const d = await feePlanDetail(schoolId(req), req.params.id);
      if (!d) return res.status(404).json({ error: "Plan introuvable" });
      const school = await feeSchoolHeader(schoolId(req));
      const rest = Math.max(0, Number(d.total_amount) - Number(d.total_paid));
      await edupdf.renderDocument(res, {
        filename: `echeancier-${d.reference || d.id}`,
        title: "Échéancier de scolarité",
        reference: `PLAN-${d.id}`,
        qrText: edupdf.docToken("PLAN", `PLAN-${d.id}`),
        school,
        sections: [
          { title: "Élève", rows: [
            { label: "Nom complet", value: `${d.first_name} ${d.last_name}` },
            { label: "Matricule", value: d.student_matricule },
            { label: "Classe", value: d.class_name || "—" },
            { label: "Année scolaire", value: d.year_label || "—" },
            { label: "Intitulé", value: d.label },
          ] },
          { title: "Échéancier", rows: d.installments.map((i) => ({
            label: `${i.label} — échéance ${i.due_date ? new Date(i.due_date).toLocaleDateString("fr-FR", { timeZone: "UTC" }) : "—"}`,
            value: `${Number(i.amount).toLocaleString("fr-FR")} FCFA · ${i.status === "paid" ? "payé" : i.status === "partial" ? `partiel (${Number(i.amount_paid).toLocaleString("fr-FR")})` : "à payer"}`,
          })) },
          { title: "Totaux", rows: [
            { label: "Total scolarité", value: `${Number(d.total_amount).toLocaleString("fr-FR")} FCFA` },
            { label: "Total payé", value: `${Number(d.total_paid).toLocaleString("fr-FR")} FCFA` },
            { label: "Reste à payer", value: `${rest.toLocaleString("fr-FR")} FCFA` },
          ] },
        ],
        footerNote: `Échéancier généré par MaliLink Éducation le ${new Date().toLocaleDateString("fr-FR")}. Authenticité vérifiable par le QR code.`,
      });
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur génération de l'échéancier PDF" }); }
  });

  // Reçu de mensualité PDF (§13).
  router.get("/fee-payments/:id/receipt", reserveAuDossier("paiement"), async (req, res) => {
    try {
      const pay = (await pool.query(
        `SELECT fp.*, p.label AS plan_label, p.total_amount,
                s.first_name, s.last_name, s.matricule AS student_matricule,
                c.name AS class_name, y.label AS year_label,
                COALESCE(u.fullname,'') AS recorded_by_name,
                COALESCE((SELECT SUM(amount) FROM edu_feeplan_payments x WHERE x.plan_id=fp.plan_id AND x.status='paid'),0) AS total_paid
           FROM edu_feeplan_payments fp
           JOIN edu_feeplans p ON p.id=fp.plan_id
           JOIN edu_students s ON s.id=p.student_id
           LEFT JOIN edu_classes c ON c.id=p.class_id
           LEFT JOIN edu_school_years y ON y.id=p.school_year_id
           LEFT JOIN users u ON u.id=fp.recorded_by
          WHERE fp.id=$1 AND fp.company_id=$2`,
        [req.params.id, schoolId(req)]
      )).rows[0];
      if (!pay) return res.status(404).json({ error: "Reçu introuvable" });
      const school = await feeSchoolHeader(schoolId(req));
      const ref = pay.receipt_number || `PAY-${pay.id}`;
      const rest = Math.max(0, Number(pay.total_amount) - Number(pay.total_paid));
      await edupdf.renderDocument(res, {
        filename: `recu-${ref}`,
        title: pay.status === "cancelled" ? "Reçu de mensualité (ANNULÉ)" : "Reçu de mensualité",
        reference: ref,
        qrText: edupdf.docToken("RECU", ref),
        school,
        sections: [
          { title: "Élève", rows: [
            { label: "Nom complet", value: `${pay.first_name} ${pay.last_name}` },
            { label: "Matricule", value: pay.student_matricule },
            { label: "Classe", value: pay.class_name || "—" },
            { label: "Année scolaire", value: pay.year_label || "—" },
            { label: "Plan", value: pay.plan_label },
          ] },
          { title: "Versement", rows: [
            { label: "Numéro de reçu", value: ref },
            { label: "Date", value: new Date(pay.created_at).toLocaleDateString("fr-FR") },
            { label: "Montant reçu", value: `${Number(pay.amount).toLocaleString("fr-FR")} FCFA` },
            { label: "Moyen de paiement", value: pay.method || "—" },
            { label: "Référence transaction", value: pay.reference || "—" },
            { label: "Encaissé par", value: pay.recorded_by_name || "—" },
          ] },
          { title: "Situation de la scolarité", rows: [
            { label: "Total scolarité", value: `${Number(pay.total_amount).toLocaleString("fr-FR")} FCFA` },
            { label: "Total payé", value: `${Number(pay.total_paid).toLocaleString("fr-FR")} FCFA` },
            { label: "Reste à payer", value: `${rest.toLocaleString("fr-FR")} FCFA` },
          ] },
        ],
        footerNote: `Reçu généré par MaliLink Éducation le ${new Date().toLocaleDateString("fr-FR")}. Authenticité vérifiable par le QR code.`,
      });
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur génération du reçu PDF" }); }
  });

  // ---------- EMPLOIS DU TEMPS (§7) + CONFLITS (§8) ----------

  const DAYS = ["", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];

  // Détecte un chevauchement pour le professeur, la classe ou la salle.
  async function scheduleConflict(companyId, s, excludeId = null) {
    const { rows } = await pool.query(
      `SELECT sc.*, t.first_name, t.last_name, c.name AS class_name
         FROM edu_schedules sc
         LEFT JOIN edu_teachers t ON t.id=sc.teacher_id
         LEFT JOIN edu_classes c ON c.id=sc.class_id
        WHERE sc.company_id=$1 AND sc.status='actif' AND sc.day_of_week=$2
          AND sc.start_time < $4 AND sc.end_time > $3
          AND ($7::int IS NULL OR sc.id <> $7)
          AND (
            ($5::int IS NOT NULL AND sc.teacher_id=$5)
            OR sc.class_id=$6
            OR ($8 <> '' AND lower(sc.room)=lower($8))
          )
        LIMIT 1`,
      [companyId, s.day_of_week, s.start_time, s.end_time, s.teacher_id || null, s.class_id, excludeId, s.room || ""]
    );
    const c = rows[0];
    if (!c) return null;
    const h = (t) => String(t).slice(0, 5);
    let who;
    if (s.teacher_id && c.teacher_id === s.teacher_id) who = `${c.first_name} ${c.last_name} enseigne déjà`;
    else if (c.class_id === s.class_id) who = `La classe ${c.class_name} a déjà cours`;
    else who = `La salle ${c.room} est déjà occupée`;
    return `Impossible d'enregistrer ce cours. ${who} le ${DAYS[s.day_of_week]} de ${h(c.start_time)} à ${h(c.end_time)}.`;
  }

  router.get("/schedules", async (req, res) => {
    try {
      const classId = req.query.class_id ? Number(req.query.class_id) : null;
      const teacherId = req.query.teacher_id ? Number(req.query.teacher_id) : null;
      const { rows } = await pool.query(
        `SELECT sc.*, t.first_name AS teacher_first, t.last_name AS teacher_last,
                c.name AS class_name, s.name AS subject_name
           FROM edu_schedules sc
           LEFT JOIN edu_teachers t ON t.id=sc.teacher_id
           LEFT JOIN edu_classes c ON c.id=sc.class_id
           LEFT JOIN edu_subjects s ON s.id=sc.subject_id
          WHERE sc.company_id=$1 AND sc.status<>'annule'
            AND ($2::int IS NULL OR sc.class_id=$2)
            AND ($3::int IS NULL OR sc.teacher_id=$3)
          ORDER BY sc.day_of_week, sc.start_time`,
        [schoolId(req), classId, teacherId]
      );
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur emploi du temps" }); }
  });

  router.post("/schedules", requireRoles(STAFF_ROLES), async (req, res) => {
    try {
      const b = req.body || {};
      const day = Number(b.day_of_week);
      if (!b.class_id || !day || day < 1 || day > 7 || !b.start_time || !b.end_time) {
        return res.status(400).json({ error: "Classe, jour (1-7), heure de début et de fin obligatoires." });
      }
      if (b.end_time <= b.start_time) return res.status(400).json({ error: "L'heure de fin doit être après l'heure de début." });
      const own = await pool.query(`SELECT 1 FROM edu_classes WHERE id=$1 AND company_id=$2`, [b.class_id, schoolId(req)]);
      if (!own.rows[0]) return res.status(403).json({ error: "Classe hors de votre établissement." });

      const conflict = await scheduleConflict(schoolId(req), {
        day_of_week: day, start_time: b.start_time, end_time: b.end_time, teacher_id: b.teacher_id || null, class_id: b.class_id, room: b.room || "",
      });
      if (conflict) return res.status(409).json({ error: conflict });

      const { rows } = await pool.query(
        `INSERT INTO edu_schedules
           (company_id, assignment_id, teacher_id, class_id, subject_id, school_year_id, day_of_week,
            start_time, end_time, room, frequency, session_type, mode, meeting_link, valid_from, valid_to, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
        [schoolId(req), b.assignment_id || null, b.teacher_id || null, b.class_id, b.subject_id || null,
         b.school_year_id || null, day, b.start_time, b.end_time, b.room || "", b.frequency || "weekly",
         b.session_type || "cours", b.mode || "presentiel", b.meeting_link || "", b.valid_from || null, b.valid_to || null, req.user.id]
      );
      res.status(201).json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur création du cours" }); }
  });

  router.patch("/schedules/:id", requireRoles(STAFF_ROLES), async (req, res) => {
    try {
      const b = req.body || {};
      const cur = await pool.query(`SELECT * FROM edu_schedules WHERE id=$1 AND company_id=$2`, [req.params.id, schoolId(req)]);
      if (!cur.rows[0]) return res.status(404).json({ error: "Cours introuvable" });
      const merged = { ...cur.rows[0], ...b };
      if (merged.end_time <= merged.start_time) return res.status(400).json({ error: "L'heure de fin doit être après l'heure de début." });
      const conflict = await scheduleConflict(schoolId(req), merged, Number(req.params.id));
      if (conflict) return res.status(409).json({ error: conflict });
      const fields = ["teacher_id", "subject_id", "day_of_week", "start_time", "end_time", "room",
        "frequency", "session_type", "mode", "meeting_link", "valid_from", "valid_to", "status"];
      const set = []; const vals = [];
      for (const f of fields) { if (b[f] !== undefined) { vals.push(b[f]); set.push(`${f}=$${vals.length}`); } }
      if (set.length === 0) return res.status(400).json({ error: "Aucune modification" });
      vals.push(req.params.id, schoolId(req));
      const { rows } = await pool.query(
        `UPDATE edu_schedules SET ${set.join(", ")}, updated_at=NOW() WHERE id=$${vals.length - 1} AND company_id=$${vals.length} RETURNING *`,
        vals
      );
      res.json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur modification du cours" }); }
  });

  router.delete("/schedules/:id", requireRoles(STAFF_ROLES), async (req, res) => {
    try {
      const { rowCount } = await pool.query(`DELETE FROM edu_schedules WHERE id=$1 AND company_id=$2`, [req.params.id, schoolId(req)]);
      if (!rowCount) return res.status(404).json({ error: "Cours introuvable" });
      res.json({ ok: true });
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur suppression du cours" }); }
  });

  // Vues d'emploi du temps (par classe / par professeur).
  router.get("/timetables/class/:classId", async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT sc.*, t.first_name AS teacher_first, t.last_name AS teacher_last, s.name AS subject_name
           FROM edu_schedules sc LEFT JOIN edu_teachers t ON t.id=sc.teacher_id
           LEFT JOIN edu_subjects s ON s.id=sc.subject_id
          WHERE sc.company_id=$1 AND sc.class_id=$2 AND sc.status='actif'
          ORDER BY sc.day_of_week, sc.start_time`,
        [schoolId(req), req.params.classId]
      );
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur emploi du temps classe" }); }
  });

  router.get("/timetables/teacher/:teacherId", async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT sc.*, c.name AS class_name, s.name AS subject_name
           FROM edu_schedules sc LEFT JOIN edu_classes c ON c.id=sc.class_id
           LEFT JOIN edu_subjects s ON s.id=sc.subject_id
          WHERE sc.company_id=$1 AND sc.teacher_id=$2 AND sc.status='actif'
          ORDER BY sc.day_of_week, sc.start_time`,
        [schoolId(req), req.params.teacherId]
      );
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur emploi du temps professeur" }); }
  });

  // ---------- ÉLÈVES + BADGES QR ----------

  router.get("/students", async (req, res) => {
    try {
      const classFilter = req.query.class_id ? Number(req.query.class_id) : null;
      if (req.eduRole === "parent") {
        const ids = await parentStudentIds(req);
        if (ids.length === 0) return res.json([]);
        const { rows } = await pool.query(
          `SELECT s.*, c.name AS class_name FROM edu_students s
           LEFT JOIN edu_classes c ON c.id=s.class_id
           WHERE s.id = ANY($1) ORDER BY s.last_name`,
          [ids]
        );
        return res.json(rows.map(({ photo_key, ...r }) => ({ ...r, photo_url: parcours.urlFichier("eleve", photo_key) })));
      }
      if (req.eduRole === "teacher") {
        const classes = await teacherClassIds(req);
        if (classes.length === 0) return res.json([]);
        const { rows } = await pool.query(
          `SELECT s.*, c.name AS class_name FROM edu_students s
           LEFT JOIN edu_classes c ON c.id=s.class_id
           WHERE s.class_id = ANY($1) AND ($2::int IS NULL OR s.class_id=$2)
           ORDER BY s.last_name`,
          [classes, classFilter]
        );
        return res.json(rows.map(({ photo_key, ...r }) => ({ ...r, photo_url: parcours.urlFichier("eleve", photo_key) })));
      }
      if (!STAFF_ROLES.includes(req.eduRole) && !MONEY_ROLES.includes(req.eduRole)) {
        return res.status(403).json({ error: "Accès refusé" });
      }
      const archives = req.query.archives === "1";
      const recherche = String(req.query.q || "").trim().slice(0, 60);
      const { rows } = await pool.query(
        `SELECT s.*, c.name AS class_name, c.level AS class_level FROM edu_students s
         LEFT JOIN edu_classes c ON c.id=s.class_id
         WHERE s.company_id=$1 AND ($2::int IS NULL OR s.class_id=$2)
           AND (CASE WHEN $3::boolean THEN s.archived_at IS NOT NULL ELSE s.archived_at IS NULL END)
           AND ($4::text = '' OR s.last_name ILIKE '%'||$4||'%' OR s.first_name ILIKE '%'||$4||'%' OR s.matricule ILIKE '%'||$4||'%')
         ORDER BY s.last_name, s.first_name LIMIT 1000`,
        [schoolId(req), classFilter, archives, recherche]
      );
      res.json(rows.map(({ photo_key, ...r }) => ({ ...r, photo_url: parcours.urlFichier("eleve", photo_key) })));
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur élèves" }); }
  });

  // Création élève : matricule + QR générés automatiquement
  router.post("/students", requireRoles(STAFF_ROLES), async (req, res) => {
    try {
      const { first_name, last_name, gender, birth_date, class_id, parent_user_id } = req.body || {};
      if (!first_name || !last_name) return res.status(400).json({ error: "Nom et prénom requis" });

      // L'écran d'inscription est le seul parcours de l'interface ; cette route
      // reste pour l'import et les intégrations, avec les mêmes garde-fous.
      if (class_id) await parcours.verifierReferences(pool, schoolId(req), { classId: Number(class_id) });
      if (parent_user_id) {
        const parent = await pool.query(`SELECT 1 FROM users WHERE id=$1 AND company_id=$2`, [Number(parent_user_id), schoolId(req)]);
        if (!parent.rows[0]) return res.status(404).json({ error: "Parent introuvable dans votre établissement." });
      }
      const etab = await parcours.etablissement(pool, schoolId(req));
      const matricule = await parcours.genererMatricule(pool, schoolId(req), etab.matricule_prefix);
      const qrCode = `EDU-${crypto.randomBytes(12).toString("hex")}`;

      const { rows } = await pool.query(
        `INSERT INTO edu_students (company_id, first_name, last_name, gender, birth_date, class_id, matricule, qr_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [schoolId(req), first_name, last_name, gender || null, birth_date || null, class_id || null, matricule, qrCode]
      );
      const student = rows[0];

      if (parent_user_id) {
        await pool.query(
          `INSERT INTO edu_student_parents (student_id, parent_user_id)
           VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [student.id, parent_user_id]
        );
      }
      res.status(201).json(student);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      console.error(e); res.status(500).json({ error: "Erreur création élève" });
    }
  });

  // Badge QR (data URL PNG) — imprimable
  router.get("/students/:id/badge", async (req, res) => {
    try {
      const student = await assertStudentAccess(req, req.params.id);
      if (!student) return res.status(404).json({ error: "Élève introuvable ou accès refusé" });
      const qrDataUrl = await QRCode.toDataURL(student.qr_code, { width: 300, margin: 1 });
      res.json({
        matricule: student.matricule,
        first_name: student.first_name,
        last_name: student.last_name,
        class_id: student.class_id,
        qr_data_url: qrDataUrl
      });
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur badge" }); }
  });

  router.post("/students/:id/parents", requireRoles(STAFF_ROLES), async (req, res) => {
    try {
      const student = await assertStudentAccess(req, req.params.id);
      if (!student) return res.status(404).json({ error: "Élève introuvable" });
      const { parent_user_id, relation } = req.body || {};
      if (!parent_user_id) return res.status(400).json({ error: "parent_user_id requis" });
      await pool.query(
        `INSERT INTO edu_student_parents (student_id, parent_user_id, relation)
         VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [student.id, parent_user_id, relation || "parent"]
      );
      res.status(201).json({ ok: true });
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur liaison parent" }); }
  });

  // ---------- PRÉSENCES (scan QR + appel) ----------

  // Scan badge à l'entrée (surveillant / tablette avec compte staff)
  router.post("/attendance/scan", requireRoles([...STAFF_ROLES, "teacher"]), async (req, res) => {
    try {
      const { qr_code, action = "entree" } = req.body || {};
      if (!qr_code) return res.status(400).json({ error: "QR manquant" });

      // Deux QR acceptés : l'ancien code de badge (EDU-…) et le QR de la
      // carte scolaire (URL /verifier/<jeton>, carte valide uniquement).
      const lu = String(qr_code).trim().slice(0, 300);
      const jeton = (lu.match(/\/verifier\/([A-Za-z0-9_-]{20,64})/) || [])[1]
        || (!lu.startsWith("EDU-") && /^[A-Za-z0-9_-]{20,64}$/.test(lu) ? lu : null);
      const { rows } = jeton
        ? await pool.query(
          `SELECT s.* FROM edu_document_verifications v JOIN edu_students s ON s.id=v.student_id AND s.company_id=v.company_id
            WHERE v.token=$1 AND v.company_id=$2 AND v.doc_type='carte' AND v.status='valide' AND s.archived_at IS NULL`,
          [jeton, schoolId(req)])
        : await pool.query("SELECT * FROM edu_students WHERE qr_code=$1 AND company_id=$2 AND archived_at IS NULL", [lu, schoolId(req)]);
      const trouve = rows[0];
      if (!trouve) return res.status(404).json({ error: "Élève introuvable dans cet établissement (ou carte remplacée)" });
      const { photo_key, ...student } = trouve;
      student.photo_url = parcours.urlFichier("eleve", photo_key);

      if (action === "sortie") {
        const upd = await pool.query(
          `UPDATE edu_attendance SET check_out_at=NOW(), status=CASE WHEN status='present' THEN 'present' ELSE status END
           WHERE student_id=$1 AND attendance_date=CURRENT_DATE RETURNING *`,
          [student.id]
        );
        return res.json({ student, attendance: upd.rows[0] || null, action: "sortie" });
      }

      // Anti-double scan (§5) : si une présence existe déjà aujourd'hui, on
      // ne recrée rien et on le signale clairement (l'heure d'entrée initiale
      // est conservée par la contrainte ON CONFLICT).
      const existing = await pool.query(
        `SELECT * FROM edu_attendance WHERE student_id=$1 AND attendance_date=CURRENT_DATE`,
        [student.id]
      );
      if (existing.rows[0]) {
        return res.json({ student, attendance: existing.rows[0], action: "entree", already_recorded: true });
      }

      // retard si arrivée après 08h15 (paramétrable plus tard)
      const now = new Date();
      const lateLimit = new Date(now); lateLimit.setHours(8, 15, 0, 0);
      const status = now > lateLimit ? "retard" : "present";

      const ins = await pool.query(
        `INSERT INTO edu_attendance (company_id, student_id, class_id, attendance_date, status, check_in_at, source, recorded_by_user_id)
         VALUES ($1,$2,$3,CURRENT_DATE,$4,NOW(),'scan',$5)
         ON CONFLICT (student_id, attendance_date) DO UPDATE SET check_in_at=COALESCE(edu_attendance.check_in_at, NOW())
         RETURNING *`,
        [schoolId(req), student.id, student.class_id, status, req.user.id]
      );
      res.json({ student, attendance: ins.rows[0], action: "entree", already_recorded: false });
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur scan" }); }
  });

  // Appel en classe (professeur) : liste de {student_id, status}
  router.post("/attendance/roll-call", requireRoles([...STAFF_ROLES, "teacher"]), async (req, res) => {
    try {
      const { class_id, entries } = req.body || {};
      if (!class_id || !Array.isArray(entries)) {
        return res.status(400).json({ error: "class_id et entries requis" });
      }
      if (req.eduRole === "teacher") {
        const classes = await teacherClassIds(req);
        if (!classes.includes(Number(class_id))) {
          return res.status(403).json({ error: "Classe non affectée à ce professeur" });
        }
      }
      // Toute la liste doit appartenir à la classe appelée (même établissement).
      const lot = entries.slice(0, 200);
      if (!(await elevesDeLaClasse(schoolId(req), class_id, lot.map((e) => e.student_id)))) {
        return res.status(422).json({ error: "Un élève de la liste n'appartient pas à cette classe.", code: "ELEVE_HORS_CLASSE" });
      }
      let count = 0;
      for (const entry of lot) {
        const st = ["present", "retard", "absent", "absence_justifiee"].includes(entry.status)
          ? entry.status : "present";
        await pool.query(
          `INSERT INTO edu_attendance (company_id, student_id, class_id, attendance_date, status, source, recorded_by_user_id, check_in_at)
           VALUES ($1,$2,$3,CURRENT_DATE,$4,'appel',$5, CASE WHEN $4 IN ('present','retard') THEN NOW() ELSE NULL END)
           ON CONFLICT (student_id, attendance_date) DO UPDATE SET status=$4, source='appel', recorded_by_user_id=$5`,
          [schoolId(req), entry.student_id, class_id, st, req.user.id]
        );
        count++;
      }
      res.json({ ok: true, count });
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur appel" }); }
  });

  router.get("/attendance", async (req, res) => {
    try {
      const date = req.query.date || new Date().toISOString().slice(0, 10);
      const classId = req.query.class_id ? Number(req.query.class_id) : null;
      const studentId = req.query.student_id ? Number(req.query.student_id) : null;

      if (studentId) {
        const student = await assertStudentAccess(req, studentId);
        if (!student) return res.status(403).json({ error: "Accès refusé" });
        const { rows } = await pool.query(
          `SELECT * FROM edu_attendance WHERE student_id=$1 ORDER BY attendance_date DESC LIMIT 200`,
          [studentId]
        );
        return res.json(rows);
      }

      if (!GRADE_ROLES.includes(req.eduRole)) return res.status(403).json({ error: "Accès refusé" });
      if (req.eduRole === "teacher" && classId) {
        const classes = await teacherClassIds(req);
        if (!classes.includes(classId)) return res.status(403).json({ error: "Classe non affectée" });
      }

      const { rows } = await pool.query(
        `SELECT a.*, s.first_name, s.last_name, s.matricule, c.name AS class_name
         FROM edu_attendance a
         JOIN edu_students s ON s.id=a.student_id
         LEFT JOIN edu_classes c ON c.id=a.class_id
         WHERE a.company_id=$1 AND a.attendance_date=$2 AND ($3::int IS NULL OR a.class_id=$3)
         ORDER BY s.last_name`,
        [schoolId(req), date, classId]
      );
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur présences" }); }
  });

  // ---------- ÉVALUATIONS / NOTES / MOYENNES ----------

  router.post("/exams", requireRoles(GRADE_ROLES), async (req, res) => {
    try {
      const { term_id, class_id, subject_id, exam_type, title, exam_date, max_score, weight } = req.body || {};
      if (!class_id || !subject_id || !title) {
        return res.status(400).json({ error: "Classe, matière et titre requis" });
      }
      if (req.eduRole === "teacher") {
        const classes = await teacherClassIds(req);
        if (!classes.includes(Number(class_id))) return res.status(403).json({ error: "Classe non affectée" });
      }
      const { rows } = await pool.query(
        `INSERT INTO edu_exams (company_id, term_id, class_id, subject_id, teacher_user_id, exam_type, title, exam_date, max_score, weight)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [schoolId(req), term_id || null, class_id, subject_id, req.user.id,
         exam_type || "devoir", title, exam_date || null, max_score || 20, weight || 1]
      );
      res.status(201).json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur évaluation" }); }
  });

  router.get("/exams", requireRoles(GRADE_ROLES), async (req, res) => {
    try {
      const classId = req.query.class_id ? Number(req.query.class_id) : null;
      const { rows } = await pool.query(
        `SELECT e.*, s.name AS subject_name, c.name AS class_name
         FROM edu_exams e
         JOIN edu_subjects s ON s.id=e.subject_id
         JOIN edu_classes c ON c.id=e.class_id
         WHERE e.company_id=$1 AND ($2::int IS NULL OR e.class_id=$2)
         ORDER BY e.exam_date DESC NULLS LAST LIMIT 200`,
        [schoolId(req), classId]
      );
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur évaluations" }); }
  });

  // Saisie des notes en masse : [{student_id, score, remark}]
  router.post("/exams/:id/grades", requireRoles(GRADE_ROLES), async (req, res) => {
    try {
      const examId = Number(req.params.id);
      const { rows: exams } = await pool.query(
        "SELECT * FROM edu_exams WHERE id=$1 AND company_id=$2",
        [examId, schoolId(req)]
      );
      const exam = exams[0];
      if (!exam) return res.status(404).json({ error: "Évaluation introuvable" });
      if (req.eduRole === "teacher") {
        const classes = await teacherClassIds(req);
        if (!classes.includes(exam.class_id)) return res.status(403).json({ error: "Classe non affectée" });
      }

      const grades = Array.isArray(req.body?.grades) ? req.body.grades.slice(0, 200) : [];
      if (!(await elevesDeLaClasse(schoolId(req), exam.class_id, grades.map((g) => g.student_id)))) {
        return res.status(422).json({ error: "Un élève de la liste n'appartient pas à la classe de l'évaluation.", code: "ELEVE_HORS_CLASSE" });
      }
      let count = 0;
      for (const g of grades) {
        const score = Number(g.score);
        if (!Number.isFinite(score) || score < 0 || score > Number(exam.max_score)) continue;
        await pool.query(
          `INSERT INTO edu_grades (exam_id, student_id, score, remark)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (exam_id, student_id) DO UPDATE SET score=$3, remark=$4`,
          [examId, g.student_id, score, g.remark || null]
        );
        count++;
      }
      res.json({ ok: true, count });
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur notes" }); }
  });

  // Moyennes d'un élève (par matière + générale) pour une période
  async function computeStudentAverages(companyId, studentId, termId) {
    const { rows } = await pool.query(
      `SELECT sub.id AS subject_id, sub.name AS subject_name, sub.coefficient,
              SUM((g.score / e.max_score) * 20 * e.weight) / NULLIF(SUM(e.weight), 0) AS subject_average
       FROM edu_grades g
       JOIN edu_exams e ON e.id=g.exam_id
       JOIN edu_subjects sub ON sub.id=e.subject_id
       WHERE g.student_id=$1 AND e.company_id=$2 AND ($3::int IS NULL OR e.term_id=$3)
       GROUP BY sub.id, sub.name, sub.coefficient
       ORDER BY sub.name`,
      [studentId, companyId, termId]
    );
    const subjects = rows.map((r) => ({
      ...r,
      subject_average: r.subject_average === null ? null : Math.round(Number(r.subject_average) * 100) / 100
    }));
    const totalCoef = subjects.reduce((acc, s) => acc + Number(s.coefficient), 0);
    const weighted = subjects.reduce(
      (acc, s) => acc + Number(s.subject_average || 0) * Number(s.coefficient), 0
    );
    const general = totalCoef > 0 ? Math.round((weighted / totalCoef) * 100) / 100 : null;
    return { subjects, general_average: general };
  }

  router.get("/students/:id/averages", async (req, res) => {
    try {
      const student = await assertStudentAccess(req, req.params.id);
      if (!student) return res.status(403).json({ error: "Accès refusé" });
      const termId = req.query.term_id ? Number(req.query.term_id) : null;
      const result = await computeStudentAverages(schoolId(req), student.id, termId);
      res.json(result);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur moyennes" }); }
  });

  // ---------- BULLETINS ----------

  // Génération des bulletins d'une classe pour une période (calcul + rang)
  router.post("/report-cards/generate", requireRoles(STAFF_ROLES), async (req, res) => {
    try {
      const { term_id, class_id } = req.body || {};
      if (!term_id || !class_id) return res.status(400).json({ error: "term_id et class_id requis" });

      const { rows: students } = await pool.query(
        "SELECT * FROM edu_students WHERE class_id=$1 AND company_id=$2 AND status='actif'",
        [class_id, schoolId(req)]
      );
      if (students.length === 0) return res.status(404).json({ error: "Aucun élève dans cette classe" });

      const results = [];
      for (const s of students) {
        const avg = await computeStudentAverages(schoolId(req), s.id, Number(term_id));
        const att = await pool.query(
          `SELECT COUNT(*) FILTER (WHERE status IN ('absent','absence_justifiee')) AS absences,
                  COUNT(*) FILTER (WHERE status='retard') AS retards
           FROM edu_attendance WHERE student_id=$1`,
          [s.id]
        );
        results.push({
          student: s,
          general_average: avg.general_average,
          details: avg.subjects,
          absences: Number(att.rows[0].absences),
          retards: Number(att.rows[0].retards)
        });
      }

      results.sort((a, b) => (b.general_average || 0) - (a.general_average || 0));

      let generated = 0;
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        await pool.query(
          `INSERT INTO edu_report_cards
             (company_id, student_id, term_id, general_average, rank_in_class, class_size,
              absences_count, late_count, details, generated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
           ON CONFLICT (student_id, term_id) DO UPDATE SET
             general_average=$4, rank_in_class=$5, class_size=$6,
             absences_count=$7, late_count=$8, details=$9, generated_at=NOW()`,
          [schoolId(req), r.student.id, term_id, r.general_average, i + 1, results.length,
           r.absences, r.retards, JSON.stringify(r.details)]
        );
        generated++;
      }
      res.json({ ok: true, generated });
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur génération bulletins" }); }
  });

  router.get("/students/:id/report-cards", async (req, res) => {
    try {
      const student = await assertStudentAccess(req, req.params.id);
      if (!student) return res.status(403).json({ error: "Accès refusé" });
      const { rows } = await pool.query(
        `SELECT rc.*, t.label AS term_label FROM edu_report_cards rc
         JOIN edu_terms t ON t.id=rc.term_id
         WHERE rc.student_id=$1 ORDER BY rc.term_id DESC`,
        [student.id]
      );
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur bulletins" }); }
  });

  // Mention selon la moyenne générale (système /20).
  function mention(avg) {
    if (avg == null) return "—";
    const a = Number(avg);
    if (a >= 18) return "Excellent";
    if (a >= 16) return "Très bien";
    if (a >= 14) return "Bien";
    if (a >= 12) return "Assez bien";
    if (a >= 10) return "Passable";
    return "Insuffisant";
  }

  // Liste des bulletins générés pour une classe + période (avec noms d'élèves).
  router.get("/classes/:id/report-cards", requireRoles(GRADE_ROLES), async (req, res) => {
    try {
      const termId = req.query.term_id ? Number(req.query.term_id) : null;
      const { rows } = await pool.query(
        `SELECT rc.id, rc.student_id, rc.term_id, rc.general_average, rc.rank_in_class, rc.class_size,
                rc.absences_count, rc.late_count, rc.appreciation, rc.conduct, rc.council_decision,
                s.first_name, s.last_name, s.matricule AS student_matricule, t.label AS term_label
           FROM edu_report_cards rc
           JOIN edu_students s ON s.id=rc.student_id
           JOIN edu_terms t ON t.id=rc.term_id
          WHERE rc.company_id=$1 AND s.class_id=$2 AND ($3::int IS NULL OR rc.term_id=$3)
          ORDER BY rc.rank_in_class NULLS LAST, s.last_name`,
        [schoolId(req), req.params.id, termId]
      );
      res.json(rows.map((r) => ({ ...r, mention: mention(r.general_average) })));
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur bulletins" }); }
  });

  // Appréciation / conduite / décision du conseil sur un bulletin.
  router.patch("/report-cards/:id", requireRoles(STAFF_ROLES), async (req, res) => {
    try {
      const b = req.body || {};
      const { rows } = await pool.query(
        `UPDATE edu_report_cards SET
           appreciation=COALESCE($3, appreciation),
           conduct=COALESCE($4, conduct),
           council_decision=COALESCE($5, council_decision)
         WHERE id=$1 AND company_id=$2 RETURNING *`,
        [req.params.id, schoolId(req), b.appreciation ?? null, b.conduct ?? null, b.council_decision ?? null]
      );
      if (!rows[0]) return res.status(404).json({ error: "Bulletin introuvable" });
      res.json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur bulletin" }); }
  });

  // Bulletin PDF (§16) — tableau des matières, moyenne, rang, mention, QR signé.
  router.get("/report-cards/:id/pdf", reserveAuDossier("bulletin"), async (req, res) => {
    try {
      const rc = (await pool.query(
        `SELECT rc.*, s.first_name, s.last_name, s.matricule AS student_matricule, s.gender,
                c.name AS class_name, t.label AS term_label, y.label AS year_label
           FROM edu_report_cards rc
           JOIN edu_students s ON s.id=rc.student_id
           LEFT JOIN edu_classes c ON c.id=s.class_id
           JOIN edu_terms t ON t.id=rc.term_id
           LEFT JOIN edu_school_years y ON y.id=t.school_year_id
          WHERE rc.id=$1 AND rc.company_id=$2`,
        [req.params.id, schoolId(req)]
      )).rows[0];
      if (!rc) return res.status(404).json({ error: "Bulletin introuvable" });
      const school = (await pool.query(
        `SELECT co.name, es.address, es.phone, es.director_name, es.logo_url
           FROM companies co LEFT JOIN edu_schools es ON es.company_id=co.id WHERE co.id=$1 LIMIT 1`,
        [schoolId(req)]
      )).rows[0] || {};
      let details = [];
      try { details = Array.isArray(rc.details) ? rc.details : JSON.parse(rc.details || "[]"); } catch { details = []; }
      const ref = `BUL-${rc.id}`;
      const subjectRows = details.map((d) => {
        const coef = Number(d.coefficient) || 0;
        const avg = d.subject_average == null ? null : Number(d.subject_average);
        return [
          d.subject_name,
          coef.toString(),
          avg == null ? "—" : avg.toFixed(2),
          avg == null ? "—" : (avg * coef).toFixed(2),
          avg == null ? "—" : mention(avg),
        ];
      });
      const totalCoef = details.reduce((s, d) => s + (Number(d.coefficient) || 0), 0);
      const totalPts = details.reduce((s, d) => s + (d.subject_average == null ? 0 : Number(d.subject_average) * (Number(d.coefficient) || 0)), 0);
      await edupdf.renderDocument(res, {
        filename: `bulletin-${rc.student_matricule || rc.id}`,
        title: "Bulletin de notes",
        subtitle: `${rc.term_label || ""}${rc.year_label ? " · " + rc.year_label : ""}`,
        reference: ref,
        qrText: edupdf.docToken("BULLETIN", ref),
        school,
        sections: [
          { title: "Élève", rows: [
            { label: "Nom complet", value: `${rc.first_name} ${rc.last_name}` },
            { label: "Matricule", value: rc.student_matricule },
            { label: "Classe", value: rc.class_name || "—" },
          ] },
          { title: "Résultats par matière", table: {
            columns: [
              { label: "Matière", width: 200 },
              { label: "Coef", width: 45, align: "center" },
              { label: "Moy./20", width: 70, align: "center" },
              { label: "Moy×Coef", width: 80, align: "center" },
              { label: "Mention", width: 110 },
            ],
            rows: [
              ...subjectRows,
              ["TOTAL", totalCoef.toString(), "", totalPts.toFixed(2), ""],
            ],
          } },
          { title: "Synthèse", rows: [
            { label: "Moyenne générale", value: rc.general_average == null ? "—" : `${Number(rc.general_average).toFixed(2)}/20` },
            { label: "Mention", value: mention(rc.general_average) },
            { label: "Rang", value: rc.rank_in_class ? `${rc.rank_in_class}ᵉ / ${rc.class_size}` : "—" },
            { label: "Absences", value: String(rc.absences_count ?? 0) },
            { label: "Retards", value: String(rc.late_count ?? 0) },
            { label: "Conduite", value: rc.conduct || "—" },
            { label: "Appréciation", value: rc.appreciation || "—" },
            { label: "Décision du conseil", value: rc.council_decision || "—" },
          ] },
        ],
        footerNote: `Bulletin généré par MaliLink Éducation le ${new Date().toLocaleDateString("fr-FR")}. Authenticité vérifiable par le QR code.`,
      });
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur génération du bulletin PDF" }); }
  });

  // ---------- PAIEMENTS SCOLAIRES ----------

  router.get("/fees", requireRoles([...MONEY_ROLES, "parent"]), async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT f.*, c.name AS class_name FROM edu_fees f
         LEFT JOIN edu_classes c ON c.id=f.class_id
         WHERE f.company_id=$1 ORDER BY f.due_date NULLS LAST`,
        [schoolId(req)]
      );
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur frais" }); }
  });

  router.post("/fees", requireRoles(MONEY_ROLES), async (req, res) => {
    try {
      const { label, fee_type, amount, class_id, due_date, school_year_id } = req.body || {};
      if (!label || !amount) return res.status(400).json({ error: "Libellé et montant requis" });
      const { rows } = await pool.query(
        `INSERT INTO edu_fees (company_id, label, fee_type, amount, class_id, due_date, school_year_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [schoolId(req), label, fee_type || "scolarite", amount, class_id || null, due_date || null, school_year_id || null]
      );
      res.status(201).json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur frais" }); }
  });

  router.post("/fee-payments", requireRoles(MONEY_ROLES), async (req, res) => {
    try {
      const { fee_id, student_id, amount, payment_method, reference, paid_by_user_id } = req.body || {};
      if (!fee_id || !student_id || !amount) {
        return res.status(400).json({ error: "fee_id, student_id et montant requis" });
      }
      const student = await assertStudentAccess(req, student_id);
      if (!student) return res.status(404).json({ error: "Élève introuvable" });
      const fee = await pool.query(`SELECT id FROM edu_fees WHERE id=$1 AND company_id=$2`, [Number(fee_id), schoolId(req)]);
      if (!fee.rows[0]) return res.status(404).json({ error: "Frais introuvable" });
      if (!(Number(amount) > 0)) return res.status(400).json({ error: "Montant invalide." });
      /* Ancien circuit « frais » : il écrivait par erreur dans
         edu_feeplan_payments (colonnes inexistantes → erreur 500). */
      const { rows } = await pool.query(
        `INSERT INTO edu_fee_payments (company_id, fee_id, student_id, amount, payment_method, reference, paid_by_user_id, recorded_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,NULL,$7) RETURNING *`,
        [schoolId(req), fee.rows[0].id, student.id, Number(amount), payment_method || "especes",
         reference || null, req.user.id]
      );
      res.status(201).json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur paiement" }); }
  });

  // Situation financière d'un élève (parent, direction, comptable) :
  // anciens frais, échéanciers (inscription + mensualités) et tous les reçus.
  router.get("/students/:id/finances", async (req, res) => {
    try {
      const student = await assertStudentAccess(req, req.params.id);
      if (!student) return res.status(403).json({ error: "Accès refusé" });
      const cid = schoolId(req);
      const [fees, payments, plans] = await Promise.all([
        pool.query(
          `SELECT f.*, COALESCE(p.paid, 0) AS paid, (f.amount - COALESCE(p.paid, 0)) AS remaining
             FROM edu_fees f
             LEFT JOIN LATERAL (
               SELECT SUM(amount) AS paid FROM edu_fee_payments
                WHERE fee_id=f.id AND student_id=$1 AND company_id=$2
             ) p ON true
            WHERE f.company_id=$2 AND (f.class_id IS NULL OR f.class_id=$3)
            ORDER BY f.due_date NULLS LAST`,
          [student.id, cid, student.class_id]
        ),
        pool.query(
          `SELECT * FROM (
             SELECT 'frais' AS source, id, amount, payment_method AS method, reference, NULL::text AS receipt_number,
                    'paid' AS status, COALESCE(paid_at, created_at) AS created_at
               FROM edu_fee_payments WHERE student_id=$1 AND company_id=$2
             UNION ALL
             SELECT 'echeancier', fp.id, fp.amount, fp.method, fp.reference, fp.receipt_number, fp.status, fp.created_at
               FROM edu_feeplan_payments fp JOIN edu_feeplans p ON p.id=fp.plan_id
              WHERE p.student_id=$1 AND fp.company_id=$2
             UNION ALL
             SELECT 'inscription', ep.id, ep.amount, ep.method, ep.reference, ep.receipt_number, ep.status, ep.created_at
               FROM edu_enrollment_payments ep JOIN edu_enrollments e ON e.id=ep.enrollment_id
              WHERE e.student_id=$1 AND ep.company_id=$2
           ) x ORDER BY created_at DESC LIMIT 200`,
          [student.id, cid]
        ),
        pool.query(
          `SELECT p.id, p.label, p.total_amount, p.status,
                  COALESCE((SELECT SUM(amount) FROM edu_feeplan_payments fp WHERE fp.plan_id=p.id AND fp.status='paid'),0) AS total_paid
             FROM edu_feeplans p WHERE p.company_id=$1 AND p.student_id=$2 ORDER BY p.created_at DESC`,
          [cid, student.id]
        ),
      ]);
      res.json({ fees: fees.rows, payments: payments.rows, plans: plans.rows });
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur finances" }); }
  });

  // ---------- COURS EN LIGNE / DEVOIRS ----------

  // Classes visibles selon le rôle (null = toutes celles de l'établissement).
  async function visibleClassIds(req) {
    if (req.eduRole === "teacher") return await teacherClassIds(req);
    if (req.eduRole === "parent") {
      const kids = await parentStudentIds(req);
      if (kids.length === 0) return [];
      const { rows } = await pool.query(
        "SELECT DISTINCT class_id FROM edu_students WHERE id=ANY($1) AND class_id IS NOT NULL", [kids]
      );
      return rows.map((r) => r.class_id);
    }
    if (req.eduRole === "student") {
      const { rows } = await pool.query(
        "SELECT class_id FROM edu_students WHERE user_id=$1 AND company_id=$2", [req.user.id, schoolId(req)]
      );
      return rows.map((r) => r.class_id).filter(Boolean);
    }
    return null;
  }

  // Téléversement d'une pièce jointe de cours → renvoie une URL servie par /uploads.
  router.post("/courses/upload", requireRoles(GRADE_ROLES), eduUpload.single("file"), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Aucun fichier reçu." });
    res.status(201).json({
      file_url: `/uploads/education/${req.file.filename}`,
      file_name: req.file.originalname,
      size: req.file.size,
    });
  });

  router.post("/courses", requireRoles(GRADE_ROLES), async (req, res) => {
    try {
      const b = req.body || {};
      const { class_id, subject_id, course_type, title, content, file_url, file_name, video_url, due_date } = b;
      if (!class_id || !title) return res.status(400).json({ error: "Classe et titre requis" });
      if (req.eduRole === "teacher") {
        const classes = await teacherClassIds(req);
        if (!classes.includes(Number(class_id))) return res.status(403).json({ error: "Classe non affectée" });
      }
      const { rows } = await pool.query(
        `INSERT INTO edu_courses
           (company_id, class_id, subject_id, teacher_user_id, course_type, title, content,
            file_url, file_name, video_url, due_date, is_published)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [schoolId(req), class_id, subject_id || null, req.user.id,
         course_type || "cours", title, content || null, file_url || null, file_name || null,
         video_url || null, due_date || null, b.is_published !== false]
      );
      res.status(201).json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur cours" }); }
  });

  router.get("/courses", async (req, res) => {
    try {
      const classId = req.query.class_id ? Number(req.query.class_id) : null;
      const type = req.query.type ? String(req.query.type) : null;
      const allowedClasses = await visibleClassIds(req);
      // Les élèves et parents ne voient que les cours publiés.
      const publishedOnly = ["student", "parent"].includes(req.eduRole);
      const { rows } = await pool.query(
        `SELECT co.*, c.name AS class_name, s.name AS subject_name,
                COALESCE(u.fullname,'') AS teacher_name
         FROM edu_courses co
         JOIN edu_classes c ON c.id=co.class_id
         LEFT JOIN edu_subjects s ON s.id=co.subject_id
         LEFT JOIN users u ON u.id=co.teacher_user_id
         WHERE co.company_id=$1
           AND ($2::int IS NULL OR co.class_id=$2)
           AND ($3::int[] IS NULL OR co.class_id=ANY($3))
           AND ($4::text IS NULL OR co.course_type=$4)
           AND ($5::bool = FALSE OR co.is_published = TRUE)
         ORDER BY co.created_at DESC LIMIT 200`,
        [schoolId(req), classId, allowedClasses, type, publishedOnly]
      );
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur cours" }); }
  });

  // Modification (professeur propriétaire ou staff).
  router.patch("/courses/:id", requireRoles(GRADE_ROLES), async (req, res) => {
    try {
      const existing = (await pool.query(
        `SELECT * FROM edu_courses WHERE id=$1 AND company_id=$2`, [req.params.id, schoolId(req)]
      )).rows[0];
      if (!existing) return res.status(404).json({ error: "Cours introuvable" });
      if (req.eduRole === "teacher" && existing.teacher_user_id !== req.user.id) {
        return res.status(403).json({ error: "Vous ne pouvez modifier que vos cours." });
      }
      const b = req.body || {};
      const fields = ["title", "content", "file_url", "file_name", "video_url", "subject_id", "due_date", "is_published"];
      const sets = []; const vals = []; let i = 1;
      for (const f of fields) if (b[f] !== undefined) { sets.push(`${f}=$${i++}`); vals.push(b[f]); }
      if (sets.length === 0) return res.json(existing);
      sets.push("updated_at=NOW()");
      vals.push(req.params.id, schoolId(req));
      const { rows } = await pool.query(
        `UPDATE edu_courses SET ${sets.join(", ")} WHERE id=$${i++} AND company_id=$${i} RETURNING *`, vals
      );
      res.json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur modification cours" }); }
  });

  router.delete("/courses/:id", requireRoles(GRADE_ROLES), async (req, res) => {
    try {
      const existing = (await pool.query(
        `SELECT * FROM edu_courses WHERE id=$1 AND company_id=$2`, [req.params.id, schoolId(req)]
      )).rows[0];
      if (!existing) return res.status(404).json({ error: "Cours introuvable" });
      if (req.eduRole === "teacher" && existing.teacher_user_id !== req.user.id) {
        return res.status(403).json({ error: "Vous ne pouvez supprimer que vos cours." });
      }
      // Supprime le fichier local associé s'il est dans uploads/education.
      if (existing.file_url && existing.file_url.startsWith("/uploads/education/")) {
        fs.unlink(path.join(__dirname, "..", existing.file_url), () => {});
      }
      await pool.query(`DELETE FROM edu_courses WHERE id=$1 AND company_id=$2`, [req.params.id, schoolId(req)]);
      res.json({ ok: true });
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur suppression cours" }); }
  });

  // ---------- DEVOIRS ET CORRECTIONS (§18) ----------

  // Rôles autorisés à téléverser un rendu (élèves + parents + staff/prof).
  const SUBMIT_ROLES = [...GRADE_ROLES, "student", "parent"];

  // Établissement effectif de l'élève courant (rôle student).
  async function currentStudentId(req) {
    const { rows } = await pool.query(
      "SELECT id, class_id FROM edu_students WHERE user_id=$1 AND company_id=$2",
      [req.user.id, schoolId(req)]
    );
    return rows[0] || null;
  }

  // Téléversement d'un fichier de rendu (accessible aux élèves/parents).
  router.post("/submissions/upload", requireRoles(SUBMIT_ROLES), eduUpload.single("file"), (req, res) => {
    if (!req.file) return res.status(400).json({ error: "Aucun fichier reçu." });
    res.status(201).json({
      file_url: `/uploads/education/${req.file.filename}`,
      file_name: req.file.originalname,
      size: req.file.size,
    });
  });

  // Liste des devoirs (course_type='devoir') avec nombre de rendus.
  router.get("/assignments", async (req, res) => {
    try {
      const classId = req.query.class_id ? Number(req.query.class_id) : null;
      const allowedClasses = await visibleClassIds(req);
      const publishedOnly = ["student", "parent"].includes(req.eduRole);
      const { rows } = await pool.query(
        `SELECT co.*, c.name AS class_name, s.name AS subject_name, COALESCE(u.fullname,'') AS teacher_name,
                (SELECT COUNT(*) FROM edu_assignment_submissions sub WHERE sub.course_id=co.id) AS submissions_count,
                (SELECT COUNT(*) FROM edu_assignment_submissions sub WHERE sub.course_id=co.id AND sub.status='graded') AS graded_count,
                (SELECT COUNT(*) FROM edu_students st WHERE st.class_id=co.class_id AND st.status='actif') AS class_size
         FROM edu_courses co
         JOIN edu_classes c ON c.id=co.class_id
         LEFT JOIN edu_subjects s ON s.id=co.subject_id
         LEFT JOIN users u ON u.id=co.teacher_user_id
         WHERE co.company_id=$1 AND co.course_type='devoir'
           AND ($2::int IS NULL OR co.class_id=$2)
           AND ($3::int[] IS NULL OR co.class_id=ANY($3))
           AND ($4::bool = FALSE OR co.is_published = TRUE)
         ORDER BY co.due_date NULLS LAST, co.created_at DESC LIMIT 200`,
        [schoolId(req), classId, allowedClasses, publishedOnly]
      );
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur devoirs" }); }
  });

  // Création d'un devoir (réutilise edu_courses en type 'devoir').
  router.post("/assignments", requireRoles(GRADE_ROLES), async (req, res) => {
    try {
      const b = req.body || {};
      if (!b.class_id || !b.title) return res.status(400).json({ error: "Classe et titre requis" });
      if (req.eduRole === "teacher") {
        const classes = await teacherClassIds(req);
        if (!classes.includes(Number(b.class_id))) return res.status(403).json({ error: "Classe non affectée" });
      }
      const { rows } = await pool.query(
        `INSERT INTO edu_courses
           (company_id, class_id, subject_id, teacher_user_id, course_type, title, content,
            file_url, file_name, due_date, is_published)
         VALUES ($1,$2,$3,$4,'devoir',$5,$6,$7,$8,$9,$10) RETURNING *`,
        [schoolId(req), b.class_id, b.subject_id || null, req.user.id, b.title, b.content || null,
         b.file_url || null, b.file_name || null, b.due_date || null, b.is_published !== false]
      );
      res.status(201).json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur création devoir" }); }
  });

  // Devoir + son état pour l'utilisateur courant.
  async function assignmentById(companyId, id) {
    const { rows } = await pool.query(
      `SELECT co.*, c.name AS class_name, s.name AS subject_name
         FROM edu_courses co JOIN edu_classes c ON c.id=co.class_id
         LEFT JOIN edu_subjects s ON s.id=co.subject_id
        WHERE co.id=$1 AND co.company_id=$2 AND co.course_type='devoir'`,
      [id, companyId]
    );
    return rows[0] || null;
  }

  // Soumettre / mettre à jour un rendu. student_id requis pour le staff/prof ;
  // pour un élève, c'est son propre rendu.
  router.post("/assignments/:id/submissions", requireRoles(SUBMIT_ROLES), async (req, res) => {
    try {
      const devoir = await assignmentById(schoolId(req), req.params.id);
      if (!devoir) return res.status(404).json({ error: "Devoir introuvable" });
      const b = req.body || {};
      let studentId = b.student_id ? Number(b.student_id) : null;
      if (req.eduRole === "student") {
        const me = await currentStudentId(req);
        if (!me) return res.status(403).json({ error: "Profil élève introuvable." });
        studentId = me.id;
      } else if (!studentId) {
        return res.status(400).json({ error: "Élève requis." });
      } else {
        // Staff/prof/parent : vérifier l'accès à l'élève.
        const st = await assertStudentAccess(req, studentId);
        if (!st) return res.status(403).json({ error: "Accès à cet élève refusé." });
      }
      if (devoir.class_id && !(await elevesDeLaClasse(schoolId(req), devoir.class_id, [studentId]))) {
        return res.status(422).json({ error: "Cet élève n'est pas dans la classe du devoir.", code: "ELEVE_HORS_CLASSE" });
      }
      const { rows } = await pool.query(
        `INSERT INTO edu_assignment_submissions
           (company_id, course_id, student_id, content, file_url, file_name, max_score, submitted_by, status, submitted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'submitted',NOW())
         ON CONFLICT (course_id, student_id) DO UPDATE SET
           content=EXCLUDED.content, file_url=EXCLUDED.file_url, file_name=EXCLUDED.file_name,
           status='submitted', submitted_by=EXCLUDED.submitted_by, submitted_at=NOW()
         RETURNING *`,
        [schoolId(req), devoir.id, studentId, b.content || null, b.file_url || null, b.file_name || null,
         Number(devoir.max_score || b.max_score || 20), req.user.id]
      );
      res.status(201).json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur soumission" }); }
  });

  // Liste des rendus d'un devoir (professeur/staff) avec noms d'élèves.
  router.get("/assignments/:id/submissions", requireRoles(GRADE_ROLES), async (req, res) => {
    try {
      const devoir = await assignmentById(schoolId(req), req.params.id);
      if (!devoir) return res.status(404).json({ error: "Devoir introuvable" });
      if (req.eduRole === "teacher") {
        const classes = await teacherClassIds(req);
        if (!classes.includes(devoir.class_id)) return res.status(403).json({ error: "Classe non affectée" });
      }
      // Tous les élèves actifs de la classe + leur rendu éventuel.
      const { rows } = await pool.query(
        `SELECT st.id AS student_id, st.first_name, st.last_name, st.matricule,
                sub.id AS submission_id, sub.content, sub.file_url, sub.file_name, sub.status,
                sub.score, sub.max_score, sub.feedback, sub.correction_file_url, sub.correction_file_name,
                sub.submitted_at, sub.graded_at
           FROM edu_students st
           LEFT JOIN edu_assignment_submissions sub
             ON sub.student_id=st.id AND sub.course_id=$2
          WHERE st.company_id=$1 AND st.class_id=$3 AND st.status='actif'
          ORDER BY st.last_name, st.first_name`,
        [schoolId(req), devoir.id, devoir.class_id]
      );
      res.json({ assignment: devoir, submissions: rows });
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur rendus" }); }
  });

  // Rendu de l'élève courant (ou d'un enfant pour un parent).
  router.get("/assignments/:id/my-submission", async (req, res) => {
    try {
      const devoir = await assignmentById(schoolId(req), req.params.id);
      if (!devoir) return res.status(404).json({ error: "Devoir introuvable" });
      let studentId = req.query.student_id ? Number(req.query.student_id) : null;
      if (req.eduRole === "student") {
        const me = await currentStudentId(req);
        if (!me) return res.json(null);
        studentId = me.id;
      } else if (studentId) {
        const st = await assertStudentAccess(req, studentId);
        if (!st) return res.status(403).json({ error: "Accès refusé" });
      } else {
        return res.status(400).json({ error: "Élève requis." });
      }
      const { rows } = await pool.query(
        `SELECT * FROM edu_assignment_submissions WHERE course_id=$1 AND student_id=$2`,
        [devoir.id, studentId]
      );
      res.json(rows[0] || null);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur rendu" }); }
  });

  // Correction : note + appréciation + fichier de correction.
  router.patch("/submissions/:id/grade", requireRoles(GRADE_ROLES), async (req, res) => {
    try {
      const sub = (await pool.query(
        `SELECT sub.*, co.class_id FROM edu_assignment_submissions sub
           JOIN edu_courses co ON co.id=sub.course_id
          WHERE sub.id=$1 AND sub.company_id=$2`,
        [req.params.id, schoolId(req)]
      )).rows[0];
      if (!sub) return res.status(404).json({ error: "Rendu introuvable" });
      if (req.eduRole === "teacher") {
        const classes = await teacherClassIds(req);
        if (!classes.includes(sub.class_id)) return res.status(403).json({ error: "Classe non affectée" });
      }
      const b = req.body || {};
      const score = b.score != null && b.score !== "" ? Number(b.score) : null;
      if (score != null && (!Number.isFinite(score) || score < 0 || score > Number(sub.max_score))) {
        return res.status(400).json({ error: `Note invalide (0 à ${sub.max_score}).` });
      }
      const { rows } = await pool.query(
        `UPDATE edu_assignment_submissions SET
           score=$3::numeric, feedback=COALESCE($4, feedback),
           correction_file_url=COALESCE($5, correction_file_url),
           correction_file_name=COALESCE($6, correction_file_name),
           status=CASE WHEN $3::numeric IS NOT NULL THEN 'graded' ELSE status END,
           graded_by=$7, graded_at=NOW()
         WHERE id=$1 AND company_id=$2 RETURNING *`,
        [req.params.id, schoolId(req), score, b.feedback ?? null,
         b.correction_file_url ?? null, b.correction_file_name ?? null, req.user.id]
      );
      res.json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur correction" }); }
  });

  // ---------- CONDUITE ----------

  router.post("/conduct", requireRoles(GRADE_ROLES), async (req, res) => {
    try {
      const { student_id, conduct_type, description } = req.body || {};
      const student = await assertStudentAccess(req, student_id);
      if (!student) return res.status(403).json({ error: "Accès refusé" });
      const { rows } = await pool.query(
        `INSERT INTO edu_conduct (company_id, student_id, conduct_type, description, recorded_by_user_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [schoolId(req), student.id, conduct_type || "remarque", description || null, req.user.id]
      );
      res.status(201).json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur conduite" }); }
  });

  router.get("/students/:id/conduct", async (req, res) => {
    try {
      const student = await assertStudentAccess(req, req.params.id);
      if (!student) return res.status(403).json({ error: "Accès refusé" });
      const { rows } = await pool.query(
        "SELECT * FROM edu_conduct WHERE student_id=$1 ORDER BY conduct_date DESC LIMIT 100",
        [student.id]
      );
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur conduite" }); }
  });

  // ---------- MESSAGES ----------

  router.post("/messages", async (req, res) => {
    try {
      const { recipient_user_id, student_id, class_id, subject, body, is_announcement } = req.body || {};
      if (!body) return res.status(400).json({ error: "Message vide" });
      const canAnnounce = STAFF_ROLES.includes(req.eduRole) || req.eduRole === "teacher";
      if (is_announcement && !canAnnounce) return res.status(403).json({ error: "Accès refusé" });
      const { rows } = await pool.query(
        `INSERT INTO edu_messages (company_id, sender_user_id, recipient_user_id, student_id, class_id, subject, body, is_announcement)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [schoolId(req), req.user.id, recipient_user_id || null, student_id || null,
         class_id || null, subject || null, body, Boolean(is_announcement)]
      );
      res.status(201).json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur message" }); }
  });

  router.get("/messages", async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT m.*, u.name AS sender_name FROM edu_messages m
         LEFT JOIN users u ON u.id=m.sender_user_id
         WHERE m.company_id=$1
           AND (m.recipient_user_id=$2 OR m.sender_user_id=$2 OR m.is_announcement=true)
         ORDER BY m.created_at DESC LIMIT 100`,
        [schoolId(req), req.user.id]
      );
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur messages" }); }
  });

  // ---------- TABLEAU DE BORD DIRECTION ----------

  router.get("/dashboard", requireRoles([...STAFF_ROLES, "accountant"]), async (req, res) => {
    try {
      const cid = schoolId(req);
      const [students, todayAtt, pendingFees, topStudents] = await Promise.all([
        pool.query(
          "SELECT COUNT(*)::int AS total FROM edu_students WHERE company_id=$1 AND status='actif'",
          [cid]
        ),
        pool.query(
          `SELECT
             COUNT(*) FILTER (WHERE status='present')::int AS presents,
             COUNT(*) FILTER (WHERE status='retard')::int AS retards,
             COUNT(*) FILTER (WHERE status IN ('absent','absence_justifiee'))::int AS absents
           FROM edu_attendance WHERE company_id=$1 AND attendance_date=CURRENT_DATE`,
          [cid]
        ),
        /* Reste dû : échéances non soldées (dont l'inscription) + inscriptions
           anciennes sans échéancier. L'ancienne requête lisait une colonne
           inexistante (edu_feeplan_payments.fee_id) et faisait tomber la page. */
        pool.query(
          `SELECT
             COALESCE((SELECT SUM(i.amount - i.amount_paid) FROM edu_feeplan_installments i
                        JOIN edu_feeplans p ON p.id=i.plan_id AND p.status <> 'cancelled'
                       WHERE i.company_id=$1 AND i.status <> 'paid'),0)
           + COALESCE((SELECT SUM(GREATEST(e.enrollment_fee - e.amount_paid, 0)) FROM edu_enrollments e
                       WHERE e.company_id=$1 AND e.fee_plan_id IS NULL
                         AND e.enrollment_state NOT IN ('abandon','transfere')),0) AS impaye`,
          [cid]
        ),
        pool.query(
          `SELECT rc.general_average, s.first_name, s.last_name, c.name AS class_name
           FROM edu_report_cards rc
           JOIN edu_students s ON s.id=rc.student_id
           LEFT JOIN edu_classes c ON c.id=s.class_id
           WHERE rc.company_id=$1
           ORDER BY rc.general_average DESC NULLS LAST LIMIT 5`,
          [cid]
        )
      ]);
      res.json({
        total_students: students.rows[0].total,
        today: todayAtt.rows[0],
        unpaid_total: Number(pendingFees.rows[0]?.impaye || 0),
        top_students: topStudents.rows
      });
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur tableau de bord" }); }
  });

  parcours = require("./education-parcours")(router, {
    pool, schoolId, requireRoles, STAFF_ROLES, MONEY_ROLES, edupdf,
    nextEnrollmentRef, nextReceiptRef, recomputeFeePlan, buildInstallments, assertStudentAccess,
  });

  return router;
};
