"use strict";

/**
 * MODÈLE PDF MALILINK — factures, avoirs et reçus de la plateforme.
 *
 * Bleu nuit, or, blanc ; logo officiel ; client, numéro, dates, tableau,
 * VRAIE LIGNE DE REMISE (lecture comptable), net, statut, mode et référence
 * de paiement, montant en lettres, cadre signature / cachet,
 * malilinkglobal.com.
 *
 * Les polices standard du PDF (WinAnsi) n'ont pas l'espace fine insécable de
 * `toLocaleString("fr-FR")` : les montants sont donc formatés à la main.
 */

const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const { montantEnLettres } = require("./montant-lettres");

const NUIT = "#0a1330";
const OR = "#c9a13c";
const GRIS = "#5b6475";
const CLAIR = "#f4f1e8";
const LOGO = path.join(__dirname, "..", "assets", "malilink-logo.jpg");

function fcfa(n) {
  const v = Math.round(Number(n || 0));
  const signe = v < 0 ? "-" : "";
  return `${signe}${String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} FCFA`;
}

function dateFr(d) {
  if (!d) return "—";
  const x = new Date(d);
  return `${String(x.getDate()).padStart(2, "0")}/${String(x.getMonth() + 1).padStart(2, "0")}/${x.getFullYear()}`;
}

const LIBELLE_STATUT = { brouillon: "BROUILLON", emise: "À PAYER", partielle: "PARTIELLEMENT PAYÉE", payee: "PAYÉE", annulee: "ANNULÉE" };
const LIBELLE_METHODE = { orange_money: "Orange Money", wave: "Wave", moov_money: "Moov Money", virement: "Virement",
  especes: "Espèces", carte: "Carte", autre: "Autre" };

function entete(doc, titre, numero, lignesDroite) {
  doc.rect(0, 0, doc.page.width, 118).fill(NUIT);
  if (fs.existsSync(LOGO)) doc.image(LOGO, 40, 24, { width: 70, height: 70 });
  doc.fillColor(OR).font("Helvetica-Bold").fontSize(20).text("MaliLink Global", 122, 34);
  doc.fillColor("#ffffff").font("Helvetica").fontSize(9).text("Marketplace et solutions numériques — malilinkglobal.com", 122, 60);
  doc.fillColor(OR).font("Helvetica-Bold").fontSize(18).text(titre, 330, 30, { width: 225, align: "right" });
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(11).text(numero, 330, 54, { width: 225, align: "right" });
  doc.font("Helvetica").fontSize(9);
  lignesDroite.forEach((l, i) => doc.text(l, 330, 72 + i * 12, { width: 225, align: "right" }));
  doc.fillColor("#000000");
}

function pied(doc) {
  const y = doc.page.height - 50;
  doc.moveTo(40, y).lineTo(doc.page.width - 40, y).lineWidth(0.5).strokeColor(OR).stroke();
  /* Le pied s'écrit SOUS la marge basse : sans la lever le temps de l'écrire,
     pdfkit ouvrait une seconde page qui ne portait que cette ligne. */
  const marge = doc.page.margins.bottom;
  doc.page.margins.bottom = 0;
  doc.fillColor(GRIS).font("Helvetica").fontSize(8)
    .text("MaliLink Global — malilinkglobal.com — Document généré électroniquement.", 40, y + 8,
      { width: doc.page.width - 80, align: "center", lineBreak: false });
  doc.page.margins.bottom = marge;
}

function blocClient(doc, client, y) {
  doc.fillColor(GRIS).font("Helvetica-Bold").fontSize(9).text("FACTURÉ À", 40, y);
  doc.fillColor(NUIT).font("Helvetica-Bold").fontSize(12).text(client.name || "—", 40, y + 14, { width: 300 });
  doc.fillColor("#000000").font("Helvetica").fontSize(9);
  let yy = y + 32;
  for (const l of [client.responsible_name ? `À l'attention de ${client.responsible_name}` : "", client.address, client.phone, client.email]) {
    if (!l) continue;
    doc.text(String(l), 40, yy, { width: 300 });
    yy += 12;
  }
  return yy;
}

