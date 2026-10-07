"use strict";

/**
 * Moteur de dessin à double sortie pour les documents Éducation.
 *
 * Un modèle (carte scolaire, en-tête…) est écrit UNE fois avec des
 * primitives simples ; il se rend soit dans un PDF (pdfkit), soit en SVG
 * pour l'aperçu dans le navigateur. Mêmes polices (Helvetica, Times), mêmes
 * métriques (celles de pdfkit), donc l'aperçu correspond au PDF imprimé.
 *
 * Coordonnées en points PDF, origine en haut à gauche ; le `y` d'un texte
 * est sa ligne de base.
 */

const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");

const POLICES = {
  sans: { pdf: "Helvetica", svg: "Helvetica, Arial, sans-serif", poids: 400, style: "normal" },
  "sans-bold": { pdf: "Helvetica-Bold", svg: "Helvetica, Arial, sans-serif", poids: 700, style: "normal" },
  "sans-italic": { pdf: "Helvetica-Oblique", svg: "Helvetica, Arial, sans-serif", poids: 400, style: "italic" },
  serif: { pdf: "Times-Roman", svg: "'Times New Roman', Times, serif", poids: 400, style: "normal" },
  "serif-bold": { pdf: "Times-Bold", svg: "'Times New Roman', Times, serif", poids: 700, style: "normal" },
  "serif-italic": { pdf: "Times-Italic", svg: "'Times New Roman', Times, serif", poids: 400, style: "italic" },
};

/* Les polices standard du PDF ne couvrent que le jeu WinAnsi : les lettres
   hors de ce jeu (ɛ, ɔ, ɲ… parfois utilisées dans les noms) sont
   translittérées plutôt que d'imprimer des signes illisibles. */
const WINANSI_EXTRA = new Set("ŒœŠšŽžŸƒˆ˜–—‘’‚“”„†‡•…‰‹›€™");
const TRANSLITTERATION = { "ɛ": "e", "Ɛ": "E", "ɔ": "o", "Ɔ": "O", "ɲ": "ny", "Ɲ": "Ny", "ŋ": "ng", "Ŋ": "Ng", "ᵉ": "e", "ʼ": "'", " ": " ", " ": " " };
function nettoyer(texte) {
  let s = "";
  for (const ch of String(texte ?? "").normalize("NFC")) {
    if (TRANSLITTERATION[ch] !== undefined) s += TRANSLITTERATION[ch];
    else if (ch.charCodeAt(0) <= 0xff || WINANSI_EXTRA.has(ch)) s += ch;
    else {
      const base = ch.normalize("NFD").replace(/[̀-ͯ]/g, "");
      s += base.charCodeAt(0) <= 0xff ? base : "";
    }
  }
  return s;
}

// Un document pdfkit sert d'instrument de mesure (jamais écrit).
const mesureur = new PDFDocument({ autoFirstPage: false });
function largeur(texte, police = "sans", taille = 10, espacement = 0) {
  const t = nettoyer(texte);
  mesureur.font(POLICES[police]?.pdf || "Helvetica").fontSize(taille);
  return mesureur.widthOfString(t) + Math.max(0, t.length - 1) * espacement;
}

