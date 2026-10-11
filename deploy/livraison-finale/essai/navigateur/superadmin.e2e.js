"use strict";
/* Super Admin › Entreprises › Modifier, dans un vrai navigateur :
   bouton, formulaire prérempli, sauvegarde réelle (relue en base), journal,
   administrateur, mot de passe temporaire, changement d'email vérifié,
   validation administrative — et aucun mot de passe existant affiché. */
const path = require("path");
const { chromium } = require("playwright-core");
const B = process.env.BACK || path.resolve(__dirname, "../../../..");
const { Pool } = require(path.join(B, "node_modules/pg"));
const d = require("./e2e-donnees.json");
const BASE = process.env.BASE || "http://localhost:3000";
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const q = async (s, p = []) => (await pool.query(s, p)).rows;
const resultats = [];
const ok = (titre, cond, detail = "") => { resultats.push(cond); console.log(`${cond ? "✓" : "✗"} ${titre}${!cond && detail ? ` — ${detail}` : ""}`); };

(async () => {
  const navigateur = await chromium.launch();
  const ctx = await navigateur.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on("dialog", (dialog) => dialog.accept());
  const textes = [];
  page.on("response", async (r) => { if (r.url().includes("/api/")) textes.push(await r.text().catch(() => "")); });
  try {
    // Vraie connexion par le formulaire (jeton, cookies et session posés par l'application).
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle", timeout: 180000 });
    await page.getByPlaceholder("Votre email ou téléphone").fill("sa-e2e@essai.test");
    await page.getByPlaceholder("Votre mot de passe").fill("Essai-2026-ok");
    await page.getByRole("button", { name: "Se connecter", exact: true }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 });
    const jetonNavigateur = await page.evaluate(() => localStorage.getItem("business_token") || localStorage.getItem("token"));
    ok("connexion Super Admin par le formulaire : jeton portant l'espace", JSON.parse(Buffer.from(jetonNavigateur.split(".")[1], "base64url").toString()).tenant_id === "malilink");
    await page.goto(`${BASE}/super-admin`, { waitUntil: "networkidle", timeout: 180000 });
    const lien = page.locator(`a[href="/super-admin/entreprises/${d.ecole}/modifier"]`).first();
    await lien.waitFor({ timeout: 60000 });
    ok("liste Super Admin : bouton « Modifier » de l'école", await lien.isVisible());
    ok("liste Super Admin : la société de l'espace HAFIYA n'apparaît pas", (await page.locator(`a[href="/super-admin/entreprises/${d.hafiya}/modifier"]`).count()) === 0);
    await lien.click();
    await page.getByRole("heading", { name: new RegExp(`Modifier l.entreprise #${d.ecole}`) }).waitFor({ timeout: 120000 });
    const champNom = page.locator("label", { hasText: /^Nom$/ }).locator("input");
    ok("formulaire prérempli (nom de l'école)", (await champNom.inputValue()) === "MALILINK SCOOL", await champNom.inputValue());

    await champNom.fill("MALILINK SCOOL (essai)");
    await page.locator("label", { hasText: /^Adresse$/ }).locator("input").fill("Bamako, ACI 2000");
    await page.getByRole("button", { name: /Enregistrer l.entreprise/ }).click();
    await page.getByText(/Enregistré \(\d+ modification/).waitFor({ timeout: 30000 });
    const soc = (await q(`SELECT name, address FROM companies WHERE id=$1`, [d.ecole]))[0];
    ok("sauvegarde réelle en base (nom, adresse)", soc.name === "MALILINK SCOOL (essai)" && soc.address === "Bamako, ACI 2000", JSON.stringify(soc));
    ok("journal de la modification", (await q(`SELECT 1 FROM audit_logs WHERE company_id=$1 AND action='super_admin_company_update'`, [d.ecole])).length > 0);

    const nomAdmin = page.locator("label", { hasText: /^Nom complet$/ }).locator("input").first();
    ok("administrateur prérempli", (await nomAdmin.inputValue()) === "Directeur MaliLink Scool");
    await nomAdmin.fill("Directeur Scool (essai)");
    await page.getByRole("button", { name: /Enregistrer l.administrateur/ }).first().click();
    await page.waitForTimeout(1500);
    ok("administrateur enregistré en base", (await q(`SELECT fullname FROM users WHERE id=$1`, [d.directeur]))[0].fullname === "Directeur Scool (essai)");

    const avant = (await q(`SELECT password FROM users WHERE id=$1`, [d.directeur]))[0].password;
    await page.getByRole("button", { name: /Réinitialiser \(je le transmets\)/ }).first().click();
    const temporaire = page.getByText(/MaliLink-[0-9a-f]{6}-[0-9A-F]{6}9/).first();
    await temporaire.waitFor({ timeout: 30000 });
    const apres = (await q(`SELECT password, force_password_change FROM users WHERE id=$1`, [d.directeur]))[0];
    ok("mot de passe temporaire affiché une fois, changement imposé, ancien mot de passe remplacé", apres.force_password_change === true && apres.password !== avant);
    ok("aucune empreinte de mot de passe dans les réponses reçues par le navigateur", textes.every((t) => !/\$2[aby]\$\d\d\$/.test(t) && !/"password"\s*:/.test(t)));

    // Changement d'email : entreprise puis administrateur, chacun en attente de confirmation.
    await fetch("http://127.0.0.1:8025/api/v1/messages", { method: "DELETE" });
    const champs = page.getByPlaceholder("Nouvelle adresse");
    await champs.nth(0).fill("contact-nouveau@ecole.test");
    await champs.nth(0).locator("xpath=following-sibling::button[1]").click();
    await page.waitForTimeout(2000);
    await champs.nth(1).fill("nouveau-directeur@essai.test");
    await champs.nth(1).locator("xpath=following-sibling::button[1]").click();
    await page.waitForTimeout(2500);
    const enAttente = await q(`SELECT subject_type, subject_id, new_email FROM account_email_changes WHERE confirmed_at IS NULL AND cancelled_at IS NULL ORDER BY id`);
    const actuels = (await q(`SELECT (SELECT email FROM companies WHERE id=$1) AS societe, (SELECT email FROM users WHERE id=$2) AS admin`, [d.ecole, d.directeur]))[0];
    ok("changement d'email (entreprise et administrateur) : en attente de confirmation, adresses actuelles inchangées",
      enAttente.some((c) => c.subject_type === "company" && c.subject_id === d.ecole && c.new_email === "contact-nouveau@ecole.test")
      && enAttente.some((c) => c.subject_type === "user" && c.subject_id === d.directeur && c.new_email === "nouveau-directeur@essai.test")
      && actuels.admin === "directeur-scool@essai.test" && !String(actuels.societe).includes("nouveau"), JSON.stringify({ enAttente, actuels }));
    const recus = await fetch("http://127.0.0.1:8025/api/v1/messages").then((r) => r.json());
    const a = (recus.messages || []).map((m) => m.To?.[0]?.Address);
    ok("email de confirmation envoyé aux NOUVELLES adresses (Mailpit)", a.includes("contact-nouveau@ecole.test") && a.includes("nouveau-directeur@essai.test"), JSON.stringify(a));

    await page.getByPlaceholder("Motif (obligatoire)").first().fill("Validation administrative demandée par le propriétaire (essai)");
    await page.getByRole("button", { name: /Valider le compte/ }).first().click();
    await page.waitForTimeout(2000);
    const v = (await q(`SELECT admin_validated_at, email_verified FROM users WHERE id=$1`, [d.directeur]))[0];
    ok("validation administrative journalisée, email TOUJOURS non vérifié", Boolean(v.admin_validated_at) && v.email_verified === false
      && (await q(`SELECT 1 FROM account_admin_validations WHERE user_id=$1`, [d.directeur])).length === 1);
    await page.screenshot({ path: "superadmin-modifier.png", fullPage: true });
  } catch (e) {
    ok(`erreur : ${e.message.split("\n")[0]}`, false);
    await page.screenshot({ path: "superadmin-erreur.png", fullPage: true }).catch(() => {});
  } finally {
    await navigateur.close();
    await pool.end();
    const echecs = resultats.filter((c) => !c).length;
    console.log(`\nBILAN ${resultats.length - echecs} réussis, ${echecs} échoués`);
    process.exit(echecs ? 1 : 0);
  }
})();
