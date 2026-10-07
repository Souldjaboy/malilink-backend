"use strict";

/**
 * Cartes scolaires MaliLink Éducation — six modèles réellement différents
 * (mise en page, typographie, formes), recto et verso, paysage et portrait.
 * Format carte bancaire (CR80 : 85,6 × 54 mm). Chaque modèle est dessiné
 * une fois et rendu en PDF (impression) ou en SVG (aperçu).
 *
 * Le QR ne porte qu'une URL de vérification avec un jeton aléatoire.
 */

const PDFDocument = require("pdfkit");
const {
  ToileSvg, ToilePdf, paragraphe, nettoyer, largeur, eclaircir, assombrir, surFond, typeImage,
} = require("./dessin");

const CARTE_L = 242.65; // 85,6 mm
const CARTE_H = 153.07; // 54 mm
const MODELES = {
  academique: "Académique classique",
  moderne: "Moderne",
  premium: "Premium",
  minimaliste: "Minimaliste",
  institutionnel: "Institutionnel",
  creatif: "Créatif",
};

const GRIS = "#6b7280";
const ENCRE = "#111827";
const MENTION_PERTE = "Carte strictement personnelle. En cas de perte, merci de la rapporter à l'établissement.";

/* ---------------------------- Éléments communs ---------------------------- */
const majuscules = (t) => nettoyer(t).toLocaleUpperCase("fr-FR");
function initiales(nom) {
  return nettoyer(nom).split(/\s+/).filter((m) => m.length > 2 || /^[A-Z]/.test(m)).slice(0, 3).map((m) => m[0]).join("").toUpperCase() || "E";
}

function logo(c, d, x, y, taille, o = {}) {
  if (o.pastille) c.circle(x + taille / 2, y + taille / 2, taille / 2 + (o.marge ?? 2), { fill: o.pastille });
  if (d.options.logo !== false && typeImage(d.ecole.logo)) {
    c.image(d.ecole.logo, x, y, taille, taille, { fit: "contain" });
    return;
  }
  // Pas de logo : monogramme aux couleurs de l'école.
  c.circle(x + taille / 2, y + taille / 2, taille / 2, { fill: o.fondMonogramme || d.p });
  c.text(initiales(d.ecole.nomCourt || d.ecole.nom), x + taille / 2, y + taille / 2 + taille * 0.14,
    { font: "sans-bold", size: taille * 0.36, color: surFond(o.fondMonogramme || d.p), align: "center", maxWidth: taille * 0.85 });
}

function photo(c, d, x, y, w, h, o = {}) {
  if (d.options.photo !== false && typeImage(d.eleve.photo)) {
    c.image(d.eleve.photo, x, y, w, h, { clip: o.cercle ? "circle" : "rect", radius: o.radius || 0 });
    return;
  }
  // Silhouette neutre si pas de photo.
  const fond = o.fond || "#e5e7eb";
  if (o.cercle) c.circle(x + w / 2, y + h / 2, Math.min(w, h) / 2, { fill: fond });
  else c.rect(x, y, w, h, { fill: fond, radius: o.radius || 0 });
  const r = Math.min(w, h);
  c.circle(x + w / 2, y + h * 0.4, r * 0.17, { fill: "#9ca3af" });
  c.ellipse(x + w / 2, y + h * 0.78, r * 0.3, r * 0.18, { fill: "#9ca3af" });
}

function champs(d) {
  const l = [["Matricule", d.eleve.matricule], ["Classe", d.eleve.classe || "—"]];
  if (d.options.niveau !== false && d.eleve.niveau) l.push(["Niveau", d.eleve.niveau]);
  if (d.options.naissance === true && d.eleve.naissance) l.push(["Né(e) le", d.eleve.naissance]);
  return l;
}