/* Couleurs */
function rgb(hex) {
  const h = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""))?.[1] || "0f1b3d";
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const versHex = (c) => `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
function melange(a, b, t) {
  const x = rgb(a);
  const y = rgb(b);
  return versHex(x.map((v, i) => v + (y[i] - v) * t));
}
const eclaircir = (c, t) => melange(c, "#ffffff", t);
const assombrir = (c, t) => melange(c, "#000000", t);
function luminance(hex) {
  const [r, g, b] = rgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** Texte lisible sur un fond donné. */
const surFond = (fond, clair = "#ffffff", fonce = "#111827") => (luminance(fond) > 0.45 ? fonce : clair);

/* Coupe un texte en lignes d'une largeur donnée. */
function couper(texte, police, taille, largeurMax, maxLignes = 99) {
  const mots = nettoyer(texte).split(/\s+/).filter(Boolean);
  const lignes = [];
  let courante = "";
  for (const mot of mots) {
    const essai = courante ? `${courante} ${mot}` : mot;
    if (largeur(essai, police, taille) <= largeurMax || !courante) courante = essai;
    else { lignes.push(courante); courante = mot; }
  }
  if (courante) lignes.push(courante);
  if (lignes.length > maxLignes) {
    const garde = lignes.slice(0, maxLignes);
    let derniere = garde[maxLignes - 1];
    while (derniere.length > 1 && largeur(`${derniere}…`, police, taille) > largeurMax) derniere = derniere.slice(0, -1);
    garde[maxLignes - 1] = `${derniere}…`;
    return garde;
  }
  return lignes;
}

/* Ajuste un texte à une largeur : réduit la taille (jusqu'à 70 %), puis tronque. */
function ajuster(texte, police, taille, largeurMax, espacement = 0) {
  let t = nettoyer(texte);
  let s = taille;
  while (s > taille * 0.7 && largeur(t, police, s, espacement) > largeurMax) s -= 0.25;
  if (largeur(t, police, s, espacement) > largeurMax) {
    while (t.length > 1 && largeur(`${t}…`, police, s, espacement) > largeurMax) t = t.slice(0, -1);
    t = `${t}…`;
  }
  return { texte: t, taille: s };
}

function matriceQr(texte) {
  const qr = QRCode.create(String(texte || " "), { errorCorrectionLevel: "M" });
  return { n: qr.modules.size, data: qr.modules.data };
}

const echapper = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const nombre = (v) => Number(v.toFixed(2));

/* Type d'image (JPEG/PNG) d'après sa signature. */
function typeImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  return null;
}

/* ------------------------------ Sortie SVG ------------------------------ */
class ToileSvg {
  constructor(largeurPt, hauteurPt) {
    this.w = largeurPt;
    this.h = hauteurPt;
    this.defs = [];
    this.corps = [];
    this.id = `d${Math.random().toString(36).slice(2, 8)}`;
    this.n = 0;
  }

  nouvelId() { this.n += 1; return `${this.id}-${this.n}`; }

  remplissage(o) {
    if (o.degrade) {
      const id = this.nouvelId();
      const [x1, y1, x2, y2] = o.degrade.sens || [0, 0, 1, 1];
      this.defs.push(`<linearGradient id="${id}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}"><stop offset="0" stop-color="${o.degrade.de}"/><stop offset="1" stop-color="${o.degrade.a}"/></linearGradient>`);
      return `url(#${id})`;
    }
    return o.fill || "none";
  }

  attrs(o) {
    const a = [`fill="${this.remplissage(o)}"`];
    if (o.stroke) a.push(`stroke="${o.stroke}" stroke-width="${o.lineWidth ?? 1}"`);
    if (o.dash) a.push(`stroke-dasharray="${o.dash.join(" ")}"`);
    if (o.opacity != null && o.opacity < 1) a.push(`opacity="${o.opacity}"`);
    return a.join(" ");
  }

  rect(x, y, w, h, o = {}) {
    const r = o.radius ? ` rx="${nombre(o.radius)}"` : "";
    this.corps.push(`<rect x="${nombre(x)}" y="${nombre(y)}" width="${nombre(w)}" height="${nombre(h)}"${r} ${this.attrs(o)}/>`);
  }

  circle(cx, cy, r, o = {}) {
    this.corps.push(`<circle cx="${nombre(cx)}" cy="${nombre(cy)}" r="${nombre(r)}" ${this.attrs(o)}/>`);
  }

  ellipse(cx, cy, rx, ry, o = {}) {
    this.corps.push(`<ellipse cx="${nombre(cx)}" cy="${nombre(cy)}" rx="${nombre(rx)}" ry="${nombre(ry)}" ${this.attrs(o)}/>`);
  }

  polygon(points, o = {}) {
    this.corps.push(`<polygon points="${points.map(([x, y]) => `${nombre(x)},${nombre(y)}`).join(" ")}" ${this.attrs(o)}/>`);
  }

  line(x1, y1, x2, y2, o = {}) {
    this.corps.push(`<line x1="${nombre(x1)}" y1="${nombre(y1)}" x2="${nombre(x2)}" y2="${nombre(y2)}" ${this.attrs({ ...o, stroke: o.stroke || "#000" })}/>`);
  }

  text(texte, x, y, o = {}) {
    const police = POLICES[o.font || "sans"];
    let t = nettoyer(texte);
    let taille = o.size || 10;
    if (o.maxWidth) ({ texte: t, taille } = ajuster(t, o.font || "sans", taille, o.maxWidth, o.spacing || 0));
    const l = largeur(t, o.font || "sans", taille, o.spacing || 0);
    const x0 = o.align === "center" ? x - l / 2 : o.align === "right" ? x - l : x;
    const ls = o.spacing ? ` letter-spacing="${o.spacing}"` : "";
    const op = o.opacity != null && o.opacity < 1 ? ` opacity="${o.opacity}"` : "";
    this.corps.push(`<text x="${nombre(x0)}" y="${nombre(y)}" font-family="${police.svg}" font-size="${nombre(taille)}" font-weight="${police.poids}" font-style="${police.style}" fill="${o.color || "#111827"}"${ls}${op} xml:space="preserve">${echapper(t)}</text>`);
    return l;
  }

  image(buf, x, y, w, h, o = {}) {
    const type = typeImage(buf);
    if (!type) return false;
    let clip = "";
    if (o.clip) {
      const id = this.nouvelId();
      const forme = o.clip === "circle"
        ? `<circle cx="${nombre(x + w / 2)}" cy="${nombre(y + h / 2)}" r="${nombre(Math.min(w, h) / 2)}"/>`
        : `<rect x="${nombre(x)}" y="${nombre(y)}" width="${nombre(w)}" height="${nombre(h)}" rx="${nombre(o.radius || 0)}"/>`;
      this.defs.push(`<clipPath id="${id}">${forme}</clipPath>`);
      clip = ` clip-path="url(#${id})"`;
    }
    const ratio = o.fit === "contain" ? "xMidYMid meet" : "xMidYMid slice";
    const op = o.opacity != null && o.opacity < 1 ? ` opacity="${o.opacity}"` : "";
    this.corps.push(`<image x="${nombre(x)}" y="${nombre(y)}" width="${nombre(w)}" height="${nombre(h)}" preserveAspectRatio="${ratio}"${clip}${op} href="data:${type};base64,${buf.toString("base64")}"/>`);
    return true;
  }

  qr(texte, x, y, taille, o = {}) {
    const { n, data } = matriceQr(texte);
    const m = taille / n;
    let d = "";
    for (let r = 0; r < n; r += 1) {
      for (let c = 0; c < n; c += 1) {
        if (data[r * n + c]) d += `M${nombre(x + c * m)} ${nombre(y + r * m)}h${nombre(m + 0.02)}v${nombre(m + 0.02)}h${nombre(-(m + 0.02))}z`;
      }
    }
    this.corps.push(`<path d="${d}" fill="${o.color || "#000"}"/>`);
  }

  pivoter(angle, cx, cy, dessin) {
    this.corps.push(`<g transform="rotate(${angle} ${nombre(cx)} ${nombre(cy)})">`);
    dessin();
    this.corps.push("</g>");
  }

  rendre() {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${nombre(this.w)} ${nombre(this.h)}" width="${nombre(this.w)}" height="${nombre(this.h)}"><defs>${this.defs.join("")}</defs>${this.corps.join("")}</svg>`;
  }
}

