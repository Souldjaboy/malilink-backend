"use strict";
const { chromium } = require("playwright-core");
const donnees = require("./e2e-donnees.json");
const [jetonHote, jetonSpectateur, jetonAutreEspace] = [donnees.jetons.hote, donnees.jetons.spectateur, donnees.jetons.membreB];
const BASE = process.env.BASE || "http://localhost:3000";
const API = "http://localhost:5052";
const resultats = [];
const ok = (titre, cond, detail = "") => { resultats.push([cond, titre]); console.log(`${cond ? "✓" : "✗"} ${titre}${!cond && detail ? ` — ${detail}` : ""}`); };

async function contexte(navigateur, jeton) {
  const ctx = await navigateur.newContext({ permissions: ["camera", "microphone"], viewport: { width: 1280, height: 800 } });
  await ctx.addInitScript((t) => {
    localStorage.setItem("client_token", t); localStorage.setItem("token", t);
    document.cookie = `triangle_client_token=${t}; path=/`; document.cookie = `triangle_token=${t}; path=/`;
  }, jeton);
  return ctx;
}
const api = (chemin, jeton, opts = {}) => fetch(`${API}${chemin}`, { ...opts, headers: { Authorization: `Bearer ${jeton}`, "x-tenant-id": "malilink", "Content-Type": "application/json", ...(opts.headers || {}) } }).then((r) => r.json());

(async () => {
  const navigateur = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  try {
    const hote = await (await contexte(navigateur, jetonHote)).newPage();
    await hote.goto(`${BASE}/social/lives/nouveau`, { waitUntil: "networkidle", timeout: 120000 });
    await hote.getByRole("button", { name: /Activer la caméra et le micro/ }).click();
    await hote.getByPlaceholder("De quoi parle votre direct ?").fill("Essai de direct MaliLink");
    await hote.getByRole("button", { name: /Démarrer le direct/ }).click();
    await hote.getByText("EN DIRECT", { exact: false }).waitFor({ timeout: 30000 });
    ok("hôte : direct démarré et caméra publiée", true);

    const lives = await api("/social/lives", jetonSpectateur);
    const live = (lives.lives || []).find((l) => l.title === "Essai de direct MaliLink");
    ok("spectateur : le direct apparaît dans sa liste", Boolean(live), JSON.stringify(lives).slice(0, 200));

    const spec = await (await contexte(navigateur, jetonSpectateur)).newPage();
    await spec.goto(`${BASE}/social/lives/${live.id}`, { waitUntil: "networkidle", timeout: 120000 });
    const images = await spec.waitForFunction(() => {
      const v = document.querySelector("video");
      return v && v.videoWidth > 0 && v.readyState >= 2 ? `${v.videoWidth}x${v.videoHeight}` : null;
    }, null, { timeout: 60000 }).then((h) => h.jsonValue()).catch(() => null);
    ok(`spectateur : images réellement reçues par WebRTC (${images || "aucune"})`, Boolean(images));
    const sonPiste = await spec.evaluate(() => { const a = document.querySelector("audio"); return Boolean(a && a.srcObject && a.srcObject.getAudioTracks().length); });
    ok("spectateur : piste audio de l'hôte reçue", sonPiste);

    // Compte d'un autre espace (hafiya) avec l'adresse exacte du direct : aucune image, aucun jeton.
    const intrus = await (await contexte(navigateur, jetonAutreEspace)).newPage();
    const jetonsVus = [];
    intrus.on("response", async (r) => { if (r.url().includes("/rejoindre")) jetonsVus.push(await r.text().catch(() => "")); });
    await intrus.goto(`${BASE}/social/lives/${live.id}`, { waitUntil: "networkidle", timeout: 120000 }).catch(() => {});
    await intrus.waitForTimeout(5000);
    const imagesIntrus = await intrus.evaluate(() => { const v = document.querySelector("video"); return v ? v.videoWidth : 0; }).catch(() => 0);
    const direct = await api(`/social/lives/${live.id}`, jetonAutreEspace, { headers: { "x-tenant-id": "hafiya" } });
    // L'espace vient du serveur : l'en-tête « hafiya » contraire est refusé dès l'entrée (400).
    ok(`autre espace (hafiya) avec l'adresse du direct : aucune image, aucun jeton (${intrus.url().replace(BASE, "")})`,
      imagesIntrus === 0 && !jetonsVus.some((t) => t.includes('"token"')) && !direct.token && direct.error === "Tenant invalide.", JSON.stringify(direct));

    await new Promise((r) => setTimeout(r, 6000));
    const detail = await api(`/social/lives/${live.id}`, jetonHote);
    ok(`compteur réel côté serveur média : ${detail.compteur?.spectateurs} spectateur (${detail.compteur?.source})`, detail.compteur?.spectateurs === 1 && detail.compteur.source === "serveur_media", JSON.stringify(detail.compteur));

    await spec.getByLabel("Commentaire").fill("Bonjour depuis le second compte !");
    await spec.getByRole("button", { name: "Envoyer" }).click();
    await hote.getByText("Bonjour depuis le second compte !").waitFor({ timeout: 20000 });
    ok("commentaire du spectateur reçu chez l'hôte", true);

    const moiSpec = JSON.parse(Buffer.from(jetonSpectateur.split(".")[1], "base64url").toString()).id;
    const excl = await api(`/social/lives/${live.id}/exclure/${moiSpec}`, jetonHote, { method: "POST", body: "{}" });
    ok("exclusion : spectateur déconnecté par le serveur média", excl.deconnecte_du_serveur_media === true, JSON.stringify(excl));
    await spec.getByText("Vous avez été exclu de ce direct.").waitFor({ timeout: 15000 });
    ok("le spectateur exclu voit le message d'exclusion", true);
    const rejoindre = await api(`/social/lives/${live.id}/rejoindre`, jetonSpectateur, { method: "POST" });
    ok("l'exclu ne peut plus obtenir de jeton", rejoindre.code === "EXCLU");

    const fin = await api(`/social/lives/${live.id}/terminer`, jetonHote, { method: "POST" });
    ok("l'hôte termine le direct (salle fermée)", fin.termine === true);
    await hote.screenshot({ path: "hote.png" });
  } catch (e) {
    ok(`erreur : ${e.message}`, false);
  } finally {
    await navigateur.close();
    const echecs = resultats.filter(([c]) => !c).length;
    console.log(`\nBILAN ${resultats.length - echecs} réussis, ${echecs} échoués`);
    process.exit(echecs ? 1 : 0);
  }
})();
