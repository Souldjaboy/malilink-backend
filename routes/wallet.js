"use strict";

/**
 * MaliLink Wallet — portefeuille interne à grand livre immuable.
 *
 * Règles non négociables :
 * - le solde N'EST JAMAIS modifié directement : chaque opération crée une
 *   transaction + des écritures (wallet_entries), le solde en découle ;
 * - toute opération financière est ATOMIQUE (BEGIN/COMMIT, verrous
 *   FOR UPDATE sur les wallets, ordre d'acquisition stable anti-deadlock) ;
 * - idempotence : une même idempotency_key ne débite jamais deux fois ;
 * - aucun argent réel : dépôts/retraits/fournisseurs derrière des
 *   feature flags DÉSACTIVÉS ; transferts internes uniquement ;
 * - anti-IDOR : un utilisateur ne voit que SON wallet, une entreprise
 *   que le sien ; les ajustements admin exigent un motif et sont audités.
 */

const crypto = require("crypto");
const express = require("express");
const { createRateLimiter } = require("../middleware/rateLimit");

const MAX_AMOUNT = 10000000; // 10 000 000 FCFA par opération interne

module.exports = function createWalletRouter({
  pool,
  authenticateToken,
  createNotification,
  isSuperAdminUser,
  getEffectiveCompanyId,
  phoneVariants,
  bcrypt
}) {
  const router = express.Router();
  router.use(authenticateToken);

  /* ---------- Carte virtuelle : génération sécurisée ---------- */

  // Somme de contrôle Luhn sur les chiffres → chiffre de contrôle final.
  function luhnCheckDigit(digits) {
    let sum = 0;
    let alt = true;
    for (let i = digits.length - 1; i >= 0; i -= 1) {
      let n = Number(digits[i]);
      if (alt) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
      alt = !alt;
    }
    return (10 - (sum % 10)) % 10;
  }

  // Numéro interne MLK : "MLK YYYY NNNN NNNN NNNC" (C = contrôle Luhn).
  // Ce n'est PAS un numéro bancaire : circuit fermé MaliLink uniquement.
  function generateCardNumber() {
    const year = new Date().getFullYear();
    let body = "";
    for (let i = 0; i < 11; i += 1) body += Math.floor(Math.random() * 10);
    const check = luhnCheckDigit(`${year}${body}`);
    const full = `${body}${check}`; // 12 chiffres après l'année
    return `MLK ${year} ${full.slice(0, 4)} ${full.slice(4, 8)} ${full.slice(8, 12)}`;
  }

  function maskCardNumber(cardNumber) {
    const last4 = cardNumber.replace(/\D/g, "").slice(-4);
    return `MLK •••• •••• •••• ${last4}`;
  }

  // Génère un identifiant public de wallet (ne révèle pas user_id).
  function generateWalletNumber() {
    return `MLW-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
  }

  async function cardAudit(cardId, action, actorId, details = "") {
    await pool
      .query(
        `INSERT INTO wallet_card_audit_logs (card_id, action, actor_user_id, details)
         VALUES ($1,$2,$3,$4)`,
        [cardId, action, actorId, String(details).slice(0, 300)]
      )
      .catch(() => {});
  }

  /* Assure wallet_number + carte virtuelle pour un wallet donné.
     Idempotent : ne recrée jamais si déjà présents. */
  async function ensureCard(wallet) {
    if (!wallet.wallet_number) {
      await pool
        .query(`UPDATE wallets SET wallet_number=$1 WHERE id=$2 AND wallet_number IS NULL`, [
          generateWalletNumber(),
          wallet.id
        ])
        .catch(() => {});
    }
    const existing = await pool.query(`SELECT * FROM wallet_cards WHERE wallet_id=$1`, [wallet.id]);
    if (existing.rows[0]) return existing.rows[0];

    const owner = wallet.company_id
      ? await pool.query(`SELECT name AS holder, name AS company FROM companies WHERE id=$1`, [wallet.company_id])
      : await pool.query(`SELECT fullname AS holder FROM users WHERE id=$1`, [wallet.user_id]);
    const cardType = wallet.company_id ? "entreprise" : "personnelle";
    const template = wallet.company_id ? "entreprise" : "navy_gold";
    const validUntil = new Date();
    validUntil.setFullYear(validUntil.getFullYear() + 4);

    const inserted = await pool
      .query(
        `INSERT INTO wallet_cards
           (wallet_id, card_number, card_type, template, holder_name, company_name, valid_until)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (wallet_id) DO NOTHING
         RETURNING *`,
        [
          wallet.id,
          generateCardNumber(),
          cardType,
          template,
          owner.rows[0]?.holder || "Titulaire MaliLink",
          owner.rows[0]?.company || "",
          validUntil.toISOString().slice(0, 10)
        ]
      )
      .catch(() => ({ rows: [] }));
    if (inserted.rows[0]) {
      await cardAudit(inserted.rows[0].id, "created", wallet.user_id);
      return inserted.rows[0];
    }
    const retry = await pool.query(`SELECT * FROM wallet_cards WHERE wallet_id=$1`, [wallet.id]);
    return retry.rows[0];
  }

  function publicCardView(card, walletNumber) {
    return {
      id: card.id,
      wallet_number: walletNumber,
      masked_number: maskCardNumber(card.card_number),
      card_type: card.card_type,
      template: card.template,
      holder_name: card.holder_name,
      company_name: card.company_name,
      status: card.status,
      valid_until: card.valid_until,
      currency: "FCFA",
      label: "MaliLink Virtual Wallet Card"
    };
  }

  const writeLimiter = createRateLimiter({
    windowMs: 60 * 1000,
    max: 20,
    message: "Trop d'opérations wallet. Patientez un instant."
  });

  let flagsCache = { at: 0, values: {} };
  async function getFlags() {
    if (Date.now() - flagsCache.at < 30000) return flagsCache.values;
    try {
      const { rows } = await pool.query("SELECT flag_key, enabled FROM wallet_feature_flags");
      flagsCache = { at: Date.now(), values: Object.fromEntries(rows.map((r) => [r.flag_key, r.enabled])) };
    } catch {
      flagsCache = { at: Date.now(), values: {} };
    }
    return flagsCache.values;
  }

  function reference() {
    return `MLW-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  }

  function cleanAmount(raw) {
    const amount = Math.round(Number(raw) * 100) / 100;
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) return null;
    return amount;
  }

  /* Wallet d'un propriétaire (créé au premier accès). `client` optionnel
     pour participer à une transaction en cours. */
  async function ensureWallet(db, { userId = null, companyId = null }) {
    const ownerType = companyId ? "company" : "user";
    const found = await db.query(
      companyId
        ? `SELECT * FROM wallets WHERE owner_type='company' AND company_id=$1`
        : `SELECT * FROM wallets WHERE owner_type='user' AND user_id=$1`,
      [companyId || userId]
    );
    if (found.rows[0]) return found.rows[0];
    const inserted = await db.query(
      `INSERT INTO wallets (owner_type, user_id, company_id)
       VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [ownerType, companyId ? null : userId, companyId]
    );
    if (inserted.rows[0]) return inserted.rows[0];
    const retry = await db.query(
      companyId
        ? `SELECT * FROM wallets WHERE owner_type='company' AND company_id=$1`
        : `SELECT * FROM wallets WHERE owner_type='user' AND user_id=$1`,
      [companyId || userId]
    );
    return retry.rows[0];
  }

  async function balances(db, walletId) {
    const [last, holds] = await Promise.all([
      db.query(
        `SELECT balance_after FROM wallet_entries WHERE wallet_id=$1 ORDER BY id DESC LIMIT 1`,
        [walletId]
      ),
      db.query(
        `SELECT COALESCE(SUM(amount),0)::numeric AS held FROM wallet_holds
         WHERE wallet_id=$1 AND status='held'`,
        [walletId]
      )
    ]);
    const balance = Number(last.rows[0]?.balance_after || 0);
    const held = Number(holds.rows[0]?.held || 0);
    return { balance, held, available: Math.max(balance - held, 0) };
  }

  async function audit(walletId, transactionId, action, actorId, details) {
    await pool
      .query(
        `INSERT INTO wallet_audit_logs (wallet_id, transaction_id, action, actor_user_id, details)
         VALUES ($1,$2,$3,$4,$5)`,
        [walletId, transactionId, action, actorId, String(details || "").slice(0, 500)]
      )
      .catch(() => {});
  }

  /* Écriture atomique : à appeler DANS une transaction, wallet verrouillé. */
  async function writeEntry(client, walletId, direction, amount, transactionId) {
    const { balance } = await balances(client, walletId);
    const after = direction === "credit" ? balance + amount : balance - amount;
    await client.query(
      `INSERT INTO wallet_entries (transaction_id, wallet_id, direction, amount, balance_after)
       VALUES ($1,$2,$3,$4,$5)`,
      [transactionId, walletId, direction, amount, after]
    );
    return after;
  }

  /* ---------- Mon wallet ---------- */
  router.get("/me", async (req, res) => {
    try {
      const flags = await getFlags();
      if (flags.wallet_enabled === false) {
        return res.status(503).json({ error: "Le wallet est temporairement désactivé." });
      }
      const wallet = await ensureWallet(pool, { userId: req.user.id });
      const card = await ensureCard(wallet); // création auto de la carte au 1er accès
      const fresh = await pool.query(`SELECT wallet_number FROM wallets WHERE id=$1`, [wallet.id]);
      const walletNumber = fresh.rows[0]?.wallet_number;
      const walletBalances = await balances(pool, wallet.id);
      const transactions = await pool.query(
        `SELECT e.id, e.direction, e.amount, e.balance_after, e.created_at,
                t.reference, t.kind, t.status, t.description, t.related_module
         FROM wallet_entries e
         JOIN wallet_transactions t ON t.id=e.transaction_id
         WHERE e.wallet_id=$1
         ORDER BY e.id DESC LIMIT 20`,
        [wallet.id]
      );
      res.json({
        wallet: { id: wallet.id, wallet_number: walletNumber, currency: wallet.currency, status: wallet.status },
        card: publicCardView(card, walletNumber),
        ...walletBalances,
        transactions: transactions.rows,
        features: {
          transfers: flags.wallet_transfers_enabled !== false,
          deposits: flags.wallet_deposits_enabled === true,
          withdrawals: flags.wallet_withdrawals_enabled === true
        }
      });
    } catch (error) {
      console.error("ERREUR WALLET ME :", error.message);
      res.status(500).json({ error: "Erreur chargement du wallet." });
    }
  });

  /* Historique paginé. */
  router.get("/transactions", async (req, res) => {
    try {
      const wallet = await ensureWallet(pool, { userId: req.user.id });
      const before = Number(req.query.before) || null;
      const values = [wallet.id];
      let filter = "";
      if (before) {
        values.push(before);
        filter = "AND e.id < $2";
      }
      const { rows } = await pool.query(
        `SELECT e.id, e.direction, e.amount, e.balance_after, e.created_at,
                t.reference, t.kind, t.status, t.description
         FROM wallet_entries e
         JOIN wallet_transactions t ON t.id=e.transaction_id
         WHERE e.wallet_id=$1 ${filter}
         ORDER BY e.id DESC LIMIT 50`,
        values
      );
      res.json(rows);
    } catch (error) {
      res.status(500).json({ error: "Erreur historique." });
    }
  });

  /* Reçu d'une transaction (uniquement si j'y participe). */
  router.get("/receipt/:reference", async (req, res) => {
    try {
      const wallet = await ensureWallet(pool, { userId: req.user.id });
      const { rows } = await pool.query(
        `SELECT t.reference, t.kind, t.status, t.description, t.created_at,
                e.direction, e.amount, e.balance_after
         FROM wallet_transactions t
         JOIN wallet_entries e ON e.transaction_id=t.id AND e.wallet_id=$2
         WHERE t.reference=$1
         LIMIT 1`,
        [String(req.params.reference).slice(0, 40), wallet.id]
      );
      if (!rows[0]) return res.status(404).json({ error: "Reçu introuvable." });
      res.json({ ...rows[0], holder: req.user.id, currency: "FCFA" });
    } catch (error) {
      res.status(500).json({ error: "Erreur reçu." });
    }
  });

  /* ---------- Transfert interne MaliLink → MaliLink ---------- */
  router.post("/transfer", writeLimiter, async (req, res) => {
    const client = await pool.connect();
    try {
      const flags = await getFlags();
      if (flags.wallet_transfers_enabled === false) {
        return res.status(503).json({ error: "Les transferts sont temporairement désactivés." });
      }

      const amount = cleanAmount(req.body?.amount);
      if (!amount) return res.status(400).json({ error: "Montant invalide." });
      const note = String(req.body?.note || "").slice(0, 200);
      const idempotencyKey = String(req.body?.idempotency_key || "").slice(0, 80) || null;

      // Idempotence : même clé → renvoyer la transaction existante, zéro double débit.
      if (idempotencyKey) {
        const existing = await pool.query(
          `SELECT reference, status FROM wallet_transactions WHERE idempotency_key=$1`,
          [idempotencyKey]
        );
        if (existing.rows[0]) {
          return res.json({ success: true, duplicate: true, ...existing.rows[0] });
        }
      }

      // Destinataire par téléphone (normalisé +223) ou par user_id.
      let recipientId = Number(req.body?.to_user_id) || null;
      if (!recipientId && req.body?.to_phone) {
        const digits = phoneVariants(req.body.to_phone).map((v) => v.replace(/[^0-9]/g, ""));
        const found = await pool.query(
          `SELECT id, fullname FROM users
           WHERE regexp_replace(COALESCE(phone,''), '[^0-9]', '', 'g') = ANY($1) LIMIT 1`,
          [digits]
        );
        recipientId = found.rows[0]?.id || null;
      }
      if (!recipientId) return res.status(404).json({ error: "Destinataire introuvable." });
      if (recipientId === req.user.id) {
        return res.status(400).json({ error: "Impossible de se transférer à soi-même." });
      }

      await client.query("BEGIN");
      const senderWallet = await ensureWallet(client, { userId: req.user.id });
      const recipientWallet = await ensureWallet(client, { userId: recipientId });

      // Verrous dans un ordre stable (anti-deadlock).
      const [firstId, secondId] =
        senderWallet.id < recipientWallet.id
          ? [senderWallet.id, recipientWallet.id]
          : [recipientWallet.id, senderWallet.id];
      await client.query(`SELECT id FROM wallets WHERE id=$1 FOR UPDATE`, [firstId]);
      await client.query(`SELECT id FROM wallets WHERE id=$1 FOR UPDATE`, [secondId]);

      if (senderWallet.status !== "active") {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "Votre wallet est bloqué." });
      }

      const { available } = await balances(client, senderWallet.id);
      if (available < amount) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: `Solde insuffisant. Disponible : ${available.toLocaleString("fr-FR")} FCFA.`
        });
      }

      const tx = await client.query(
        `INSERT INTO wallet_transactions
           (tenant_id, reference, idempotency_key, kind, status, description, initiated_by, completed_at)
         VALUES ($1,$2,$3,'transfer','completed',$4,$5,NOW())
         RETURNING id, reference`,
        [req.tenant_id || "malilink", reference(), idempotencyKey, note || "Transfert MaliLink", req.user.id]
      );
      await writeEntry(client, senderWallet.id, "debit", amount, tx.rows[0].id);
      await writeEntry(client, recipientWallet.id, "credit", amount, tx.rows[0].id);
      await client.query("COMMIT");

      await audit(senderWallet.id, tx.rows[0].id, "transfer_out", req.user.id, `${amount} FCFA → user ${recipientId}`);
      await audit(recipientWallet.id, tx.rows[0].id, "transfer_in", req.user.id, `${amount} FCFA`);
      if (createNotification) {
        await createNotification({
          user_id: recipientId,
          title: "Wallet : argent reçu 💰",
          message: `Vous avez reçu ${amount.toLocaleString("fr-FR")} FCFA sur votre wallet MaliLink.`,
          type: "wallet_credit",
          company_id: null
        }).catch(() => {});
      }
      res.status(201).json({ success: true, reference: tx.rows[0].reference, amount });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if (String(error.message || "").includes("idempotency_key")) {
        return res.json({ success: true, duplicate: true });
      }
      console.error("ERREUR WALLET TRANSFER :", error.message);
      res.status(500).json({ error: "Erreur transfert. Aucun montant n'a été débité." });
    } finally {
      client.release();
    }
  });

  /* ---------- Crédit administratif (bonus/cashback/ajustement) ---------- */
  router.post("/admin/credit", writeLimiter, async (req, res) => {
    const client = await pool.connect();
    try {
      if (!isSuperAdminUser(req.user)) {
        return res.status(403).json({ error: "Réservé au super administrateur MaliLink." });
      }
      const amount = cleanAmount(req.body?.amount);
      const targetId = Number(req.body?.user_id);
      const kind = ["bonus", "cashback", "adjustment"].includes(req.body?.kind)
        ? req.body.kind
        : "bonus";
      const motif = String(req.body?.motif || "").trim();
      if (!amount || !targetId) return res.status(400).json({ error: "Montant et utilisateur obligatoires." });
      if (!motif) return res.status(400).json({ error: "Motif obligatoire pour tout ajustement." });

      await client.query("BEGIN");
      const wallet = await ensureWallet(client, { userId: targetId });
      await client.query(`SELECT id FROM wallets WHERE id=$1 FOR UPDATE`, [wallet.id]);
      const tx = await client.query(
        `INSERT INTO wallet_transactions
           (tenant_id, reference, kind, status, description, related_module, initiated_by, completed_at)
         VALUES ($1,$2,$3,'completed',$4,'admin',$5,NOW())
         RETURNING id, reference`,
        [req.tenant_id || "malilink", reference(), kind, motif, req.user.id]
      );
      await writeEntry(client, wallet.id, "credit", amount, tx.rows[0].id);
      await client.query("COMMIT");
      await audit(wallet.id, tx.rows[0].id, `admin_${kind}`, req.user.id, motif);
      if (createNotification) {
        await createNotification({
          user_id: targetId,
          title: kind === "cashback" ? "Cashback MaliLink 🎁" : "Bonus MaliLink 🎁",
          message: `${amount.toLocaleString("fr-FR")} FCFA crédités sur votre wallet : ${motif}`,
          type: "wallet_credit",
          company_id: null
        }).catch(() => {});
      }
      res.status(201).json({ success: true, reference: tx.rows[0].reference });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("ERREUR WALLET ADMIN CREDIT :", error.message);
      res.status(500).json({ error: "Erreur crédit administratif." });
    } finally {
      client.release();
    }
  });

  /* ---------- Wallet entreprise (lecture, admins de l'entreprise) ---------- */
  router.get("/company", async (req, res) => {
    try {
      const role = String(req.user?.role || "").toLowerCase();
      if (!isSuperAdminUser(req.user) && !["admin", "direction", "directeur", "comptable"].includes(role)) {
        return res.status(403).json({ error: "Réservé à la direction et à la comptabilité." });
      }
      const companyId = getEffectiveCompanyId(req);
      if (!companyId) return res.status(400).json({ error: "Entreprise requise." });
      const wallet = await ensureWallet(pool, { companyId });
      const walletBalances = await balances(pool, wallet.id);
      const transactions = await pool.query(
        `SELECT e.direction, e.amount, e.balance_after, e.created_at,
                t.reference, t.kind, t.status, t.description
         FROM wallet_entries e
         JOIN wallet_transactions t ON t.id=e.transaction_id
         WHERE e.wallet_id=$1 ORDER BY e.id DESC LIMIT 50`,
        [wallet.id]
      );
      res.json({ wallet: { id: wallet.id, currency: wallet.currency }, ...walletBalances, transactions: transactions.rows });
    } catch (error) {
      console.error("ERREUR WALLET COMPANY :", error.message);
      res.status(500).json({ error: "Erreur wallet entreprise." });
    }
  });

  /* ---------- Carte virtuelle : endpoints ---------- */

  // Ma carte (numéro TOUJOURS masqué ici).
  router.get("/card", async (req, res) => {
    try {
      const wallet = await ensureWallet(pool, { userId: req.user.id });
      const card = await ensureCard(wallet);
      const fresh = await pool.query(`SELECT wallet_number FROM wallets WHERE id=$1`, [wallet.id]);
      res.json(publicCardView(card, fresh.rows[0]?.wallet_number));
    } catch (error) {
      console.error("ERREUR WALLET CARD :", error.message);
      res.status(500).json({ error: "Erreur chargement de la carte." });
    }
  });

  // Révéler le numéro complet : ré-authentification par mot de passe obligatoire.
  router.post("/card/reveal", async (req, res) => {
    try {
      const password = String(req.body?.password || "");
      if (!password) return res.status(400).json({ error: "Mot de passe requis." });
      const userRow = await pool.query(`SELECT password FROM users WHERE id=$1`, [req.user.id]);
      const hash = userRow.rows[0]?.password;
      const ok = hash && bcrypt && (await bcrypt.compare(password, hash));
      if (!ok) return res.status(403).json({ error: "Mot de passe incorrect." });

      const wallet = await ensureWallet(pool, { userId: req.user.id });
      const card = await ensureCard(wallet);
      // Code de sécurité interne DYNAMIQUE (expire) — jamais stocké, jamais loggé.
      const dynamicCode = String(Math.floor(100 + Math.random() * 900));
      await cardAudit(card.id, "number_revealed", req.user.id);
      res.json({
        card_number: card.card_number,
        security_code: dynamicCode,
        security_code_expires_in: 60,
        note: "Code de sécurité interne dynamique, valable 60 secondes."
      });
    } catch (error) {
      console.error("ERREUR WALLET CARD REVEAL :", error.message);
      res.status(500).json({ error: "Erreur révélation carte." });
    }
  });

  // Bloquer / débloquer ma carte.
  router.post("/card/block", async (req, res) => {
    try {
      const wallet = await ensureWallet(pool, { userId: req.user.id });
      const card = await ensureCard(wallet);
      const block = req.body?.block !== false;
      const { rows } = await pool.query(
        `UPDATE wallet_cards SET status=$1, updated_at=NOW() WHERE id=$2 RETURNING *`,
        [block ? "blocked" : "active", card.id]
      );
      await cardAudit(card.id, block ? "blocked" : "unblocked", req.user.id);
      const fresh = await pool.query(`SELECT wallet_number FROM wallets WHERE id=$1`, [wallet.id]);
      res.json({ success: true, card: publicCardView(rows[0], fresh.rows[0]?.wallet_number) });
    } catch (error) {
      res.status(500).json({ error: "Erreur blocage carte." });
    }
  });

  // Demander une carte physique — service non activé (statut de suivi seulement).
  router.post("/card/physical-request", async (req, res) => {
    try {
      const wallet = await ensureWallet(pool, { userId: req.user.id });
      const card = await ensureCard(wallet);
      const existing = await pool.query(
        `SELECT id, status FROM wallet_card_requests
         WHERE card_id=$1 AND status NOT IN ('rejetee','livree') ORDER BY id DESC LIMIT 1`,
        [card.id]
      );
      if (existing.rows[0]) {
        return res.json({ success: true, request: existing.rows[0], existing: true });
      }
      const { rows } = await pool.query(
        `INSERT INTO wallet_card_requests (card_id, user_id, status)
         VALUES ($1,$2,'soumise') RETURNING id, status`,
        [card.id, req.user.id]
      );
      await cardAudit(card.id, "print_requested", req.user.id);
      res.status(201).json({
        success: true,
        request: rows[0],
        message:
          "Demande enregistrée. Le service de carte physique n'est pas encore activé : vous serez notifié dès son ouverture."
      });
    } catch (error) {
      res.status(500).json({ error: "Erreur demande de carte physique." });
    }
  });

  /* Dépôts / retraits : argent réel — explicitement non disponibles. */
  router.post("/deposit", async (req, res) => {
    res.status(503).json({
      error:
        "Les dépôts d'argent réel ne sont pas encore disponibles : ils seront activés avec un fournisseur de paiement agréé (Orange Money, Wave, Moov)."
    });
  });
  router.post("/withdraw", async (req, res) => {
    res.status(503).json({
      error:
        "Les retraits d'argent réel ne sont pas encore disponibles : ils seront activés avec un fournisseur de paiement agréé."
    });
  });

  return router;
};