/* ------------------------------ Sortie PDF ------------------------------ */
class ToilePdf {
  /** Dessine dans `doc` (pdfkit), décalé de (ox, oy). */
  constructor(doc, ox = 0, oy = 0) {
    this.doc = doc;
    this.ox = ox;
    this.oy = oy;
  }

  peindre(o, forme) {
    const d = this.doc;
    d.save();
    if (o.opacity != null && o.opacity < 1) { d.fillOpacity(o.opacity); d.strokeOpacity(o.opacity); }
    if (o.dash) d.dash(o.dash[0], { space: o.dash[1] ?? o.dash[0] });
    forme();
    let fond = o.fill && o.fill !== "none" ? o.fill : null;
    if (o.degrade) {
      const [x1, y1, x2, y2] = o.degrade.sens || [0, 0, 1, 1];
      const b = o.boite;
      const g = d.linearGradient(b.x + x1 * b.w, b.y + y1 * b.h, b.x + x2 * b.w, b.y + y2 * b.h);
      g.stop(0, o.degrade.de).stop(1, o.degrade.a);
      fond = g;
    }
    if (fond && o.stroke) d.lineWidth(o.lineWidth ?? 1).fillAndStroke(fond, o.stroke);
    else if (fond) d.fill(fond);
    else if (o.stroke) d.lineWidth(o.lineWidth ?? 1).stroke(o.stroke);
    d.restore();
  }

  rect(x, y, w, h, o = {}) {
    const X = this.ox + x;
    const Y = this.oy + y;
    this.peindre({ ...o, boite: { x: X, y: Y, w, h } }, () => {
      if (o.radius) this.doc.roundedRect(X, Y, w, h, o.radius);
      else this.doc.rect(X, Y, w, h);
    });
  }

