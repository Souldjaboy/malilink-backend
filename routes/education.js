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
const QRCode = require("qrcode");

const STAFF_ROLES = ["super_admin", "school_admin", "director", "secretary", "supervisor"];
const GRADE_ROLES = [...STAFF_ROLES, "teacher"];
const MONEY_ROLES = ["super_admin", "school_admin", "director", "accountant", "secretary"];

module.exports = function createEducationRouter({ pool, authenticateToken, authorizeRoles }) {
  const router = express.Router();
  router.use(authenticateToken);

  // Établissement effectif de l'utilisateur (super_admin peut cibler via ?company_id)
  function schoolId(req) {
    if (req.user.role === "super_admin" && req.query.company_id) {
      return Number(req.query.company_id);
    }
    return Number(req.user.company_id);
  }

  function requireRoles(roles) {
    return (req, res, next) => {
      if (!roles.includes(req.user.role)) {
        return res.status(403).json({ error: "Accès refusé (rôle insuffisant)" });
      }
      next();
    };
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

    const role = req.user.role;
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
      if (req.user.role === "teacher") {
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
      const { rows } = await pool.query(
        `INSERT INTO edu_classes (company_id, name, level, school_year_id, main_teacher_user_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [schoolId(req), name, level || null, school_year_id || null, main_teacher_user_id || null]
      );
      res.status(201).json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur classe" }); }
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

  router.post("/teacher-assignments", requireRoles(STAFF_ROLES), async (req, res) => {
    try {
      const { teacher_user_id, class_id, subject_id } = req.body || {};
      if (!teacher_user_id || !class_id) return res.status(400).json({ error: "Professeur et classe requis" });
      const { rows } = await pool.query(
        `INSERT INTO edu_teacher_assignments (company_id, teacher_user_id, class_id, subject_id)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (teacher_user_id, class_id, subject_id) DO NOTHING
         RETURNING *`,
        [schoolId(req), teacher_user_id, class_id, subject_id || null]
      );
      res.status(201).json(rows[0] || { ok: true });
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur affectation" }); }
  });

  // ---------- ÉLÈVES + BADGES QR ----------

  router.get("/students", async (req, res) => {
    try {
      const classFilter = req.query.class_id ? Number(req.query.class_id) : null;
      if (req.user.role === "parent") {
        const ids = await parentStudentIds(req);
        if (ids.length === 0) return res.json([]);
        const { rows } = await pool.query(
          `SELECT s.*, c.name AS class_name FROM edu_students s
           LEFT JOIN edu_classes c ON c.id=s.class_id
           WHERE s.id = ANY($1) ORDER BY s.last_name`,
          [ids]
        );
        return res.json(rows);
      }
      if (req.user.role === "teacher") {
        const classes = await teacherClassIds(req);
        if (classes.length === 0) return res.json([]);
        const { rows } = await pool.query(
          `SELECT s.*, c.name AS class_name FROM edu_students s
           LEFT JOIN edu_classes c ON c.id=s.class_id
           WHERE s.class_id = ANY($1) AND ($2::int IS NULL OR s.class_id=$2)
           ORDER BY s.last_name`,
          [classes, classFilter]
        );
        return res.json(rows);
      }
      if (!STAFF_ROLES.includes(req.user.role) && !MONEY_ROLES.includes(req.user.role)) {
        return res.status(403).json({ error: "Accès refusé" });
      }
      const { rows } = await pool.query(
        `SELECT s.*, c.name AS class_name FROM edu_students s
         LEFT JOIN edu_classes c ON c.id=s.class_id
         WHERE s.company_id=$1 AND ($2::int IS NULL OR s.class_id=$2)
         ORDER BY s.last_name LIMIT 500`,
        [schoolId(req), classFilter]
      );
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur élèves" }); }
  });

  // Création élève : matricule + QR générés automatiquement
  router.post("/students", requireRoles(STAFF_ROLES), async (req, res) => {
    try {
      const { first_name, last_name, gender, birth_date, class_id, parent_user_id } = req.body || {};
      if (!first_name || !last_name) return res.status(400).json({ error: "Nom et prénom requis" });

      const year = new Date().getFullYear();
      const seq = await pool.query(
        "SELECT COUNT(*)::int + 1 AS n FROM edu_students WHERE company_id=$1",
        [schoolId(req)]
      );
      const matricule = `ML${year}-${String(schoolId(req)).padStart(3, "0")}-${String(seq.rows[0].n).padStart(4, "0")}`;
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
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur création élève" }); }
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

      const { rows } = await pool.query(
        "SELECT * FROM edu_students WHERE qr_code=$1 AND company_id=$2",
        [qr_code, schoolId(req)]
      );
      const student = rows[0];
      if (!student) return res.status(404).json({ error: "Élève introuvable dans cet établissement" });

      if (action === "sortie") {
        const upd = await pool.query(
          `UPDATE edu_attendance SET check_out_at=NOW(), status=CASE WHEN status='present' THEN 'present' ELSE status END
           WHERE student_id=$1 AND attendance_date=CURRENT_DATE RETURNING *`,
          [student.id]
        );
        return res.json({ student, attendance: upd.rows[0] || null, action: "sortie" });
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
      res.json({ student, attendance: ins.rows[0], action: "entree" });
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur scan" }); }
  });

  // Appel en classe (professeur) : liste de {student_id, status}
  router.post("/attendance/roll-call", requireRoles([...STAFF_ROLES, "teacher"]), async (req, res) => {
    try {
      const { class_id, entries } = req.body || {};
      if (!class_id || !Array.isArray(entries)) {
        return res.status(400).json({ error: "class_id et entries requis" });
      }
      if (req.user.role === "teacher") {
        const classes = await teacherClassIds(req);
        if (!classes.includes(Number(class_id))) {
          return res.status(403).json({ error: "Classe non affectée à ce professeur" });
        }
      }
      let count = 0;
      for (const entry of entries.slice(0, 200)) {
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

      if (!GRADE_ROLES.includes(req.user.role)) return res.status(403).json({ error: "Accès refusé" });
      if (req.user.role === "teacher" && classId) {
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
      if (req.user.role === "teacher") {
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
      if (req.user.role === "teacher") {
        const classes = await teacherClassIds(req);
        if (!classes.includes(exam.class_id)) return res.status(403).json({ error: "Classe non affectée" });
      }

      const grades = Array.isArray(req.body?.grades) ? req.body.grades.slice(0, 200) : [];
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
      const { rows } = await pool.query(
        `INSERT INTO edu_fee_payments (company_id, fee_id, student_id, amount, payment_method, reference, paid_by_user_id, recorded_by_user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [schoolId(req), fee_id, student_id, amount, payment_method || "especes",
         reference || null, paid_by_user_id || null, req.user.id]
      );
      res.status(201).json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur paiement" }); }
  });

  // Situation financière d'un élève (parent, direction, comptable)
  router.get("/students/:id/finances", async (req, res) => {
    try {
      const student = await assertStudentAccess(req, req.params.id);
      if (!student) return res.status(403).json({ error: "Accès refusé" });
      const fees = await pool.query(
        `SELECT f.*, COALESCE(p.paid, 0) AS paid,
                (f.amount - COALESCE(p.paid, 0)) AS remaining
         FROM edu_fees f
         LEFT JOIN LATERAL (
           SELECT SUM(amount) AS paid FROM edu_fee_payments
           WHERE fee_id=f.id AND student_id=$1
         ) p ON true
         WHERE f.company_id=$2 AND (f.class_id IS NULL OR f.class_id=$3)
         ORDER BY f.due_date NULLS LAST`,
        [student.id, schoolId(req), student.class_id]
      );
      const payments = await pool.query(
        `SELECT * FROM edu_fee_payments WHERE student_id=$1 ORDER BY paid_at DESC LIMIT 100`,
        [student.id]
      );
      res.json({ fees: fees.rows, payments: payments.rows });
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur finances" }); }
  });

  // ---------- COURS / DEVOIRS ----------

  router.post("/courses", requireRoles(GRADE_ROLES), async (req, res) => {
    try {
      const { class_id, subject_id, course_type, title, content, file_url, due_date } = req.body || {};
      if (!class_id || !title) return res.status(400).json({ error: "Classe et titre requis" });
      if (req.user.role === "teacher") {
        const classes = await teacherClassIds(req);
        if (!classes.includes(Number(class_id))) return res.status(403).json({ error: "Classe non affectée" });
      }
      const { rows } = await pool.query(
        `INSERT INTO edu_courses (company_id, class_id, subject_id, teacher_user_id, course_type, title, content, file_url, due_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [schoolId(req), class_id, subject_id || null, req.user.id,
         course_type || "cours", title, content || null, file_url || null, due_date || null]
      );
      res.status(201).json(rows[0]);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur cours" }); }
  });

  router.get("/courses", async (req, res) => {
    try {
      const classId = req.query.class_id ? Number(req.query.class_id) : null;
      let allowedClasses = null;
      if (req.user.role === "teacher") allowedClasses = await teacherClassIds(req);
      if (req.user.role === "parent") {
        const kids = await parentStudentIds(req);
        if (kids.length === 0) return res.json([]);
        const { rows } = await pool.query(
          "SELECT DISTINCT class_id FROM edu_students WHERE id=ANY($1) AND class_id IS NOT NULL",
          [kids]
        );
        allowedClasses = rows.map((r) => r.class_id);
      }
      if (req.user.role === "student") {
        const { rows } = await pool.query(
          "SELECT class_id FROM edu_students WHERE user_id=$1 AND company_id=$2",
          [req.user.id, schoolId(req)]
        );
        allowedClasses = rows.map((r) => r.class_id).filter(Boolean);
      }

      const { rows } = await pool.query(
        `SELECT co.*, c.name AS class_name, s.name AS subject_name
         FROM edu_courses co
         JOIN edu_classes c ON c.id=co.class_id
         LEFT JOIN edu_subjects s ON s.id=co.subject_id
         WHERE co.company_id=$1
           AND ($2::int IS NULL OR co.class_id=$2)
           AND ($3::int[] IS NULL OR co.class_id=ANY($3))
         ORDER BY co.created_at DESC LIMIT 200`,
        [schoolId(req), classId, allowedClasses]
      );
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: "Erreur cours" }); }
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
      const canAnnounce = STAFF_ROLES.includes(req.user.role) || req.user.role === "teacher";
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
        pool.query(
          `SELECT COALESCE(SUM(f.amount), 0) - COALESCE(SUM(p.total_paid), 0) AS impaye
           FROM edu_fees f
           LEFT JOIN LATERAL (
             SELECT SUM(amount) AS total_paid FROM edu_fee_payments WHERE fee_id=f.id
           ) p ON true
           WHERE f.company_id=$1`,
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

  return router;
};
