#!/usr/bin/env node
"use strict";

/**
 * Attribution ADMINISTRATIVE de l'espace des comptes sans société.
 *
 * Un ancien compte sans société (client, livreur…) n'a pas d'espace prouvé :
 * il ne peut plus se connecter tant qu'un administrateur n'a pas attribué
 * explicitement son espace. Rien n'est déduit du site utilisé ni d'une
 * valeur par défaut. Chaque attribution est journalisée
 * (account_tenant_assignments + audit_logs : qui, quand, pourquoi, preuve).
 *
 *   node scripts/comptes/attribuer-espace.js --rapport
 *       lecture seule : comptes sans société, rattachés ou non, par rôle ;
 *       liste des non rattachés (emails et téléphones masqués).
 *
 *   node scripts/comptes/attribuer-espace.js --attribuer --espace malilink \
 *       (--ids 12,15 | --tous-non-rattaches) --par <email Super Admin|auto> \
 *       --motif "…" [--preuve "…"] --oui
 *       --tous-non-rattaches : décision de l'administrateur que TOUS les
 *       comptes sans société non rattachés de CETTE base appartiennent à
 *       cet espace (par ex. base dédiée à MaliLink). À utiliser en
 *       connaissance de cause, après --rapport.
 *
 * Le .env du dossier courant est lu (DATABASE_URL).
 */

const path = require("path");
require("dotenv").config({ path: path.join(process.cwd(), ".env"), quiet: true });
const { Pool } = require("pg");
const espaces = require(path.join(__dirname, "..", "..", "services", "espaces"));

const args = process.argv.slice(2);
const opt = (nom) => (args.includes(nom) ? args[args.indexOf(nom) + 1] : undefined);
const masquer = (v) => {
  const s = String(v || "");
  if (!s) return "—";
  if (s.includes("@")) { const [a, d] = s.split("@"); return `${a.slice(0, 1)}***@${d.slice(0, 1)}***${d.includes(".") ? d.slice(d.lastIndexOf(".")) : ""}`; }
  return s.length > 4 ? `${"*".repeat(s.length - 3)}${s.slice(-3)}` : "***";
};

async function rapport(pool) {
  const parRole = (await pool.query(
    `SELECT COALESCE(NULLIF(LOWER(role),''),'?') AS role,
            COUNT(*) FILTER (WHERE account_tenant_id IS NOT NULL) AS rattaches,
            COUNT(*) FILTER (WHERE account_tenant_id IS NULL) AS non_rattaches
       FROM users WHERE company_id IS NULL GROUP BY 1 ORDER BY 1`)).rows;
  const parEspace = (await pool.query(
    `SELECT account_tenant_id AS espace, COUNT(*) AS n FROM users WHERE company_id IS NULL AND account_tenant_id IS NOT NULL GROUP BY 1 ORDER BY 1`)).rows;
  console.log("Comptes sans société, par rôle :");
  if (!parRole.length) console.log("  (aucun)");
  for (const r of parRole) console.log(`  ${r.role.padEnd(14)} rattachés ${String(r.rattaches).padStart(5)} · NON rattachés ${String(r.non_rattaches).padStart(5)}`);
  console.log("Rattachés, par espace :", parEspace.length ? parEspace.map((r) => `${r.espace} ${r.n}`).join(" · ") : "aucun");
  const liste = (await pool.query(
    `SELECT u.id, u.role, u.email, u.phone, u.is_active, u.is_super_admin, u.created_at,
            EXISTS (SELECT 1 FROM marketplace_profiles mp WHERE mp.user_id=u.id) AS marketplace,
            (SELECT string_agg(DISTINCT d.tenant_id, ',') FROM delivery_drivers d WHERE d.user_id=u.id) AS livraison
       FROM users u WHERE u.company_id IS NULL AND u.account_tenant_id IS NULL ORDER BY u.id LIMIT 200`).catch(() => ({ rows: [] }))).rows;
  console.log(`\nNon rattachés (${liste.length} affichés au plus 200) — ils ne peuvent pas se connecter :`);
  for (const u of liste) {
    console.log(`  - ${u.id} · ${u.role}${u.is_super_admin ? " (SUPER ADMIN)" : ""} · ${masquer(u.email)} · ${masquer(u.phone)} · actif=${u.is_active !== false}`
      + ` · créé ${u.created_at ? new Date(u.created_at).toISOString().slice(0, 10) : "?"}${u.marketplace ? " · profil marketplace" : ""}${u.livraison ? ` · livreur (fiche ${u.livraison})` : ""}`);
  }
  console.log("\nAucune modification. Pour attribuer : --attribuer --espace <espace> (--ids … | --tous-non-rattaches) --par <email|auto> --motif \"…\" --oui");
}

async function attribuer(pool) {
  const tenant = espaces.normaliser(opt("--espace"));
  const motif = String(opt("--motif") || "").trim();
  const preuve = String(opt("--preuve") || "attestation_administrateur").trim();
  if (!tenant) throw new Error("--espace malilink|hafiya|triangle obligatoire");
  if (motif.length < 10) throw new Error("--motif obligatoire (10 caractères au moins)");
  if (!args.includes("--oui")) throw new Error("confirmation --oui obligatoire");
  const par = opt("--par");
  const superAdmins = (await pool.query(
    `SELECT id, email FROM users WHERE is_active IS NOT FALSE AND (is_super_admin IS TRUE OR LOWER(role)='super_admin')
       ${par && par !== "auto" ? "AND LOWER(email)=LOWER($1)" : ""}`, par && par !== "auto" ? [par] : [])).rows;
  if (superAdmins.length !== 1) throw new Error(par && par !== "auto" ? "Super Admin introuvable ou inactif" : `${superAdmins.length} Super Admins actifs : précisez --par <email>`);
  let ids;
  if (args.includes("--tous-non-rattaches")) {
    ids = (await pool.query("SELECT id FROM users WHERE company_id IS NULL AND account_tenant_id IS NULL ORDER BY id")).rows.map((r) => r.id);
  } else {
    ids = String(opt("--ids") || "").split(",").map((v) => Number(v.trim())).filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) throw new Error("--ids 12,15 ou --tous-non-rattaches obligatoire");
  }
  let faits = 0;
  for (const id of ids) {
    const r = await espaces.attribuer(pool, { userId: id, tenant, parId: superAdmins[0].id, motif, preuve, source: "script_vps" });
    if (r.ok) { faits += 1; console.log(`  ✓ compte ${id} → espace ${tenant} (journal n°${r.assignmentId})`); }
    else console.log(`  - compte ${id} : non modifié (${r.raison})`);
  }
  console.log(`\nATTRIBUTION_ESPACE_EFFECTUEE · ${faits} compte(s) → ${tenant} · par ${masquer(superAdmins[0].email)} · ${ids.length - faits} non modifié(s)`);
}

(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL absent (lancer depuis le dossier du backend)");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    if (args.includes("--attribuer")) await attribuer(pool);
    else await rapport(pool);
  } finally {
    await pool.end();
  }
})().catch((e) => { console.error(`ARRÊT : ${e.message}`); process.exit(1); });