  circle(cx, cy, r, o = {}) {
    const X = this.ox + cx;
    const Y = this.oy + cy;
    this.peindre({ ...o, boite: { x: X - r, y: Y - r, w: 2 * r, h: 2 * r } }, () => this.doc.circle(X, Y, r));
  }

  ellipse(cx, cy, rx, ry, o = {}) {
    const X = this.ox + cx;
    const Y = this.oy + cy;
    this.peindre({ ...o, boite: { x: X - rx, y: Y - ry, w: 2 * rx, h: 2 * ry } }, () => this.doc.ellipse(X, Y, rx, ry));
  }

  polygon(points, o = {}) {
    const pts = points.map(([x, y]) => [this.ox + x, this.oy + y]);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const boite = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    this.peindre({ ...o, boite }, () => this.doc.polygon(...pts));
  }

  line(x1, y1, x2, y2, o = {}) {
    this.peindre({ ...o, stroke: o.stroke || "#000", fill: null }, () => {
      this.doc.moveTo(this.ox + x1, this.oy + y1).lineTo(this.ox + x2, this.oy + y2);
    });
  }

  text(texte, x, y, o = {}) {
    const police = o.font || "sans";
    let t = nettoyer(texte);
    let taille = o.size || 10;
    if (o.maxWidth) ({ texte: t, taille } = ajuster(t, police, taille, o.maxWidth, o.spacing || 0));
    const l = largeur(t, police, taille, o.spacing || 0);
    const x0 = o.align === "center" ? x - l / 2 : o.align === "right" ? x - l : x;
    const d = this.doc;
    d.save();
    if (o.opacity != null && o.opacity < 1) d.fillOpacity(o.opacity);
    d.font(POLICES[police].pdf).fontSize(taille).fillColor(o.color || "#111827")
      .text(t, this.ox + x0, this.oy + y, { lineBreak: false, baseline: "alphabetic", characterSpacing: o.spacing || 0 });
    d.restore();
    return l;
  }

  image(buf, x, y, w, h, o = {}) {
    if (!typeImage(buf)) return false;
    const d = this.doc;
    let img;
    try { img = d.openImage(buf); } catch { return false; }
    const X = this.ox + x;
    const Y = this.oy + y;
    d.save();
    if (o.opacity != null && o.opacity < 1) d.fillOpacity(o.opacity);
    if (o.clip === "circle") d.circle(X + w / 2, Y + h / 2, Math.min(w, h) / 2).clip();
    else if (o.clip) d.roundedRect(X, Y, w, h, o.radius || 0).clip();
    if (o.fit === "contain") {
      d.image(img, X, Y, { fit: [w, h], align: "center", valign: "center" });
    } else {
      const s = Math.max(w / img.width, h / img.height);
      d.image(img, X - (img.width * s - w) / 2, Y - (img.height * s - h) / 2, { width: img.width * s, height: img.height * s });
    }
    d.restore();
    return true;
  }

  qr(texte, x, y, taille, o = {}) {
    const { n, data } = matriceQr(texte);
    const m = taille / n;
    const d = this.doc;
    d.save();
    for (let r = 0; r < n; r += 1) {
      for (let c = 0; c < n; c += 1) {
        if (data[r * n + c]) d.rect(this.ox + x + c * m, this.oy + y + r * m, m + 0.02, m + 0.02);
      }
    }
    d.fill(o.color || "#000");
    d.restore();
  }

  pivoter(angle, cx, cy, dessin) {
    this.doc.save();
    this.doc.rotate(angle, { origin: [this.ox + cx, this.oy + cy] });
    dessin();
    this.doc.restore();
  }
}

/* Paragraphe (lignes coupées), commun aux deux sorties. */
function paragraphe(toile, texte, x, y, o = {}) {
  const lignes = couper(texte, o.font || "sans", o.size || 8, o.width || 100, o.maxLines || 3);
  const pas = o.lineHeight || (o.size || 8) * 1.25;
  lignes.forEach((l, i) => toile.text(l, x, y + i * pas, { ...o, maxWidth: undefined }));
  return lignes.length * pas;
}

module.exports = {
  ToileSvg, ToilePdf, paragraphe, couper, ajuster, largeur, nettoyer,
  melange, eclaircir, assombrir, surFond, luminance, typeImage,
};