function tableau(doc, lignes, y) {
  const x = [40, 300, 345, 445];
  const largeurs = [255, 40, 95, 110];
  doc.rect(40, y, 515, 22).fill(NUIT);
  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(9);
  ["Désignation", "Qté", "Prix unitaire", "Montant"].forEach((t, i) =>
    doc.text(t, x[i] + 6, y + 7, { width: largeurs[i] - 12, align: i === 0 ? "left" : "right" }));
  y += 22;
  const rangee = (cellules, { gras = false, couleur = "#000000", fond = null } = {}) => {
    const hauteur = Math.max(20, doc.heightOfString(cellules[0], { width: largeurs[0] - 12 }) + 10);
    if (fond) doc.rect(40, y, 515, hauteur).fill(fond);
    doc.fillColor(couleur).font(gras ? "Helvetica-Bold" : "Helvetica").fontSize(9);
    cellules.forEach((t, i) => doc.text(t, x[i] + 6, y + 5, { width: largeurs[i] - 12, align: i === 0 ? "left" : "right" }));
    y += hauteur;
    doc.moveTo(40, y).lineTo(555, y).lineWidth(0.3).strokeColor("#d9dce3").stroke();
  };
  for (const l of lignes) {
    const qte = Number(l.quantity);
    const libelle = l.description ? `${l.label}\n${l.description}` : l.label;
    // Prix standard d'abord, puis une vraie ligne de remise : lecture comptable.
    rangee([libelle, String(qte % 1 === 0 ? qte : qte.toFixed(2)), fcfa(l.unit_price_standard), fcfa(Number(l.unit_price_standard) * qte)]);
    if (Number(l.discount_amount) > 0) {
      rangee([`${l.discount_label || "Réduction exceptionnelle"}`, "", "", fcfa(-Number(l.discount_amount))], { couleur: "#9a2b2b" });
      rangee([`Net ${String(l.label).replace(/^Installation/i, "installation")}`, "", "", fcfa(l.line_total)], { gras: true, fond: CLAIR });
    }
  }
  return y;
}

function totaux(doc, f, y) {
  const lignes = [["Total au prix standard", fcfa(f.subtotal_standard)]];
  if (Number(f.discount_total) > 0) lignes.push(["Remises accordées", fcfa(-Number(f.discount_total))]);
  lignes.push([f.kind === "avoir" ? "Montant de l'avoir" : "Net à payer", fcfa(f.total)]);
  if (f.kind !== "avoir") {
    lignes.push(["Déjà réglé", fcfa(f.amount_paid)]);
    lignes.push(["Reste à payer", fcfa(Number(f.total) - Number(f.amount_paid))]);
  }
  y += 10;
  lignes.forEach(([l, v], i) => {
    const fort = l === "Net à payer" || l === "Montant de l'avoir";
    if (fort) doc.rect(330, y - 3, 225, 22).fill(NUIT);
    doc.fillColor(fort ? OR : "#000000").font(fort ? "Helvetica-Bold" : "Helvetica").fontSize(fort ? 11 : 9)
      .text(l, 336, y + (fort ? 2 : 0), { width: 120 });
    doc.fillColor(fort ? "#ffffff" : "#000000").text(v, 446, y + (fort ? 2 : 0), { width: 103, align: "right" });
    y += fort ? 24 : 15;
    if (i === lignes.length - 1) y += 4;
  });
  return y;
}

/**
 * Facture (ou avoir) : `f` est la facture complète (lignes, paiements),
 * `moyens` les moyens de paiement publiés.
 */
