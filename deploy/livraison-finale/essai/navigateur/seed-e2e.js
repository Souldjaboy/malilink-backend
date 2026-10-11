// Données d'essai pour les tests navigateur (base malilink_e2e, jamais la base de développement).
const path = require("path");
const B = process.env.BACK || path.resolve(__dirname, "../../../..");
const { Pool } = require(path.join(B, "node_modules/pg"));
const bcrypt = require(path.join(B, "node_modules/bcryptjs"));
const jwt = require(path.join(B, "node_modules/jsonwebtoken"));
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const q = async (s, p = []) => (await pool.query(s, p)).rows;
(async () => {
  const H = bcrypt.hashSync("Essai-2026-ok", 4);
  const plan = (await q(`SELECT id FROM subscription_plans WHERE commercial_code='business'`))[0].id;
  const societe = async (nom, type, espace, verifiee = true) => {
    const c = (await q(`INSERT INTO companies (name, business_type, status, subscription_status, plan_id, tenant_id, email_verified, account_status, email, phone)
      VALUES ($1,$2,'active','active',$3,$4,$5,$6,$7,'+22370000000') RETURNING id`, [nom, type, plan, espace, verifiee, verifiee ? "active" : "pending_verification", `contact-${Date.now()}@ecole.test`]))[0].id;
    await q(`INSERT INTO subscriptions (company_id, plan_id, status, payment_status) VALUES ($1,$2,'active','paid')`, [c, plan]);
    return c;
  };
  const compte = async (nom, email, role, companyId, { sa = false, verifie = true, espace = null } = {}) => (await q(
    `INSERT INTO users (fullname, email, password, role, company_id, is_super_admin, is_active, email_verified, account_status, verification_required, account_tenant_id, account_tenant_source)
     VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$9,$10,$11) RETURNING id`,
    [nom, email, H, role, companyId, sa, verifie, verifie ? "active" : "pending_verification", !verifie, espace, espace ? "inscription" : null]))[0].id;
  const plateforme = await societe("Plateforme MaliLink", "commerce", "malilink");
  const sa = await compte("Super Admin E2E", "sa-e2e@essai.test", "super_admin", plateforme, { sa: true });
  const ecole = await societe("MALILINK SCOOL", "ecole", "malilink", false);
  const directeur = await compte("Directeur MaliLink Scool", "directeur-scool@essai.test", "admin", ecole, { verifie: false });
  const hafiya = await societe("Laboratoire HAFIYA", "laboratoire", "hafiya");
  const hafiyaAdmin = await compte("Admin HAFIYA", "admin-hafiya@essai.test", "admin", hafiya);
  const hote = await compte("Fanta Hôte", "hote-e2e@essai.test", "customer", null, { espace: "malilink" });
  const spectateur = await compte("Issa Spectateur", "spectateur-e2e@essai.test", "customer", null, { espace: "malilink" });
  const membreB = await compte("Sira Espace B", "membre-b@essai.test", "customer", null, { espace: "hafiya" });
  await q(`UPDATE social_feature_flags SET enabled=true WHERE flag_key IN ('social_enabled','social_lives_enabled')`);
  const signe = (id, role, company_id, tenant_id, is_super_admin = false) => jwt.sign({ id, role, company_id, tenant_id, is_super_admin }, process.env.JWT_SECRET, { expiresIn: "4h" });
  const sortie = { plateforme, sa, ecole, directeur, hafiya, hafiyaAdmin, hote, spectateur, membreB,
    jetons: { sa: signe(sa, "super_admin", plateforme, "malilink", true), hote: signe(hote, "customer", null, "malilink"), spectateur: signe(spectateur, "customer", null, "malilink"), membreB: signe(membreB, "customer", null, "hafiya") } };
  require("fs").writeFileSync(path.join(__dirname, "e2e-donnees.json"), JSON.stringify(sortie, null, 1));
  console.log(JSON.stringify({ ...sortie, jetons: Object.keys(sortie.jetons) }));
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
