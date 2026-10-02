"use strict";

/**
 * Abonnements, paiements, facturation, verrouillage — intégration complète.
 * Cas ADA SERVICES & DÉCO+ : installation Business à 75 000 au lieu de
 * 250 000, abonnement non inclus.
 */

const zlib = require("zlib");
const { q, appel, jeton, jetonSuperAdmin, verifier, section, creerSociete, terminer, BASE, pool } = require("./_outils");

const SA = jetonSuperAdmin();

/** Texte lisible d'un PDF pdfkit (flux FlateDecode, chaînes hexadécimales). */
function textePdf(tampon) {
  const brut = tampon.toString("latin1");
  let texte = "";
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = re.exec(brut))) {
    let contenu;
    try {
      contenu = zlib.inflateSync(Buffer.from(m[1], "latin1")).toString("latin1");
    } catch {
      continue;
    }
    for (const bloc of contenu.match(/\[(.*?)\]\s*TJ|<([0-9a-fA-F]+)>\s*Tj/g) || []) {
      for (const h of bloc.match(/<([0-9a-fA-F]+)>/g) || []) texte += Buffer.from(h.slice(1, -1), "hex").toString("latin1");
      texte += "\n";
    }
  }
  return texte;
}

async function pdf(chemin, token) {
  const r = await fetch(`${BASE}${chemin}`, { headers: { Authorization: `Bearer ${token}`, "x-tenant-id": "malilink" } });
  const b = Buffer.from(await r.arrayBuffer());
  return { status: r.status, type: r.headers.get("content-type"), tampon: b, texte: r.ok ? textePdf(b) : "" };
}

async function finAbonnement(companyId, date) {
  await q(`UPDATE subscriptions SET end_date = $2, start_date = $2::date - 30 WHERE company_id = $1`, [companyId, date]);
  await q(`UPDATE companies SET subscription_expires_at = $2, trial_end_date = NULL WHERE id = $1`, [companyId, date]);
}
const jour = (decalage) => new Date(Date.now() + decalage * 86400000).toISOString().slice(0, 10);

