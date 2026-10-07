"use strict";

/**
 * Bulletins de notes MaliLink Éducation — six modèles A4 réellement
 * différents (structure, typographie, mise en valeur des résultats).
 * Rendus en PDF (impression, envoi) et en SVG (aperçu des paramètres) par
 * le même moteur que les cartes. QR : URL de vérification + jeton aléatoire.
 */

const PDFDocument = require("pdfkit");
const {
  ToileSvg, ToilePdf, paragraphe, nettoyer, largeur, eclaircir, assombrir, surFond, typeImage,
} = require("./dessin");

const A4 = [595.28, 841.89];
const MODELES = {
  institutionnel: "Institutionnel",
  academique: "Académique classique",
  moderne: "Moderne épuré",
  premium: "Premium",
  compact: "Compact",
  elegant: "Élégant école privée",
};
const GRIS = "#6b7280";
const ENCRE = "#111827";

const n2 = (v) => (v == null || Number.isNaN(Number(v)) ? "—" : Number(v).toFixed(2).replace(".", ","));
const rangTexte = (r, n) => (r ? `${r}${r === 1 ? "er" : "e"}${n ? ` / ${n}` : ""}` : "—");
const majuscules = (t) => nettoyer(t).toLocaleUpperCase("fr-FR");

function appreciationAuto(m) {
  if (m == null) return "";
  if (m >= 16) return "Excellent";
  if (m >= 14) return "Très bien";
  if (m >= 12) return "Bien";
  if (m >= 10) return "Assez bien";
  if (m >= 8) return "Insuffisant";
  return "Faible";
}
function mentionAuto(m) {
  if (m == null) return "";
  if (m >= 16) return "Félicitations du conseil";
  if (m >= 14) return "Encouragements";
  if (m >= 12) return "Tableau d'honneur";
  if (m >= 10) return "Passable";
  return "Doit redoubler d'efforts";
}
const teinteMoyenne = (m) => (m == null ? ["#f3f4f6", GRIS] : m >= 14 ? ["#dcfce7", "#166534"] : m >= 10 ? ["#fef3c7", "#92400e"] : ["#fee2e2", "#991b1b"]);

function logo(c, b, x, y, t, o = {}) {
  if (o.pastille) c.circle(x + t / 2, y + t / 2, t / 2 + 3, { fill: o.pastille });
  if (b.options.logo !== false && typeImage(b.ecole.logo)) return c.image(b.ecole.logo, x, y, t, t, { fit: "contain" });
  const sigle = nettoyer(b.ecole.nomCourt || b.ecole.nom).split(/\s+/).filter((m) => m.length > 2).slice(0, 3).map((m) => m[0]).join("").toUpperCase() || "E";
  c.circle(x + t / 2, y + t / 2, t / 2, { fill: o.fond || b.p });
  c.text(sigle, x + t / 2, y + t / 2 + t * 0.14, { font: "sans-bold", size: t * 0.34, color: surFond(o.fond || b.p), align: "center", maxWidth: t * 0.8 });
  return true;
}

function photo(c, b, x, y, w, h, o = {}) {
  if (!typeImage(b.eleve.photo)) {
    c.rect(x, y, w, h, { fill: "#e5e7eb", radius: o.radius || 0 });
    c.circle(x + w / 2, y + h * 0.4, Math.min(w, h) * 0.17, { fill: "#9ca3af" });
    c.ellipse(x + w / 2, y + h * 0.8, Math.min(w, h) * 0.3, Math.min(w, h) * 0.17, { fill: "#9ca3af" });
    return;
  }
  c.image(b.eleve.photo, x, y, w, h, { clip: o.cercle ? "circle" : "rect", radius: o.radius || 0 });
}

