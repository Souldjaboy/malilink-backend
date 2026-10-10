"use strict";
const crypto = require("crypto");
const access = require("../../access-control");
class LearningError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new LearningError(status, message); };
function id(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > 2147483647) fail(400, "Identifiant invalide.");
  return n;
}
const STAFF = ["super_admin", "admin", "school_admin", "director", "teacher"];
const ACCOUNT_ROLES = ["super_admin", "admin", "school_admin", "director"];
function webUrl(value) {
  if (!value) return "";
  try { const url = new URL(String(value)); return url.protocol === "https:" ? url.toString().slice(0, 2000) : fail(400, "Les liens doivent utiliser HTTPS."); }
  catch (error) { if (error instanceof LearningError) throw error; fail(400, "Lien de ressource invalide."); }
}
function validateResources(resources) {
  if (resources === undefined) return [];
  if (!Array.isArray(resources) || resources.length > 12) fail(400, "Une leçon accepte au maximum 12 ressources.");
  return resources.map(resource => {
    if (!resource || typeof resource !== "object") fail(400, "Ressource invalide.");
    const type = String(resource.type || "");
    const title = String(resource.title || "").trim().slice(0, 160);
    if (!title || !["file", "video", "link"].includes(type)) fail(400, "Type ou titre de ressource invalide.");
    if (type === "file") return { type, title, asset_id: id(resource.asset_id) };
    return { type, title, url: webUrl(resource.url) };
  });
}
function validateProgram(body) {
  if (!body || typeof body !== "object") fail(400, "Parcours invalide.");
  const title = String(body.title || "").trim();
  const threshold = Number(body.threshold ?? 70), max = Number(body.max_attempts ?? 3);
  if (!title || title.length > 160 || !Number.isInteger(threshold) || threshold < 1 || threshold > 100 || !Number.isInteger(max) || max < 1 || max > 20) fail(400, "Titre, seuil ou tentatives invalides.");
  if (!Array.isArray(body.units) || !body.units.length || body.units.length > 50) fail(400, "Le parcours doit contenir 1 à 50 leçons.");
  const units = body.units.map(unit => {
    if (!unit || typeof unit !== "object") fail(400, "Leçon invalide.");
    if (!Array.isArray(unit.questions) || !unit.questions.length || unit.questions.length > 30) fail(400, "Chaque leçon doit contenir 1 à 30 questions.");
    return { course_id: id(unit.course_id), resources: validateResources(unit.resources), questions: unit.questions.map(q => {
      if (!q || typeof q !== "object") fail(400, "Question invalide.");
      if (typeof q.prompt !== "string" || !q.prompt.trim() || q.prompt.length > 1000 || !Array.isArray(q.choices) || q.choices.length < 2 || q.choices.length > 6 || q.choices.some(c => typeof c !== "string" || !c.trim() || c.length > 500) || !Number.isInteger(q.answer) || q.answer < 0 || q.answer >= q.choices.length) fail(400, "Question ou réponse invalide.");
      return { prompt: q.prompt.trim(), choices: q.choices.map(c => c.trim()), answer: q.answer, explanation: String(q.explanation || "").slice(0, 1500) };
    }) };
  });
  if (new Set(units.map(u => u.course_id)).size !== units.length) fail(400, "Une leçon ne peut pas être ajoutée deux fois.");
  return { title, description: String(body.description || "").slice(0, 3000), class_id: id(body.class_id), threshold, max_attempts: max, units };
}
function createLearningService(pool, dependencies = {}) {
  const notify = typeof dependencies.createNotification === "function" ? dependencies.createNotification : async () => {};
  async function actor(req, action = "view") {
    const accountCompany = id(req.user.company_id), tid = req.tenant_id;
    if (!tid) fail(403, "Tenant absent.");
    const account = (await pool.query(`SELECT u.id,u.role,u.company_id,u.is_super_admin FROM users u JOIN companies c ON c.id=u.company_id
      WHERE u.id=$1 AND u.company_id=$2 AND c.tenant_id=$3 AND u.is_active IS TRUE AND c.status='active'`, [req.user.id, accountCompany, tid])).rows[0];
    if (!account) fail(403, "Compte ou établissement inactif.");
    const superAdmin = account.is_super_admin === true || String(account.role).toLowerCase() === "super_admin";
    const requested = req.headers?.["x-active-company-id"];
    // A browser header never grants the right to switch schools.
    const company = superAdmin && requested !== undefined ? id(requested) : accountCompany;
    const selected = (await pool.query("SELECT id FROM companies WHERE id=$1 AND tenant_id=$2 AND status='active'", [company, tid])).rows[0];
    if (!selected) fail(403, "Établissement sélectionné indisponible pour ce tenant.");
    const u = { ...account, company_id: company, role: superAdmin ? "super_admin" : account.role };
    // Explicit opt-in required even for super admins; missing rows fail closed for new schools.
    const rows = (await pool.query("SELECT is_enabled,enabled FROM company_modules WHERE company_id=$1 AND module_key='education.learning'", [company])).rows;
    if (!rows.length || rows.some(r => (r.is_enabled ?? r.enabled) !== true)) fail(403, "Academy n'est pas activé pour cet établissement.");
    const ctx = await access.loadAccessContext(pool, { companyId: company, userId: u.id, role: u.role, isSuperAdmin: superAdmin });
    if (!access.effectiveAccess(ctx, "education", "view").allowed || !access.effectiveAccess(ctx, "education.learning", action).allowed) fail(403, "Permission Academy refusée.");
    return { ...u, tenant_id: tid, staff: STAFF.includes(u.role) };
  }
  async function classAccess(a, classId, db = pool) {
    const exists = (await db.query("SELECT id FROM edu_classes WHERE id=$1 AND company_id=$2", [classId, a.company_id])).rows[0];
    if (!exists) fail(404, "Classe introuvable.");
    if (a.role === "teacher") {
      const linked = (await db.query("SELECT 1 FROM edu_teacher_assignments WHERE teacher_user_id=$1 AND class_id=$2 AND company_id=$3", [a.id, classId, a.company_id])).rows[0];
      if (!linked) fail(403, "Classe non affectée à ce professeur.");
    } else if (!a.staff) fail(403, "Administration réservée aux enseignants et à la direction.");
  }
  async function student(a, classId, db = pool) {
    if (a.role !== "student") fail(403, "Espace réservé à l'élève.");
    const s = (await db.query("SELECT id FROM edu_students WHERE user_id=$1 AND company_id=$2 AND class_id=$3 AND status='actif'", [a.id, a.company_id, classId])).rows;
    if (s.length !== 1) fail(403, "Aucun compte élève actif unique dans cette classe.");
    return s[0];
  }
  async function program(a, programId, db = pool, lock = false) {
    const p = (await db.query(`SELECT * FROM edu_learning_programs WHERE id=$1 AND company_id=$2 AND tenant_id=$3${lock ? " FOR UPDATE" : ""}`, [id(programId), a.company_id, a.tenant_id])).rows[0];
    if (!p) fail(404, "Parcours introuvable.");
    if (a.staff) await classAccess(a, p.class_id, db);
    else { await student(a, p.class_id, db); if (!p.published) fail(404, "Parcours non publié."); }
    return p;
  }
  async function audit(db, a, p, action) {
    await db.query("INSERT INTO edu_learning_audit(company_id,tenant_id,user_id,program_id,action) VALUES($1,$2,$3,$4,$5)", [a.company_id, a.tenant_id, a.id, p, action]);
  }
  async function transaction(fn) {
    const db = await pool.connect();
    try { await db.query("BEGIN"); const out = await fn(db); await db.query("COMMIT"); return out; }
    catch (e) { await db.query("ROLLBACK"); throw e; } finally { db.release(); }
  }
  async function catalog(req) {
    const a = await actor(req);
    const rows = (await pool.query(`SELECT id,title,description,class_id,published,threshold,max_attempts,jsonb_array_length(units) AS lesson_count
      FROM edu_learning_programs WHERE company_id=$1 AND tenant_id=$2 AND archived=FALSE ORDER BY id DESC LIMIT 200`, [a.company_id, a.tenant_id])).rows;
    const programs = [];
    for (const p of rows) {
      try { if (a.staff) await classAccess(a, p.class_id); else { if (!p.published) continue; await student(a, p.class_id); } programs.push(p); }
      catch (e) { if (![403, 404].includes(e.status)) throw e; }
    }
    const settings = (await pool.query(`SELECT brand_name,welcome_text,primary_color,celebration_enabled
      FROM edu_learning_settings WHERE company_id=$1 AND tenant_id=$2`, [a.company_id, a.tenant_id])).rows[0]
      || { brand_name: "MaliLink Academy", welcome_text: "Apprendre, pratiquer et progresser.", primary_color: "#0f172a", celebration_enabled: true };
    return { staff: a.staff, can_manage: ACCOUNT_ROLES.includes(a.role), programs, settings };
  }
  async function save(req, programId) {
    const a = await actor(req, programId ? "update" : "create");
    if (!a.staff) fail(403, "Création non autorisée.");
    const v = validateProgram(req.body);
    return transaction(async db => {
      await classAccess(a, v.class_id, db);
      if (programId) { const old = await program(a, programId, db, true); if (old.published) fail(409, "Ce parcours publié est figé. Créez un nouveau parcours pour une nouvelle version."); }
      for (const unit of v.units) {
        const c = (await db.query("SELECT id FROM edu_courses WHERE id=$1 AND company_id=$2 AND class_id=$3 AND is_published=TRUE", [unit.course_id, a.company_id, v.class_id])).rows[0];
        if (!c) fail(400, "Chaque cours doit être publié et appartenir à cette classe.");
        const assetIds = unit.resources.filter(r => r.type === "file").map(r => r.asset_id);
        if (assetIds.length) {
          const owned = (await db.query("SELECT id FROM edu_learning_assets WHERE id=ANY($1) AND company_id=$2 AND tenant_id=$3", [assetIds, a.company_id, a.tenant_id])).rows;
          if (owned.length !== new Set(assetIds).size) fail(400, "Une ressource ne dépend pas de cet établissement.");
        }
      }
      const values = [v.title, v.description, v.class_id, v.threshold, v.max_attempts, JSON.stringify(v.units)];
      const p = programId ? (await db.query(`UPDATE edu_learning_programs SET title=$1,description=$2,class_id=$3,threshold=$4,max_attempts=$5,units=$6,updated_at=NOW() WHERE id=$7 RETURNING id`, [...values, id(programId)])).rows[0]
        : (await db.query(`INSERT INTO edu_learning_programs(title,description,class_id,threshold,max_attempts,units,company_id,tenant_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [...values, a.company_id, a.tenant_id, a.id])).rows[0];
      await audit(db, a, p.id, programId ? "draft_updated" : "draft_created"); return p;
    });
  }
  async function publish(req, programId) {
    const a = await actor(req, "update"); if (!a.staff) fail(403, "Publication refusée.");
    const result = await transaction(async db => {
      const p = await program(a, programId, db, true);
      if (!p.published) {
        // Freeze source content at publication so quiz attempts always refer to one lesson version.
        for (const unit of p.units) {
          const c = (await db.query("SELECT title,content FROM edu_courses WHERE id=$1 AND company_id=$2 AND class_id=$3 AND is_published=TRUE", [unit.course_id, a.company_id, p.class_id])).rows[0];
          if (!c) fail(409, "Un cours lié n'est plus disponible.");
          unit.lesson = { title: c.title, content: c.content || "" };
        }
        await db.query("UPDATE edu_learning_programs SET units=$2,published=TRUE,published_at=NOW(),updated_at=NOW() WHERE id=$1", [p.id, JSON.stringify(p.units)]);
        await audit(db, a, p.id, "published");
      }
      const recipients = (await db.query(`SELECT DISTINCT u.id FROM edu_students s JOIN users u ON u.id=s.user_id
        WHERE s.company_id=$1 AND s.class_id=$2 AND s.status='actif' AND u.is_active IS TRUE`, [a.company_id, p.class_id])).rows;
      return { success: true, newly_published: !p.published, recipients, title: p.title, id: p.id };
    });
    if (result.newly_published) await Promise.allSettled(result.recipients.map(row => notify({
      user_id: row.id, title: "Nouveau parcours Academy", message: `${result.title} est disponible.`, type: "education_learning",
      company_id: a.company_id, related_entity_type: "edu_learning_program", related_entity_id: result.id,
      action_url: `/education/academy?program=${result.id}`, created_by: a.id
    })));
    return { success: true };
  }
  async function detail(req, programId) {
    const a = await actor(req), p = await program(a, programId);
    if (a.staff) return { ...p, staff: true, can_manage: ACCOUNT_ROLES.includes(a.role) };
    const s = await student(a, p.class_id);
    const allowances = (await pool.query("SELECT unit_index,attempt_limit FROM edu_learning_allowances WHERE program_id=$1 AND student_id=$2 AND company_id=$3 AND tenant_id=$4", [p.id, s.id, a.company_id, a.tenant_id])).rows;
    const attempts = (await pool.query("SELECT id,unit_index,submitted_at,score,passed FROM edu_learning_attempts WHERE program_id=$1 AND student_id=$2 AND company_id=$3 AND tenant_id=$4 ORDER BY id", [p.id, s.id, a.company_id, a.tenant_id])).rows;
    const certificate = (await pool.query("SELECT id,verification_token,issued_at FROM edu_learning_certificates WHERE program_id=$1 AND student_id=$2 AND company_id=$3 AND tenant_id=$4", [p.id, s.id, a.company_id, a.tenant_id])).rows[0] || null;
    let unlocked = true;
    const units = p.units.map((u, index) => {
      const history = attempts.filter(t => t.unit_index === index), passed = history.some(t => t.passed), locked = !unlocked;
      unlocked = unlocked && passed;
      const resources = locked ? [] : (u.resources || []).map(r => r.type === "file" ? { ...r, url: `/education/learning/assets/${r.asset_id}/download` } : r);
      return { course_id: u.course_id, title: u.lesson.title, locked, passed, attempts: history, attempt_limit: Math.max(p.max_attempts, allowances.find(v => v.unit_index === index)?.attempt_limit || 0), lesson: locked ? null : u.lesson, resources,
        questions: locked ? [] : u.questions.map(q => ({ prompt: q.prompt, choices: q.choices })) };
    });
    return { id: p.id, title: p.title, description: p.description, threshold: p.threshold, max_attempts: p.max_attempts, staff: false, units, certificate };
  }
  async function start(req, programId) {
    const a = await actor(req);
    return transaction(async db => {
      const p = await program(a, programId, db, true), s = await student(a, p.class_id, db), index = req.body.unit_index;
      if (!Number.isInteger(index) || index < 0 || index >= p.units.length) fail(400, "Leçon invalide.");
      const attempts = (await db.query("SELECT * FROM edu_learning_attempts WHERE program_id=$1 AND student_id=$2", [p.id, s.id])).rows;
      for (let i = 0; i < index; i++) if (!attempts.some(t => t.unit_index === i && t.passed)) fail(403, "Validez les leçons précédentes.");
      const history = attempts.filter(t => t.unit_index === index);
      if (history.some(t => t.passed)) fail(409, "Leçon déjà validée.");
      const open = history.find(t => !t.submitted_at); if (open) return { id: open.id };
      const allowance = (await db.query("SELECT attempt_limit FROM edu_learning_allowances WHERE program_id=$1 AND student_id=$2 AND unit_index=$3 AND company_id=$4 AND tenant_id=$5", [p.id, s.id, index, a.company_id, a.tenant_id])).rows[0];
      if (history.length >= Math.max(p.max_attempts, allowance?.attempt_limit || 0)) fail(409, "Tentatives épuisées. Demandez de l'aide à votre professeur.");
      const attempt = (await db.query("INSERT INTO edu_learning_attempts(company_id,tenant_id,program_id,student_id,unit_index) VALUES($1,$2,$3,$4,$5) RETURNING id", [a.company_id, a.tenant_id, p.id, s.id, index])).rows[0];
      await audit(db, a, p.id, "attempt_started"); return attempt;
    });
  }
  async function submit(req, attemptId) {
    const a = await actor(req);
    const result = await transaction(async db => {
      const t = (await db.query("SELECT * FROM edu_learning_attempts WHERE id=$1 AND company_id=$2 AND tenant_id=$3 FOR UPDATE", [id(attemptId), a.company_id, a.tenant_id])).rows[0];
      if (!t) fail(404, "Tentative introuvable.");
      const p = await program(a, t.program_id, db), s = await student(a, p.class_id, db);
      if (s.id !== t.student_id) fail(403, "Cette tentative ne vous appartient pas.");
      const questions = p.units[t.unit_index].questions;
      if (t.submitted_at) return { score: t.score, passed: t.passed, feedback: questions.map((q,i) => ({ correct: t.answers[i] === q.answer, explanation: q.explanation })), replay: true };
      const answers = req.body.answers;
      if (!Array.isArray(answers) || answers.length !== questions.length || answers.some((v, i) => !Number.isInteger(v) || v < 0 || v >= questions[i].choices.length)) fail(400, "Répondez à toutes les questions.");
      const score = Math.round(100 * questions.filter((q, i) => q.answer === answers[i]).length / questions.length), passed = score >= p.threshold;
      await db.query("UPDATE edu_learning_attempts SET answers=$2,score=$3,passed=$4,submitted_at=NOW() WHERE id=$1", [t.id, JSON.stringify(answers), score, passed]);
      let certificate = null;
      if (passed) {
        await db.query(`INSERT INTO edu_learning_achievements(company_id,tenant_id,program_id,student_id,unit_index,score)
          VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(program_id,student_id,unit_index) DO UPDATE
          SET score=GREATEST(edu_learning_achievements.score,EXCLUDED.score)`, [a.company_id, a.tenant_id, p.id, s.id, t.unit_index, score]);
        const completed = Number((await db.query("SELECT COUNT(*)::int n FROM edu_learning_achievements WHERE program_id=$1 AND student_id=$2", [p.id, s.id])).rows[0].n) === p.units.length;
        if (completed) certificate = (await db.query(`INSERT INTO edu_learning_certificates(company_id,tenant_id,program_id,student_id,verification_token)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT(program_id,student_id) DO UPDATE SET program_id=EXCLUDED.program_id RETURNING id,verification_token,issued_at`,
        [a.company_id, a.tenant_id, p.id, s.id, crypto.randomBytes(24).toString("hex")])).rows[0];
      }
      await audit(db, a, p.id, passed ? "unit_passed" : "unit_retry");
      return { score, passed, certificate, program: p, feedback: questions.map((q,i) => ({ correct: answers[i] === q.answer, explanation: q.explanation })) };
    });
    if (!result.replay) await notify({
      user_id: a.id, title: result.certificate ? "Parcours Academy terminé" : result.passed ? "Leçon Academy validée" : "Nouvelle tentative Academy",
      message: result.certificate ? `Félicitations ! Votre attestation ${result.program.title} est disponible.` : `Résultat : ${result.score} %.`,
      type: "education_learning", company_id: a.company_id, related_entity_type: "edu_learning_program",
      related_entity_id: result.program.id, action_url: `/education/academy?program=${result.program.id}`
    }).catch(() => {});
    delete result.program; delete result.replay; return result;
  }
  async function report(req, programId) {
    const a = await actor(req); if (!a.staff) fail(403, "Rapport réservé au professeur.");
    const p = await program(a, programId);
    return (await pool.query(`SELECT s.id,s.first_name,s.last_name,s.user_id,u.email,u.is_active,COUNT(t.id)::int AS attempts,
      COUNT(DISTINCT t.unit_index) FILTER(WHERE t.passed)::int AS passed_units,MAX(t.submitted_at) AS last_activity
      FROM edu_students s LEFT JOIN edu_learning_attempts t ON t.student_id=s.id AND t.program_id=$1 AND t.company_id=$2 AND t.tenant_id=$3
      LEFT JOIN users u ON u.id=s.user_id AND u.company_id=s.company_id
      WHERE s.company_id=$2 AND s.class_id=$4 GROUP BY s.id,u.email,u.is_active ORDER BY s.last_name,s.first_name`, [p.id, a.company_id, a.tenant_id, p.class_id])).rows;
  }
  async function allowRetry(req, programId) {
    const a = await actor(req, "update");
    if (!a.staff) fail(403, "Autorisation réservée au professeur.");
    const { unit_index: index, attempt_limit: limit, reason } = req.body;
    const studentId = id(req.body.student_id);
    if (!Number.isInteger(index) || index < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20 || typeof reason !== "string" || !reason.trim() || reason.length > 500) fail(400, "Leçon, limite ou justification invalide.");
    return transaction(async db => {
      const p = await program(a, programId, db, true);
      if (!p.published || index >= p.units.length || limit < p.max_attempts) fail(400, "Limite ou leçon invalide pour ce parcours.");
      const s = (await db.query("SELECT id FROM edu_students WHERE id=$1 AND company_id=$2 AND class_id=$3", [studentId, a.company_id, p.class_id])).rows[0];
      if (!s) fail(404, "Élève introuvable dans cette classe.");
      // Absolute limit: retries of this request never accumulate additional attempts.
      await db.query(`INSERT INTO edu_learning_allowances(company_id,tenant_id,program_id,student_id,unit_index,attempt_limit,reason,granted_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(program_id,student_id,unit_index) DO UPDATE
        SET attempt_limit=GREATEST(edu_learning_allowances.attempt_limit,EXCLUDED.attempt_limit),reason=EXCLUDED.reason,granted_by=EXCLUDED.granted_by,updated_at=NOW()`,
      [a.company_id, a.tenant_id, p.id, s.id, index, limit, reason.trim(), a.id]);
      await audit(db, a, p.id, `retry_allowed:student=${s.id}:unit=${index}:limit=${limit}`);
      return { success: true };
    });
  }
  async function settings(req, update = false) {
    const a = await actor(req, update ? "update" : "view");
    if (!update) return (await pool.query("SELECT brand_name,welcome_text,primary_color,celebration_enabled FROM edu_learning_settings WHERE company_id=$1 AND tenant_id=$2", [a.company_id, a.tenant_id])).rows[0]
      || { brand_name: "MaliLink Academy", welcome_text: "Apprendre, pratiquer et progresser.", primary_color: "#0f172a", celebration_enabled: true };
    if (!ACCOUNT_ROLES.includes(a.role)) fail(403, "Paramètres réservés à la direction.");
    const body = req.body || {}, brand = String(body.brand_name || "").trim(), welcome = String(body.welcome_text || "").trim(), color = String(body.primary_color || "");
    if (!brand || brand.length > 100 || welcome.length > 500 || !/^#[0-9a-fA-F]{6}$/.test(color)) fail(400, "Identité Academy invalide.");
    const row = (await pool.query(`INSERT INTO edu_learning_settings(company_id,tenant_id,brand_name,welcome_text,primary_color,celebration_enabled,updated_by)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(company_id) DO UPDATE SET brand_name=EXCLUDED.brand_name,welcome_text=EXCLUDED.welcome_text,
      primary_color=EXCLUDED.primary_color,celebration_enabled=EXCLUDED.celebration_enabled,updated_by=EXCLUDED.updated_by,updated_at=NOW()
      RETURNING brand_name,welcome_text,primary_color,celebration_enabled`, [a.company_id, a.tenant_id, brand, welcome, color, body.celebration_enabled !== false, a.id])).rows[0];
    await audit(pool, a, null, "settings_updated"); return row;
  }
  async function createStudentAccount(req, studentId) {
    const a = await actor(req, "update");
    if (!ACCOUNT_ROLES.includes(a.role)) fail(403, "Création de compte réservée à la direction.");
    if (typeof dependencies.hashPassword !== "function") fail(503, "Service de mot de passe indisponible.");
    const email = String(req.body?.email || "").trim().toLowerCase(), password = String(req.body?.password || "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255) fail(400, "Adresse email invalide.");
    const passwordError = typeof dependencies.validatePasswordStrength === "function" ? dependencies.validatePasswordStrength(password) : (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password) ? "Mot de passe insuffisant." : "");
    if (passwordError) fail(400, passwordError);
    return transaction(async db => {
      const s = (await db.query("SELECT id,user_id,first_name,last_name,status FROM edu_students WHERE id=$1 AND company_id=$2 FOR UPDATE", [id(studentId), a.company_id])).rows[0];
      if (!s) fail(404, "Élève introuvable.");
      if (s.status !== "actif") fail(409, "Activez d'abord la fiche élève.");
      if (s.user_id) fail(409, "Cet élève possède déjà un compte.");
      if ((await db.query("SELECT 1 FROM users WHERE LOWER(email)=LOWER($1)", [email])).rows[0]) fail(409, "Cette adresse email possède déjà un compte.");
      const user = (await db.query(`INSERT INTO users(fullname,email,password,role,company_id,is_active,is_super_admin,force_password_change,
        account_status,verification_required,email_verified) VALUES($1,$2,$3,'student',$4,TRUE,FALSE,TRUE,'active',FALSE,TRUE)
        RETURNING id,email,is_active,force_password_change`, [`${s.first_name} ${s.last_name}`.trim(), email, await dependencies.hashPassword(password), a.company_id])).rows[0];
      await db.query("UPDATE edu_students SET user_id=$1 WHERE id=$2 AND company_id=$3", [user.id, s.id, a.company_id]);
      await audit(db, a, null, `student_account_created:student=${s.id}:user=${user.id}`); return user;
    });
  }
  async function setStudentAccountStatus(req, studentId) {
    const a = await actor(req, "update");
    if (!ACCOUNT_ROLES.includes(a.role)) fail(403, "Gestion des comptes réservée à la direction.");
    if (typeof req.body?.is_active !== "boolean") fail(400, "Statut de compte invalide.");
    return transaction(async db => {
      const s = (await db.query("SELECT id,user_id FROM edu_students WHERE id=$1 AND company_id=$2 FOR UPDATE", [id(studentId), a.company_id])).rows[0];
      if (!s?.user_id) fail(404, "Compte élève introuvable.");
      const user = (await db.query("UPDATE users SET is_active=$1,updated_at=NOW() WHERE id=$2 AND company_id=$3 AND role='student' RETURNING id,email,is_active", [req.body.is_active, s.user_id, a.company_id])).rows[0];
      if (!user) fail(404, "Compte élève introuvable.");
      await audit(db, a, null, `${user.is_active ? "student_account_enabled" : "student_account_disabled"}:student=${s.id}`); return user;
    });
  }
  async function registerAsset(req, file) {
    const a = await actor(req, "create"); if (!a.staff) fail(403, "Ajout réservé au personnel pédagogique.");
    const row = (await pool.query(`INSERT INTO edu_learning_assets(company_id,tenant_id,storage_key,original_name,mime_type,size_bytes,uploaded_by)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,original_name,mime_type,size_bytes`, [a.company_id, a.tenant_id, file.filename, file.originalname, file.mimetype, file.size, a.id])).rows[0];
    await audit(pool, a, null, `asset_uploaded:id=${row.id}`); return row;
  }
  async function assetForDownload(req, assetId) {
    const a = await actor(req), asset = (await pool.query("SELECT * FROM edu_learning_assets WHERE id=$1 AND company_id=$2 AND tenant_id=$3", [id(assetId), a.company_id, a.tenant_id])).rows[0];
    if (!asset) fail(404, "Ressource introuvable.");
    const programs = (await pool.query("SELECT * FROM edu_learning_programs WHERE company_id=$1 AND tenant_id=$2 AND archived=FALSE", [a.company_id, a.tenant_id])).rows;
    for (const candidate of programs) {
      const index = candidate.units.findIndex(unit => (unit.resources || []).some(resource => resource.type === "file" && Number(resource.asset_id) === asset.id));
      if (index < 0) continue;
      try {
        await program(a, candidate.id);
        if (!a.staff) {
          const s = await student(a, candidate.class_id), prior = (await pool.query("SELECT unit_index FROM edu_learning_achievements WHERE program_id=$1 AND student_id=$2", [candidate.id, s.id])).rows.map(row => row.unit_index);
          if (Array.from({ length: index }, (_, i) => i).some(i => !prior.includes(i))) continue;
        }
        await audit(pool, a, candidate.id, `asset_downloaded:id=${asset.id}`); return asset;
      } catch (error) { if (![403, 404].includes(error.status)) throw error; }
    }
    fail(404, "Ressource introuvable.");
  }
  async function duplicate(req, programId) {
    const a = await actor(req, "create"); if (!a.staff) fail(403, "Duplication non autorisée.");
    return transaction(async db => {
      const p = await program(a, programId, db, true);
      const units = p.units.map(unit => ({ course_id: unit.course_id, resources: unit.resources || [], questions: unit.questions }));
      const copy = (await db.query(`INSERT INTO edu_learning_programs(company_id,tenant_id,class_id,title,description,threshold,max_attempts,units,created_by,source_program_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [a.company_id, a.tenant_id, p.class_id, `${p.title} — copie`, p.description, p.threshold, p.max_attempts, JSON.stringify(units), a.id, p.id])).rows[0];
      await audit(db, a, copy.id, "program_duplicated"); return copy;
    });
  }
  async function archive(req, programId) {
    const a = await actor(req, "update"); if (!a.staff) fail(403, "Archivage non autorisé.");
    const p = await program(a, programId);
    await pool.query("UPDATE edu_learning_programs SET archived=TRUE,updated_at=NOW() WHERE id=$1 AND company_id=$2 AND tenant_id=$3", [p.id, a.company_id, a.tenant_id]);
    await audit(pool, a, p.id, "program_archived"); return { success: true };
  }
  async function certificate(req, programId) {
    const a = await actor(req), p = await program(a, programId); if (a.staff) fail(403, "L'attestation est personnelle à l'élève.");
    const s = await student(a, p.class_id), row = (await pool.query(`SELECT c.*,s.first_name,s.last_name,co.name AS school_name
      FROM edu_learning_certificates c JOIN edu_students s ON s.id=c.student_id JOIN companies co ON co.id=c.company_id
      WHERE c.program_id=$1 AND c.student_id=$2 AND c.company_id=$3 AND c.tenant_id=$4`, [p.id, s.id, a.company_id, a.tenant_id])).rows[0];
    if (!row) fail(404, "Attestation non disponible."); return { ...row, program_title: p.title };
  }
  return { catalog, save, publish, detail, start, submit, report, allowRetry, settings, createStudentAccount, setStudentAccountStatus, registerAsset, assetForDownload, duplicate, archive, certificate };
}
module.exports = { createLearningService, validateProgram, validateResources, LearningError };
