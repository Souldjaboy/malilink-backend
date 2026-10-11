#!/usr/bin/env node
"use strict";

/**
 * Validation administrative d'un compte d'établissement (MaliLink).
 * À lancer DANS le dossier backend de la release active (lit son .env).
 *
 *   node scripts/comptes/valider-compte-ecole.js --identifier [--societe 8]
 *       Lecture seule : candidats (ID 8 + noms proches de « MaliLink School »),
 *       statuts, administrateurs avec email MASQUÉ. Ne modifie rien.
 *
 *   node scripts/comptes/valider-compte-ecole.js --valider --societe 8 --utilisateur <ID> \
 *        --nom "<nom exact affiché>" --par <email du Super Admin | auto> --motif "<motif>" --oui
 *       Une transaction : états avant/après, sauvegarde JSON (600) dans
 *       /root/backups, journal account_admin_validations + audit_logs.
 *       email_verified et l'abonnement ne sont PAS modifiés.
 */

const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(process.cwd(), ".env") });
const { Pool } = require("pg");
const comptes = require(path.join(__dirname, "..", "..", "services", "comptes"));
const { masquer } = require(path.join(__dirname, "..", "..", "services", "courriel"));

const args = process.argv.slice(2);
const opt = (nom) => { const i = args.indexOf(nom); return i >= 0 ? args[i + 1] : undefined; };
const drapeau = (nom) => args.includes(nom);
const normaliser = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const NOMS_ATTENDUS = ["malilink scool", "malilink school", "malitech school", "mali link school", "malilink scolaire"];

if (!process.env.DATABASE_URL) { console.error("DATABASE_URL absent : lancez ce script depuis le dossier backend de la release active."); process.exit(2); }
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function afficher(fiche, attendu) {
  const e = fiche.entreprise;
  console.log(`\nSociété ${e.id} — « ${e.name} »${attendu ? "  ← correspond au nom attendu" : ""}`);
  console.log(`  tenant ${e.tenant_id || "?"} · statut ${e.status || "?"} · compte ${e.account_status || "?"} · email ${e.email_masque || "—"} vérifié=${e.email_verified}`);
  console.log(`  abonnement ${e.subscription_status || "?"} · validation admin ${e.admin_validated_at ? new Date(e.admin_validated_at).toISOString() : "non"}`);
  if (e.tenant_id !== "malilink") {
    console.log(`  ⚠ espace « ${e.tenant_id || "non défini"} » : ce compte ne pourra pas se connecter sur MaliLink tant que l'espace de la société n'est pas « malilink » (aucune modification faite ici).`);
  }
  if (!fiche.administrateurs.length) console.log("  (aucun administrateur)");
  for (const u of fiche.administrateurs) {
    console.log(`  - utilisateur ${u.id} · ${u.role} · ${u.email_masque} · actif=${u.is_active} · compte=${u.account_status || "?"} · email vérifié=${u.email_verified} · vérification requise=${u.verification_required} · validation admin=${u.admin_validated_at ? "oui" : "non"}`);
  }
}

async function identifier() {
  const societe = Number(opt("--societe") || 8);
  const { rows } = await pool.query(`SELECT id, name FROM companies WHERE id=$1 OR name ~* 'mali\\s*(link|tech)' ORDER BY id`, [societe]);
  const candidats = rows.filter((r) => r.id === societe || /school|scool|ecole|scolaire|academy/.test(normaliser(r.name)));
  if (!candidats.length) { console.log("Aucune société candidate."); return; }
  for (const c of candidats) {
    const fiche = await comptes.identifier(pool, c.id);
    afficher(fiche, NOMS_ATTENDUS.includes(normaliser(c.name)));
  }
  console.log("\nAucune modification effectuée. Pour valider, relancez avec --valider et les IDs affichés ci-dessus.");
}

async function valider() {
  const societe = Number(opt("--societe"));
  const utilisateur = Number(opt("--utilisateur"));
  const nom = opt("--nom");
  const motif = opt("--motif");
  const par = opt("--par");
  if (!societe || !utilisateur || !nom || !motif || !par || !drapeau("--oui")) {
    console.error("Paramètres obligatoires : --societe --utilisateur --nom \"<nom exact>\" --par <email|auto> --motif \"...\" --oui");
    process.exit(2);
  }
  const fiche = await comptes.identifier(pool, societe);
  if (!fiche) { console.error(`Société ${societe} introuvable : arrêt.`); process.exit(1); }
  if (fiche.entreprise.name !== nom) {
    console.error(`Nom réel « ${fiche.entreprise.name} » différent du nom fourni « ${nom} » : arrêt sans modification.`);
    process.exit(1);
  }
  if (!fiche.administrateurs.some((u) => u.id === utilisateur)) {
    console.error(`L'utilisateur ${utilisateur} n'est pas un administrateur de la société ${societe} : arrêt sans modification.`);
    process.exit(1);
  }
  let superAdmin;
  if (par === "auto") {
    const { rows } = await pool.query(`SELECT id, email FROM users WHERE is_active IS NOT FALSE AND (is_super_admin IS TRUE OR LOWER(role)='super_admin')`);
    if (rows.length !== 1) { console.error(`${rows.length} Super Admins actifs : précisez --par <email>. Arrêt.`); process.exit(1); }
    superAdmin = rows[0];
  } else {
    superAdmin = (await pool.query(`SELECT id, email FROM users WHERE LOWER(email)=LOWER($1) AND is_active IS NOT FALSE AND (is_super_admin IS TRUE OR LOWER(role)='super_admin')`, [par])).rows[0];
    if (!superAdmin) { console.error("Super Admin introuvable ou inactif : arrêt."); process.exit(1); }
  }
  afficher(fiche, true);
  const dossier = process.env.MALILINK_SAUVEGARDES || "/root/backups";
  const fichier = path.join(fs.existsSync(dossier) ? dossier : process.cwd(), `malilink-validation-compte-${societe}-${utilisateur}-${Date.now()}.json`);
  fs.writeFileSync(fichier, JSON.stringify({ date: new Date().toISOString(), avant: fiche }, null, 2), { mode: 0o600 });
  console.log(`\nÉtat avant sauvegardé : ${fichier}`);
  const r = await comptes.validerAdministrativement(pool, { companyId: societe, userId: utilisateur, parId: superAdmin.id, motif, source: "script_vps" });
  console.log(`\nVALIDATION_ADMINISTRATIVE_EFFECTUEE · journal n°${r.journal_id} · par ${masquer(superAdmin.email)}`);
  console.log(`  utilisateur : compte ${r.avant.utilisateur.account_status} → ${r.apres.utilisateur.account_status}, vérification requise ${r.avant.utilisateur.verification_required} → ${r.apres.utilisateur.verification_required}`);
  console.log(`  email vérifié (inchangé) : ${r.apres.utilisateur.email_verified}`);
  console.log(`  entreprise : compte ${r.avant.entreprise.account_status} → ${r.apres.entreprise.account_status}`);
  console.log("La connexion n'est prouvée qu'après un essai réel de connexion avec ce compte.");
}

(async () => {
  try {
    if (drapeau("--valider")) await valider();
    else await identifier();
  } catch (e) {
    console.error(`ARRÊT : ${e.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