function coordonnees(d) {
  const e = d.ecole;
  const l = [];
  if (e.adresse || e.ville) l.push([e.adresse, e.ville].filter(Boolean).join(", "));
  const tel = [e.telephone && `Tél. ${e.telephone}`, e.whatsapp && e.whatsapp !== e.telephone && `WhatsApp ${e.whatsapp}`].filter(Boolean).join(" · ");
  if (tel) l.push(tel);
  if (e.email) l.push(e.email);
  if (e.site) l.push(e.site.replace(/^https?:\/\//, ""));
  return l;
}

function signatureCachet(c, d, x, y, w, h, o = {}) {
  if (d.options.signature === false) return;
  const aCachet = typeImage(d.ecole.cachet);
  const aSignature = typeImage(d.ecole.signature);
  if (aCachet) c.image(d.ecole.cachet, x + w - h, y, h, h, { fit: "contain", opacity: 0.85 });
  if (aSignature) c.image(d.ecole.signature, x, y + h * 0.15, w * 0.62, h * 0.7, { fit: "contain" });
  if (o.libelle !== false) {
    c.text(o.libelle || (d.ecole.directeur ? `Le Directeur · ${d.ecole.directeur}` : "Le Directeur"), x + w / 2, y + h + 6,
      { font: o.police || "sans", size: 4.8, color: o.couleur || GRIS, align: "center", maxWidth: w + 10 });
  }
}

function qrSurBlanc(c, d, x, y, taille, o = {}) {
  const marge = o.marge ?? taille * 0.08;
  c.rect(x - marge, y - marge, taille + 2 * marge, taille + 2 * marge, { fill: "#ffffff", radius: o.radius ?? 3, stroke: o.bord, lineWidth: 0.6 });
  c.qr(d.carte.url, x, y, taille, { color: o.couleur || ENCRE });
}

/* ------------------------------ 1. Académique ------------------------------ */
const academique = {
  recto(c, d, W, H, portrait) {
    const { p, s } = d;
    c.rect(0, 0, W, H, { fill: "#ffffff" });
    if (!portrait) {
      c.rect(0, 0, W, 34, { fill: p });
      c.rect(0, 34, W, 2, { fill: s });
      logo(c, d, 9, 6, 22, { pastille: "#ffffff", marge: 2 });
      c.text(d.ecole.nom, 40, 16, { font: "serif-bold", size: 10, color: surFond(p), maxWidth: W - 48 });
      c.text(`CARTE SCOLAIRE  ·  ${d.carte.annee}`, 40, 27, { size: 5.8, spacing: 1.1, color: surFond(p), opacity: 0.85, maxWidth: W - 48 });
      c.rect(11, 45, 56, 70, { stroke: s, lineWidth: 1.2, fill: "#ffffff" });
      photo(c, d, 13, 47, 52, 66);
      c.text(majuscules(d.eleve.nom), 78, 56, { font: "serif-bold", size: 12, color: p, maxWidth: W - 90 });
      c.text(d.eleve.prenom, 78, 68, { font: "serif", size: 10, color: "#374151", maxWidth: W - 90 });
      champs(d).slice(0, 4).forEach(([l, v], i) => {
        const x = 78 + (i % 2) * 58;
        const y = 84 + Math.floor(i / 2) * 22;
        c.text(l.toUpperCase(), x, y, { size: 5, spacing: 0.6, color: GRIS });
        c.text(v, x, y + 9, { font: "sans-bold", size: 7.5, color: ENCRE, maxWidth: 54 });
      });
      qrSurBlanc(c, d, W - 50, H - 54, 40, { bord: eclaircir(p, 0.75) });
      c.line(11, H - 10, W - 62, H - 10, { stroke: eclaircir(s, 0.4), lineWidth: 0.5 });
      c.text(`N° ${d.carte.numero}`, 11, H - 3.5, { size: 5, color: GRIS });
      return;
    }
    c.rect(0, 0, W, 54, { fill: p });
    c.rect(0, 54, W, 11, { fill: s });
    logo(c, d, W / 2 - 11, 7, 22, { pastille: "#ffffff", marge: 2 });
    c.text(d.ecole.nom, W / 2, 46, { font: "serif-bold", size: 8.5, color: surFond(p), align: "center", maxWidth: W - 14 });
    c.text(`CARTE SCOLAIRE  ·  ${d.carte.annee}`, W / 2, 62, { size: 5.3, spacing: 0.9, color: surFond(s), align: "center", maxWidth: W - 12 });
    c.rect(W / 2 - 31, 72, 62, 76, { stroke: s, lineWidth: 1.2, fill: "#fff" });
    photo(c, d, W / 2 - 29, 74, 58, 72);
    c.text(majuscules(d.eleve.nom), W / 2, 162, { font: "serif-bold", size: 11, color: p, align: "center", maxWidth: W - 16 });
    c.text(d.eleve.prenom, W / 2, 173, { font: "serif", size: 9, color: "#374151", align: "center", maxWidth: W - 16 });
    champs(d).slice(0, 4).forEach(([l, v], i) => {
      const y = 188 + i * 11;
      c.text(`${l} :`, 12, y, { size: 5.5, color: GRIS });
      c.text(v, 50, y, { font: "sans-bold", size: 7, color: ENCRE, maxWidth: 56 });
    });
    qrSurBlanc(c, d, W - 42, H - 48, 32, { bord: eclaircir(p, 0.75) });
    c.text(`N° ${d.carte.numero}`, 12, H - 6, { size: 5, color: GRIS });
  },
  verso(c, d, W, H, portrait) {
    const { p, s } = d;
    c.rect(0, 0, W, H, { fill: "#ffffff" });
    c.rect(0, 0, W, 20, { fill: p });
    c.rect(0, 20, W, 1.5, { fill: s });
    c.text(d.ecole.nom, portrait ? W / 2 : 10, 13.5, { font: "serif-bold", size: 8, color: surFond(p), align: portrait ? "center" : "left", maxWidth: W - 20 });
    const qrT = portrait ? 66 : 62;
    const qx = portrait ? W / 2 - qrT / 2 : W - qrT - 14;
    const qy = portrait ? 32 : 30;
    qrSurBlanc(c, d, qx, qy, qrT, { bord: eclaircir(p, 0.7) });
    c.text("Vérifier l'authenticité", qx + qrT / 2, qy + qrT + 10, { size: 5, color: GRIS, align: "center" });
    let x = 12;
    let y = portrait ? 124 : 36;
    const larg = portrait ? W - 24 : W - qrT - 40;
    c.text("COORDONNÉES", x, y, { font: "sans-bold", size: 5.8, spacing: 1, color: p });
    y += 10;
    for (const l of coordonnees(d)) y += paragraphe(c, l, x, y, { size: 6.3, color: "#374151", width: larg, maxLines: 2, lineHeight: 8 });
    if (d.options.slogan !== false && d.ecole.slogan) {
      y += 3;
      c.text(`« ${d.ecole.slogan} »`, x, y, { font: "serif-italic", size: 7, color: assombrir(s, 0.15), maxWidth: larg });
      y += 9;
    }
    c.text(`Valable jusqu'au ${d.carte.validite}`, x, y + 3, { font: "sans-bold", size: 6.3, color: ENCRE });
    if (portrait) {
      signatureCachet(c, d, W / 2 - 38, H - 50, 76, 26);
      paragraphe(c, MENTION_PERTE, 12, H - 8.5, { font: "serif-italic", size: 4.6, color: GRIS, width: W - 24, maxLines: 1 });
    } else {
      signatureCachet(c, d, W - 104, H - 44, 76, 26);
      paragraphe(c, MENTION_PERTE, 12, H - 15, { font: "serif-italic", size: 5, color: GRIS, width: 118, maxLines: 2, lineHeight: 6 });
    }
  },
};

/* ------------------------------- 2. Moderne ------------------------------- */
const moderne = {
  recto(c, d, W, H, portrait) {
    const { p, s } = d;
    const degrade = { de: p, a: assombrir(p, 0.38), sens: [0, 0, 0, 1] };
    c.rect(0, 0, W, H, { fill: "#ffffff" });
    if (!portrait) {
      const L = W * 0.38;
      c.rect(0, 0, L, H, { degrade });
      c.polygon([[W - 64, 0], [W, 0], [W, 42]], { fill: s, opacity: 0.95 });
      logo(c, d, 8, 7, 16, { pastille: "#ffffff", marge: 1.5 });
      c.text(d.ecole.nomCourt || d.ecole.nom, 29, 17.5, { font: "sans-bold", size: 6.5, color: "#ffffff", maxWidth: L - 34 });
      c.circle(L / 2, 68, 33, { fill: "#ffffff" });
      photo(c, d, L / 2 - 30.5, 37.5, 61, 61, { cercle: true, fond: eclaircir(p, 0.8) });
      c.text("MATRICULE", L / 2, 113, { size: 4.8, spacing: 1, color: "#ffffff", opacity: 0.75, align: "center" });
      c.text(d.eleve.matricule, L / 2, 122, { font: "sans-bold", size: 7, color: "#ffffff", align: "center", maxWidth: L - 10 });
      c.text(d.carte.annee, L / 2, H - 9, { font: "sans-bold", size: 6, color: s, align: "center" });
      const x = L + 12;
      c.text("CARTE D'ÉLÈVE", x, 26, { font: "sans-bold", size: 6, spacing: 1.6, color: assombrir(s, 0.1) });
      c.text(d.eleve.prenom, x, 45, { size: 9, color: GRIS, maxWidth: W - x - 10 });
      c.text(majuscules(d.eleve.nom), x, 61, { font: "sans-bold", size: 15, color: p, maxWidth: W - x - 10 });
      let cx = x;
      for (const t of [d.eleve.classe, d.options.niveau !== false ? d.eleve.niveau : null].filter(Boolean)) {
        const l = Math.min(largeur(t, "sans-bold", 7) + 12, W - cx - 12);
        c.rect(cx, 70, l, 13, { fill: eclaircir(p, 0.87), radius: 6.5 });
        c.text(t, cx + 6, 79, { font: "sans-bold", size: 7, color: p, maxWidth: l - 10 });
        cx += l + 5;
      }
      if (d.options.naissance === true && d.eleve.naissance) c.text(`Né(e) le ${d.eleve.naissance}`, x, 98, { size: 6.5, color: GRIS });
      c.text(d.ecole.nom, x, H - 24, { size: 5.5, color: GRIS, maxWidth: W - x - 56 });
      c.text(`N° ${d.carte.numero}`, x, H - 12, { font: "sans-bold", size: 5.5, color: ENCRE });
      qrSurBlanc(c, d, W - 46, H - 46, 36, { bord: eclaircir(p, 0.8), radius: 4 });
      return;
    }
    c.rect(0, 0, W, 100, { degrade });
    c.circle(W, 0, 44, { fill: s, opacity: 0.95 });
    logo(c, d, 8, 8, 16, { pastille: "#ffffff", marge: 1.5 });
    c.text(d.ecole.nomCourt || d.ecole.nom, 29, 18.5, { font: "sans-bold", size: 6.5, color: "#ffffff", maxWidth: W - 70 });
    c.circle(W / 2, 100, 35, { fill: "#ffffff" });
    photo(c, d, W / 2 - 32, 68, 64, 64, { cercle: true, fond: eclaircir(p, 0.8) });
    c.text("CARTE D'ÉLÈVE", W / 2, 148, { font: "sans-bold", size: 5.6, spacing: 1.5, color: assombrir(s, 0.1), align: "center" });
    c.text(d.eleve.prenom, W / 2, 161, { size: 8.5, color: GRIS, align: "center", maxWidth: W - 14 });
    c.text(majuscules(d.eleve.nom), W / 2, 176, { font: "sans-bold", size: 13, color: p, align: "center", maxWidth: W - 14 });
    const puces = [d.eleve.classe, d.options.niveau !== false ? d.eleve.niveau : null].filter(Boolean);
    const larg = puces.map((t) => Math.min(largeur(t, "sans-bold", 6.5) + 12, 66));
    let cx = W / 2 - (larg.reduce((a, b) => a + b, 0) + (puces.length - 1) * 4) / 2;
    puces.forEach((t, i) => {
      c.rect(cx, 184, larg[i], 12, { fill: eclaircir(p, 0.87), radius: 6 });
      c.text(t, cx + 6, 192.3, { font: "sans-bold", size: 6.5, color: p, maxWidth: larg[i] - 10 });
      cx += larg[i] + 4;
    });
    c.text("MATRICULE", 12, H - 30, { size: 4.6, spacing: 0.9, color: GRIS });
    c.text(d.eleve.matricule, 12, H - 21, { font: "sans-bold", size: 7, color: ENCRE, maxWidth: 80 });
    c.text(`${d.carte.annee}  ·  N° ${d.carte.numero}`, 12, H - 9, { size: 5, color: GRIS, maxWidth: 95 });
    qrSurBlanc(c, d, W - 42, H - 42, 32, { bord: eclaircir(p, 0.8), radius: 4 });
  },
  verso(c, d, W, H, portrait) {
    const { p, s } = d;
    c.rect(0, 0, W, H, { fill: "#ffffff" });
    if (portrait) c.rect(0, 0, W, 7, { fill: s });
    else c.rect(0, 0, 7, H, { fill: s });
    const qrT = 66;
    const qx = portrait ? W / 2 - qrT / 2 : 22;
    const qy = portrait ? 22 : 24;
    c.rect(qx - 7, qy - 7, qrT + 14, qrT + 14, { fill: "#ffffff", radius: 9, stroke: eclaircir(p, 0.75), lineWidth: 0.8 });
    c.qr(d.carte.url, qx, qy, qrT, { color: p });
    c.text("Scannez pour vérifier", qx + qrT / 2, qy + qrT + 17, { font: "sans-bold", size: 6, color: p, align: "center" });
    const x = portrait ? 14 : 114;
    let y = portrait ? 130 : 28;
    const larg = W - x - 12;
    c.text(d.ecole.nom, x, y, { font: "sans-bold", size: 8.5, color: p, maxWidth: larg });
    y += 10;
    if (d.options.slogan !== false && d.ecole.slogan) { c.text(d.ecole.slogan, x, y, { font: "sans-italic", size: 6.3, color: assombrir(s, 0.2), maxWidth: larg }); y += 11; }
    for (const l of coordonnees(d).slice(0, 4)) {
      c.circle(x + 1.6, y - 2.1, 1.6, { fill: s });
      c.text(l, x + 7, y, { size: 6.2, color: "#374151", maxWidth: larg - 8 });
      y += 9;
    }
    y += 2;
    const pill = `Valide jusqu'au ${d.carte.validite}`;
    c.rect(x, y, largeur(pill, "sans-bold", 6) + 12, 12, { fill: eclaircir(p, 0.88), radius: 6 });
    c.text(pill, x + 6, y + 8.3, { font: "sans-bold", size: 6, color: p });
    if (portrait) {
      signatureCachet(c, d, W / 2 - 36, H - 40, 72, 24);
    } else {
      signatureCachet(c, d, W - 84, H - 38, 70, 24);
      c.text(MENTION_PERTE, 22, H - 7, { size: 4.6, color: GRIS, maxWidth: W - 120 });
    }
  },
};

/* ------------------------------- 3. Premium ------------------------------- */
const premium = {
  recto(c, d, W, H, portrait) {
    const { p, s } = d;
    const or = s;
    c.rect(0, 0, W, H, { degrade: { de: p, a: assombrir(p, 0.5), sens: [0, 0, 1, 1] } });
    c.rect(6, 6, W - 12, H - 12, { stroke: or, lineWidth: 0.8, radius: 6 });
    for (const [x, y] of [[W / 2, 6], [W / 2, H - 6]]) c.polygon([[x - 4, y], [x, y - 2.5], [x + 4, y], [x, y + 2.5]], { fill: or });
    const blanc = "#ffffff";
    if (!portrait) {
      logo(c, d, 15, 13, 20, { pastille: blanc, marge: 1.5 });
      c.text(majuscules(d.ecole.nom), 42, 22, { font: "serif-bold", size: 8.2, spacing: 0.5, color: or, maxWidth: W - 58 });
      c.text(`CARTE D'ÉLÈVE  ·  ${d.carte.annee}`, 42, 31, { size: 5.3, spacing: 1.5, color: blanc, opacity: 0.8, maxWidth: W - 58 });
      c.rect(15, 42, 54, 68, { fill: or, radius: 4 });
      photo(c, d, 16.5, 43.5, 51, 65, { radius: 3, fond: eclaircir(p, 0.75) });
      c.text(majuscules(d.eleve.nom), 79, 57, { font: "serif-bold", size: 12, color: blanc, maxWidth: W - 146 });
      c.text(d.eleve.prenom, 79, 69, { font: "serif", size: 9.5, color: eclaircir(or, 0.35), maxWidth: W - 146 });
      champs(d).slice(0, 4).forEach(([l, v], i) => {
        const x = 79 + (i % 2) * 58;
        const y = 85 + Math.floor(i / 2) * 20;
        c.text(l.toUpperCase(), x, y, { size: 4.8, spacing: 0.8, color: or });
        c.text(v, x, y + 8.5, { font: "sans-bold", size: 7.2, color: blanc, maxWidth: i % 2 ? W - 66 - x : 54 });
      });
      qrSurBlanc(c, d, W - 58, 46, 40, { radius: 4, couleur: p });
      c.text(`N° ${d.carte.numero}`, W - 38, 102, { size: 5.2, color: or, align: "center", maxWidth: 52 });
      c.rect(6, H - 17, W - 12, 3, { degrade: { de: or, a: eclaircir(or, 0.6), sens: [0, 0, 1, 0] } });
      return;
    }
    logo(c, d, W / 2 - 11, 14, 22, { pastille: blanc, marge: 1.5 });
    c.text(majuscules(d.ecole.nom), W / 2, 50, { font: "serif-bold", size: 7.5, spacing: 0.4, color: or, align: "center", maxWidth: W - 22 });
    c.text(`CARTE D'ÉLÈVE  ·  ${d.carte.annee}`, W / 2, 59, { size: 4.9, spacing: 1.2, color: blanc, opacity: 0.8, align: "center", maxWidth: W - 22 });
    c.rect(W / 2 - 30, 67, 60, 74, { fill: or, radius: 4 });
    photo(c, d, W / 2 - 28.5, 68.5, 57, 71, { radius: 3, fond: eclaircir(p, 0.75) });
    c.text(majuscules(d.eleve.nom), W / 2, 156, { font: "serif-bold", size: 11, color: blanc, align: "center", maxWidth: W - 22 });
    c.text(d.eleve.prenom, W / 2, 167, { font: "serif", size: 8.5, color: eclaircir(or, 0.35), align: "center", maxWidth: W - 22 });
    champs(d).slice(0, 3).forEach(([l, v], i) => {
      const y = 182 + i * 10.5;
      c.text(l.toUpperCase(), 16, y, { size: 4.6, spacing: 0.7, color: or });
      c.text(v, 54, y, { font: "sans-bold", size: 6.8, color: blanc, maxWidth: 50 });
    });
    qrSurBlanc(c, d, W - 44, H - 52, 30, { radius: 3, couleur: p });
    c.text(`N° ${d.carte.numero}`, 16, H - 16, { size: 5, color: or, maxWidth: 80 });
    c.rect(6, H - 11, W - 12, 2.5, { degrade: { de: or, a: eclaircir(or, 0.6), sens: [0, 0, 1, 0] } });
  },
  verso(c, d, W, H, portrait) {
    const { p, s } = d;
    const or = s;
    c.rect(0, 0, W, H, { degrade: { de: assombrir(p, 0.15), a: assombrir(p, 0.5), sens: [1, 0, 0, 1] } });
    c.rect(6, 6, W - 12, H - 12, { stroke: or, lineWidth: 0.8, radius: 6 });
    if (typeImage(d.ecole.logo) && d.options.logo !== false) {
      const t = Math.min(W, H) * 0.7;
      c.image(d.ecole.logo, W / 2 - t / 2, H / 2 - t / 2, t, t, { fit: "contain", opacity: 0.07 });
    }
    c.text(majuscules(d.ecole.nom), W / 2, 22, { font: "serif-bold", size: 7.6, spacing: 0.4, color: or, align: "center", maxWidth: W - 26 });
    if (d.options.slogan !== false && d.ecole.slogan) c.text(d.ecole.slogan, W / 2, 32, { font: "serif-italic", size: 6.8, color: "#ffffff", opacity: 0.85, align: "center", maxWidth: W - 26 });
    const qrT = portrait ? 56 : 52;
    const qx = portrait ? W / 2 - qrT / 2 : W - qrT - 20;
    const qy = portrait ? 44 : 42;
    qrSurBlanc(c, d, qx, qy, qrT, { radius: 4, couleur: p });
    c.text("Authenticité vérifiable", qx + qrT / 2, qy + qrT + 11, { size: 5, color: or, align: "center" });
    const x = portrait ? 16 : 18;
    let y = portrait ? 128 : 50;
    const larg = portrait ? W - 32 : W - qrT - 52;
    for (const l of coordonnees(d)) y += paragraphe(c, l, x, y, { size: 6.2, color: "#ffffff", width: larg, maxLines: 2, lineHeight: 8 });
    c.text(`Valable jusqu'au ${d.carte.validite}`, x, y + 4, { font: "sans-bold", size: 6, color: or });
    if (d.options.signature !== false && (typeImage(d.ecole.signature) || typeImage(d.ecole.cachet))) {
      const bx = portrait ? W / 2 - 42 : 18;
      const by = H - 44;
      c.rect(bx, by, 84, 30, { fill: "#ffffff", radius: 4, opacity: 0.95 });
      signatureCachet(c, d, bx + 4, by + 3, 76, 24, { libelle: false });
      c.text("La Direction", bx + 84 + 5, by + 27, { size: 4.8, color: or });
    }
  },
};

/* ----------------------------- 4. Minimaliste ----------------------------- */
const minimaliste = {
  recto(c, d, W, H, portrait) {
    const { p, s } = d;
    c.rect(0, 0, W, H, { fill: "#ffffff" });
    logo(c, d, 14, 11, 14);
    c.text(d.ecole.nomCourt || d.ecole.nom, 32, 20.5, { font: "sans-bold", size: 6.5, color: ENCRE, maxWidth: portrait ? W - 50 : W - 110 });
    if (!portrait) {
      c.circle(W - 62, 17.5, 2.6, { fill: s });
      c.text(d.carte.annee, W - 56, 19.8, { size: 6, color: GRIS });
      photo(c, d, W - 64, 34, 50, 62, { radius: 4, fond: "#f3f4f6" });
      c.text(d.eleve.prenom, 14, 56, { size: 11, color: "#374151", maxWidth: W - 92 });
      c.text(majuscules(d.eleve.nom), 14, 75, { font: "sans-bold", size: 17, color: ENCRE, maxWidth: W - 92 });
      c.line(14, 85, W - 78, 85, { stroke: p, lineWidth: 0.6 });
      champs(d).slice(0, 3).forEach(([l, v], i) => {
        const x = 14 + i * 52;
        c.text(l.toUpperCase(), x, 99, { size: 4.8, spacing: 1, color: "#9ca3af" });
        c.text(v, x, 109, { font: "sans-bold", size: 7.3, color: ENCRE, maxWidth: 48 });
      });
      c.rect(14, H - 20, 18, 2, { fill: s });
      c.text(`N° ${d.carte.numero}`, 14, H - 9, { size: 5, color: "#9ca3af" });
      c.qr(d.carte.url, W - 44, H - 44, 30, { color: ENCRE });
      return;
    }
    c.circle(W - 22, 17.5, 2.6, { fill: s });
    photo(c, d, 14, 34, 62, 76, { radius: 4, fond: "#f3f4f6" });
    c.qr(d.carte.url, W - 50, 36, 36, { color: ENCRE });
    c.text(d.carte.annee, W - 14, 108, { size: 6, color: GRIS, align: "right" });
    c.text(d.eleve.prenom, 14, 132, { size: 10, color: "#374151", maxWidth: W - 28 });
    c.text(majuscules(d.eleve.nom), 14, 149, { font: "sans-bold", size: 15, color: ENCRE, maxWidth: W - 28 });
    c.line(14, 158, W - 14, 158, { stroke: p, lineWidth: 0.6 });
    champs(d).slice(0, 4).forEach(([l, v], i) => {
      const x = 14 + (i % 2) * 64;
      const y = 172 + Math.floor(i / 2) * 22;
      c.text(l.toUpperCase(), x, y, { size: 4.6, spacing: 0.9, color: "#9ca3af" });
      c.text(v, x, y + 9, { font: "sans-bold", size: 7, color: ENCRE, maxWidth: 60 });
    });
    c.rect(14, H - 17, 18, 2, { fill: s });
    c.text(`N° ${d.carte.numero}`, 14, H - 7, { size: 4.8, color: "#9ca3af" });
  },
  verso(c, d, W, H, portrait) {
    const { p, s } = d;
    c.rect(0, 0, W, H, { fill: "#ffffff" });
    const qrT = 58;
    const qx = portrait ? W / 2 - qrT / 2 : 14;
    const qy = portrait ? 16 : 16;
    c.qr(d.carte.url, qx, qy, qrT, { color: ENCRE });
    c.text("VÉRIFICATION", qx + qrT / 2, qy + qrT + 9, { size: 4.8, spacing: 1.2, color: "#9ca3af", align: "center" });
    const x = portrait ? 14 : 86;
    let y = portrait ? 106 : 24;
    const larg = W - x - 14;
    y += paragraphe(c, d.ecole.nom, x, y, { font: "sans-bold", size: 7.8, color: ENCRE, width: larg, maxLines: 2, lineHeight: 9.5 }) + 4;
    for (const l of coordonnees(d)) y += paragraphe(c, l, x, y, { size: 6.2, color: "#4b5563", width: larg, maxLines: 2, lineHeight: 8 });
    if (d.options.slogan !== false && d.ecole.slogan) c.text(d.ecole.slogan, x, y + 4, { font: "sans-italic", size: 6, color: "#9ca3af", maxWidth: larg });
    if (!portrait) paragraphe(c, MENTION_PERTE, 14, 100, { size: 4.6, color: "#9ca3af", width: 62, maxLines: 4, lineHeight: 5.6 });
    c.line(14, H - 26, W - 14, H - 26, { stroke: p, lineWidth: 0.5 });
    c.text(`VALIDE JUSQU'AU ${d.carte.validite}`, 14, H - 14, { size: 5.3, spacing: 0.8, color: GRIS });
    if (d.options.signature !== false) {
      if (typeImage(d.ecole.signature)) c.image(d.ecole.signature, W - 74, H - 52, 60, 22, { fit: "contain" });
      c.text("Direction", W - 14, H - 14, { size: 5, color: "#9ca3af", align: "right" });
    }
    c.rect(W - 14 - 18, H - 7, 18, 1.6, { fill: s });
  },
};

/* --------------------------- 5. Institutionnel --------------------------- */
function guilloche(c, d, cx, cy, rMax) {
  if (typeImage(d.ecole.sceau)) {
    c.image(d.ecole.sceau, cx - rMax * 0.75, cy - rMax * 0.75, rMax * 1.5, rMax * 1.5, { fit: "contain", opacity: 0.09 });
  }
  for (let r = 8; r <= rMax; r += 5.5) c.circle(cx, cy, r, { stroke: eclaircir(d.p, 0.82), lineWidth: 0.3 });
}
const institutionnel = {
  recto(c, d, W, H, portrait) {
    const { p, s } = d;
    c.rect(0, 0, W, H, { fill: eclaircir(p, 0.965) });
    guilloche(c, d, W / 2, H * 0.58, Math.min(W, H) * 0.42);
    c.rect(3, 3, W - 6, H - 6, { stroke: p, lineWidth: 1.2 });
    c.rect(6, 6, W - 12, H - 12, { stroke: s, lineWidth: 0.5 });
    const lignes = [["Nom", majuscules(d.eleve.nom)], ["Prénom(s)", d.eleve.prenom], ["Matricule", d.eleve.matricule], ["Classe", d.eleve.classe || "—"]];
    if (d.options.niveau !== false && d.eleve.niveau) lignes.push(["Niveau", d.eleve.niveau]);
    if (d.options.naissance === true && d.eleve.naissance) lignes.push(["Né(e) le", d.eleve.naissance]);
    if (!portrait) {
      logo(c, d, 12, 11, 22);
      c.text(majuscules(d.ecole.nom), W / 2 + 8, 19, { font: "sans-bold", size: 7.3, color: p, align: "center", maxWidth: W - 90 });
      c.text("CARTE D'IDENTITÉ SCOLAIRE", W / 2 + 8, 30, { font: "serif-bold", size: 8.5, color: assombrir(s, 0.25), align: "center" });
      c.text(`Année scolaire ${d.carte.annee}`, W / 2 + 8, 38.5, { size: 5.8, color: "#374151", align: "center" });
      c.line(40, 43, W - 22, 43, { stroke: p, lineWidth: 0.4 });
      c.rect(W - 66, 49, 52, 64, { stroke: p, lineWidth: 0.8, fill: "#ffffff" });
      photo(c, d, W - 65, 50, 50, 62);
      lignes.slice(0, 6).forEach(([l, v], i) => {
        const y = 56 + i * 10.6;
        const ll = c.text(`${l} :`, 12, y, { font: "serif", size: 6.6, color: ENCRE });
        const lv = c.text(v, 12 + ll + 4, y - 0.6, { font: "sans-bold", size: 7, color: p, maxWidth: W - 92 - ll });
        if (12 + ll + lv + 8 < W - 74) c.line(12 + ll + lv + 7, y + 0.5, W - 74, y + 0.5, { stroke: "#9ca3af", lineWidth: 0.4, dash: [0.6, 1.2] });
      });
      c.qr(d.carte.url, 12, H - 34, 24, { color: ENCRE });
      c.text(`N° ${d.carte.numero}`, 41, H - 13, { font: "sans-bold", size: 5.3, color: p });
      signatureCachet(c, d, W - 112, H - 37, 90, 24, { libelle: "Le Chef d'établissement", police: "serif-italic", couleur: ENCRE });
      return;
    }
    logo(c, d, W / 2 - 12, 11, 24);
    c.text(majuscules(d.ecole.nom), W / 2, 46, { font: "sans-bold", size: 6.5, color: p, align: "center", maxWidth: W - 20 });
    c.text("CARTE D'IDENTITÉ SCOLAIRE", W / 2, 56, { font: "serif-bold", size: 7.6, color: assombrir(s, 0.25), align: "center", maxWidth: W - 18 });
    c.text(`Année scolaire ${d.carte.annee}`, W / 2, 64, { size: 5.4, color: "#374151", align: "center" });
    c.line(14, 68, W - 14, 68, { stroke: p, lineWidth: 0.4 });
    c.rect(W / 2 - 27, 73, 54, 66, { stroke: p, lineWidth: 0.8, fill: "#ffffff" });
    photo(c, d, W / 2 - 26, 74, 52, 64);
    lignes.slice(0, 6).forEach(([l, v], i) => {
      const y = 152 + i * 10;
      const ll = c.text(`${l} :`, 12, y, { font: "serif", size: 6.2, color: ENCRE });
      const lv = c.text(v, 12 + ll + 4, y - 0.6, { font: "sans-bold", size: 6.6, color: p, maxWidth: W - 30 - ll });
      if (12 + ll + lv + 8 < W - 12) c.line(12 + ll + lv + 7, y + 0.5, W - 12, y + 0.5, { stroke: "#9ca3af", lineWidth: 0.4, dash: [0.6, 1.2] });
    });
    c.qr(d.carte.url, 12, H - 30, 21, { color: ENCRE });
    c.text(`N° ${d.carte.numero}`, 12, H - 4.5 - 0, { font: "sans-bold", size: 4.6, color: p });
    signatureCachet(c, d, W - 78, H - 32, 64, 20, { libelle: "Le Chef d'établissement", police: "serif-italic", couleur: ENCRE });
  },
  verso(c, d, W, H, portrait) {
    const { p, s } = d;
    c.rect(0, 0, W, H, { fill: eclaircir(p, 0.965) });
    guilloche(c, d, W / 2, H / 2, Math.min(W, H) * 0.45);
    c.rect(3, 3, W - 6, H - 6, { stroke: p, lineWidth: 1.2 });
    c.rect(6, 6, W - 12, H - 12, { stroke: s, lineWidth: 0.5 });
    c.text(majuscules(d.ecole.nom), W / 2, 19, { font: "serif-bold", size: 7.2, color: p, align: "center", maxWidth: W - 24 });
    c.line(W / 2 - 30, 23, W / 2 + 30, 23, { stroke: s, lineWidth: 0.6 });
    const qrT = portrait ? 52 : 58;
    const qx = portrait ? W / 2 - qrT / 2 : W - qrT - 14;
    const qy = portrait ? H - qrT - 46 : 32;
    c.rect(qx - 3, qy - 3, qrT + 6, qrT + 6, { fill: "#ffffff", stroke: p, lineWidth: 0.5 });
    c.qr(d.carte.url, qx, qy, qrT, { color: ENCRE });
    c.text("Vérification d'authenticité", qx + qrT / 2, qy + qrT + 9, { font: "serif-italic", size: 5.4, color: ENCRE, align: "center" });
    const larg = portrait ? W - 24 : W - qrT - 36;
    let y = 33;
    y += paragraphe(c, `Le titulaire de la présente carte est élève régulièrement inscrit(e) dans l'établissement pour l'année scolaire ${d.carte.annee}. Les membres du personnel sont priés de lui prêter assistance en cas de besoin.`,
      12, y, { font: "serif", size: 6.3, color: ENCRE, width: larg, maxLines: 5, lineHeight: 7.8 }) + 3;
    for (const l of coordonnees(d).slice(0, portrait ? 3 : 4)) y += paragraphe(c, l, 12, y, { size: 5.8, color: "#374151", width: larg, maxLines: 1, lineHeight: 7.3 });
    c.text(`Valable jusqu'au ${d.carte.validite}`, 12, portrait ? y + 6 : H - 13, { font: "sans-bold", size: 6, color: p });
    if (!portrait) signatureCachet(c, d, qx - 4, H - 40, qrT + 8, 22, { libelle: false });
    else c.text(MENTION_PERTE, W / 2, H - 10, { size: 3.9, color: GRIS, align: "center", maxWidth: W - 20 });
  },
};

/* -------------------------------- 6. Créatif ------------------------------- */
const creatif = {
  recto(c, d, W, H, portrait) {
    const { p, s } = d;
    c.rect(0, 0, W, H, { fill: "#ffffff" });
    if (!portrait) {
      c.circle(W + 8, -14, 74, { fill: s });
      c.circle(-16, H + 10, 46, { fill: p, opacity: 0.92 });
      c.circle(W * 0.71, H - 11, 4.5, { fill: s, opacity: 0.55 });
      c.circle(W * 0.87, H * 0.6, 3, { fill: p, opacity: 0.5 });
      c.circle(W - 26, 24, 15, { fill: "#ffffff" });
      logo(c, d, W - 37, 13, 22);
      c.text(d.ecole.nomCourt || d.ecole.nom, 14, 20, { font: "sans-bold", size: 7, color: p, maxWidth: W - 72 });
      c.text(`Année ${d.carte.annee}`, 14, 29, { size: 5.8, color: GRIS });
      c.pivoter(-4, 46, 74, () => {
        c.rect(15, 40, 62, 68, { fill: p, radius: 13 });
        photo(c, d, 18, 43, 56, 62, { radius: 11, fond: eclaircir(p, 0.8) });
      });
      c.pivoter(-10, 26, 41, () => {
        c.rect(10, 35, 34, 11, { fill: s, radius: 5.5 });
        c.text("ÉLÈVE", 27, 42.6, { font: "sans-bold", size: 5.8, color: surFond(s), align: "center", spacing: 0.6 });
      });
      const x = 88;
      c.text(d.eleve.prenom, x, 55, { font: "sans-bold", size: 9, color: "#374151", maxWidth: W - x - 50 });
      const nom = majuscules(d.eleve.nom);
      const ln = Math.min(largeur(nom, "sans-bold", 14) + 6, W - x - 50);
      c.rect(x - 2, 60, ln, 12, { fill: s, opacity: 0.4, radius: 2 });
      c.text(nom, x + 1, 70, { font: "sans-bold", size: 14, color: p, maxWidth: W - x - 56 });
      let cx = x;
      [[`Classe ${d.eleve.classe || "—"}`, p], ...(d.options.niveau !== false && d.eleve.niveau ? [[`Niveau ${d.eleve.niveau}`, s]] : [])].forEach(([t, fond]) => {
        const l = Math.min(largeur(t, "sans-bold", 6.5) + 12, 70);
        c.rect(cx, 80, l, 14, { fill: fond, radius: 7 });
        c.text(t, cx + 6, 89.3, { font: "sans-bold", size: 6.5, color: surFond(fond), maxWidth: l - 10 });
        cx += l + 4;
      });
      c.text("Matricule", x, 108, { size: 6, color: GRIS });
      c.text(d.eleve.matricule, x, 117, { font: "sans-bold", size: 7.5, color: ENCRE, maxWidth: 80 });
      qrSurBlanc(c, d, W - 52, H - 52, 38, { radius: 8, bord: eclaircir(p, 0.7), marge: 4 });
      c.text(`N° ${d.carte.numero}`, x, H - 10, { size: 5, color: GRIS });
      return;
    }
    c.circle(W + 4, -10, 62, { fill: s });
    c.circle(-14, H + 6, 44, { fill: p, opacity: 0.92 });
    c.circle(W * 0.82, H * 0.52, 4, { fill: p, opacity: 0.45 });
    c.circle(W - 24, 22, 14, { fill: "#ffffff" });
    logo(c, d, W - 34, 12, 20);
    c.text(d.ecole.nomCourt || d.ecole.nom, 12, 20, { font: "sans-bold", size: 6.8, color: p, maxWidth: W - 56 });
    c.text(`Année ${d.carte.annee}`, 12, 29, { size: 5.5, color: GRIS });
    c.pivoter(-4, W / 2, 82, () => {
      c.rect(W / 2 - 33, 44, 66, 76, { fill: p, radius: 14 });
      photo(c, d, W / 2 - 30, 47, 60, 70, { radius: 12, fond: eclaircir(p, 0.8) });
    });
    c.pivoter(-10, W / 2 - 30, 46, () => {
      c.rect(W / 2 - 48, 40, 34, 11, { fill: s, radius: 5.5 });
      c.text("ÉLÈVE", W / 2 - 31, 47.6, { font: "sans-bold", size: 5.8, color: surFond(s), align: "center", spacing: 0.6 });
    });
    c.text(d.eleve.prenom, W / 2, 140, { font: "sans-bold", size: 8.5, color: "#374151", align: "center", maxWidth: W - 20 });
    const nom = majuscules(d.eleve.nom);
    const ln = Math.min(largeur(nom, "sans-bold", 12.5) + 8, W - 20);
    c.rect(W / 2 - ln / 2, 145, ln, 12, { fill: s, opacity: 0.4, radius: 2 });
    c.text(nom, W / 2, 155, { font: "sans-bold", size: 12.5, color: p, align: "center", maxWidth: W - 26 });
    const t = `Classe ${d.eleve.classe || "—"}`;
    const l = Math.min(largeur(t, "sans-bold", 6.5) + 12, W - 30);
    c.rect(W / 2 - l / 2, 163, l, 13, { fill: p, radius: 6.5 });
    c.text(t, W / 2, 172, { font: "sans-bold", size: 6.5, color: surFond(p), align: "center", maxWidth: l - 10 });
    c.text("Matricule", W - 12, H - 42, { size: 5.5, color: GRIS, align: "right" });
    c.text(d.eleve.matricule, W - 12, H - 33, { font: "sans-bold", size: 7, color: ENCRE, align: "right", maxWidth: 80 });
    c.text(`N° ${d.carte.numero}`, W - 12, H - 23, { size: 4.8, color: GRIS, align: "right" });
    qrSurBlanc(c, d, 42, H - 46, 32, { radius: 7, bord: eclaircir(p, 0.7), marge: 4 });
  },
  verso(c, d, W, H, portrait) {
    const { p, s } = d;
    c.rect(0, 0, W, H, { fill: s });
    for (let x = 6; x < W; x += 12) for (let y = 6; y < H; y += 12) c.circle(x, y, 1, { fill: "#ffffff", opacity: 0.22 });
    c.rect(11, 11, W - 22, H - 22, { fill: "#ffffff", radius: 12 });
    const qrT = 60;
    const qx = portrait ? W / 2 - qrT / 2 : 24;
    const qy = portrait ? 24 : 26;
    c.qr(d.carte.url, qx, qy, qrT, { color: p });
    c.text("Scanne-moi pour vérifier !", qx + qrT / 2, qy + qrT + 11, { font: "sans-bold", size: 5.8, color: p, align: "center" });
    const x = portrait ? 22 : 98;
    let y = portrait ? 120 : 32;
    const larg = W - x - 20;
    c.text(d.ecole.nom, x, y, { font: "sans-bold", size: 8.2, color: p, maxWidth: larg });
    y += 10;
    if (d.options.slogan !== false && d.ecole.slogan) { c.text(d.ecole.slogan, x, y, { font: "sans-italic", size: 6.3, color: assombrir(s, 0.35), maxWidth: larg }); y += 11; }
    coordonnees(d).slice(0, 4).forEach((l, i) => {
      c.rect(x, y - 4.6, 4.2, 4.2, { fill: i % 2 ? s : p, radius: 1 });
      c.text(l, x + 8, y, { size: 6, color: "#374151", maxWidth: larg - 8 });
      y += 9;
    });
    const pill = `Valide jusqu'au ${d.carte.validite}`;
    const lp = largeur(pill, "sans-bold", 5.8) + 12;
    c.rect(x, y + 1, lp, 12, { fill: p, radius: 6 });
    c.text(pill, x + 6, y + 9.2, { font: "sans-bold", size: 5.8, color: surFond(p) });
    if (portrait) signatureCachet(c, d, W / 2 - 34, H - 52, 68, 22);
    else signatureCachet(c, d, W - 92, H - 50, 70, 22);
  },
};

const DESSINS = { academique, moderne, premium, minimaliste, institutionnel, creatif };

/* ------------------------------ Rendu public ------------------------------ */
function preparer(donnees) {
  const o = donnees.options || {};
  return {
    ...donnees,
    p: /^#[0-9a-f]{6}$/i.test(o.couleur_principale || "") ? o.couleur_principale : donnees.couleurs?.principale || "#0f1b3d",
    s: /^#[0-9a-f]{6}$/i.test(o.couleur_secondaire || "") ? o.couleur_secondaire : donnees.couleurs?.secondaire || "#d4a23c",
    options: o,
  };
}
const portraitDe = (d) => d.options.orientation === "portrait";
const dimensions = (portrait) => (portrait ? [CARTE_H, CARTE_L] : [CARTE_L, CARTE_H]);

/** Aperçu SVG d'une face de carte. */
function carteSvg(donnees, modele = "academique", face = "recto") {
  const d = preparer(donnees);
  const portrait = portraitDe(d);
  const [W, H] = dimensions(portrait);
  const toile = new ToileSvg(W, H);
  (DESSINS[modele] || academique)[face === "verso" ? "verso" : "recto"](toile, d, W, H, portrait);
  return toile.rendre();
}

/**
 * PDF des cartes.
 *  format « carte »   : une page par face, au format carte (imprimante à cartes) ;
 *  format « planche » : A4, 10 cartes (paysage) ou 9 (portrait) par page,
 *                       recto puis verso en miroir pour l'impression recto-verso.
 */
function cartesPdf(flux, liste, { modele = "academique", format = "carte" } = {}) {
  const cartes = liste.map(preparer);
  const portrait = cartes[0] ? portraitDe(cartes[0]) : false;
  const [W, H] = dimensions(portrait);
  const dessin = DESSINS[modele] || academique;
  const doc = new PDFDocument({ autoFirstPage: false, margin: 0, info: { Title: "Cartes scolaires", Creator: "MaliLink Éducation" } });
  doc.pipe(flux);
  if (format === "planche") {
    const A4 = [595.28, 841.89];
    const cols = portrait ? 3 : 2;
    const rows = portrait ? 3 : 5;
    const gx = 14;
    const gy = portrait ? 10 : 8;
    const mx = (A4[0] - cols * W - (cols - 1) * gx) / 2;
    const my = (A4[1] - rows * H - (rows - 1) * gy) / 2;
    const parPage = cols * rows;
    for (let debut = 0; debut < cartes.length; debut += parPage) {
      const lot = cartes.slice(debut, debut + parPage);
      for (const face of ["recto", "verso"]) {
        doc.addPage({ size: "A4", margin: 0 });
        lot.forEach((d, i) => {
          const col = face === "verso" ? cols - 1 - (i % cols) : i % cols;
          const x = mx + col * (W + gx);
          const y = my + Math.floor(i / cols) * (H + gy);
          doc.save().rect(x, y, W, H).clip();
          dessin[face](new ToilePdf(doc, x, y), d, W, H, portrait);
          doc.restore();
          doc.save().lineWidth(0.3).dash(2, { space: 2 }).rect(x - 0.5, y - 0.5, W + 1, H + 1).stroke("#b0b0b0").restore();
        });
        doc.fontSize(6).fillColor("#9ca3af").font("Helvetica")
          .text(`${face === "recto" ? "Recto" : "Verso (imprimer au dos, retournement bord long)"} · ${nettoyer(MODELES[modele] || "")}`, 0, A4[1] - 14, { width: A4[0], align: "center", lineBreak: false });
      }
    }
  } else {
    for (const d of cartes) {
      for (const face of ["recto", "verso"]) {
        doc.addPage({ size: [W, H], margin: 0 });
        dessin[face](new ToilePdf(doc, 0, 0), d, W, H, portrait);
      }
    }
  }
  doc.end();
}

module.exports = { MODELES, carteSvg, cartesPdf, CARTE_L, CARTE_H };
