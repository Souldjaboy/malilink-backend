"use strict";

/**
 * ABONNEMENTS, PAIEMENTS ET FACTURATION DE LA PLATEFORME MALILINK.
 *
 * Règles de sécurité (non négociables) :
 *   • jamais de montant ni de statut repris du navigateur : la grille vient
 *     de l'offre, le solde des factures, le statut des règles ci-dessous ;
 *   • une référence de transaction ne sert qu'une fois (index unique), une
 *     clé d'idempotence aussi : un double clic ou un rejeu ne paie pas deux fois ;
 *   • une facture émise ne change plus de montants (déclencheur SQL) : on
 *     l'annule (sans paiement) ou on émet un avoir ;
 *   • un paiement confirmé ne se supprime jamais : il se rembourse, tracé ;
 *   • tout est journalisé dans l'historique de la société.
 *
 * Verrouillage : au-delà de la fin de période + délai de grâce, les fonctions
 * métier sont bloquées ; connexion, abonnement, paiement, facture, support et
 * déconnexion restent ouverts. Aucune donnée n'est jamais supprimée.
 */

const METHODES = new Set(["orange_money", "wave", "moov_money", "virement", "especes", "carte", "autre"]);
const DUREE_CACHE_MS = 30 * 1000;

class FacturationError extends Error {
  constructor(message, code, httpStatus = 400) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

const arrondi = (n) => Math.round(Number(n || 0) * 100) / 100;
const jourISO = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

function creerFacturation({ pool }) {
  const cache = new Map();

  // ═══════════════════════════════════════════════════════════════ JOURNAL

  async function evenement(client, { companyId, type, montant, factureId, paiementId, details, par }) {
    await (client || pool).query(
      `INSERT INTO company_billing_events (company_id, event_type, amount, invoice_id, payment_id, details, performed_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [companyId, type, montant ?? null, factureId || null, paiementId || null, JSON.stringify(details || {}), par || null]);
  }

  // ════════════════════════════════════════════════════════ ÉTAT / VERROU

  async function abonnementCourant(client, companyId) {
    const { rows } = await (client || pool).query(
      `SELECT s.*, p.name AS plan_name, p.commercial_name, p.commercial_code, p.price_monthly, p.installation_fee AS plan_installation_fee,
              c.name AS company_name, c.trial_end_date, c.subscription_expires_at, c.status AS company_status
         FROM companies c
         LEFT JOIN LATERAL (SELECT * FROM subscriptions WHERE company_id = c.id ORDER BY id DESC LIMIT 1) s ON TRUE
         LEFT JOIN subscription_plans p ON p.id = COALESCE(s.plan_id, c.plan_id)
        WHERE c.id = $1`,
      [companyId]);
    if (!rows[0]) throw new FacturationError("Entreprise introuvable.", "SOCIETE_INTROUVABLE", 404);
    return rows[0];
  }

  /**
   * État calculé, jamais déclaré : actif, essai, grâce, expiré, suspendu,
   * gratuit. `verrouille` décide du blocage des fonctions métier.
   */
  async function etat(companyId, client = null) {
    const s = await abonnementCourant(client, companyId);
    const aujourdHui = new Date(new Date().toISOString().slice(0, 10));
    /* La date la plus tardive des trois sources : personne qui se connecte
       aujourd'hui ne se retrouve verrouillé par un simple changement de règle. */
    const dates = [s.end_date, s.subscription_expires_at, s.trial_end_date].filter(Boolean).map((d) => new Date(d));
    const fin = dates.length ? jourISO(new Date(Math.max(...dates.map((d) => d.getTime())))) : null;
    const grace = Number(s.grace_period_days ?? 5);
    const finGrace = fin ? new Date(new Date(fin).getTime() + grace * 86400000) : null;
    const { rows: solde } = await (client || pool).query(
      `SELECT COALESCE(SUM(total - amount_paid), 0)::numeric AS du, count(*)::int AS n
         FROM invoices WHERE company_id = $1 AND status IN ('emise', 'partielle') AND kind <> 'avoir'`, [companyId]);
    const montantDu = arrondi(solde[0].du);
    const forceActif = s.manual_override === "deverrouillage_force"
      && (!s.manual_override_until || new Date(s.manual_override_until) > new Date());

    let statut;
    if (String(s.status || "") === "free") statut = "gratuit";
    else if (String(s.status || "") === "suspended" || s.suspended_at) statut = "suspendu";
    else if (!fin) statut = String(s.status || "") === "trial" ? "essai" : "actif";
    else if (new Date(fin) >= aujourdHui) statut = String(s.status || "") === "trial" ? "essai" : "actif";
    else if (finGrace && finGrace >= aujourdHui) statut = "grace";
    else statut = "expire";

    const verrouille = !forceActif && (statut === "expire" || statut === "suspendu");
    const mensualite = arrondi(s.monthly_fee ?? s.price_monthly ?? 0);
    const resultat = {
      company_id: Number(companyId),
      company_name: s.company_name,
      statut,
      verrouille,
      deverrouillage_force: forceActif,
      offre: {
        id: s.plan_id || null,
        nom: s.commercial_name || s.plan_name || "",
        code: s.commercial_code || "",
        mensualite,
        installation: arrondi(s.installation_fee ?? s.plan_installation_fee ?? 0),
      },
      subscription_id: s.id || null,
      subscription_start: s.start_date || null,
      subscription_end: fin || null,
      fin_grace: finGrace ? jourISO(finGrace) : null,
      jours_grace: grace,
      next_due_date: s.next_due_date || fin || null,
      last_payment_at: s.last_payment_at || null,
      balance_due: montantDu,
      factures_ouvertes: solde[0].n,
      // Ce qu'il faut régler pour rouvrir : les factures ouvertes, sinon une mensualité.
      montant_du: montantDu > 0 ? montantDu : (statut === "expire" || statut === "grace" ? mensualite : 0),
      suspension: statut === "suspendu" ? { depuis: s.suspended_at, motif: s.suspension_reason || "" } : null,
    };
    // Tout calcul frais rafraîchit le verrou (la page Abonnement, une validation…).
    cache.set(Number(companyId), { etat: resultat, a: Date.now() });
    return resultat;
  }

  async function etatEnCache(companyId) {
    const e = cache.get(companyId);
    if (e && Date.now() - e.a < DUREE_CACHE_MS) return e.etat;
    const valeur = await etat(companyId);
    cache.set(companyId, { etat: valeur, a: Date.now() });
    return valeur;
  }

  const invalider = (companyId) => cache.delete(Number(companyId));

  // ═════════════════════════════════════════════════════════════ FACTURES

  async function prochainNumero(client, prefixe = "MLG") {
    const annee = new Date().getFullYear();
    const { rows } = await client.query(
      `INSERT INTO invoice_sequences (year, last) VALUES ($1, 1)
       ON CONFLICT (year) DO UPDATE SET last = invoice_sequences.last + 1 RETURNING last`, [annee]);
    return `${prefixe}-${annee}-${String(rows[0].last).padStart(5, "0")}`;
  }

  /**
   * Lignes calculées par le SERVEUR. Pour l'installation et l'abonnement, le
   * prix standard vient de l'offre ; seul le prix facturé (≤ standard) peut
   * être fixé, et la remise se calcule toute seule.
   */
  function preparerLignes(entrees, abonnement) {
    const mensuel = arrondi(abonnement.monthly_fee ?? abonnement.price_monthly ?? 0);
    const installation = arrondi(abonnement.installation_fee ?? abonnement.plan_installation_fee ?? 0);
    const nomOffre = abonnement.commercial_name || abonnement.plan_name || "MaliLink";
    const lignes = [];
    for (const [i, e] of (entrees || []).entries()) {
      const type = String(e?.kind || "");
      let libelle;
      let standard;
      let quantite = 1;
      let mois = null;
      if (type === "installation") {
        standard = installation;
        libelle = e.label || `Installation ${nomOffre}`;
      } else if (type === "abonnement") {
        mois = Math.floor(Number(e.months || 1));
        if (!(mois >= 1 && mois <= 36)) throw new FacturationError("Durée d'abonnement invalide (1 à 36 mois).", "LIGNE_INVALIDE");
        quantite = mois;
        standard = mensuel;
        libelle = e.label || `Abonnement ${nomOffre} — ${mois} mois`;
      } else if (type === "personnalise") {
        libelle = String(e.label || "").trim();
        if (!libelle) throw new FacturationError("Une ligne personnalisée exige un libellé.", "LIGNE_INVALIDE");
        quantite = Number(e.quantity || 1);
        if (!(quantite > 0)) throw new FacturationError("Quantité invalide.", "LIGNE_INVALIDE");
        standard = arrondi(e.unit_price_standard ?? e.unit_price);
      } else {
        throw new FacturationError("Type de ligne inconnu.", "LIGNE_INVALIDE");
      }
      const facture = e.unit_price === undefined || e.unit_price === null || e.unit_price === "" ? standard : arrondi(e.unit_price);
      if (!(facture >= 0)) throw new FacturationError("Prix facturé invalide.", "LIGNE_INVALIDE");
      if (!(standard >= 0)) throw new FacturationError("Prix standard invalide.", "LIGNE_INVALIDE");
      if (facture > standard) {
        throw new FacturationError("Le prix facturé ne peut pas dépasser le prix standard (utilisez une ligne personnalisée).", "LIGNE_INVALIDE");
      }
      const remise = arrondi((standard - facture) * quantite);
      lignes.push({
        kind: type, label: String(libelle).slice(0, 200), description: String(e.description || "").slice(0, 500),
        quantity: quantite, unit_price_standard: standard, unit_price: facture, discount_amount: remise,
        discount_label: remise > 0 ? String(e.discount_label || "Réduction exceptionnelle").slice(0, 120) : "",
        line_total: arrondi(facture * quantite), period_months: mois, sort_order: i,
      });
    }
    if (!lignes.length) throw new FacturationError("Une facture doit contenir au moins une ligne.", "FACTURE_VIDE");
    return lignes;
  }

  function natureFacture(lignes) {
    const types = new Set(lignes.map((l) => l.kind));
    if (types.has("personnalise")) return "personnalisee";
    if (types.has("installation") && types.has("abonnement")) return "mixte";
    return types.has("installation") ? "installation" : "abonnement";
  }

  async function creerFacture({ companyId, lignes: entrees, echeance, reference, notes, par, client: externe }) {
    const client = externe || await pool.connect();
    try {
      if (!externe) await client.query("BEGIN");
      const ab = await abonnementCourant(client, companyId);
      const lignes = preparerLignes(entrees, ab);
      const total = arrondi(lignes.reduce((t, l) => t + l.line_total, 0));
      const standard = arrondi(lignes.reduce((t, l) => t + l.unit_price_standard * l.quantity, 0));
      const remise = arrondi(lignes.reduce((t, l) => t + l.discount_amount, 0));
      const avecAbonnement = lignes.some((l) => l.kind === "abonnement");
      const mois = lignes.filter((l) => l.kind === "abonnement").reduce((t, l) => t + (l.period_months || 0), 0);
      const { rows: soc } = await client.query(
        `SELECT name, address, phone, email, responsible_name FROM companies WHERE id = $1`, [companyId]);
      const numero = await prochainNumero(client);
      const { rows } = await client.query(
        `INSERT INTO invoices
           (company_id, subscription_id, number, kind, status, due_date, currency, reference, notes,
            subscription_included, monthly_fee_info, plan_snapshot, client_snapshot, created_by)
         VALUES ($1,$2,$3,$4,'brouillon',$5,'FCFA',$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [companyId, ab.id || null, numero, natureFacture(lignes), echeance || null, String(reference || "").slice(0, 120),
          String(notes || "").slice(0, 1000), avecAbonnement, arrondi(ab.monthly_fee ?? ab.price_monthly ?? 0),
          JSON.stringify({ id: ab.plan_id, nom: ab.commercial_name || ab.plan_name, code: ab.commercial_code,
            mensualite: arrondi(ab.monthly_fee ?? ab.price_monthly ?? 0),
            installation: arrondi(ab.installation_fee ?? ab.plan_installation_fee ?? 0) }),
          JSON.stringify(soc[0] || {}), par || null]);
      const facture = rows[0];
      for (const l of lignes) {
        await client.query(
          `INSERT INTO invoice_items (invoice_id, kind, label, description, quantity, unit_price_standard, unit_price,
                                      discount_amount, discount_label, line_total, period_months, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [facture.id, l.kind, l.label, l.description, l.quantity, l.unit_price_standard, l.unit_price,
            l.discount_amount, l.discount_label, l.line_total, l.period_months, l.sort_order]);
      }
      // L'émission fige montants et lignes (déclencheurs SQL).
      const periode = mois > 0 ? { de: jourISO(new Date()), a: null } : { de: null, a: null };
      const emise = (await client.query(
        `UPDATE invoices SET status = 'emise', total = $2, subtotal_standard = $3, discount_total = $4,
                period_from = $5, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [facture.id, total, standard, remise, periode.de])).rows[0];
      await client.query(`INSERT INTO invoice_status_history (invoice_id, from_status, to_status, changed_by)
                          VALUES ($1, NULL, 'emise', $2)`, [facture.id, par || null]);
      await evenement(client, { companyId, type: "facture", montant: total, factureId: facture.id,
        details: { numero, nature: emise.kind }, par });
      if (remise > 0) {
        await evenement(client, { companyId, type: "remise", montant: remise, factureId: facture.id,
          details: { numero, standard, facture: total }, par });
      }
      await client.query(`UPDATE subscriptions SET balance_due = (
          SELECT COALESCE(SUM(total - amount_paid), 0) FROM invoices
           WHERE company_id = $1 AND status IN ('emise','partielle') AND kind <> 'avoir')
        WHERE id = (SELECT id FROM subscriptions WHERE company_id = $1 ORDER BY id DESC LIMIT 1)`, [companyId]);
      if (!externe) await client.query("COMMIT");
      invalider(companyId);
      return emise;
    } catch (e) {
      if (!externe) await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      if (!externe) client.release();
    }
  }

  async function facture(companyId, id, client = null) {
    const { rows } = await (client || pool).query(`SELECT * FROM invoices WHERE id = $1 AND company_id = $2`, [Number(id), companyId]);
    if (!rows[0]) throw new FacturationError("Facture introuvable.", "FACTURE_INTROUVABLE", 404);
    const { rows: lignes } = await (client || pool).query(
      `SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY sort_order, id`, [rows[0].id]);
    const { rows: paiements } = await (client || pool).query(
      `SELECT sp.id, sp.amount, sp.method, sp.transaction_reference, sp.status, sp.paid_at, sp.validated_at, sp.receipt_number, ip.amount AS imputation
         FROM invoice_payments ip JOIN subscription_payments sp ON sp.id = ip.subscription_payment_id
        WHERE ip.invoice_id = $1 ORDER BY sp.id`, [rows[0].id]);
    const { rows: historique } = await (client || pool).query(
      `SELECT from_status, to_status, reason, changed_by, changed_at FROM invoice_status_history WHERE invoice_id = $1 ORDER BY id`, [rows[0].id]);
    return { ...rows[0], solde: arrondi(Number(rows[0].total) - Number(rows[0].amount_paid)), lignes, paiements, historique };
  }

  async function changerStatutFacture(client, f, vers, raison, par) {
    if (f.status === vers) return;
    await client.query(`UPDATE invoices SET status = $2, updated_at = now() WHERE id = $1`, [f.id, vers]);
    await client.query(`INSERT INTO invoice_status_history (invoice_id, from_status, to_status, reason, changed_by)
                        VALUES ($1,$2,$3,$4,$5)`, [f.id, f.status, vers, String(raison || "").slice(0, 300), par || null]);
  }

  async function annulerFacture({ companyId, id, raison, par }) {
    const motif = String(raison || "").trim();
    if (!motif) throw new FacturationError("Le motif d'annulation est obligatoire.", "MOTIF_REQUIS");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(`SELECT * FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE`, [Number(id), companyId]);
      const f = rows[0];
      if (!f) throw new FacturationError("Facture introuvable.", "FACTURE_INTROUVABLE", 404);
      if (f.status === "annulee") throw new FacturationError("Facture déjà annulée.", "FACTURE_ANNULEE", 409);
      if (Number(f.amount_paid) > 0) {
        throw new FacturationError("Facture déjà (partiellement) payée : émettez un avoir ou remboursez le paiement.", "FACTURE_PAYEE", 409);
      }
      await client.query(`UPDATE invoices SET cancelled_at = now(), cancelled_by = $2, cancel_reason = $3 WHERE id = $1`,
        [f.id, par || null, motif.slice(0, 300)]);
      await changerStatutFacture(client, f, "annulee", motif, par);
      await evenement(client, { companyId, type: "annulation", montant: f.total, factureId: f.id, details: { numero: f.number, motif }, par });
      await client.query("COMMIT");
      invalider(companyId);
      return facture(companyId, f.id);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  /** Avoir : la seule façon de corriger une facture payée. Montant négatif, référence à l'original. */
  async function emettreAvoir({ companyId, id, raison, montant, par }) {
    const motif = String(raison || "").trim();
    if (!motif) throw new FacturationError("Le motif de l'avoir est obligatoire.", "MOTIF_REQUIS");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(`SELECT * FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE`, [Number(id), companyId]);
      const f = rows[0];
      if (!f) throw new FacturationError("Facture introuvable.", "FACTURE_INTROUVABLE", 404);
      if (f.kind === "avoir" || !["payee", "partielle"].includes(f.status)) {
        throw new FacturationError("Un avoir ne s'émet que sur une facture payée ou partiellement payée.", "AVOIR_IMPOSSIBLE", 409);
      }
      const valeur = arrondi(montant === undefined ? f.amount_paid : montant);
      if (!(valeur > 0 && valeur <= Number(f.total))) throw new FacturationError("Montant d'avoir invalide.", "MONTANT_INVALIDE");
      const numero = await prochainNumero(client, "AV");
      const { rows: av } = await client.query(
        `INSERT INTO invoices (company_id, subscription_id, number, kind, status, currency, notes, credited_invoice_id,
                               plan_snapshot, client_snapshot, created_by)
         VALUES ($1,$2,$3,'avoir','brouillon','FCFA',$4,$5,$6,$7,$8) RETURNING *`,
        [companyId, f.subscription_id, numero, motif.slice(0, 1000), f.id, f.plan_snapshot, f.client_snapshot, par || null]);
      await client.query(
        `INSERT INTO invoice_items (invoice_id, kind, label, quantity, unit_price_standard, unit_price, line_total)
         VALUES ($1,'avoir',$2,1,$3,$3,$3)`, [av[0].id, `Avoir sur la facture ${f.number}`, -valeur]);
      await client.query(`UPDATE invoices SET status = 'emise', total = $2, subtotal_standard = $2 WHERE id = $1`, [av[0].id, -valeur]);
      await client.query(`INSERT INTO invoice_status_history (invoice_id, from_status, to_status, reason, changed_by)
                          VALUES ($1, NULL, 'emise', $2, $3)`, [av[0].id, motif, par || null]);
      await client.query(`INSERT INTO invoice_status_history (invoice_id, from_status, to_status, reason, changed_by)
                          VALUES ($1, $2, $2, $3, $4)`, [f.id, f.status, `Avoir ${numero} émis : ${motif}`, par || null]);
      await evenement(client, { companyId, type: "avoir", montant: -valeur, factureId: av[0].id,
        details: { numero, facture: f.number, motif }, par });
      await client.query("COMMIT");
      return facture(companyId, av[0].id);
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  // ═════════════════════════════════════════════════════════════ PAIEMENTS

  /**
   * Enregistre un paiement EN ATTENTE. Le montant d'une déclaration client
   * est fixé par le serveur (solde de la facture ou mensualité), jamais lu
   * dans la requête.
   */
  async function enregistrerPaiement({ companyId, factureId, montant, methode, reference, cleIdempotence, source, mois,
    notes, par, payeLe }) {
    const m = String(methode || "").trim();
    if (!METHODES.has(m)) throw new FacturationError("Moyen de paiement inconnu.", "METHODE_INVALIDE");
    const ref = String(reference || "").trim().slice(0, 120);
    if (source !== "manuel" && !ref) {
      throw new FacturationError("Indiquez la référence de la transaction (reçue par SMS).", "REFERENCE_REQUISE");
    }
    if (cleIdempotence) {
      const { rows } = await pool.query(`SELECT * FROM subscription_payments WHERE idempotency_key = $1`, [String(cleIdempotence).slice(0, 120)]);
      if (rows[0]) {
        if (Number(rows[0].company_id) !== Number(companyId)) throw new FacturationError("Clé d'idempotence déjà utilisée.", "IDEMPOTENCE_CONFLIT", 409);
        return { paiement: rows[0], deja: true };
      }
    }
    const ab = await abonnementCourant(null, companyId);
    let valeur;
    let periode = null;
    let f = null;
    if (factureId) {
      const { rows } = await pool.query(`SELECT * FROM invoices WHERE id = $1 AND company_id = $2`, [Number(factureId), companyId]);
      f = rows[0];
      if (!f) throw new FacturationError("Facture introuvable.", "FACTURE_INTROUVABLE", 404);
      if (!["emise", "partielle"].includes(f.status) || f.kind === "avoir") {
        throw new FacturationError("Cette facture n'attend pas de paiement.", "FACTURE_NON_PAYABLE", 409);
      }
      const solde = arrondi(Number(f.total) - Number(f.amount_paid));
      valeur = source === "declaration_client" ? solde : arrondi(montant);
      if (!(valeur > 0)) throw new FacturationError("Montant invalide.", "MONTANT_INVALIDE");
      if (valeur > solde) throw new FacturationError(`Montant supérieur au solde de la facture (${solde} FCFA).`, "MONTANT_EXCEDENTAIRE");
    } else {
      // Sans facture : une période d'abonnement, au prix de l'abonnement.
      periode = Math.floor(Number(mois || 1));
      if (!(periode >= 1 && periode <= 36)) throw new FacturationError("Durée invalide (1 à 36 mois).", "LIGNE_INVALIDE");
      const mensuel = arrondi(ab.monthly_fee ?? ab.price_monthly ?? 0);
      if (!(mensuel > 0)) throw new FacturationError("Aucune mensualité définie pour cet abonnement.", "MENSUALITE_ABSENTE", 409);
      valeur = arrondi(mensuel * periode);
      if (source === "manuel" && montant !== undefined && montant !== null && arrondi(montant) !== valeur) {
        throw new FacturationError(`Montant attendu pour ${periode} mois : ${valeur} FCFA.`, "MONTANT_INCORRECT");
      }
    }
    try {
      const { rows } = await pool.query(
        `INSERT INTO subscription_payments
           (company_id, subscription_id, invoice_id, amount, method, transaction_reference, idempotency_key, status,
            source, period_months, paid_at, notes, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10,$11,$12) RETURNING *`,
        [companyId, ab.id || null, f?.id || null, valeur, m, ref, cleIdempotence ? String(cleIdempotence).slice(0, 120) : null,
          source || "manuel", periode, payeLe || null, String(notes || "").slice(0, 500), par || null]);
      await evenement(null, { companyId, type: source === "declaration_client" ? "paiement_declare" : "paiement",
        montant: valeur, factureId: f?.id, paiementId: rows[0].id,
        details: { methode: m, reference: ref, statut: "pending" }, par });
      return { paiement: rows[0], deja: false };
    } catch (e) {
      if (e.code === "23505") {
        throw new FacturationError("Cette référence de transaction a déjà été enregistrée.", "REFERENCE_DUPLIQUEE", 409);
      }
      throw e;
    }
  }

  /**
   * Confirme un paiement — idempotent. Dans une seule transaction :
   * vérifier le montant, enregistrer, imputer sur la facture (ou créer la
   * facture de la période payée), prolonger l'abonnement si la période est
   * soldée, numéroter le reçu, recalculer le solde, journaliser. Le
   * déverrouillage suit (état recalculé).
   */
  async function confirmerPaiement({ companyId, paiementId, par }) {
    const avant = await etat(companyId);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `SELECT * FROM subscription_payments WHERE id = $1 AND company_id = $2 FOR UPDATE`, [Number(paiementId), companyId]);
      const p = rows[0];
      if (!p) throw new FacturationError("Paiement introuvable.", "PAIEMENT_INTROUVABLE", 404);
      if (p.status === "confirmed") {
        await client.query("COMMIT");
        return { paiement: p, deja: true, etat: avant };
      }
      if (p.status !== "pending") throw new FacturationError(`Paiement ${p.status} : confirmation impossible.`, "PAIEMENT_NON_CONFIRMABLE", 409);

      let fid = p.invoice_id;
      if (!fid) {
        const ab = await abonnementCourant(client, companyId);
        const mensuel = arrondi(ab.monthly_fee ?? ab.price_monthly ?? 0);
        if (arrondi(mensuel * (p.period_months || 1)) !== arrondi(p.amount)) {
          throw new FacturationError("Montant incohérent avec la mensualité : paiement à vérifier.", "MONTANT_INCORRECT", 409);
        }
        const f = await creerFacture({ companyId, client, par,
          lignes: [{ kind: "abonnement", months: p.period_months || 1 }],
          notes: `Facture générée à la confirmation du paiement ${p.method} ${p.transaction_reference}`.trim() });
        fid = f.id;
        await client.query(`UPDATE subscription_payments SET invoice_id = $2 WHERE id = $1`, [p.id, fid]);
      }
      const { rows: fr } = await client.query(`SELECT * FROM invoices WHERE id = $1 AND company_id = $2 FOR UPDATE`, [fid, companyId]);
      const f = fr[0];
      if (!f || !["emise", "partielle"].includes(f.status)) {
        throw new FacturationError("La facture liée n'attend plus de paiement.", "FACTURE_NON_PAYABLE", 409);
      }
      const solde = arrondi(Number(f.total) - Number(f.amount_paid));
      if (arrondi(p.amount) > solde) throw new FacturationError("Montant supérieur au solde de la facture.", "MONTANT_EXCEDENTAIRE", 409);

      const recu = `REC-${new Date().getFullYear()}-${String(p.id).padStart(6, "0")}`;
      const { rows: conf } = await client.query(
        `UPDATE subscription_payments SET status = 'confirmed', validated_at = now(), validated_by = $2,
                paid_at = COALESCE(paid_at, now()), receipt_number = $3, updated_at = now()
          WHERE id = $1 RETURNING *`, [p.id, par || null, recu]);
      await client.query(`INSERT INTO invoice_payments (invoice_id, subscription_payment_id, amount) VALUES ($1,$2,$3)`,
        [f.id, p.id, p.amount]);
      const paye = arrondi(Number(f.amount_paid) + Number(p.amount));
      await client.query(`UPDATE invoices SET amount_paid = $2, updated_at = now() WHERE id = $1`, [f.id, paye]);
      const solde2 = arrondi(Number(f.total) - paye);
      await changerStatutFacture(client, f, solde2 <= 0 ? "payee" : "partielle", `Paiement ${recu}`, par);

      // Période d'abonnement soldée : prolongation à partir de la fin actuelle (ou d'aujourd'hui).
      let prolongation = null;
      if (solde2 <= 0) {
        const { rows: lignes } = await client.query(
          `SELECT COALESCE(SUM(period_months), 0)::int AS mois FROM invoice_items WHERE invoice_id = $1 AND kind = 'abonnement'`, [f.id]);
        const mois = lignes[0].mois;
        if (mois > 0) {
          const { rows: ab } = await client.query(
            `UPDATE subscriptions
                SET status = CASE WHEN status IN ('suspended', 'free') THEN status ELSE 'active' END,
                    start_date = CASE WHEN end_date IS NULL OR end_date < CURRENT_DATE THEN CURRENT_DATE ELSE start_date END,
                    end_date = (GREATEST(COALESCE(end_date, CURRENT_DATE), CURRENT_DATE) + ($2 || ' months')::interval)::date,
                    next_due_date = (GREATEST(COALESCE(end_date, CURRENT_DATE), CURRENT_DATE) + ($2 || ' months')::interval)::date,
                    payment_status = 'paid', updated_at = now()
              WHERE id = (SELECT id FROM subscriptions WHERE company_id = $1 ORDER BY id DESC LIMIT 1)
              RETURNING end_date`, [companyId, String(mois)]);
          prolongation = { mois, nouvelle_fin: ab[0]?.end_date || null };
          await client.query(`UPDATE companies SET subscription_status = 'active', subscription_expires_at = $2 WHERE id = $1`,
            [companyId, ab[0]?.end_date || null]);
        }
        if (f.kind === "installation" || f.kind === "mixte") {
          await evenement(client, { companyId, type: "installation", montant: f.total, factureId: f.id, details: { numero: f.number, statut: "payee" }, par });
        }
      }
      await client.query(
        `UPDATE subscriptions SET last_payment_at = now(), balance_due = (
             SELECT COALESCE(SUM(total - amount_paid), 0) FROM invoices
              WHERE company_id = $1 AND status IN ('emise','partielle') AND kind <> 'avoir')
          WHERE id = (SELECT id FROM subscriptions WHERE company_id = $1 ORDER BY id DESC LIMIT 1)`, [companyId]);
      await evenement(client, { companyId, type: "paiement", montant: p.amount, factureId: f.id, paiementId: p.id,
        details: { recu, methode: p.method, reference: p.transaction_reference, facture: f.number, prolongation }, par });
      if (prolongation) {
        await evenement(client, { companyId, type: "prolongation", factureId: f.id, paiementId: p.id,
          details: { ...prolongation, cause: "paiement" }, par });
      }
      await client.query("COMMIT");
      invalider(companyId);
      const apres = await etat(companyId);
      if (avant.verrouille && !apres.verrouille) {
        await evenement(null, { companyId, type: "deverrouillage", paiementId: p.id, details: { cause: "paiement", recu }, par });
      }
      return { paiement: conf[0], deja: false, facture_id: f.id, prolongation, etat: apres };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async function refuserPaiement({ companyId, paiementId, raison, par }) {
    const motif = String(raison || "").trim();
    if (!motif) throw new FacturationError("Le motif du refus est obligatoire.", "MOTIF_REQUIS");
    const { rows } = await pool.query(
      `UPDATE subscription_payments SET status = 'failed', status_reason = $3, validated_by = $4, updated_at = now()
        WHERE id = $1 AND company_id = $2 AND status = 'pending' RETURNING *`,
      [Number(paiementId), companyId, motif.slice(0, 300), par || null]);
    if (!rows[0]) throw new FacturationError("Paiement introuvable ou déjà traité.", "PAIEMENT_NON_REFUSABLE", 409);
    await evenement(null, { companyId, type: "paiement_refuse", montant: rows[0].amount, paiementId: rows[0].id, details: { motif }, par });
    return rows[0];
  }

  /** Remboursement : le paiement reste, marqué remboursé ; la facture redevient due. */
  async function rembourserPaiement({ companyId, paiementId, raison, par }) {
    const motif = String(raison || "").trim();
    if (!motif) throw new FacturationError("Le motif du remboursement est obligatoire.", "MOTIF_REQUIS");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `SELECT * FROM subscription_payments WHERE id = $1 AND company_id = $2 FOR UPDATE`, [Number(paiementId), companyId]);
      const p = rows[0];
      if (!p || p.status !== "confirmed") throw new FacturationError("Seul un paiement confirmé se rembourse.", "PAIEMENT_NON_REMBOURSABLE", 409);
      await client.query(`UPDATE subscription_payments SET status = 'refunded', status_reason = $2, updated_at = now() WHERE id = $1`,
        [p.id, motif.slice(0, 300)]);
      if (p.invoice_id) {
        const { rows: fr } = await client.query(`SELECT * FROM invoices WHERE id = $1 FOR UPDATE`, [p.invoice_id]);
        const f = fr[0];
        const paye = arrondi(Math.max(0, Number(f.amount_paid) - Number(p.amount)));
        await client.query(`UPDATE invoices SET amount_paid = $2, updated_at = now() WHERE id = $1`, [f.id, paye]);
        if (f.status !== "annulee") await changerStatutFacture(client, f, paye > 0 ? "partielle" : "emise", `Remboursement : ${motif}`, par);
      }
      await evenement(client, { companyId, type: "remboursement", montant: -Number(p.amount), paiementId: p.id,
        factureId: p.invoice_id, details: { motif, note: "La période d'abonnement n'est pas réduite automatiquement." }, par });
      await client.query("COMMIT");
      invalider(companyId);
      return { ok: true };
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  // ═══════════════════════════════════════════════════════ ACTIONS SUPER-ADMIN

  async function majAbonnement(companyId, requete, valeurs) {
    const { rows } = await pool.query(
      `UPDATE subscriptions SET ${requete}, updated_at = now()
        WHERE id = (SELECT id FROM subscriptions WHERE company_id = $1 ORDER BY id DESC LIMIT 1) RETURNING *`,
      [companyId, ...valeurs]);
    if (!rows[0]) throw new FacturationError("Aucun abonnement pour cette entreprise.", "ABONNEMENT_ABSENT", 404);
    invalider(companyId);
    return rows[0];
  }

  const motifRequis = (raison) => {
    const m = String(raison || "").trim();
    if (!m) throw new FacturationError("Le motif est obligatoire.", "MOTIF_REQUIS");
    return m.slice(0, 300);
  };

  async function prolonger({ companyId, mois, jours, gratuit, raison, par }) {
    const motif = motifRequis(raison);
    const m = Math.floor(Number(mois || 0));
    const j = Math.floor(Number(jours || 0));
    if (!(m > 0 || j > 0) || m > 36 || j > 366) throw new FacturationError("Durée invalide.", "DUREE_INVALIDE");
    const s = await majAbonnement(companyId,
      `end_date = (GREATEST(COALESCE(end_date, CURRENT_DATE), CURRENT_DATE) + ($2 || ' months')::interval + ($3 || ' days')::interval)::date,
       next_due_date = (GREATEST(COALESCE(end_date, CURRENT_DATE), CURRENT_DATE) + ($2 || ' months')::interval + ($3 || ' days')::interval)::date,
       status = CASE WHEN status = 'suspended' THEN status ELSE 'active' END`, [String(m), String(j)]);
    await pool.query(`UPDATE companies SET subscription_status = 'active', subscription_expires_at = $2 WHERE id = $1`, [companyId, s.end_date]);
    await evenement(null, { companyId, type: gratuit ? "periode_gratuite" : "prolongation",
      details: { mois: m, jours: j, nouvelle_fin: s.end_date, motif }, par });
    return etat(companyId);
  }

  async function suspendre({ companyId, raison, par }) {
    const motif = motifRequis(raison);
    await majAbonnement(companyId, `status = 'suspended', suspended_at = now(), suspension_reason = $2`, [motif]);
    await evenement(null, { companyId, type: "suspension", details: { motif }, par });
    return etat(companyId);
  }

  async function reactiver({ companyId, raison, par }) {
    const motif = motifRequis(raison);
    await majAbonnement(companyId, `status = 'active', suspended_at = NULL, suspension_reason = ''`, []);
    await evenement(null, { companyId, type: "reactivation", details: { motif }, par });
    return etat(companyId);
  }

  async function deverrouillerForce({ companyId, raison, jusqua, par }) {
    const motif = motifRequis(raison);
    const fin = jusqua ? new Date(jusqua) : null;
    if (fin && !(fin > new Date())) throw new FacturationError("La date de fin doit être future.", "DUREE_INVALIDE");
    await majAbonnement(companyId,
      `manual_override = 'deverrouillage_force', manual_override_reason = $2, manual_override_until = $3, manual_override_by = $4`,
      [motif, fin, par || null]);
    await evenement(null, { companyId, type: "deverrouillage_force", details: { motif, jusqua: fin }, par });
    return etat(companyId);
  }

  async function leverDerogation({ companyId, raison, par }) {
    const motif = motifRequis(raison);
    await majAbonnement(companyId, `manual_override = '', manual_override_reason = '', manual_override_until = NULL`, []);
    await evenement(null, { companyId, type: "verrouillage", details: { motif, cause: "fin_derogation" }, par });
    return etat(companyId);
  }

  // ═══════════════════════════════════════════════════════════════ LECTURE

  async function factures(companyId) {
    const { rows } = await pool.query(
      `SELECT id, number, kind, status, issue_date, due_date, total, amount_paid, (total - amount_paid) AS solde,
              discount_total, subtotal_standard, subscription_included, reference, credited_invoice_id, created_at
         FROM invoices WHERE company_id = $1 ORDER BY issue_date DESC, id DESC LIMIT 500`, [companyId]);
    return rows;
  }

  async function paiements(companyId) {
    const { rows } = await pool.query(
      `SELECT sp.*, i.number AS invoice_number FROM subscription_payments sp
         LEFT JOIN invoices i ON i.id = sp.invoice_id
        WHERE sp.company_id = $1 ORDER BY sp.created_at DESC LIMIT 500`, [companyId]);
    return rows;
  }

  async function historique(companyId) {
    const { rows } = await pool.query(
      `SELECT e.id, e.event_type, e.amount, e.invoice_id, e.payment_id, e.details, e.created_at,
              u.fullname AS performed_by_name
         FROM company_billing_events e LEFT JOIN users u ON u.id = e.performed_by
        WHERE e.company_id = $1 ORDER BY e.created_at DESC, e.id DESC LIMIT 500`, [companyId]);
    return rows;
  }

  async function moyensPaiement({ tous = false } = {}) {
    const { rows } = await pool.query(
      `SELECT code, label, account_number, account_name, instructions, qr_payload, enabled, sort_order
         FROM billing_payment_methods ${tous ? "" : "WHERE enabled AND account_number <> ''"} ORDER BY sort_order, code`);
    return rows;
  }

  async function majMoyenPaiement(code, champs, par) {
    const { rows } = await pool.query(
      `UPDATE billing_payment_methods SET label = COALESCE($2, label), account_number = COALESCE($3, account_number),
              account_name = COALESCE($4, account_name), instructions = COALESCE($5, instructions),
              qr_payload = COALESCE($6, qr_payload), enabled = COALESCE($7, enabled), updated_by = $8, updated_at = now()
        WHERE code = $1 RETURNING *`,
      [code, champs.label ?? null, champs.account_number ?? null, champs.account_name ?? null, champs.instructions ?? null,
        champs.qr_payload ?? null, typeof champs.enabled === "boolean" ? champs.enabled : null, par || null]);
    if (!rows[0]) throw new FacturationError("Moyen de paiement inconnu.", "METHODE_INVALIDE", 404);
    if (rows[0].enabled && !rows[0].account_number) {
      await pool.query(`UPDATE billing_payment_methods SET enabled = FALSE WHERE code = $1`, [code]);
      throw new FacturationError("Renseignez le numéro ou le compte avant d'activer ce moyen.", "COMPTE_REQUIS");
    }
    return rows[0];
  }

  return {
    METHODES, etat, etatEnCache, invalider, creerFacture, facture, factures, annulerFacture, emettreAvoir,
    enregistrerPaiement, confirmerPaiement, refuserPaiement, rembourserPaiement, prolonger, suspendre, reactiver,
    deverrouillerForce, leverDerogation, paiements, historique, moyensPaiement, majMoyenPaiement, evenement,
  };
}

module.exports = { creerFacturation, FacturationError, METHODES };