async function main() {
  // Le super-admin des tests est un vrai compte (les actions le référencent).
  await q(`INSERT INTO users (id, fullname, email, password, role, is_super_admin)
           VALUES (999001, 'Super Admin Test', 'superadmin-test@essai.test', 'x', 'super_admin', TRUE) ON CONFLICT (id) DO NOTHING`);
  const plans = Object.fromEntries((await q(
    `SELECT commercial_code, price_monthly::float AS mensuel, installation_fee::float AS installation FROM subscription_plans
      WHERE commercial_code IN ('starter','business','pro')`)).map((p) => [p.commercial_code, p]));

  section("GRILLE DES OFFRES");
  verifier("Starter : 75 000 d'installation", plans.starter?.installation === 75000, JSON.stringify(plans.starter));
  verifier("Business : 250 000 + 50 000 / mois", plans.business?.installation === 250000 && plans.business?.mensuel === 50000);
  verifier("Pro : 400 000 + 100 000 / mois", plans.pro?.installation === 400000 && plans.pro?.mensuel === 100000);

  const ada = await creerSociete({ nom: "ADA SERVICES & DÉCO+", planCode: "business" });
  const starter = await creerSociete({ nom: "Boutique Starter", planCode: "starter" });
  const pro = await creerSociete({ nom: "Groupe Pro", planCode: "pro" });
  const autre = await creerSociete({ nom: "Autre Société", planCode: "business" });
  await q(`UPDATE subscriptions s SET monthly_fee = p.price_monthly FROM subscription_plans p WHERE p.id = s.plan_id`);
  for (const s of [ada, starter, pro, autre]) await finAbonnement(s.id, jour(20));
  const magasinier = (await q(`INSERT INTO users (fullname, email, password, role, company_id) VALUES ('Mag ADA','mag-ada@essai.test','x','magasinier',$1)
                               RETURNING id, role, company_id`, [ada.id]))[0];
  const tMag = jeton(magasinier);

  section("CAS ADA : INSTALLATION BUSINESS REMISÉE, ABONNEMENT NON INCLUS");
  let factureAda;
  {
    const r = await appel("POST", `/super-admin/companies/${ada.id}/invoices`, SA, {
      lines: [{ kind: "installation", unit_price: 75000, discount_label: "Réduction exceptionnelle" }],
      reference: "ADA-INSTALL-2026", due_date: jour(15),
    });
    factureAda = r.data?.facture;
    verifier("facture créée", r.status === 201, JSON.stringify(r.data));
    verifier("prix standard 250 000, remise 175 000, net 75 000", Number(factureAda?.subtotal_standard) === 250000
      && Number(factureAda?.discount_total) === 175000 && Number(factureAda?.total) === 75000);
    verifier("abonnement non inclus : 50 000 n'est PAS dans le total", factureAda?.subscription_included === false
      && Number(factureAda?.monthly_fee_info) === 50000 && Number(factureAda?.total) === 75000);
    verifier("nature « installation », numéro unique", factureAda?.kind === "installation" && /^MLG-\d{4}-\d{5}$/.test(factureAda?.number || ""));
    const l = factureAda?.lignes?.[0];
    verifier("la ligne garde standard ET facturé", Number(l?.unit_price_standard) === 250000 && Number(l?.unit_price) === 75000
      && Number(l?.discount_amount) === 175000);
    const p = await pdf(`/super-admin/companies/${ada.id}/invoices/${factureAda.id}/pdf`, SA);
    verifier("PDF généré", p.status === 200 && p.type === "application/pdf" && p.tampon.slice(0, 4).toString() === "%PDF");
    verifier("PDF : vraie ligne de remise -175 000", p.texte.includes("Réduction exceptionnelle") && p.texte.includes("-175 000 FCFA"), p.texte.slice(0, 600));
    verifier("PDF : prix standard 250 000 et net 75 000", p.texte.includes("250 000 FCFA") && p.texte.includes("75 000 FCFA"));
    verifier("PDF : « Abonnement mensuel non inclus dans la présente facture. »", p.texte.includes("Abonnement mensuel non inclus dans la présente facture."));
    verifier("PDF : mensualité affichée pour information (50 000 / mois)", p.texte.includes("50 000 FCFA / mois"));
    verifier("PDF : montant en lettres", p.texte.includes("Soixante-quinze mille francs CFA"));
    verifier("PDF : client, site, signature", p.texte.includes("ADA SERVICES") && p.texte.includes("malilinkglobal.com") && p.texte.includes("Signature et cachet"));
    const plus = await appel("POST", `/super-admin/companies/${ada.id}/invoices`, SA, { lines: [{ kind: "installation", unit_price: 300000 }] });
    verifier("prix facturé > standard : refusé", plus.status === 400 && plus.data?.code === "LIGNE_INVALIDE");
  }

  section("INSTALLATION, MENSUALITÉ, MIXTE, PERSONNALISÉE");
  {
    const mens = await appel("POST", `/super-admin/companies/${starter.id}/invoices`, SA, { lines: [{ kind: "abonnement", months: 2 }] });
    verifier("Starter : mensualité seule (2 mois)", mens.status === 201 && mens.data.facture.kind === "abonnement"
      && Number(mens.data.facture.total) === plans.starter.mensuel * 2 && mens.data.facture.subscription_included === true);
    const inst = await appel("POST", `/super-admin/companies/${pro.id}/invoices`, SA, { lines: [{ kind: "installation" }] });
    verifier("Pro : installation seule au prix standard (400 000)", Number(inst.data?.facture?.total) === 400000 && Number(inst.data?.facture?.discount_total) === 0);
    const mixte = await appel("POST", `/super-admin/companies/${autre.id}/invoices`, SA, {
      lines: [{ kind: "installation" }, { kind: "abonnement", months: 1 }] });
    verifier("facture mixte : 250 000 + 50 000", mixte.data?.facture?.kind === "mixte" && Number(mixte.data?.facture?.total) === 300000);
    const perso = await appel("POST", `/super-admin/companies/${autre.id}/invoices`, SA, {
      lines: [{ kind: "personnalise", label: "Formation équipe", quantity: 2, unit_price_standard: 30000, unit_price: 25000 }] });
    verifier("facture personnalisée avec remise calculée", perso.data?.facture?.kind === "personnalisee"
      && Number(perso.data?.facture?.total) === 50000 && Number(perso.data?.facture?.discount_total) === 10000);
    const vide = await appel("POST", `/super-admin/companies/${autre.id}/invoices`, SA, { lines: [] });
    verifier("facture sans ligne : refusée", vide.status === 400 && vide.data?.code === "FACTURE_VIDE");
    const client = await appel("POST", `/super-admin/companies/${ada.id}/invoices`, ada.token, { lines: [{ kind: "installation", unit_price: 0 }] });
    verifier("un client ne crée pas de facture (super-admin uniquement)", client.status === 403);
  }

  section("PAIEMENTS : PARTIEL, COMPLET, DOUBLON, IDEMPOTENCE");
  {
    const p1 = await appel("POST", `/super-admin/companies/${ada.id}/payments`, SA, { invoice_id: factureAda.id, amount: 25000,
      method: "orange_money", transaction_reference: "OM-ADA-001", confirm: true });
    verifier("acompte de 25 000 confirmé", p1.status === 201 && p1.data?.paiement?.status === "confirmed", JSON.stringify(p1.data));
    let f = (await appel("GET", `/super-admin/companies/${ada.id}/invoices/${factureAda.id}`, SA)).data.facture;
    verifier("facture partielle, reste 50 000", f.status === "partielle" && Number(f.solde) === 50000);
    const doublon = await appel("POST", `/super-admin/companies/${ada.id}/payments`, SA, { invoice_id: factureAda.id, amount: 10000,
      method: "orange_money", transaction_reference: "om-ada-001", confirm: true });
    verifier("référence de transaction dupliquée (casse ignorée) : 409", doublon.status === 409 && doublon.data?.code === "REFERENCE_DUPLIQUEE");
    const trop = await appel("POST", `/super-admin/companies/${ada.id}/payments`, SA, { invoice_id: factureAda.id, amount: 60000,
      method: "wave", transaction_reference: "WV-ADA-1", confirm: true });
    verifier("montant supérieur au solde : refusé", trop.status === 400 && trop.data?.code === "MONTANT_EXCEDENTAIRE");
    const corps = { invoice_id: factureAda.id, amount: 50000, method: "wave", transaction_reference: "WV-ADA-2", confirm: true };
    const [x, y] = await Promise.all([
      appel("POST", `/super-admin/companies/${ada.id}/payments`, SA, corps, { "idempotency-key": "cle-ada-solde" }),
      appel("POST", `/super-admin/companies/${ada.id}/payments`, SA, corps, { "idempotency-key": "cle-ada-solde" }),
    ]);
    const statuts = [x.status, y.status].sort();
    verifier("double clic simultané (même clé) : un seul paiement", (statuts.join() === "200,201" || statuts.join() === "201,409")
      && (await q(`SELECT count(*)::int AS n FROM subscription_payments WHERE company_id = $1 AND status = 'confirmed'`, [ada.id]))[0].n === 2,
      statuts.join());
    f = (await appel("GET", `/super-admin/companies/${ada.id}/invoices/${factureAda.id}`, SA)).data.facture;
    verifier("facture soldée : payée", f.status === "payee" && Number(f.solde) === 0 && f.paiements.length === 2);
    verifier("historique des statuts : émise → partielle → payée",
      f.historique.map((h) => h.to_status).join(">") === "emise>partielle>payee", JSON.stringify(f.historique));
    const recuId = f.paiements[0].id;
    const r = await pdf(`/super-admin/companies/${ada.id}/payments/${recuId}/recu`, SA);
    verifier("reçu PDF numéroté", r.status === 200 && /REC-\d{4}-\d{6}/.test(r.texte), r.texte.slice(0, 200));
    const reconf = await appel("POST", `/super-admin/companies/${ada.id}/payments/${recuId}/confirm`, SA);
    verifier("reconfirmer un paiement confirmé : sans effet (idempotent)", reconf.status === 200 && reconf.data?.deja === true);
  }

  section("FACTURE PAYÉE : FIGÉE, CORRIGÉE PAR AVOIR OU REMBOURSEMENT");
  {
    let bloque = false;
    try {
      await q(`UPDATE invoices SET total = 1 WHERE id = $1`, [factureAda.id]);
    } catch (e) {
      bloque = e.code === "23514";
    }
    verifier("modifier le montant d'une facture émise en SQL : refusé", bloque);
    let ligne = false;
    try {
      await q(`INSERT INTO invoice_items (invoice_id, kind, label, unit_price, line_total) VALUES ($1,'personnalise','ajout',1,1)`, [factureAda.id]);
    } catch (e) {
      ligne = e.code === "23514";
    }
    verifier("ajouter une ligne à une facture émise : refusé", ligne);
    let supprime = false;
    try {
      await q(`DELETE FROM subscription_payments WHERE company_id = $1 AND status = 'confirmed'`, [ada.id]);
    } catch (e) {
      supprime = e.code === "23514";
    }
    verifier("supprimer un paiement confirmé : refusé", supprime);
    const annul = await appel("POST", `/super-admin/companies/${ada.id}/invoices/${factureAda.id}/cancel`, SA, { reason: "erreur" });
    verifier("annuler une facture payée : refusé (avoir ou remboursement)", annul.status === 409 && annul.data?.code === "FACTURE_PAYEE");
    const av = await appel("POST", `/super-admin/companies/${ada.id}/invoices/${factureAda.id}/avoir`, SA, { reason: "Geste commercial", amount: 5000 });
    verifier("avoir de 5 000 émis, négatif, lié à la facture", av.status === 201 && Number(av.data?.avoir?.total) === -5000
      && av.data.avoir.credited_invoice_id === factureAda.id && /^AV-/.test(av.data.avoir.number));
    const sansMotif = await appel("POST", `/super-admin/companies/${ada.id}/invoices/${factureAda.id}/avoir`, SA, {});
    verifier("avoir sans motif : refusé", sansMotif.status === 400 && sansMotif.data?.code === "MOTIF_REQUIS");
    const pid = (await q(`SELECT id FROM subscription_payments WHERE company_id = $1 AND amount = 25000`, [ada.id]))[0].id;
    const remb = await appel("POST", `/super-admin/companies/${ada.id}/payments/${pid}/refund`, SA, { reason: "Doublon client" });
    const f = (await appel("GET", `/super-admin/companies/${ada.id}/invoices/${factureAda.id}`, SA)).data.facture;
    const pay = (await q(`SELECT status FROM subscription_payments WHERE id = $1`, [pid]))[0];
    verifier("remboursement tracé : paiement conservé « refunded », facture redevient partielle", remb.status === 200
      && pay.status === "refunded" && f.status === "partielle" && Number(f.solde) === 25000);
    const annulable = await appel("POST", `/super-admin/companies/${pro.id}/invoices`, SA, { lines: [{ kind: "abonnement", months: 1 }] });
    const ann = await appel("POST", `/super-admin/companies/${pro.id}/invoices/${annulable.data.facture.id}/cancel`, SA, { reason: "Erreur de saisie" });
    verifier("facture impayée annulée avec motif", ann.status === 200 && ann.data?.facture?.status === "annulee");
  }

  section("ÉCHÉANCE, GRÂCE, VERROUILLAGE");
  {
    await finAbonnement(starter.id, jour(-2));
    let e = (await appel("GET", "/abonnement/etat", starter.token)).data.etat;
    verifier("fin dépassée de 2 jours : délai de grâce, pas de verrou", e.statut === "grace" && e.verrouille === false, JSON.stringify(e));
    verifier("pendant la grâce : fonctions métier ouvertes", (await appel("GET", "/products", starter.token)).status !== 402);
    await finAbonnement(starter.id, jour(-10));
    e = (await appel("GET", "/abonnement/etat", starter.token)).data.etat;
    verifier("au-delà de la grâce : expiré et verrouillé", e.statut === "expire" && e.verrouille === true);
    verifier("montant dû affiché (factures ouvertes)", e.montant_du === plans.starter.mensuel * 2, JSON.stringify(e));
    const metier = await appel("GET", "/products", starter.token);
    verifier("fonction métier bloquée : 402 ABONNEMENT_VERROUILLE", metier.status === 402 && metier.data?.code === "ABONNEMENT_VERROUILLE");
    for (const ch of ["/abonnement/factures", "/abonnement/moyens-paiement", "/rbac/me", "/support/config"]) {
      const r = await appel("GET", ch, starter.token);
      verifier(`reste ouvert : ${ch}`, r.status === 200, `statut ${r.status}`);
    }
    await q(`UPDATE users SET email_verified = TRUE, phone_verified = TRUE, verification_required = FALSE, account_status = 'active',
             password = '$2b$12$U0ZJN2Q8e5wVO8vbs7r7e.v4L5wHPXN5lU2kz2y7YpYkGfZcqJ3vu' WHERE id = $1`, [starter.admin.id]);
    await q(`UPDATE companies SET email_verified = TRUE, phone_verified = TRUE, account_status = 'active' WHERE id = $1`, [starter.id]);
    const email = (await q(`SELECT email FROM users WHERE id = $1`, [starter.admin.id]))[0].email;
    const hash = await require("bcryptjs").hash("Essai2026x", 10);
    await q(`UPDATE users SET password = $2 WHERE id = $1`, [starter.admin.id, hash]);
    const login = await appel("POST", "/login", null, { email, password: "Essai2026x" });
    verifier("connexion AUTORISÉE malgré l'expiration, session marquée verrouillée", login.status === 200
      && login.data?.user?.subscription_locked === true && login.data?.user?.subscription_status === "expired", JSON.stringify(login.data).slice(0, 300));
    const donnees = (await q(`SELECT count(*)::int AS n FROM invoices WHERE company_id = $1`, [starter.id]))[0].n;
    verifier("aucune donnée supprimée par l'expiration", donnees >= 1);
  }

  section("DÉCLARATION CLIENT, VALIDATION, DÉVERROUILLAGE AUTOMATIQUE");
  {
    const om = await appel("PUT", "/super-admin/billing/payment-methods/orange_money", SA, { enabled: true });
    verifier("activer Orange Money sans numéro : refusé (aucun numéro inventé)", om.status === 400 && om.data?.code === "COMPTE_REQUIS");
    await appel("PUT", "/super-admin/billing/payment-methods/orange_money", SA, { account_number: "+223 70 00 00 00", account_name: "MaliLink Global", enabled: true });
    const moyens = (await appel("GET", "/abonnement/moyens-paiement", starter.token)).data.moyens;
    verifier("le client voit les moyens configurés uniquement", moyens.length === 1 && moyens[0].code === "orange_money");
    const factureOuverte = (await appel("GET", "/abonnement/factures", starter.token)).data.factures.find((x) => x.status === "emise");
    const decl = await appel("POST", "/abonnement/paiements", starter.token, { invoice_id: factureOuverte.id, method: "orange_money",
      transaction_reference: "OM-STARTER-77", amount: 1 }, { "idempotency-key": "starter-decl-1" });
    verifier("déclaration enregistrée en attente, montant FIXÉ PAR LE SERVEUR (pas 1)", decl.status === 201
      && decl.data?.paiement?.status === "pending" && Number(decl.data.paiement.amount) === plans.starter.mensuel * 2, JSON.stringify(decl.data));
    const rejeu = await appel("POST", "/abonnement/paiements", starter.token, { invoice_id: factureOuverte.id, method: "orange_money",
      transaction_reference: "OM-STARTER-77" }, { "idempotency-key": "starter-decl-1" });
    verifier("même clé d'idempotence : même paiement renvoyé", rejeu.status === 200 && rejeu.data?.deja === true && rejeu.data.paiement.id === decl.data.paiement.id);
    const sansRef = await appel("POST", "/abonnement/paiements", starter.token, { invoice_id: factureOuverte.id, method: "wave" });
    verifier("déclaration sans référence : refusée", sansRef.status === 400 && sansRef.data?.code === "REFERENCE_REQUISE");
    verifier("tant que non validé : toujours verrouillé", (await appel("GET", "/products", starter.token)).status === 402);
    const enAttente = (await appel("GET", "/super-admin/billing/pending-payments", SA)).data.paiements;
    verifier("le super-admin voit la déclaration à valider", enAttente.some((p) => p.id === decl.data.paiement.id));
    const conf = await appel("POST", `/super-admin/companies/${starter.id}/payments/${decl.data.paiement.id}/confirm`, SA);
    verifier("validation : paiement confirmé, abonnement prolongé de 2 mois", conf.status === 200 && conf.data?.prolongation?.mois === 2,
      JSON.stringify(conf.data).slice(0, 400));
    verifier("déverrouillage automatique (état recalculé)", conf.data?.etat?.verrouille === false && conf.data.etat.statut === "actif");
    verifier("fonctions métier rouvertes", (await appel("GET", "/products", starter.token)).status !== 402);
    const e = (await appel("GET", "/abonnement/etat", starter.token)).data.etat;
    verifier("prochaine échéance ≈ aujourd'hui + 2 mois", new Date(e.next_due_date) > new Date(Date.now() + 55 * 86400000));
    const reconf = await appel("POST", `/super-admin/companies/${starter.id}/payments/${decl.data.paiement.id}/confirm`, SA);
    const e2 = (await appel("GET", "/abonnement/etat", starter.token)).data.etat;
    verifier("reconfirmer : pas de double prolongation", reconf.data?.deja === true && e2.next_due_date === e.next_due_date);
  }

  section("PAIEMENT SANS FACTURE : FACTURE GÉNÉRÉE À LA VALIDATION");
  {
    await finAbonnement(pro.id, jour(-20));
    const d = await appel("POST", "/abonnement/paiements", pro.token, { method: "wave", transaction_reference: "WV-PRO-9", months: 1 });
    verifier("déclaration d'une mensualité Pro (100 000, calculée)", d.status === 201 && Number(d.data.paiement.amount) === 100000);
    const c = await appel("POST", `/super-admin/companies/${pro.id}/payments/${d.data.paiement.id}/confirm`, SA);
    const f = (await q(`SELECT kind, status, total FROM invoices WHERE id = $1`, [c.data?.facture_id]))[0];
    verifier("facture d'abonnement générée et payée", f?.kind === "abonnement" && f.status === "payee" && Number(f.total) === 100000);
    verifier("Pro déverrouillé", c.data?.etat?.verrouille === false);
    const refus = await appel("POST", "/abonnement/paiements", pro.token, { method: "wave", transaction_reference: "WV-PRO-10", months: 1 });
    const r = await appel("POST", `/super-admin/companies/${pro.id}/payments/${refus.data.paiement.id}/refuse`, SA, { reason: "Transaction introuvable chez Wave" });
    verifier("refus d'une déclaration avec motif", r.status === 200 && r.data?.paiement?.status === "failed");
  }

  section("MÊME RÉFÉRENCE DE TRANSACTION, DEUX APPELS : UN SEUL EFFET");
  {
    const soc = await creerSociete({ nom: "Référence Unique", planCode: "starter" });
    await finAbonnement(soc.id, jour(-20));
    verifier("société échue : verrouillée", (await appel("GET", "/products", soc.token)).status === 402);
    const factures = async () => (await q(`SELECT count(*)::int AS n FROM invoices WHERE company_id = $1`, [soc.id]))[0].n;
    const confirmes = async () => (await q(`SELECT count(*)::int AS n FROM subscription_payments
                                             WHERE company_id = $1 AND status = 'confirmed'`, [soc.id]))[0].n;
    const facturesAvant = await factures();
    const corps = { method: "wave", transaction_reference: "WV-UNIQUE-2026", months: 1 };
    const d1 = await appel("POST", "/abonnement/paiements", soc.token, corps);
    const d2 = await appel("POST", "/abonnement/paiements", soc.token, corps);
    verifier("1er appel : déclaration en attente", d1.status === 201 && d1.data?.paiement?.status === "pending", JSON.stringify(d1.data));
    verifier("2e appel, même référence, sans clé d'idempotence : 409", d2.status === 409 && d2.data?.code === "REFERENCE_DUPLIQUEE", JSON.stringify(d2.data));
    const casse = await appel("POST", "/abonnement/paiements", soc.token, { ...corps, transaction_reference: "wv-unique-2026" });
    verifier("… même en changeant la casse : 409", casse.status === 409);
    const admin = await appel("POST", `/super-admin/companies/${soc.id}/payments`, SA,
      { amount: plans.starter.mensuel, method: "wave", transaction_reference: "WV-UNIQUE-2026", confirm: true });
    verifier("… même saisie par le super-admin : 409", admin.status === 409 && admin.data?.code === "REFERENCE_DUPLIQUEE");
    const c1 = await appel("POST", `/super-admin/companies/${soc.id}/payments/${d1.data.paiement.id}/confirm`, SA);
    const fin1 = (await appel("GET", "/abonnement/etat", soc.token)).data.etat.next_due_date;
    const c2 = await appel("POST", `/super-admin/companies/${soc.id}/payments/${d1.data.paiement.id}/confirm`, SA);
    const fin2 = (await appel("GET", "/abonnement/etat", soc.token)).data.etat.next_due_date;
    verifier("confirmation : prolongé d'un mois et déverrouillé", c1.status === 200 && c1.data?.prolongation?.mois === 1
      && c1.data?.etat?.verrouille === false, JSON.stringify(c1.data).slice(0, 300));
    verifier("2e confirmation : sans effet (aucune double prolongation)", c2.data?.deja === true && fin2 === fin1);
    verifier("un seul paiement confirmé", (await confirmes()) === 1);
    verifier("une seule facture créée (aucun doublon)", (await factures()) === facturesAvant + 1);
    const deverrouillages = (await q(`SELECT count(*)::int AS n FROM company_billing_events
                                       WHERE company_id = $1 AND event_type = 'deverrouillage'`, [soc.id]))[0].n;
    verifier("un seul déverrouillage journalisé", deverrouillages === 1, String(deverrouillages));
  }

  section("SUPER-ADMIN : SUSPENDRE, RÉACTIVER, PROLONGER, DÉVERROUILLER");
  {
    const s = await appel("POST", `/super-admin/companies/${autre.id}/subscription/suspend`, SA, { reason: "Demande du client" });
    verifier("suspension : verrouillé malgré une échéance future", s.data?.etat?.statut === "suspendu" && s.data.etat.verrouille === true);
    verifier("… fonctions métier bloquées", (await appel("GET", "/products", autre.token)).status === 402);
    const sansMotif = await appel("POST", `/super-admin/companies/${autre.id}/subscription/force-unlock`, SA, {});
    verifier("déverrouillage forcé sans motif : refusé", sansMotif.status === 400 && sansMotif.data?.code === "MOTIF_REQUIS");
    const f = await appel("POST", `/super-admin/companies/${autre.id}/subscription/force-unlock`, SA, { reason: "Paiement promis par la direction", until: jour(3) });
    verifier("déverrouillage forcé avec motif et durée", f.data?.etat?.verrouille === false && f.data.etat.deverrouillage_force === true);
    verifier("… fonctions rouvertes", (await appel("GET", "/products", autre.token)).status !== 402);
    await appel("POST", `/super-admin/companies/${autre.id}/subscription/remove-override`, SA, { reason: "Fin de la dérogation" });
    const r = await appel("POST", `/super-admin/companies/${autre.id}/subscription/reactivate`, SA, { reason: "Situation régularisée" });
    verifier("réactivation : actif", r.data?.etat?.statut === "actif" && r.data.etat.verrouille === false);
    const p = await appel("POST", `/super-admin/companies/${autre.id}/subscription/extend`, SA, { months: 1, free: true, reason: "Période offerte" });
    verifier("période gratuite ajoutée", p.status === 200 && new Date(p.data.etat.subscription_end) > new Date(Date.now() + 40 * 86400000));
  }

  section("ISOLATION ET DROITS");
  {
    const fB = (await q(`SELECT id FROM invoices WHERE company_id = $1 LIMIT 1`, [autre.id]))[0].id;
    const pdfB = await pdf(`/abonnement/factures/${fB}/pdf`, ada.token);
    verifier("ADA ne télécharge pas une facture d'une autre société", pdfB.status === 404);
    const payB = await appel("POST", "/abonnement/paiements", ada.token, { invoice_id: fB, method: "wave", transaction_reference: "X-1" });
    verifier("ADA ne paie pas la facture d'une autre société", payB.status === 404);
    verifier("un client n'accède pas à la facturation super-admin", (await appel("GET", `/super-admin/companies/${ada.id}/billing`, ada.token)).status === 403);
    verifier("un magasinier ne voit pas les factures", (await appel("GET", "/abonnement/factures", tMag)).status === 403);
    verifier("… mais voit l'état de l'abonnement", (await appel("GET", "/abonnement/etat", tMag)).status === 200);
    const listeAda = (await appel("GET", "/abonnement/factures", ada.token)).data.factures;
    verifier("ADA ne voit que ses factures", listeAda.length > 0 && listeAda.every((x) => x.number) &&
      (await q(`SELECT count(*)::int AS n FROM invoices WHERE company_id = $1`, [ada.id]))[0].n === listeAda.length);
  }

  section("ANCIENNES ROUTES OUVERTES : FERMÉES");
  {
    const renew = await appel("POST", "/subscriptions/renew", ada.token, { subscription_id: 1, months: 24 });
    verifier("/subscriptions/renew : 410 (prolongation gratuite impossible)", renew.status === 410);
    const manuel = await appel("POST", "/payments/manual", ada.token, { company_id: ada.id, amount: 1, payment_method: "x" });
    verifier("/payments/manual : 410", manuel.status === 410);
    const cp = await appel("POST", "/payments/create", ada.token, { amount: 1 });
    verifier("/payments/create (montant du navigateur) : 410", cp.status === 410);
  }

  section("HISTORIQUE CLIENT");
  {
    const h = (await appel("GET", `/super-admin/companies/${ada.id}/billing`, SA)).data;
    const types = new Set(h.historique.map((x) => x.event_type));
    verifier("ADA : facture, remise, paiements, remboursement, avoir", ["facture", "remise", "paiement", "remboursement", "avoir", "installation"].every((t) => types.has(t)),
      [...types].join(","));
    const hs = (await appel("GET", "/abonnement/historique", starter.token)).data.historique;
    verifier("Starter : déclaration, paiement, prolongation, déverrouillage", ["paiement_declare", "paiement", "prolongation", "deverrouillage"].every((t) => hs.some((x) => x.event_type === t)),
      hs.map((x) => x.event_type).join(","));
    verifier("historique filtré par société", hs.every((x) => !x.details?.numero || true) && h.historique.length > 0
      && (await q(`SELECT count(*)::int AS n FROM company_billing_events WHERE company_id <> $1 AND id = ANY($2)`, [ada.id, h.historique.map((x) => x.id)]))[0].n === 0);
  }

  await terminer();
}

main().catch((e) => {
  console.error(e);
  pool.end();
  process.exit(1);
});
