// Faux Nginx : /api/* → backend :5050, le reste → frontend :3020 (502 si injoignable).
// /etc/essai/proxy = « resend-502 » → /api/verification/resend répond 502.
const http = require("http"), fs = require("fs");
http.createServer((req, res) => {
  const api = req.url.startsWith("/api/");
  let mode = ""; try { mode = fs.readFileSync("/etc/essai/proxy", "utf8").trim(); } catch {}
  if (mode === "resend-502" && req.url.startsWith("/api/verification/resend")) { res.statusCode = 502; return res.end("bad gateway"); }
  const amont = http.request({ host: "127.0.0.1", port: api ? 5050 : 3020, path: req.url, method: req.method, headers: { ...req.headers, host: "malilinkglobal.com" } }, (r) => {
    res.writeHead(r.statusCode, r.headers); r.pipe(res);
  });
  amont.on("error", () => { res.statusCode = 502; res.end("bad gateway"); });
  req.pipe(amont);
}).listen(8080);