const contacts = (b) => [
  [b.ecole.adresse, b.ecole.ville].filter(Boolean).join(", "),
  [b.ecole.telephone && `Tél. ${b.ecole.telephone}`, b.ecole.email, b.ecole.site && b.ecole.site.replace(/^https?:\/\//, "")].filter(Boolean).join("  ·  "),
].filter(Boolean);

function signatures(c, b, x, y, w, o = {}) {
  const police = o.police || "sans";
  const couleur = o.couleur || ENCRE;
  c.text(o.titre || "Le Directeur", x + w / 2, y, { font: police, size: o.taille || 8, color: couleur, align: "center" });
  if (b.options.cachet !== false && typeImage(b.ecole.cachet)) c.image(b.ecole.cachet, x + w / 2 - 6, y + 4, 56, 56, { fit: "contain", opacity: 0.8 });
  if (b.options.signature !== false && typeImage(b.ecole.signature)) c.image(b.ecole.signature, x + w / 2 - 54, y + 10, 70, 38, { fit: "contain" });
  if (b.ecole.directeur) c.text(b.ecole.directeur, x + w / 2, y + 64, { font: police, size: 7.5, color: GRIS, align: "center", maxWidth: w });
}

function blocQr(c, b, x, y, t, o = {}) {
  c.rect(x - 3, y - 3, t + 6, t + 6, { fill: "#ffffff", radius: o.radius ?? 2 });
  c.qr(b.url, x, y, t, { color: o.couleur || ENCRE });
  if (o.legende !== false) {
    const tx = x + t + 8;
    c.text("Document vérifiable", tx, y + 12, { font: o.police ? `${o.police}-bold` : "sans-bold", size: 7.5, color: o.couleurTexte || ENCRE });
    c.text("Scannez ce code pour contrôler", tx, y + 23, { font: o.police || "sans", size: 6.8, color: GRIS });
    c.text("l'authenticité du bulletin.", tx, y + 32, { font: o.police || "sans", size: 6.8, color: GRIS });
    c.text(`Réf. ${b.reference}`, tx, y + 44, { font: o.police || "sans", size: 6.5, color: GRIS });
  }
}

/* ------------------------- Tableau des matières ------------------------- */
function colonnes(b, compact = false) {
  const l = [
    { cle: "nom", titre: "Matières", souple: 1.25, align: "left" },
    { cle: "coef", titre: "Coef.", largeur: 30, align: "center" },
    { cle: "moyenne", titre: "Moy. /20", largeur: 46, align: "center" },
    { cle: "points", titre: "Points", largeur: 44, align: "center" },
  ];
  if (b.options.moyenne_classe !== false) l.push({ cle: "moyenne_classe", titre: "Moy. classe", largeur: 54, align: "center" });
  if (compact) l.push({ cle: "min", titre: "Min", largeur: 32, align: "center" }, { cle: "max", titre: "Max", largeur: 32, align: "center" });
  if (b.options.appreciations !== false) l.push({ cle: "appreciation", titre: "Appréciation", souple: 1, align: "left" });
  return l;
}

function tableau(c, b, x, y, w, st) {
  const cols = colonnes(b, st.compact);
  const fixe = cols.reduce((s, k) => s + (k.largeur || 0), 0);
  const souple = cols.reduce((s, k) => s + (k.souple || 0), 0);
  cols.forEach((k) => { k.l = k.largeur || ((w - fixe) * k.souple) / souple; });
  const lignes = b.matieres.length ? b.matieres : [{ nom: "Aucune note enregistrée pour cette période", coef: null, moyenne: null }];
  const hEntete = st.hEntete || 18;
  const hLigne = Math.max(st.min || 11, Math.min(st.max || 18, ((st.hauteurMax || 400) - hEntete - 18) / (lignes.length + 1)));
  const taille = st.taille || 8.5;
  const police = st.police || "sans";
  const gras = `${police}-bold`;
  const total = lignes.length * hLigne + hEntete + hLigne;
  if (st.cadre) c.rect(x, y, w, total, { fill: st.cadre.fond || "#ffffff", stroke: st.cadre.trait, lineWidth: st.cadre.epaisseur || 0.6, radius: st.cadre.rayon || 0 });
  if (st.entete.fond) c.rect(x, y, w, hEntete, { fill: st.entete.fond, radius: st.entete.rayon || 0 });
  let cx = x;
  for (const k of cols) {
    const tx = k.align === "center" ? cx + k.l / 2 : cx + 6;
    const titre = st.entete.majuscules ? majuscules(k.titre) : k.titre;
    c.text(titre, tx, y + hEntete / 2 + 3, { font: st.entete.police || gras, size: st.entete.taille || 7.5, color: st.entete.couleur || ENCRE, align: k.align === "center" ? "center" : "left", spacing: st.entete.espacement || 0, maxWidth: k.l - 6 });
    cx += k.l;
  }
  if (st.grille === "horizontale" || st.grille === "aucune") c.line(x, y + hEntete, x + w, y + hEntete, { stroke: st.trait || ENCRE, lineWidth: st.traitEntete || 0.8 });
  let ly = y + hEntete;
  lignes.forEach((m, i) => {
    if (st.zebra && i % 2 === 1) c.rect(x, ly, w, hLigne, { fill: st.zebra });
    cx = x;
    for (const k of cols) {
      const base = ly + hLigne / 2 + taille * 0.35;
      const v = k.cle === "nom" ? m.nom : k.cle === "coef" ? (m.coef ?? "—") : k.cle === "appreciation" ? (m.appreciation || appreciationAuto(m.moyenne))
        : n2(m[k.cle]);
      if (k.cle === "moyenne" && st.puce && m.moyenne != null) {
        const [fond, encre] = teinteMoyenne(m.moyenne);
        c.rect(cx + k.l / 2 - 18, ly + hLigne / 2 - 6, 36, 12, { fill: fond, radius: 6 });
        c.text(v, cx + k.l / 2, base, { font: "sans-bold", size: taille - 0.5, color: encre, align: "center" });
      } else {
        const f = k.cle === "nom" ? (st.policeMatiere || police) : k.cle === "appreciation" ? (st.italiqueAppreciation ? `${police}-italic` : police) : k.cle === "moyenne" ? gras : police;
        c.text(String(v), k.align === "center" ? cx + k.l / 2 : cx + 6, base,
          { font: f, size: k.cle === "appreciation" ? taille - 0.8 : taille, color: k.cle === "appreciation" ? (st.couleurAppreciation || "#374151") : ENCRE, align: k.align === "center" ? "center" : "left", maxWidth: k.l - 8 });
      }
      cx += k.l;
    }
    ly += hLigne;
    if (st.grille !== "aucune" && i < lignes.length - 1) c.line(x, ly, x + w, ly, { stroke: st.traitLigne || "#d1d5db", lineWidth: 0.4 });
  });
  // Ligne des totaux.
  if (st.totalFond) c.rect(x, ly, w, hLigne, { fill: st.totalFond });
  c.line(x, ly, x + w, ly, { stroke: st.trait || ENCRE, lineWidth: st.grille === "complete" ? 0.6 : 0.8 });
  cx = x;
  for (const k of cols) {
    const base = ly + hLigne / 2 + taille * 0.35;
    const v = k.cle === "nom" ? "TOTAL" : k.cle === "coef" ? String(b.synthese.total_coef || "—") : k.cle === "points" ? n2(b.synthese.total_points)
      : k.cle === "moyenne" ? n2(b.synthese.moyenne) : "";
    if (v) c.text(v, k.align === "center" ? cx + k.l / 2 : cx + 6, base, { font: gras, size: taille, color: st.couleurTotal || ENCRE, align: k.align === "center" ? "center" : "left" });
    cx += k.l;
  }
  ly += hLigne;
  if (st.grille === "complete") {
    c.rect(x, y, w, ly - y, { stroke: st.trait || "#6b7280", lineWidth: 0.7 });
    cx = x;
    cols.slice(0, -1).forEach((k) => { cx += k.l; c.line(cx, y, cx, ly, { stroke: st.trait || "#6b7280", lineWidth: 0.4 }); });
  } else if (st.grille === "horizontale") {
    c.line(x, y, x + w, y, { stroke: st.trait || ENCRE, lineWidth: 1.2 });
    c.line(x, ly, x + w, ly, { stroke: st.trait || ENCRE, lineWidth: 1.2 });
  }
  return ly;
}

const lignesSynthese = (b) => {
  const s = b.synthese;
  const l = [["Moyenne générale", `${n2(s.moyenne)} / 20`]];
  if (b.options.rang !== false) l.push(["Rang", rangTexte(s.rang, s.effectif)]);
  if (b.options.moyenne_classe !== false) l.push(["Moyenne de la classe", n2(s.moyenne_classe)]);
  if (b.options.moyenne_classe !== false && s.plus_forte != null) l.push(["Plus forte / plus faible", `${n2(s.plus_forte)} / ${n2(s.plus_faible)}`]);
  return l;
};

/* ---------------------------- 1. Institutionnel ---------------------------- */
function institutionnel(c, b, W, H) {
  const { p, s } = b;
  const M = 34;
  c.rect(0, 0, W, H, { fill: "#ffffff" });
  logo(c, b, M, 28, 48);
  c.text(b.ecole.nom, M + 58, 44, { font: "sans-bold", size: 12.5, color: p, maxWidth: 255 });
  contacts(b).forEach((l, i) => c.text(l, M + 58, 57 + i * 10, { size: 7.3, color: GRIS, maxWidth: 255 }));
  c.rect(W - M - 190, 26, 190, 54, { fill: eclaircir(p, 0.94), stroke: p, lineWidth: 1 });
  c.text("BULLETIN DE NOTES", W - M - 95, 46, { font: "sans-bold", size: 13, color: p, align: "center" });
  c.text(`${b.periode.libelle}  ·  ${b.periode.annee}`, W - M - 95, 60, { size: 9, color: ENCRE, align: "center", maxWidth: 180 });
  c.text(`Réf. ${b.reference}`, W - M - 95, 72, { size: 6.5, color: GRIS, align: "center" });
  c.rect(M, 90, W - 2 * M, 1.6, { fill: p });
  c.rect(M, 93.5, W - 2 * M, 0.6, { fill: s });
  // Identité de l'élève.
  const avecPhoto = b.options.photo === true;
  const gw = W - 2 * M - (avecPhoto ? 58 : 0);
  const cellules = [
    [["Élève", `${majuscules(b.eleve.nom)} ${nettoyer(b.eleve.prenom)}`, 0.42], ["Matricule", b.eleve.matricule, 0.22], ["Classe", b.eleve.classe, 0.18], ["Effectif", b.synthese.effectif || "—", 0.18]],
    [["Né(e) le", b.eleve.naissance || "—", 0.42], ["Sexe", b.eleve.sexe || "—", 0.22], ["Année scolaire", b.periode.annee, 0.18], ["Période", b.periode.libelle, 0.18]],
  ];
  cellules.forEach((rangee, r) => {
    let cx = M;
    rangee.forEach(([l, v, part]) => {
      const cw = gw * part;
      c.rect(cx, 104 + r * 26, cw, 26, { stroke: "#9ca3af", lineWidth: 0.5 });
      c.text(l.toUpperCase(), cx + 5, 104 + r * 26 + 9, { size: 5.8, color: GRIS, spacing: 0.4 });
      c.text(String(v), cx + 5, 104 + r * 26 + 20, { font: "sans-bold", size: 8.5, color: ENCRE, maxWidth: cw - 10 });
      cx += cw;
    });
  });
  if (avecPhoto) { c.rect(W - M - 52, 104, 52, 52, { stroke: "#9ca3af", lineWidth: 0.5 }); photo(c, b, W - M - 50, 106, 48, 48); }
  const fin = tableau(c, b, M, 168, W - 2 * M, {
    grille: "complete", trait: "#6b7280", entete: { fond: eclaircir(p, 0.86), couleur: p, majuscules: true, taille: 7 },
    totalFond: "#f3f4f6", hauteurMax: 360, taille: 8.3,
  });
  // Trois encadrés de synthèse.
  const by = fin + 14;
  const bw = (W - 2 * M - 16) / 3;
  const boites = [
    ["Résultats", lignesSynthese(b)],
    ["Assiduité et conduite", [["Absences", String(b.synthese.absences ?? 0)], ["Retards", String(b.synthese.retards ?? 0)], ["Conduite", b.synthese.conduite || "—"]]],
  ];
  boites.forEach(([t, lignes], i) => {
    const bx = M + i * (bw + 8);
    c.rect(bx, by, bw, 92, { stroke: "#9ca3af", lineWidth: 0.6 });
    c.rect(bx, by, bw, 15, { fill: p });
    c.text(t.toUpperCase(), bx + 6, by + 10.5, { font: "sans-bold", size: 6.8, color: surFond(p), spacing: 0.5, maxWidth: bw - 12 });
    lignes.forEach(([l, v], j) => {
      c.text(l, bx + 6, by + 30 + j * 15, { size: 7.5, color: "#374151" });
      c.text(v, bx + bw - 6, by + 30 + j * 15, { font: "sans-bold", size: j === 0 && i === 0 ? 10 : 8, color: j === 0 && i === 0 ? p : ENCRE, align: "right", maxWidth: bw * 0.5 });
    });
  });
  const bx = M + 2 * (bw + 8);
  c.rect(bx, by, bw, 92, { stroke: "#9ca3af", lineWidth: 0.6 });
  c.rect(bx, by, bw, 15, { fill: s });
  c.text("DÉCISION DU CONSEIL", bx + 6, by + 10.5, { font: "sans-bold", size: 6.8, color: surFond(s), spacing: 0.5 });
  c.text(b.synthese.mention, bx + 6, by + 29, { font: "sans-bold", size: 8.5, color: p, maxWidth: bw - 12 });
  let ty = by + 41;
  if (b.synthese.decision) ty += paragraphe(c, b.synthese.decision, bx + 6, ty, { font: "sans-bold", size: 7.3, width: bw - 12, maxLines: 2, lineHeight: 9 });
  if (b.options.appreciations !== false && b.synthese.appreciation) paragraphe(c, b.synthese.appreciation, bx + 6, ty + 2, { font: "sans-italic", size: 7, color: "#374151", width: bw - 12, maxLines: 3, lineHeight: 8.6 });
  const sy = by + 112;
  c.text(`Fait à ${b.ecole.ville || "Bamako"}, le ${b.date}`, M, sy, { size: 8, color: ENCRE });
  c.text("Le Professeur principal", M + (W - 2 * M) * 0.32, sy + 16, { size: 8, color: ENCRE, align: "center" });
  signatures(c, b, W - M - 170, sy + 16, 170);
  blocQr(c, b, M, H - M - 58, 58);
  c.line(M, H - 22, W - M, H - 22, { stroke: p, lineWidth: 0.6 });
  c.text("Bulletin émis par MaliLink Éducation — toute rature ou surcharge l'annule.", W - M, H - 12, { size: 6.3, color: GRIS, align: "right" });
}

/* ------------------------- 2. Académique classique ------------------------- */
function academique(c, b, W, H) {
  const { p, s } = b;
  const M = 46;
  c.rect(0, 0, W, H, { fill: "#ffffff" });
  logo(c, b, W / 2 - 22, 26, 44);
  c.text(majuscules(b.ecole.nom), W / 2, 88, { font: "serif-bold", size: 14, color: p, align: "center", maxWidth: W - 2 * M });
  c.text(contacts(b).join("  —  "), W / 2, 100, { font: "serif", size: 8, color: GRIS, align: "center", maxWidth: W - 2 * M });
  c.line(M, 108, W - M, 108, { stroke: s, lineWidth: 1.4 });
  c.line(M, 111, W - M, 111, { stroke: s, lineWidth: 0.4 });
  c.text("BULLETIN SCOLAIRE", W / 2, 136, { font: "serif-bold", size: 15, spacing: 3, color: ENCRE, align: "center" });
  c.text(`${b.periode.libelle} — Année scolaire ${b.periode.annee}`, W / 2, 152, { font: "serif-italic", size: 10, color: "#374151", align: "center" });
  const avecPhoto = b.options.photo === true;
  if (avecPhoto) { c.rect(W - M - 54, 166, 54, 66, { stroke: s, lineWidth: 0.8 }); photo(c, b, W - M - 52, 168, 50, 62); }
  const gauche = [["Nom et prénoms", `${majuscules(b.eleve.nom)} ${nettoyer(b.eleve.prenom)}`], ["Matricule", b.eleve.matricule], ["Né(e) le", b.eleve.naissance || "—"]];
  const droite = [["Classe", b.eleve.classe], ["Effectif", String(b.synthese.effectif || "—")], ["Sexe", b.eleve.sexe || "—"]];
  const xd = avecPhoto ? W / 2 - 10 : W / 2 + 20;
  gauche.forEach(([l, v], i) => {
    const ll = c.text(`${l} : `, M, 182 + i * 15, { font: "serif-italic", size: 9.5, color: "#374151" });
    c.text(v, M + ll, 182 + i * 15, { font: "serif-bold", size: 9.5, color: ENCRE, maxWidth: xd - M - ll - 10 });
  });
  droite.forEach(([l, v], i) => {
    const ll = c.text(`${l} : `, xd, 182 + i * 15, { font: "serif-italic", size: 9.5, color: "#374151" });
    c.text(v, xd + ll, 182 + i * 15, { font: "serif-bold", size: 9.5, color: ENCRE, maxWidth: (avecPhoto ? W - M - 62 : W - M) - xd - ll });
  });
  const fin = tableau(c, b, M, 240, W - 2 * M, {
    grille: "horizontale", police: "serif", trait: ENCRE, entete: { police: "serif-bold", taille: 8.8, couleur: ENCRE },
    italiqueAppreciation: true, hauteurMax: 340, taille: 9.2, hEntete: 20,
  });
  const s2 = b.synthese;
  c.text(`Moyenne générale : ${n2(s2.moyenne)} / 20`, W / 2, fin + 28, { font: "serif-bold", size: 13.5, color: p, align: "center" });
  const ligne2 = [b.options.rang !== false && `Rang : ${rangTexte(s2.rang, s2.effectif)}`, b.options.moyenne_classe !== false && `Moyenne de la classe : ${n2(s2.moyenne_classe)}`].filter(Boolean).join("   ·   ");
  if (ligne2) c.text(ligne2, W / 2, fin + 44, { font: "serif", size: 10, color: ENCRE, align: "center" });
  c.text(`Absences : ${s2.absences ?? 0}   ·   Retards : ${s2.retards ?? 0}   ·   Conduite : ${s2.conduite || "—"}`, W / 2, fin + 58, { font: "serif", size: 9, color: "#374151", align: "center" });
  const ay = fin + 72;
  c.line(M, ay, W - M, ay, { stroke: s, lineWidth: 0.6 });
  c.text("Appréciation du conseil de classe", M, ay + 15, { font: "serif-bold", size: 9.5, color: ENCRE });
  c.text(s2.mention, W - M, ay + 15, { font: "serif-bold", size: 9.5, color: p, align: "right" });
  let ty = ay + 29;
  if (b.options.appreciations !== false && s2.appreciation) ty += paragraphe(c, s2.appreciation, M, ty, { font: "serif-italic", size: 9.5, color: "#374151", width: W - 2 * M, maxLines: 3, lineHeight: 12 });
  if (s2.decision) { c.text(`Décision : ${s2.decision}`, M, ty + 2, { font: "serif-bold", size: 9, color: ENCRE, maxWidth: W - 2 * M }); ty += 12; }
  c.line(M, ty + 6, W - M, ty + 6, { stroke: s, lineWidth: 0.6 });
  const sy = ty + 26;
  c.text("Le Professeur principal", M + 70, sy, { font: "serif-italic", size: 9, color: ENCRE, align: "center" });
  signatures(c, b, W - M - 180, sy, 180, { titre: "Le Chef d'établissement", police: "serif-italic", taille: 9 });
  c.qr(b.url, W - M - 50, H - M - 48, 48, { color: ENCRE });
  c.text("Authenticité : scannez le code", W - M - 25, H - M + 9, { font: "serif-italic", size: 6.8, color: GRIS, align: "center" });
  c.text(`Fait à ${b.ecole.ville || "Bamako"}, le ${b.date}  ·  Réf. ${b.reference}`, M, H - M + 4, { font: "serif", size: 7.5, color: GRIS });
}

/* ---------------------------- 3. Moderne épuré ---------------------------- */
function moderne(c, b, W, H) {
  const { p, s } = b;
  const M = 40;
  const D = 34;
  c.rect(0, 0, W, H, { fill: "#ffffff" });
  c.rect(0, 0, 10, H, { fill: p });
  c.rect(0, 0, 10, 90, { fill: s });
  logo(c, b, M, 30, 34);
  c.text(b.ecole.nom, M + 44, 44, { font: "sans-bold", size: 11, color: ENCRE, maxWidth: 260 });
  c.text(contacts(b)[0] || "", M + 44, 56, { size: 7.5, color: GRIS, maxWidth: 260 });
  c.text("Bulletin", W - D, 50, { size: 26, color: ENCRE, align: "right" });
  const pill = `${b.periode.libelle} · ${b.periode.annee}`;
  const lp = largeur(pill, "sans-bold", 8) + 16;
  c.rect(W - D - lp, 58, lp, 16, { fill: eclaircir(p, 0.88), radius: 8 });
  c.text(pill, W - D - lp / 2, 69, { font: "sans-bold", size: 8, color: p, align: "center" });
  c.rect(M, 90, W - M - D, 62, { fill: "#f6f7f9", radius: 10 });
  let fx = M + 16;
  if (b.options.photo === true) { photo(c, b, M + 12, 97, 48, 48, { cercle: true }); fx = M + 72; }
  const champs = [["Élève", `${nettoyer(b.eleve.prenom)} ${majuscules(b.eleve.nom)}`, 0.4], ["Matricule", b.eleve.matricule, 0.22], ["Classe", b.eleve.classe, 0.19], ["Effectif", String(b.synthese.effectif || "—"), 0.19]];
  const lw = W - D - 12 - fx;
  champs.forEach(([l, v, part]) => {
    c.text(l.toUpperCase(), fx, 115, { size: 6.5, spacing: 0.7, color: GRIS });
    c.text(v, fx, 131, { font: "sans-bold", size: 9.5, color: ENCRE, maxWidth: lw * part - 8 });
    fx += lw * part;
  });
  const fin = tableau(c, b, M, 168, W - M - D, {
    grille: "aucune", trait: p, traitEntete: 1, zebra: "#f9fafb", puce: true,
    entete: { couleur: p, majuscules: true, taille: 6.8, espacement: 0.6 }, hauteurMax: 330, taille: 8.6, hEntete: 20,
  });
  // Cartes de résultats.
  const ky = fin + 16;
  const cw = (W - M - D - 24) / 4;
  const s2 = b.synthese;
  const cartes = [
    ["Moyenne générale", null],
    ["Rang", b.options.rang !== false ? [rangTexte(s2.rang).replace(" / ", ""), s2.effectif ? `sur ${s2.effectif} élèves` : ""] : ["—", ""]],
    ["Moyenne de la classe", b.options.moyenne_classe !== false ? [n2(s2.moyenne_classe), s2.plus_forte != null ? `de ${n2(s2.plus_faible)} à ${n2(s2.plus_forte)}` : ""] : ["—", ""]],
    ["Assiduité", [`${s2.absences ?? 0} abs.`, `${s2.retards ?? 0} retard(s)`]],
  ];
  cartes.forEach(([t, v], i) => {
    const x = M + i * (cw + 8);
    c.rect(x, ky, cw, 70, { fill: "#f6f7f9", radius: 10 });
    c.text(t.toUpperCase(), x + 10, ky + 15, { size: 6.2, spacing: 0.6, color: GRIS, maxWidth: cw - 20 });
    if (i === 0) {
      c.circle(x + 30, ky + 44, 20, { fill: p });
      c.text(n2(s2.moyenne), x + 30, ky + 48, { font: "sans-bold", size: 11, color: surFond(p), align: "center" });
      c.text("/ 20", x + 56, ky + 48, { size: 9, color: GRIS });
    } else {
      c.text(v[0], x + 10, ky + 44, { font: "sans-bold", size: 17, color: ENCRE, maxWidth: cw - 20 });
      c.text(v[1], x + 10, ky + 58, { size: 7, color: GRIS, maxWidth: cw - 20 });
    }
  });
  const ay = ky + 84;
  c.rect(M, ay, W - M - D, 70, { stroke: eclaircir(p, 0.75), lineWidth: 0.8, radius: 10 });
  c.rect(M, ay + 10, 3, 50, { fill: s });
  c.text("Appréciation", M + 14, ay + 18, { font: "sans-bold", size: 9, color: ENCRE });
  const ment = s2.mention;
  if (ment) {
    const lm = largeur(ment, "sans-bold", 7.5) + 14;
    c.rect(W - D - 12 - lm, ay + 8, lm, 14, { fill: eclaircir(p, 0.88), radius: 7 });
    c.text(ment, W - D - 12 - lm / 2, ay + 17.6, { font: "sans-bold", size: 7.5, color: p, align: "center" });
  }
  let ty = ay + 32;
  if (b.options.appreciations !== false && s2.appreciation) ty += paragraphe(c, s2.appreciation, M + 14, ty, { size: 8.5, color: "#374151", width: W - M - D - 30, maxLines: 2, lineHeight: 11 });
  if (s2.decision) c.text(`Décision du conseil : ${s2.decision}`, M + 14, Math.min(ty + 2, ay + 62), { font: "sans-bold", size: 8, color: ENCRE, maxWidth: W - M - D - 30 });
  const fy = H - 120;
  blocQr(c, b, M, fy + 16, 60, { radius: 6 });
  signatures(c, b, W - D - 180, fy + 8, 180, { titre: "La Direction" });
  c.text(`Émis le ${b.date}`, W - D, H - 18, { size: 7, color: GRIS, align: "right" });
}

/* ------------------------------- 4. Premium ------------------------------- */
function premium(c, b, W, H) {
  const { p, s } = b;
  const or = s;
  const M = 36;
  c.rect(0, 0, W, H, { fill: "#ffffff" });
  if (typeImage(b.ecole.sceau) || typeImage(b.ecole.logo)) {
    c.image(typeImage(b.ecole.sceau) ? b.ecole.sceau : b.ecole.logo, W / 2 - 170, H / 2 - 120, 340, 340, { fit: "contain", opacity: 0.05 });
  }
  c.rect(0, 0, W, 128, { degrade: { de: p, a: assombrir(p, 0.45), sens: [0, 0, 1, 1] } });
  c.rect(0, 128, W, 3, { fill: or });
  logo(c, b, 40, 30, 46, { pastille: "#ffffff" });
  c.text(majuscules(b.ecole.nom), 104, 50, { font: "serif-bold", size: 13.5, spacing: 0.4, color: or, maxWidth: W - 230 });
  c.text(contacts(b)[0] || "", 104, 64, { size: 7.5, color: "#ffffff", opacity: 0.8, maxWidth: W - 230 });
  c.text("BULLETIN DE NOTES", 104, 96, { font: "sans-bold", size: 11, spacing: 3, color: "#ffffff" });
  c.text(`${b.periode.libelle}  ·  Année scolaire ${b.periode.annee}`, 104, 110, { size: 9, color: or });
  if (b.options.photo === true) {
    c.rect(W - 112, 34, 72, 88, { fill: or, radius: 4 });
    photo(c, b, W - 110, 36, 68, 84, { radius: 3 });
  } else {
    c.text(`Réf. ${b.reference}`, W - M, 110, { size: 7, color: "#ffffff", opacity: 0.7, align: "right" });
  }
  const champs = [["Élève", `${majuscules(b.eleve.nom)} ${nettoyer(b.eleve.prenom)}`, 0.4], ["Matricule", b.eleve.matricule, 0.22], ["Classe", b.eleve.classe, 0.19], ["Effectif", String(b.synthese.effectif || "—"), 0.19]];
  let fx = M;
  const lw = W - 2 * M;
  champs.forEach(([l, v, part], i) => {
    if (i) c.line(fx - 8, 146, fx - 8, 172, { stroke: or, lineWidth: 0.8 });
    c.text(l.toUpperCase(), fx, 152, { size: 6.5, spacing: 0.8, color: assombrir(or, 0.15) });
    c.text(v, fx, 167, { font: "serif-bold", size: 10.5, color: ENCRE, maxWidth: lw * part - 16 });
    fx += lw * part;
  });
  const fin = tableau(c, b, M, 186, W - 2 * M, {
    grille: "aucune", traitLigne: eclaircir(or, 0.55), trait: or, entete: { fond: p, couleur: or, majuscules: true, taille: 7.3, espacement: 0.6 },
    totalFond: eclaircir(or, 0.85), policeMatiere: "serif", hauteurMax: 330, taille: 8.8, hEntete: 20,
  });
  const by = fin + 16;
  c.rect(M, by, W - 2 * M, 66, { fill: p, radius: 6 });
  const s2 = b.synthese;
  const metriques = [["Moyenne générale", `${n2(s2.moyenne)}`], ...(b.options.rang !== false ? [["Rang", rangTexte(s2.rang, s2.effectif)]] : []),
    ...(b.options.moyenne_classe !== false ? [["Moyenne de la classe", n2(s2.moyenne_classe)]] : []), ["Absences · retards", `${s2.absences ?? 0} · ${s2.retards ?? 0}`]];
  const mw = (W - 2 * M) / metriques.length;
  metriques.forEach(([l, v], i) => {
    const x = M + i * mw + mw / 2;
    if (i) c.line(M + i * mw, by + 14, M + i * mw, by + 52, { stroke: or, lineWidth: 0.5, opacity: 0.6 });
    c.text(l.toUpperCase(), x, by + 22, { size: 6.3, spacing: 0.8, color: or, align: "center", maxWidth: mw - 12 });
    c.text(v, x, by + 48, { font: "serif-bold", size: 18, color: "#ffffff", align: "center", maxWidth: mw - 12 });
  });
  const ay = by + 82;
  c.rect(M, ay, 3, 58, { fill: or });
  c.text(s2.mention ? `Appréciation du conseil — ${s2.mention}` : "Appréciation du conseil", M + 12, ay + 11, { font: "serif-bold", size: 10, color: p, maxWidth: W - 2 * M - 12 });
  let ty = ay + 26;
  if (b.options.appreciations !== false && s2.appreciation) ty += paragraphe(c, s2.appreciation, M + 12, ty, { font: "serif-italic", size: 9.5, color: "#374151", width: W - 2 * M - 14, maxLines: 2, lineHeight: 12 });
  if (s2.decision) c.text(`Décision : ${s2.decision}`, M + 12, ty + 4, { font: "sans-bold", size: 8.3, color: ENCRE, maxWidth: W - 2 * M - 14 });
  const fy = H - 118;
  blocQr(c, b, M, fy + 20, 60, { couleur: p, police: "serif" });
  signatures(c, b, W - M - 180, fy + 12, 180, { titre: "Le Directeur", police: "serif-italic", taille: 9 });
  c.rect(0, H - 8, W, 8, { fill: p });
  c.rect(0, H - 10, W, 2, { fill: or });
}

/* ------------------------------- 5. Compact ------------------------------- */
function compact(c, b, W, H) {
  const { p } = b;
  const M = 28;
  c.rect(0, 0, W, H, { fill: "#ffffff" });
  logo(c, b, M, 22, 28);
  c.text(b.ecole.nom, M + 36, 34, { font: "sans-bold", size: 10, color: ENCRE, maxWidth: 280 });
  c.text(contacts(b).join("  ·  "), M + 36, 44, { size: 6.4, color: GRIS, maxWidth: 300 });
  c.text(`BULLETIN — ${majuscules(b.periode.libelle)}`, W - M, 34, { font: "sans-bold", size: 10, color: p, align: "right", maxWidth: 190 });
  c.text(`${b.periode.annee}  ·  Réf. ${b.reference}`, W - M, 44, { size: 6.4, color: GRIS, align: "right" });
  c.line(M, 54, W - M, 54, { stroke: p, lineWidth: 0.9 });
  const cellules = [["Élève", `${majuscules(b.eleve.nom)} ${nettoyer(b.eleve.prenom)}`, 0.32], ["Matricule", b.eleve.matricule, 0.16], ["Classe", b.eleve.classe, 0.13],
    ["Effectif", String(b.synthese.effectif || "—"), 0.1], ["Né(e) le", b.eleve.naissance || "—", 0.17], ["Sexe", b.eleve.sexe || "—", 0.12]];
  let cx = M;
  const gw = W - 2 * M;
  cellules.forEach(([l, v, part]) => {
    const cw = gw * part;
    c.rect(cx, 60, cw, 22, { stroke: "#d1d5db", lineWidth: 0.5 });
    c.text(l.toUpperCase(), cx + 4, 68, { size: 5.3, color: GRIS, spacing: 0.3 });
    c.text(v, cx + 4, 78, { font: "sans-bold", size: 7.4, color: ENCRE, maxWidth: cw - 8 });
    cx += cw;
  });
  const fin = tableau(c, b, M, 90, gw, {
    grille: "complete", trait: "#9ca3af", compact: true, entete: { fond: p, couleur: surFond(p), taille: 6.5 }, totalFond: "#f3f4f6",
    hauteurMax: 470, min: 10, max: 14, taille: 7.3, hEntete: 15,
  });
  const s2 = b.synthese;
  const boites = [["Moyenne", `${n2(s2.moyenne)} / 20`], ...(b.options.rang !== false ? [["Rang", rangTexte(s2.rang, s2.effectif)]] : []),
    ...(b.options.moyenne_classe !== false ? [["Moy. classe", n2(s2.moyenne_classe)]] : []), ["Absences", String(s2.absences ?? 0)], ["Retards", String(s2.retards ?? 0)], ["Mention", s2.mention || "—"]];
  const bw = gw / boites.length;
  boites.forEach(([l, v], i) => {
    c.rect(M + i * bw, fin + 8, bw, 30, { stroke: "#d1d5db", lineWidth: 0.5, fill: i === 0 ? eclaircir(p, 0.9) : "#ffffff" });
    c.text(l.toUpperCase(), M + i * bw + 5, fin + 17, { size: 5.3, color: GRIS, spacing: 0.3 });
    c.text(v, M + i * bw + 5, fin + 31, { font: "sans-bold", size: i === 0 ? 9.5 : 8, color: i === 0 ? p : ENCRE, maxWidth: bw - 10 });
  });
  const ay = fin + 46;
  const aw = (gw - 8) / 2;
  [["Appréciation", b.options.appreciations !== false ? s2.appreciation : ""], ["Décision du conseil / conduite", [s2.decision, s2.conduite && `Conduite : ${s2.conduite}`].filter(Boolean).join(" — ")]].forEach(([t, v], i) => {
    const x = M + i * (aw + 8);
    c.rect(x, ay, aw, 44, { stroke: "#d1d5db", lineWidth: 0.5 });
    c.text(t.toUpperCase(), x + 5, ay + 10, { font: "sans-bold", size: 5.8, color: p, spacing: 0.3 });
    paragraphe(c, v || "—", x + 5, ay + 21, { size: 7, color: "#374151", width: aw - 10, maxLines: 3, lineHeight: 8.5 });
  });
  const sy = ay + 62;
  const tw = gw / 3;
  ["Le Professeur principal", "Le Parent / tuteur"].forEach((t, i) => {
    c.text(t, M + i * tw + tw / 2, sy, { size: 7, color: ENCRE, align: "center" });
    c.line(M + i * tw + 20, sy + 40, M + (i + 1) * tw - 20, sy + 40, { stroke: "#d1d5db", lineWidth: 0.5, dash: [1, 1.5] });
  });
  signatures(c, b, M + 2 * tw, sy, tw, { titre: "La Direction", taille: 7 });
  c.qr(b.url, W - M - 42, H - M - 42, 42, { color: ENCRE });
  c.text("Vérification : scannez le code", W - M - 50, H - M - 12, { size: 6.3, color: GRIS, align: "right" });
  c.text(`Émis le ${b.date}`, M, H - M + 4, { size: 6.3, color: GRIS });
}

/* -------------------------- 6. Élégant école privée -------------------------- */
function elegant(c, b, W, H) {
  const { p, s } = b;
  const M = 50;
  c.rect(0, 0, W, H, { fill: "#fbf8f1" });
  c.rect(18, 18, W - 36, H - 36, { stroke: s, lineWidth: 0.9 });
  c.rect(24, 24, W - 48, H - 48, { stroke: s, lineWidth: 0.3 });
  for (const [x, y] of [[18, 18], [W - 18, 18], [18, H - 18], [W - 18, H - 18]]) c.polygon([[x - 5, y], [x, y - 5], [x + 5, y], [x, y + 5]], { fill: s });
  logo(c, b, W / 2 - 24, 40, 48);
  c.text(b.ecole.nom, W / 2, 108, { font: "serif-bold", size: 15, color: p, align: "center", maxWidth: W - 2 * M });
  if (b.ecole.slogan) c.text(b.ecole.slogan, W / 2, 121, { font: "serif-italic", size: 9, color: assombrir(s, 0.2), align: "center", maxWidth: W - 2 * M });
  c.line(W / 2 - 84, 132, W / 2 - 9, 132, { stroke: s, lineWidth: 0.5 });
  c.polygon([[W / 2 - 4, 132], [W / 2, 128], [W / 2 + 4, 132], [W / 2, 136]], { fill: s });
  c.line(W / 2 + 9, 132, W / 2 + 84, 132, { stroke: s, lineWidth: 0.5 });
  c.text(`Bulletin — ${b.periode.libelle}`, W / 2, 158, { font: "serif", size: 17, spacing: 1.2, color: ENCRE, align: "center", maxWidth: W - 2 * M });
  c.text(`Année scolaire ${b.periode.annee}`, W / 2, 172, { font: "serif-italic", size: 9.5, color: GRIS, align: "center" });
  if (b.options.photo === true) {
    c.circle(M + 34, 206, 31, { stroke: s, lineWidth: 0.8 });
    photo(c, b, M + 6, 178, 56, 56, { cercle: true });
  }
  c.text(`${nettoyer(b.eleve.prenom)} ${majuscules(b.eleve.nom)}`, W / 2, 202, { font: "serif-bold", size: 13, color: p, align: "center", maxWidth: W - 2 * M - 140 });
  c.text(`Matricule ${b.eleve.matricule}  ·  Classe ${b.eleve.classe}  ·  Effectif ${b.synthese.effectif || "—"}`, W / 2, 217, { font: "serif", size: 9, color: "#374151", align: "center", maxWidth: W - 2 * M - 140 });
  const fin = tableau(c, b, M, 240, W - 2 * M, {
    grille: "aucune", police: "serif", traitLigne: eclaircir(s, 0.6), trait: s, traitEntete: 0.6, italiqueAppreciation: true, couleurAppreciation: GRIS,
    cadre: { fond: "#ffffff", trait: s, rayon: 8 }, entete: { police: "serif-bold", couleur: assombrir(s, 0.25), majuscules: true, taille: 7.3, espacement: 0.4 },
    hauteurMax: 320, taille: 9.3, hEntete: 22,
  });
  const s2 = b.synthese;
  const medaillons = [["Moyenne", n2(s2.moyenne)], ...(b.options.rang !== false ? [["Rang", rangTexte(s2.rang)]] : []), ...(b.options.moyenne_classe !== false ? [["Moy. classe", n2(s2.moyenne_classe)]] : [])];
  const my = fin + 46;
  const pas = 110;
  const x0 = W / 2 - ((medaillons.length - 1) * pas) / 2;
  medaillons.forEach(([l, v], i) => {
    const x = x0 + i * pas;
    c.circle(x, my, 31, { fill: "#ffffff", stroke: s, lineWidth: 0.9 });
    c.circle(x, my, 27, { stroke: s, lineWidth: 0.3 });
    c.text(v, x, my + 4, { font: "serif-bold", size: 14, color: p, align: "center", maxWidth: 50 });
    c.text(l, x, my + 44, { font: "serif-italic", size: 8.5, color: GRIS, align: "center" });
  });
  let ty = my + 62;
  c.text(`Absences : ${s2.absences ?? 0}   ·   Retards : ${s2.retards ?? 0}${s2.conduite ? `   ·   Conduite : ${s2.conduite}` : ""}`, W / 2, ty, { font: "serif", size: 9, color: "#374151", align: "center" });
  ty += 18;
  if (s2.mention) { c.text(s2.mention, W / 2, ty, { font: "serif-bold", size: 10.5, color: assombrir(s, 0.25), align: "center" }); ty += 15; }
  if (b.options.appreciations !== false && s2.appreciation) {
    for (const l of require("./dessin").couper(`« ${s2.appreciation} »`, "serif-italic", 9.5, W - 2 * M - 40, 2)) { c.text(l, W / 2, ty, { font: "serif-italic", size: 9.5, color: "#374151", align: "center" }); ty += 12; }
  }
  if (s2.decision) c.text(`Décision du conseil : ${s2.decision}`, W / 2, ty + 2, { font: "serif-bold", size: 9, color: ENCRE, align: "center", maxWidth: W - 2 * M });
  const fy = H - 126;
  c.circle(M + 36, fy + 50, 36, { fill: "#ffffff", stroke: s, lineWidth: 0.8 });
  c.qr(b.url, M + 36 - 22, fy + 28, 44, { color: p });
  c.text("Authenticité vérifiable", M + 36, fy + 98, { font: "serif-italic", size: 7, color: GRIS, align: "center" });
  signatures(c, b, W - M - 190, fy + 16, 190, { titre: "La Direction", police: "serif-italic", taille: 9.5 });
  c.text(`Fait le ${b.date}  ·  Réf. ${b.reference}`, W / 2, H - 32, { font: "serif", size: 7.5, color: GRIS, align: "center" });
}

const DESSINS = { institutionnel, academique, moderne, premium, compact, elegant };

function preparer(donnees) {
  const o = donnees.options || {};
  const moyenne = donnees.synthese?.moyenne == null ? null : Number(donnees.synthese.moyenne);
  return {
    ...donnees,
    p: /^#[0-9a-f]{6}$/i.test(o.couleur_principale || "") ? o.couleur_principale : donnees.couleurs?.principale || "#0f1b3d",
    s: /^#[0-9a-f]{6}$/i.test(o.couleur_secondaire || "") ? o.couleur_secondaire : donnees.couleurs?.secondaire || "#d4a23c",
    options: o,
    synthese: { ...donnees.synthese, mention: donnees.synthese?.mention || mentionAuto(moyenne) },
  };
}

function bulletinSvg(donnees, modele = "institutionnel") {
  const b = preparer(donnees);
  const toile = new ToileSvg(A4[0], A4[1]);
  (DESSINS[modele] || institutionnel)(toile, b, A4[0], A4[1]);
  return toile.rendre();
}

/** Un ou plusieurs bulletins (toute une classe) dans un seul PDF. */
function bulletinsPdf(flux, liste, modele = "institutionnel") {
  const doc = new PDFDocument({ autoFirstPage: false, margin: 0, info: { Title: "Bulletins de notes", Creator: "MaliLink Éducation" } });
  doc.pipe(flux);
  for (const donnees of liste) {
    doc.addPage({ size: "A4", margin: 0 });
    (DESSINS[modele] || institutionnel)(new ToilePdf(doc, 0, 0), preparer(donnees), A4[0], A4[1]);
  }
  doc.end();
}

module.exports = { MODELES, bulletinSvg, bulletinsPdf, appreciationAuto, mentionAuto };
