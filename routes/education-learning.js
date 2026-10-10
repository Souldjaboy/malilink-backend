"use strict";
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const express = require("express");
const multer = require("multer");
const PDFDocument = require("pdfkit");
const { createLearningService } = require("../services/education/learning");

const STORAGE_DIR = path.join(__dirname, "..", "storage", "education-learning");
fs.mkdirSync(STORAGE_DIR, { recursive: true, mode: 0o700 });
const ALLOWED_MIME = new Set([
  "application/pdf", "image/jpeg", "image/png", "audio/mpeg", "audio/mp4", "video/mp4", "video/webm",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation"
]);
const upload = multer({
  storage: multer.diskStorage({ destination: (_req, _file, done) => done(null, STORAGE_DIR), filename: (_req, file, done) => {
    const extension = path.extname(file.originalname || "").toLowerCase().replace(/[^.a-z0-9]/g, "").slice(0, 10);
    done(null, `${crypto.randomBytes(24).toString("hex")}${extension}`);
  } }),
  limits: { fileSize: 50 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, done) => done(ALLOWED_MIME.has(file.mimetype) ? null : new Error("TYPE_NOT_ALLOWED"), ALLOWED_MIME.has(file.mimetype))
});
function signatureMatches(file) {
  const descriptor = fs.openSync(file.path, "r"), bytes = Buffer.alloc(16); let length = 0;
  try { length = fs.readSync(descriptor, bytes, 0, bytes.length, 0); } finally { fs.closeSync(descriptor); }
  const head = bytes.subarray(0, length), ascii = head.toString("ascii");
  if (file.mimetype === "application/pdf") return ascii.startsWith("%PDF-");
  if (file.mimetype === "image/jpeg") return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (file.mimetype === "image/png") return head.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  if (["video/mp4", "audio/mp4"].includes(file.mimetype)) return ascii.slice(4, 8) === "ftyp";
  if (file.mimetype === "video/webm") return head.subarray(0, 4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]));
  if (file.mimetype === "audio/mpeg") return ascii.startsWith("ID3") || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0);
  return head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}

module.exports = ({ pool, authenticateToken, hashPassword, validatePasswordStrength, createNotification }) => {
  const router = express.Router();
  const service = createLearningService(pool, { hashPassword, validatePasswordStrength, createNotification });
  router.use(authenticateToken);
  const route = fn => async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    try { res.json(await fn(req)); }
    catch (error) { res.status(error.status || 503).json({ error: error.status ? error.message : "Academy temporairement indisponible." }); }
  };
  router.get("/settings", route(req => service.settings(req)));
  router.put("/settings", route(req => service.settings(req, true)));
  router.post("/assets", (req, res) => upload.single("file")(req, res, async error => {
    res.set("Cache-Control", "private, no-store");
    if (error) return res.status(error.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: error.message === "TYPE_NOT_ALLOWED" ? "Format de fichier non autorisé." : "Téléversement impossible." });
    if (!req.file) return res.status(400).json({ error: "Fichier requis." });
    if (!signatureMatches(req.file)) { fs.unlink(req.file.path, () => {}); return res.status(400).json({ error: "Le contenu du fichier ne correspond pas au format annoncé." }); }
    try { res.status(201).json(await service.registerAsset(req, req.file)); }
    catch (registrationError) { fs.unlink(req.file.path, () => {}); res.status(registrationError.status || 503).json({ error: registrationError.status ? registrationError.message : "Enregistrement du fichier impossible." }); }
  }));
  router.get("/assets/:id/download", async (req, res) => {
    res.set("Cache-Control", "private, no-store"); res.set("X-Content-Type-Options", "nosniff");
    try {
      const asset = await service.assetForDownload(req, req.params.id), location = path.join(STORAGE_DIR, path.basename(asset.storage_key));
      if (!fs.existsSync(location)) return res.status(404).json({ error: "Fichier absent du stockage." });
      res.type(asset.mime_type); res.download(location, asset.original_name);
    } catch (error) { res.status(error.status || 503).json({ error: error.status ? error.message : "Téléchargement impossible." }); }
  });
  router.post("/students/:id/account", route(req => service.createStudentAccount(req, req.params.id)));
  router.put("/students/:id/account/status", route(req => service.setStudentAccountStatus(req, req.params.id)));
  router.get("/programs", route(req => service.catalog(req)));
  router.post("/programs", route(req => service.save(req)));
  router.get("/programs/:id", route(req => service.detail(req, req.params.id)));
  router.put("/programs/:id", route(req => service.save(req, req.params.id)));
  router.post("/programs/:id/publish", route(req => service.publish(req, req.params.id)));
  router.post("/programs/:id/duplicate", route(req => service.duplicate(req, req.params.id)));
  router.put("/programs/:id/archive", route(req => service.archive(req, req.params.id)));
  router.get("/programs/:id/report", route(req => service.report(req, req.params.id)));
  router.put("/programs/:id/allowance", route(req => service.allowRetry(req, req.params.id)));
  router.post("/programs/:id/start", route(req => service.start(req, req.params.id)));
  router.post("/attempts/:id/submit", route(req => service.submit(req, req.params.id)));
  router.get("/programs/:id/certificate.pdf", async (req, res) => {
    res.set("Cache-Control", "private, no-store");
    try {
      const certificate = await service.certificate(req, req.params.id), settings = await service.settings(req);
      const pdf = new PDFDocument({ size: "A4", layout: "landscape", margin: 55, info: { Title: `Attestation ${certificate.program_title}` } });
      res.type("application/pdf"); res.attachment(`attestation-academy-${certificate.id}.pdf`); pdf.pipe(res);
      pdf.lineWidth(3).strokeColor(settings.primary_color || "#0f172a").rect(28, 28, 786, 539).stroke();
      pdf.fillColor(settings.primary_color || "#0f172a").font("Helvetica-Bold").fontSize(30).text(settings.brand_name || "MaliLink Academy", { align: "center" });
      pdf.moveDown().fontSize(24).text("ATTESTATION DE RÉUSSITE", { align: "center" });
      pdf.moveDown(1.5).font("Helvetica").fontSize(16).fillColor("#334155").text("Cette attestation certifie que", { align: "center" });
      pdf.moveDown(.6).font("Helvetica-Bold").fontSize(28).fillColor("#0f172a").text(`${certificate.first_name} ${certificate.last_name}`, { align: "center" });
      pdf.moveDown(.6).font("Helvetica").fontSize(16).fillColor("#334155").text("a validé toutes les leçons du parcours", { align: "center" });
      pdf.moveDown(.5).font("Helvetica-Bold").fontSize(22).fillColor(settings.primary_color || "#0f172a").text(certificate.program_title, { align: "center" });
      pdf.moveDown(1.5).font("Helvetica").fontSize(12).fillColor("#475569").text(`${certificate.school_name} · Délivrée le ${new Date(certificate.issued_at).toLocaleDateString("fr-FR")}`, { align: "center" });
      pdf.moveDown(.5).fontSize(9).text(`Référence unique : ${certificate.verification_token}`, { align: "center" }); pdf.end();
    } catch (error) { if (!res.headersSent) res.status(error.status || 503).json({ error: error.status ? error.message : "Attestation indisponible." }); }
  });
  return router;
};
