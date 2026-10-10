"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { PGlite } = require("@electric-sql/pglite");
const { createLearningService, validateProgram } = require("./learning");
test("Academy: validation du contenu", () => {
  assert.throws(() => validateProgram({}), e => e.status === 400);
  const q = { prompt: "Question", choices: ["Oui", "Non"], answer: 0 };
  const body = { title: "Formation", class_id: 1, units: [{ course_id: 1, questions: [q] }] };
  assert.equal(validateProgram(body).threshold, 70);
  assert.throws(() => validateProgram({ ...body, units: [...body.units, ...body.units] }), e => e.status === 400);
  assert.throws(() => validateProgram({ ...body, units: [{ course_id: 1, questions: [{ ...q, answer: 8 }] }] }), e => e.status === 400);
});
test("Academy: migration et parcours réel sur PostgreSQL embarqué", async t => {
  const db = new PGlite(); await db.waitReady; t.after(() => db.close());
  await db.exec(`
    CREATE TABLE companies(id INTEGER PRIMARY KEY,tenant_id TEXT,status TEXT,business_type TEXT,plan_id INTEGER,name TEXT);
    CREATE TABLE users(id SERIAL PRIMARY KEY,company_id INTEGER,role TEXT,is_active BOOLEAN,email TEXT,password TEXT,fullname TEXT,
      is_super_admin BOOLEAN DEFAULT FALSE,force_password_change BOOLEAN DEFAULT FALSE,account_status TEXT,verification_required BOOLEAN,email_verified BOOLEAN,updated_at TIMESTAMPTZ DEFAULT NOW());
    CREATE TABLE edu_classes(id INTEGER PRIMARY KEY,company_id INTEGER,name TEXT);
    CREATE TABLE edu_teacher_assignments(teacher_user_id INTEGER,class_id INTEGER,company_id INTEGER);
    CREATE TABLE edu_students(id INTEGER PRIMARY KEY,company_id INTEGER,user_id INTEGER,class_id INTEGER,status TEXT,first_name TEXT,last_name TEXT);
    CREATE TABLE edu_courses(id INTEGER PRIMARY KEY,company_id INTEGER,class_id INTEGER,title TEXT,content TEXT,is_published BOOLEAN);
    CREATE TABLE modules(module_key TEXT PRIMARY KEY,module_name TEXT,description TEXT);
    CREATE TABLE company_modules(company_id INTEGER,module_key TEXT,is_enabled BOOLEAN,enabled BOOLEAN,source TEXT);
    CREATE TABLE subscription_plans(id INTEGER PRIMARY KEY,excluded_modules JSONB);
    CREATE TABLE subscriptions(id SERIAL PRIMARY KEY,company_id INTEGER,plan_id INTEGER);
    CREATE TABLE user_permissions(user_id INTEGER,module_key TEXT,can_view BOOLEAN,can_create BOOLEAN,can_update BOOLEAN,can_delete BOOLEAN,
      can_import BOOLEAN,can_export BOOLEAN,can_print BOOLEAN,can_validate BOOLEAN,can_cancel BOOLEAN,can_share BOOLEAN);
    INSERT INTO companies VALUES(1,'malilink','active','ecole',NULL,'École A'),(2,'malilink','active','ecole',NULL,'École B'),(3,'other','active','ecole',NULL,'École C');
    INSERT INTO users(id,company_id,role,is_active,email,is_super_admin) VALUES
      (1,1,'director',TRUE,'dir@a.test',FALSE),(2,1,'student',TRUE,'a@a.test',FALSE),
      (3,2,'student',TRUE,'b@b.test',FALSE),(4,1,'teacher',TRUE,'teacher@a.test',FALSE),
      (5,1,'teacher',TRUE,'other@a.test',FALSE),(6,1,'student',TRUE,'c@a.test',FALSE),
      (7,1,'super_admin',TRUE,'root@a.test',TRUE);
    SELECT setval(pg_get_serial_sequence('users','id'),7,TRUE);
    INSERT INTO edu_classes VALUES(1,1,'A'),(2,2,'B');
    INSERT INTO edu_teacher_assignments VALUES(4,1,1);
    INSERT INTO edu_students VALUES(1,1,2,1,'actif','Élève','A'),(2,2,3,2,'actif','Élève','B'),(3,1,6,1,'actif','Élève','C'),(4,1,NULL,1,'actif','Sans','Compte');
    INSERT INTO edu_courses VALUES(1,1,1,'Leçon 1','Se présenter',TRUE),(2,1,1,'Leçon 2','Dialoguer',TRUE),(3,2,2,'Secret B','Ne doit pas fuiter',TRUE);
  `);
  const migration = await fs.readFile(path.join(__dirname, "../../sql/087_education_learning.sql"), "utf8");
  const finalization = await fs.readFile(path.join(__dirname, "../../sql/088_education_learning_finalization.sql"), "utf8");
  await db.exec(migration); await db.exec(migration); await db.exec(finalization); await db.exec(finalization);
  const pool = { query: (...args) => db.query(...args), connect: async () => ({ query: (...args) => db.query(...args), release() {} }) };
  const notifications = [];
  const s = createLearningService(pool, { hashPassword: async value => `hashed:${value}`, validatePasswordStrength: value => value.length >= 8 && /[A-Za-z]/.test(value) && /[0-9]/.test(value) ? "" : "Mot de passe insuffisant.", createNotification: async value => notifications.push(value) });
  const req = (userId, body = {}, company_id = 1, tenant_id = "malilink") => ({ user: { id: userId, company_id }, tenant_id, body });
  const fails = (fn, status) => assert.rejects(fn, e => e.status === status);
  const content = { title: "Anglais", class_id: 1, max_attempts: 2, units: [1, 2].map(course_id => ({ course_id, questions: [{ prompt: "Bonjour ?", choices: ["Hello", "Bye"], answer: 0, explanation: "Hello signifie bonjour." }] })) };
  let programId, attemptId;
  await t.test("désactivé par défaut, activation ciblée et migration rejouable", async () => {
    assert.equal((await db.query("SELECT COUNT(*)::int n FROM company_modules")).rows[0].n, 3);
    await fails(() => s.catalog(req(1)), 403);
    await db.query("UPDATE company_modules SET is_enabled=TRUE,enabled=TRUE,source='super_admin' WHERE company_id=1");
    await db.exec(migration); assert.equal((await s.catalog(req(1))).staff, true);
    await fails(() => s.catalog(req(3, {}, 2)), 403);
  });
  await t.test("le super-admin utilise la société active sélectionnée", async () => {
    await db.query("UPDATE company_modules SET is_enabled=TRUE,enabled=TRUE,source='super_admin' WHERE company_id=2");
    const selected = await s.catalog({
      user: { id: 7, company_id: 1, role: "super_admin", is_super_admin: true },
      tenant_id: "malilink",
      headers: { "x-active-company-id": "2" },
      body: {}
    });
    assert.equal(selected.staff, true);
    // Verify the actual data scope, not just the staff flag.
    const actorRequest = { user: { id: 7, company_id: 1 }, tenant_id: "malilink", headers: { "x-active-company-id": "2" }, body: {} };
    await db.query("UPDATE edu_learning_settings SET brand_name='SCOPE_A' WHERE company_id=1");
    await db.query("UPDATE edu_learning_settings SET brand_name='SCOPE_B' WHERE company_id=2");
    assert.equal((await s.catalog(actorRequest)).settings.brand_name, "SCOPE_B");
    await db.query("UPDATE company_modules SET is_enabled=FALSE,enabled=FALSE WHERE company_id=1");
    assert.equal((await s.catalog(actorRequest)).staff, true);
    await db.query("UPDATE company_modules SET is_enabled=TRUE,enabled=TRUE WHERE company_id=1");
    await fails(() => s.catalog({ ...actorRequest, headers: { "x-active-company-id": "3" } }), 403);
    await fails(() => s.catalog({ ...actorRequest, headers: { "x-active-company-id": "invalid" } }), 400);
    await fails(() => s.catalog({ ...actorRequest, headers: { "x-active-company-id": "999" } }), 403);
    const ordinary = await s.catalog({ ...req(1), headers: { "x-active-company-id": "2" }, user: { id: 1, company_id: 1, is_super_admin: true, role: "super_admin" } });
    assert.equal(ordinary.settings.brand_name, "SCOPE_A");
    assert.equal(ordinary.can_manage, true);
    await db.query("UPDATE users SET role='admin' WHERE id=7");
    assert.equal((await s.catalog(actorRequest)).can_manage, true);
    await db.query("UPDATE users SET is_active=FALSE WHERE id=7");
    await fails(() => s.catalog(actorRequest), 403);
    await db.query("UPDATE users SET is_active=TRUE,role='super_admin' WHERE id=7");
    await db.query("UPDATE company_modules SET is_enabled=FALSE,enabled=FALSE WHERE company_id=2");
    await fails(() => s.catalog(actorRequest), 403);
  });
  await t.test("rôles, classe affectée et références inter-écoles", async () => {
    await fails(() => s.save(req(2, content)), 403);
    await fails(() => s.save(req(5, content)), 403);
    await fails(() => s.save(req(1, { ...content, units: [{ ...content.units[0], course_id: 3 }] })), 400);
    await fails(() => s.save(req(1, { ...content, class_id: 2 })), 404);
    programId = (await s.save(req(4, content))).id;
    assert.equal((await s.catalog(req(2))).programs.length, 0);
    await fails(() => s.detail(req(2), programId), 404);
    await fails(() => s.detail(req(1, {}, 1, "other"), programId), 403);
  });
  await t.test("publication figée, corrections non divulguées et déblocage serveur", async () => {
    await s.publish(req(1), programId);
    await fails(() => s.save(req(1, content), programId), 409);
    await db.query("UPDATE edu_courses SET content='Texte changé' WHERE id=1");
    const p = await s.detail(req(2), programId);
    assert.equal(p.units[0].lesson.content, "Se présenter");
    assert.equal("answer" in p.units[0].questions[0], false);
    assert.equal("explanation" in p.units[0].questions[0], false);
    assert.equal(p.units[1].locked, true); assert.equal(p.units[1].lesson, null);
    await fails(() => s.start(req(2, { unit_index: 1 }), programId), 403);
    attemptId = (await s.start(req(2, { unit_index: 0 }), programId)).id;
    assert.equal((await s.start(req(2, { unit_index: 0 }), programId)).id, attemptId);
  });
  await t.test("propriété de tentative, correction serveur et idempotence", async () => {
    await fails(() => s.submit(req(6, { answers: [0] }), attemptId), 403);
    await fails(() => s.submit(req(2, { answers: [5] }), attemptId), 400);
    const result = await s.submit(req(2, { answers: [1], score: 100, passed: true }), attemptId);
    assert.equal(result.score, 0); assert.equal(result.passed, false);
    assert.equal((await s.submit(req(2, { answers: [0] }), attemptId)).score, 0);
    const second = await s.start(req(2, { unit_index: 0 }), programId);
    assert.equal((await s.submit(req(2, { answers: [0] }), second.id)).passed, true);
    assert.equal((await s.detail(req(2), programId)).units[1].locked, false);
  });
  await t.test("limite de tentatives, rapport professeur et suspension immédiate", async () => {
    for (let i = 0; i < 2; i++) { const a = await s.start(req(2, { unit_index: 1 }), programId); await s.submit(req(2, { answers: [1] }), a.id); }
    await fails(() => s.start(req(2, { unit_index: 1 }), programId), 409);
    const allowance = { student_id: 1, unit_index: 1, attempt_limit: 3, reason: "Révision avec le professeur" };
    await fails(() => s.allowRetry(req(2, allowance), programId), 403);
    await fails(() => s.allowRetry(req(5, allowance), programId), 403);
    await fails(() => s.allowRetry(req(4, { ...allowance, student_id: 2 }), programId), 404);
    await s.allowRetry(req(4, allowance), programId);
    await s.allowRetry(req(4, allowance), programId);
    assert.equal((await s.detail(req(2), programId)).units[1].attempt_limit, 3);
    const extra = await s.start(req(2, { unit_index: 1 }), programId);
    await s.submit(req(2, { answers: [1] }), extra.id);
    await fails(() => s.start(req(2, { unit_index: 1 }), programId), 409);
    await fails(() => s.report(req(2), programId), 403);
    const report = await s.report(req(4), programId); assert.equal(report.find(r => r.id === 1).passed_units, 1);
    await db.query("UPDATE users SET is_active=FALSE WHERE id=2"); await fails(() => s.detail(req(2), programId), 403);
    await db.query("UPDATE users SET is_active=TRUE WHERE id=2");
    await db.query("UPDATE edu_students SET status='suspendu' WHERE id=1"); await fails(() => s.detail(req(2), programId), 403);
    await db.query("UPDATE edu_students SET status='actif' WHERE id=1");
  });
  await t.test("comptes élèves, identité de marque et activation réversible", async () => {
    await fails(() => s.settings(req(2, { brand_name: "X", welcome_text: "X", primary_color: "#112233" }), true), 403);
    const settings = await s.settings(req(1, { brand_name: "MaliTech Academy", welcome_text: "Bienvenue", primary_color: "#112233", celebration_enabled: true }), true);
    assert.equal(settings.brand_name, "MaliTech Academy");
    await fails(() => s.createStudentAccount(req(4, { email: "new@a.test", password: "Ecole2026" }), 4), 403);
    const account = await s.createStudentAccount(req(1, { email: "new@a.test", password: "Ecole2026" }), 4);
    assert.equal(account.force_password_change, true);
    assert.equal((await db.query("SELECT user_id FROM edu_students WHERE id=4")).rows[0].user_id, account.id);
    await fails(() => s.createStudentAccount(req(1, { email: "again@a.test", password: "Ecole2026" }), 4), 409);
    assert.equal((await s.setStudentAccountStatus(req(1, { is_active: false }), 4)).is_active, false);
    assert.equal((await s.setStudentAccountStatus(req(1, { is_active: true }), 4)).is_active, true);
  });
  await t.test("ressources privées, duplication, archivage, récompenses et attestation", async () => {
    const asset = await s.registerAsset(req(4), { filename: "private.pdf", originalname: "cours.pdf", mimetype: "application/pdf", size: 1200 });
    const resourceProgram = (await s.save(req(1, { ...content, title: "Avec PDF", units: [{ ...content.units[0], resources: [{ type: "file", title: "Support PDF", asset_id: asset.id }] }] }))).id;
    await s.publish(req(1), resourceProgram);
    assert.equal((await s.assetForDownload(req(2), asset.id)).storage_key, "private.pdf");
    await fails(() => s.assetForDownload(req(3, {}, 2), asset.id), 403);
    const copied = await s.duplicate(req(1), resourceProgram);
    await s.archive(req(1), copied.id);
    assert.equal((await s.catalog(req(1))).programs.some(row => row.id === copied.id), false);
    for (const unit_index of [0, 1]) {
      const attempt = await s.start(req(6, { unit_index }), programId);
      const result = await s.submit(req(6, { answers: [0] }), attempt.id);
      assert.equal(result.passed, true);
    }
    const completed = await s.detail(req(6), programId);
    assert.ok(completed.certificate?.verification_token);
    assert.equal((await s.certificate(req(6), programId)).school_name, "École A");
    assert.ok(notifications.some(value => value.user_id === 6 && value.title.includes("terminé")));
  });
  await t.test("refus explicite, autre école activée, plan et révocation", async () => {
    await db.query("UPDATE company_modules SET is_enabled=TRUE,enabled=TRUE,source='super_admin' WHERE company_id=2");
    await fails(() => s.detail(req(3, {}, 2), programId), 404);
    await db.query("INSERT INTO user_permissions(user_id,module_key,can_view) VALUES(2,'education.learning',FALSE)");
    await fails(() => s.detail(req(2), programId), 403);
    await db.query("UPDATE user_permissions SET can_view=TRUE WHERE user_id=2");
    await db.query("INSERT INTO subscription_plans VALUES(1,'[\"education.learning\"]')");
    await db.query("UPDATE companies SET plan_id=1 WHERE id=1");
    await db.query("UPDATE company_modules SET source='inscription' WHERE company_id=1");
    await fails(() => s.catalog(req(1)), 403);
    await db.query("UPDATE company_modules SET source='super_admin' WHERE company_id=1");
    assert.equal((await s.catalog(req(1))).programs.length, 2);
    await db.query("UPDATE company_modules SET is_enabled=FALSE WHERE company_id=1");
    await fails(() => s.catalog(req(1)), 403);
    assert.ok((await db.query("SELECT COUNT(*)::int n FROM edu_learning_audit")).rows[0].n > 0);
  });
  await t.test("routes HTTP: module refusé, absence de session et réponses privées", async () => {
    const express = require("express"), app = express();
    app.use(express.json());
    // Test adapter only: production continues to use authenticateToken.
    app.use("/education/learning", require("../../routes/education-learning")({ pool, authenticateToken: (request, response, next) => {
      const identities = { "Bearer test-student": 2, "Bearer test-teacher": 4, "Bearer test-complete": 6 };
      const userId = identities[request.headers.authorization]; if (!userId) return response.sendStatus(401);
      Object.assign(request, req(userId)); next();
    }, createNotification: async () => {} }));
    const server = await new Promise(resolve => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
    try {
      const url = `http://127.0.0.1:${server.address().port}/education/learning/programs`;
      assert.equal((await fetch(url)).status, 401);
      const headers = { Authorization: "Bearer test-student" };
      assert.equal((await fetch(url, { headers })).status, 403);
      await db.query("UPDATE company_modules SET is_enabled=TRUE WHERE company_id=1");
      const response = await fetch(`${url}/${programId}`, { headers });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("cache-control"), /no-store/);
      assert.equal("answer" in (await response.json()).units[0].questions[0], false);
      const invalid = new FormData(); invalid.append("file", new Blob(["plain"], { type: "text/plain" }), "plain.txt");
      assert.equal((await fetch(url.replace("/programs", "/assets"), { method: "POST", headers: { Authorization: "Bearer test-teacher" }, body: invalid })).status, 400);
      const form = new FormData(); form.append("file", new Blob(["%PDF-test"], { type: "application/pdf" }), "support.pdf");
      const uploadedResponse = await fetch(url.replace("/programs", "/assets"), { method: "POST", headers: { Authorization: "Bearer test-teacher" }, body: form });
      assert.equal(uploadedResponse.status, 201); const uploaded = await uploadedResponse.json();
      const protectedProgram = (await s.save(req(1, { ...content, title: "Téléchargement", units: [{ ...content.units[0], resources: [{ type: "file", title: "Support", asset_id: uploaded.id }] }] }))).id;
      await s.publish(req(1), protectedProgram);
      const downloaded = await fetch(url.replace("/programs", `/assets/${uploaded.id}/download`), { headers });
      assert.equal(downloaded.status, 200); assert.equal(await downloaded.text(), "%PDF-test");
      const certificate = await fetch(`${url}/${programId}/certificate.pdf`, { headers: { Authorization: "Bearer test-complete" } });
      assert.equal(certificate.status, 200); assert.match(certificate.headers.get("content-type"), /application\/pdf/); assert.ok((await certificate.arrayBuffer()).byteLength > 1000);
      const stored = (await db.query("SELECT storage_key FROM edu_learning_assets WHERE id=$1", [uploaded.id])).rows[0];
      await fs.unlink(path.join(__dirname, "../../storage/education-learning", stored.storage_key));
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
});
