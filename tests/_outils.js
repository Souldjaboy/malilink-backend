"use strict";
/* Outils communs aux tests d'intégration HTTP (vrai serveur, vraie base). */
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");

const BASE = `http://127.0.0.1:${process.env.PORT || 5078}`;
const SECRET = process.env.JWT_SECRET;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const V = "\x1b[32m", R = "\x1b[31m", G = "\x1b[1m", Z = "\x1b[0m";
const bilan = { reussis: 0, echoues: 0 };
function verifier(titre, condition, detail = "") {
  if (condition) { bilan.reussis += 1; console.log(`${V}  ✓${Z} ${titre}`); }
  else { bilan.echoues += 1; console.log(`${R}  ✗ ${titre}${Z}${detail ? `  — ${detail}` : ""}`); }
}
const section = (t) => console.log(`\n${G}${t}${Z}`);

const jeton = (u) => jwt.sign({
  id: u.id, fullname: u.fullname || "Essai", email: u.email || `u${u.id}@essai.test`,
  role: u.role, company_id: u.company_id ?? null, is_super_admin: Boolean(u.is_super_admin),
}, SECRET, { expiresIn: "2h" });
const jetonSuperAdmin = () => jeton({ id: 999001, role: "super_admin", is_super_admin: true });

async function appel(methode, chemin, token, corps, entetes = {}) {
  const r = await fetch(`${BASE}${chemin}`, {
    method: methode,
    headers: {
      "Content-Type": "application/json",
      "x-tenant-id": "malilink",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...entetes,
    },
    body: corps ? JSON.stringify(corps) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch { /* corps vide */ }
  return { status: r.status, data };
}
const q = async (sql, p = []) => (await pool.query(sql, p)).rows;

/* Société + administrateur, sur le tenant malilink, avec des modules posés. */
async function creerSociete({ nom, type = "commerce", planCode = "business", modules = {} }) {
  const plan = (await q(`SELECT id FROM subscription_plans WHERE commercial_code = $1`, [planCode]))[0];
  const societe = (await q(
    `INSERT INTO companies (name, business_type, status, subscription_status, plan_id, tenant_id)
     VALUES ($1, $2, 'active', 'active', $3, 'malilink') RETURNING id`, [nom, type, plan.id]))[0];
  await q(`INSERT INTO subscriptions (company_id, plan_id, status, payment_status) VALUES ($1,$2,'active','paid')`, [societe.id, plan.id]);
  const admin = (await q(
    `INSERT INTO users (fullname, email, password, role, company_id)
     VALUES ($1, $2, 'x', 'admin', $3) RETURNING id, role, company_id`,
    [`Direction ${nom}`, `direction-${societe.id}@essai.test`, societe.id]))[0];
  for (const [cle, actif] of Object.entries(modules)) {
    await q(`INSERT INTO company_modules (company_id, module_key, is_enabled, enabled, source)
             VALUES ($1,$2,$3,$3,'super_admin')
             ON CONFLICT (company_id, module_key) DO UPDATE SET is_enabled=EXCLUDED.is_enabled, enabled=EXCLUDED.enabled, source='super_admin'`,
      [societe.id, cle, actif]);
  }
  return { id: societe.id, planId: plan.id, admin, token: jeton(admin) };
}

async function terminer() {
  console.log(`\n${G}BILAN${Z}  ${bilan.reussis} réussis, ${bilan.echoues} échoués`);
  await pool.end();
  process.exit(bilan.echoues === 0 ? 0 : 1);
}

module.exports = { BASE, pool, q, appel, jeton, jetonSuperAdmin, verifier, section, creerSociete, terminer, bilan };
