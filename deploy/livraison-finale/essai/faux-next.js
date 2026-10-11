// Faux « next build / next start » pour le VPS d'essai.
// La release NOUVELLE (qui contient app/confirmer-email) lit /etc/essai/nouveau,
// l'ANCIENNE lit /etc/essai/ancien, au démarrage :
//   plante  → s'arrête aussitôt (code 1)     http500 → /confirmer-email répond 500
//   lent    → n'écoute qu'après 120 s        (vide)  → normal
const fs = require("fs"), http = require("http");
const lire = (f) => { try { return fs.readFileSync(f, "utf8").trim(); } catch { return ""; } };
if (process.argv[2] === "build") {
  fs.mkdirSync(".next", { recursive: true });
  fs.writeFileSync(".next/BUILD_ID", String(Date.now()));
  console.log("build ok, NEXT_PUBLIC_APP_PRODUCT=" + process.env.NEXT_PUBLIC_APP_PRODUCT);
  process.exit(0);
}
if (!fs.existsSync(".next/BUILD_ID")) { console.error("aucun build"); process.exit(1); }
const nouvelle = fs.existsSync("app/confirmer-email/page.tsx");
const mode = lire(nouvelle ? "/etc/essai/nouveau" : "/etc/essai/ancien");
console.log(`démarrage ${nouvelle ? "NOUVELLE" : "ANCIENNE"} release, mode « ${mode || "normal"} », PORT=${process.env.PORT}`);
if (mode === "plante") { console.error("plantage volontaire"); process.exit(1); }
const pages = { "/": true, "/confirmer-email": nouvelle, "/social/lives": fs.existsSync("app/social/lives/page.tsx"), "/education/academy": fs.existsSync("app/education/academy/page.tsx") };
const serveur = http.createServer((req, res) => {
  const chemin = req.url.split("?")[0];
  if (chemin === "/__essai") return res.end(JSON.stringify({ release: nouvelle ? "nouvelle" : "ancienne", cwd: process.cwd(), PORT: process.env.PORT, MARQUEUR_ESSAI: process.env.MARQUEUR_ESSAI }));
  if (mode === "http500" && chemin === "/confirmer-email") { res.statusCode = 500; return res.end("erreur volontaire"); }
  res.statusCode = pages[chemin] ? 200 : 404;
  res.end(pages[chemin] ? `page ${chemin}` : "introuvable");
});
setTimeout(() => serveur.listen(Number(process.env.PORT)), mode === "lent" ? 120000 : 0);
