"use strict";
/* Paramètres › changer mon mot de passe, dans un vrai navigateur : la session
   courante continue (nouveau jeton), une autre session ouverte est fermée. */
const { chromium } = require("playwright-core");
const BASE = process.env.BASE || "http://localhost:3000";
const resultats = [];
const ok = (t, c, d = "") => { resultats.push(c); console.log(`${c ? "✓" : "✗"} ${t}${!c && d ? ` — ${d}` : ""}`); };
async function connecter(navigateur, mdp) {
  const ctx = await navigateur.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle", timeout: 120000 });
  await page.getByPlaceholder("Votre email ou téléphone").fill("sa-e2e@essai.test");
  await page.getByPlaceholder("Votre mot de passe").fill(mdp);
  await page.getByRole("button", { name: "Se connecter", exact: true }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 }).catch(() => {});
  return page;
}
const statutMe = (page) => page.evaluate(async () => (await fetch("/api/rbac/me", { headers: { Authorization: `Bearer ${localStorage.getItem("token") || localStorage.getItem("business_token")}` } })).status);
(async () => {
  const navigateur = await chromium.launch();
  try {
    const a = await connecter(navigateur, "Essai-2026-ok");
    const b = await connecter(navigateur, "Essai-2026-ok");
    ok("deux sessions ouvertes (A et B)", (await statutMe(a)) === 200 && (await statutMe(b)) === 200);
    const avant = await a.evaluate(() => localStorage.getItem("token"));
    await a.goto(`${BASE}/parametres`, { waitUntil: "networkidle", timeout: 120000 });
    await a.getByPlaceholder("Mot de passe actuel").fill("Essai-2026-ok");
    await a.getByPlaceholder("Nouveau mot de passe").fill("Change-2026-ok");
    await a.getByRole("button", { name: "Modifier mon mot de passe" }).click();
    await a.getByText(/autres sessions ont été fermées/).waitFor({ timeout: 30000 });
    ok("message exact : mot de passe modifié, autres sessions fermées", true);
    ok("session A : nouveau jeton enregistré par l'écran", (await a.evaluate(() => localStorage.getItem("token"))) !== avant);
    await a.reload({ waitUntil: "networkidle" });
    ok("session A : toujours connectée après rechargement", (await statutMe(a)) === 200 && !a.url().includes("/login"));
    ok("session B : fermée (401)", (await statutMe(b)) === 401);
    const c = await connecter(navigateur, "Change-2026-ok");
    ok("connexion avec le nouveau mot de passe", (await statutMe(c)) === 200);
  } catch (e) {
    ok(`erreur : ${e.message.split("\n")[0]}`, false);
  } finally {
    await navigateur.close();
    const echecs = resultats.filter((x) => !x).length;
    console.log(`\nBILAN ${resultats.length - echecs} réussis, ${echecs} échoués`);
    process.exit(echecs ? 1 : 0);
  }
})();
