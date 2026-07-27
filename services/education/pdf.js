"use strict";

/**
 * Générateur de documents PDF Éducation (côté serveur) — réutilisable par les
 * fiches d'inscription, reçus et bulletins. QR de vérification SIGNÉ (HMAC) qui
 * ne contient qu'une référence opaque, jamais de données personnelles.
 */

const crypto = require("crypto");
const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");

const DOC_SECRET =
  process.env.EDU_DOC_SECRET ||
  (process.env.NODE_ENV === "production"
    ? (() => { throw new Error("EDU_DOC_SECRET requis en production."); })()
    : "malilink_edu_docs_dev_only");

const NAVY = "#0f1b3d";
const GOLD = "#b3862e";

function signRef(fields) {
  return crypto.createHmac("sha256", DOC_SECRET).update(fields.join("|")).digest("hex").slice(0, 24);
}

// Jeton QR opaque : type|reference|signature (vérifiable côté serveur).
function docToken(type, reference, extra = "") {
  const sig = signRef([type, reference, extra]);
  return `MLK|${type}|${reference}|${sig}`;
}
function verifyToken(type, reference, sig, extra = "") {
  const expected = signRef([type, reference, extra]);
  return sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

async function qrBuffer(text) {
  const dataUrl = await QRCode.toDataURL(text, { margin: 1, width: 120 });
  return Buffer.from(dataUrl.split(",")[1], "base64");
}

/**
 * Rend un document et le pipe dans la réponse Express.
 * @param spec { filename, title, subtitle?, school, reference, qrText,
 *               sections: [{ title, rows: [{label, value}] }], footerNote? }
 */
async function renderDocument(res, spec) {
  const doc = new PDFDocument({ size: "A4", margin: 40 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${spec.filename || "document"}.pdf"`);
  doc.pipe(res);

  const school = spec.school || {};
  // En-tête établissement.
  doc.fillColor(NAVY).fontSize(16).font("Helvetica-Bold").text(school.name || "Établissement", 40, 45);
  doc.fontSize(9).font("Helvetica").fillColor("#444");
  const lines = [school.address, [school.phone, school.email].filter(Boolean).join(" · "), school.approval].filter(Boolean);
  lines.forEach((l, i) => doc.text(l, 40, 66 + i * 12));

  // QR en haut à droite.
  try {
    const qr = await qrBuffer(spec.qrText || spec.reference || "");
    doc.image(qr, 470, 40, { width: 85 });
  } catch { /* QR facultatif */ }

  // Bande titre.
  doc.moveTo(40, 118).lineTo(555, 118).lineWidth(2).strokeColor(GOLD).stroke();
  doc.fillColor(NAVY).fontSize(18).font("Helvetica-Bold").text(spec.title || "Document", 40, 128);
  if (spec.subtitle) doc.fontSize(10).font("Helvetica").fillColor("#555").text(spec.subtitle, 40, 152);
  doc.fontSize(9).fillColor("#777").text(`Référence : ${spec.reference || "—"}`, 40, spec.subtitle ? 168 : 152);

  let y = spec.subtitle ? 190 : 176;
  for (const section of spec.sections || []) {
    doc.fillColor(GOLD).fontSize(11).font("Helvetica-Bold").text(section.title, 40, y);
    y += 18;
    for (const row of section.rows) {
      doc.fillColor("#555").fontSize(10).font("Helvetica").text(String(row.label), 50, y, { width: 180, continued: false });
      doc.fillColor("#111").font("Helvetica-Bold").text(String(row.value ?? "—"), 235, y, { width: 320 });
      y += 16;
      if (y > 760) { doc.addPage(); y = 50; }
    }
    y += 10;
  }

  // Pied de page.
  const footY = 790;
  doc.moveTo(40, footY).lineTo(555, footY).lineWidth(0.5).strokeColor("#ccc").stroke();
  doc.fillColor("#888").fontSize(8).font("Helvetica").text(
    spec.footerNote || "Document généré par MaliLink Éducation. Vérifiable via le QR code.",
    40, footY + 6, { width: 515, align: "center" }
  );

  doc.end();
}

module.exports = { signRef, docToken, verifyToken, renderDocument, qrBuffer, DOC_SECRET };