function genererFacturePdf(f, { moyens = [] } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 40, info: { Title: `${f.kind === "avoir" ? "Avoir" : "Facture"} ${f.number}`, Author: "MaliLink Global" } });
    const morceaux = [];
    doc.on("data", (c) => morceaux.push(c));
    doc.on("end", () => resolve(Buffer.concat(morceaux)));
    doc.on("error", reject);

    const client = f.client_snapshot || {};
    entete(doc, f.kind === "avoir" ? "AVOIR" : "FACTURE", f.number, [
      `Date : ${dateFr(f.issue_date)}`,
      `Échéance : ${dateFr(f.due_date)}`,
      `Statut : ${LIBELLE_STATUT[f.status] || f.status}`,
    ]);
    let y = blocClient(doc, client, 140);
    const offre = f.plan_snapshot || {};
    doc.fillColor(GRIS).font("Helvetica-Bold").fontSize(9).text("OFFRE", 360, 140);
    doc.fillColor(NUIT).font("Helvetica-Bold").fontSize(12).text(offre.nom || "—", 360, 154, { width: 195 });
    if (f.reference) doc.fillColor("#000000").font("Helvetica").fontSize(9).text(`Référence : ${f.reference}`, 360, 172, { width: 195 });
    y = Math.max(y, 190) + 14;

    y = tableau(doc, f.lignes || [], y);
    y = totaux(doc, f, y);

    if (!f.subscription_included && Number(f.monthly_fee_info) > 0 && f.kind !== "avoir") {
      doc.rect(40, y, 515, 40).fill(CLAIR);
      doc.fillColor(NUIT).font("Helvetica-Bold").fontSize(9)
        .text(`Abonnement mensuel ${offre.nom || ""} : ${fcfa(f.monthly_fee_info)} / mois`, 50, y + 8, { width: 495 });
      doc.font("Helvetica").fillColor("#000000").text("Abonnement mensuel non inclus dans la présente facture.", 50, y + 22, { width: 495 });
      y += 50;
    }

    doc.fillColor("#000000").font("Helvetica-Oblique").fontSize(9)
      .text(`Arrêtée la présente ${f.kind === "avoir" ? "note d'avoir" : "facture"} à la somme de : ${montantEnLettres(Math.abs(Number(f.total)))}.`,
        40, y + 4, { width: 515 });
    y += 26;

    const confirmes = (f.paiements || []).filter((p) => p.status === "confirmed");
    if (confirmes.length) {
      doc.font("Helvetica-Bold").fontSize(9).text("Paiements reçus", 40, y);
      y += 13;
      doc.font("Helvetica").fontSize(9);
      for (const p of confirmes) {
        doc.text(`${dateFr(p.paid_at || p.validated_at)} — ${LIBELLE_METHODE[p.method] || p.method} — réf. ${p.transaction_reference || "—"} — ${fcfa(p.imputation || p.amount)} (reçu ${p.receipt_number || "—"})`, 40, y, { width: 515 });
        y += 12;
      }
      y += 6;
    } else if (f.kind !== "avoir" && f.status !== "annulee" && moyens.length) {
      doc.font("Helvetica-Bold").fontSize(9).text("Modes de paiement", 40, y);
      y += 13;
      doc.font("Helvetica").fontSize(9);
      for (const m of moyens) {
        doc.text(`${m.label} : ${m.account_number}${m.account_name ? ` (${m.account_name})` : ""}${m.instructions ? ` — ${m.instructions}` : ""}`, 40, y, { width: 515 });
        y += 12;
      }
      doc.text(`Indiquez le numéro ${f.number} en référence du paiement.`, 40, y, { width: 515 });
      y += 18;
    }
    if (f.notes) {
      doc.font("Helvetica-Bold").fontSize(9).text("Notes", 40, y);
      doc.font("Helvetica").text(String(f.notes), 40, y + 12, { width: 300 });
    }
    if (f.status === "annulee") {
      doc.save().rotate(-25, { origin: [300, 420] }).fillColor("#b91c1c").opacity(0.15).font("Helvetica-Bold").fontSize(80)
        .text("ANNULÉE", 120, 380).restore();
    }

    const ys = Math.max(y + 10, doc.page.height - 190);
    doc.rect(355, ys, 200, 100).lineWidth(0.8).strokeColor(OR).stroke();
    doc.fillColor(GRIS).font("Helvetica").fontSize(8).text("Pour MaliLink Global", 365, ys + 8);
    doc.text("Signature et cachet", 365, ys + 84);
    pied(doc);
    doc.end();
  });
}

/** Reçu d'un paiement confirmé. */
function genererRecuPdf(p, f) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A5", layout: "landscape", margin: 30, info: { Title: `Reçu ${p.receipt_number}`, Author: "MaliLink Global" } });
    const morceaux = [];
    doc.on("data", (c) => morceaux.push(c));
    doc.on("end", () => resolve(Buffer.concat(morceaux)));
    doc.on("error", reject);
    doc.rect(0, 0, doc.page.width, 80).fill(NUIT);
    if (fs.existsSync(LOGO)) doc.image(LOGO, 30, 14, { width: 52, height: 52 });
    doc.fillColor(OR).font("Helvetica-Bold").fontSize(16).text("MaliLink Global", 92, 24);
    doc.fillColor("#ffffff").font("Helvetica").fontSize(8).text("malilinkglobal.com", 92, 46);
    doc.fillColor(OR).font("Helvetica-Bold").fontSize(16).text("REÇU DE PAIEMENT", 300, 20, { width: 265, align: "right" });
    doc.fillColor("#ffffff").fontSize(11).text(p.receipt_number || "", 300, 44, { width: 265, align: "right" });
    const c = f?.client_snapshot || {};
    let y = 100;
    const ligne = (l, v) => {
      doc.fillColor(GRIS).font("Helvetica").fontSize(9).text(l, 30, y, { width: 160 });
      doc.fillColor("#000000").font("Helvetica-Bold").text(v, 190, y, { width: 375 });
      y += 18;
    };
    ligne("Reçu de", c.name || "—");
    ligne("Montant", fcfa(p.amount));
    ligne("En lettres", montantEnLettres(p.amount));
    ligne("Mode de paiement", LIBELLE_METHODE[p.method] || p.method);
    ligne("Référence de transaction", p.transaction_reference || "—");
    ligne("Facture réglée", f ? `${f.number}${Number(f.total) - Number(f.amount_paid) > 0 ? ` (reste ${fcfa(Number(f.total) - Number(f.amount_paid))})` : " (soldée)"}` : "—");
    ligne("Date", dateFr(p.paid_at || p.validated_at));
    doc.rect(doc.page.width - 210, y + 4, 180, 60).lineWidth(0.8).strokeColor(OR).stroke();
    doc.fillColor(GRIS).font("Helvetica").fontSize(8).text("Signature et cachet", doc.page.width - 200, y + 50);
    doc.end();
  });
}

module.exports = { genererFacturePdf, genererRecuPdf, fcfa };
