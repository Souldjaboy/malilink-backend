"use strict";

/**
 * Comptes — opérations sensibles partagées par l'écran Super Admin et les
 * scripts d'exploitation : identification d'un établissement, validation
 * administrative journalisée, changement d'email vérifié.
 */

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const courriel = require("./courriel");

const ROLES_ADMIN = ["admin", "administrateur", "administrateur_entreprise", "direction", "directeur", "gerant", "manager", "school_admin"];

function erreur(message, status = 400, code) {
  const e = new Error(message);
  e.status = status;
  if (code) e.code = code;
  return e;
}

/* Champs observés avant/après une validation (jamais le mot de passe). */
const CHAMPS_UTILISATEUR = ["id", "company_id", "role", "is_active", "account_status", "verification_required", "email_verified",
  "phone_verified", "admin_validated_at", "admin_validated_by", "force_password_change"];
const CHAMPS_ENTREPRISE = ["id", "name", "status", "account_status", "email_verified", "phone_verified", "verification_status",
  "subscription_status", "admin_validated_at", "admin_validated_by"];
const extraire = (ligne, champs) => Object.fromEntries(champs.map((c) => [c, ligne?.[c] ?? null]));

/** Établissement et ses administrateurs, emails masqués (identification). */
async function identifier(db, companyId) {
  const entreprise = (await db.query(`SELECT * FROM companies WHERE id=$1`, [companyId])).rows[0];
  if (!entreprise) return null;
  const admins = (await db.query(
    `SELECT * FROM users WHERE company_id=$1 AND (LOWER(role) = ANY($2::text[]) OR is_super_admin IS TRUE) ORDER BY id`,
    [companyId, ROLES_ADMIN])).rows;
  return {
    entreprise: { ...extraire(entreprise, CHAMPS_ENTREPRISE), tenant_id: entreprise.tenant_id || null, email_masque: courriel.masquer(entreprise.email) },
    administrateurs: admins.map((u) => ({ ...extraire(u, CHAMPS_UTILISATEUR), fullname: u.fullname, email_masque: courriel.masquer(u.email) })),
  };
}

/**
 * Validation administrative d'un compte d'établissement par un Super Admin.
 * Une transaction : verrous, états avant, mise à jour, états après,
 * journal dédié + audit. N'écrit NI email_verified NI l'abonnement.
 */
async function validerAdministrativement(pool, { companyId, userId, parId, motif, source = "interface", ip = "" }) {
  const raison = String(motif || "").trim();
  if (raison.length < 5) throw erreur("Indiquez le motif de la validation (5 caractères au moins).");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const par = (await client.query(`SELECT id, email, role, is_super_admin, is_active FROM users WHERE id=$1`, [parId])).rows[0];
    if (!par || par.is_active === false || !(par.is_super_admin === true || String(par.role).toLowerCase() === "super_admin")) {
      throw erreur("Seul un Super Admin actif peut valider un compte.", 403);
    }
    const entreprise = (await client.query(`SELECT * FROM companies WHERE id=$1 FOR UPDATE`, [companyId])).rows[0];
    if (!entreprise) throw erreur("Établissement introuvable.", 404);
    const utilisateur = (await client.query(`SELECT * FROM users WHERE id=$1 FOR UPDATE`, [userId])).rows[0];
    if (!utilisateur || Number(utilisateur.company_id) !== Number(companyId)) throw erreur("Ce compte n'appartient pas à cet établissement.", 404);
    if (!ROLES_ADMIN.includes(String(utilisateur.role || "").toLowerCase())) throw erreur("Ce compte n'est pas un administrateur de l'établissement.", 409);
    if (utilisateur.is_active === false) throw erreur("Ce compte est désactivé : la validation ne le réactive pas.", 409, "COMPTE_DESACTIVE");
    if (String(entreprise.status || "").toLowerCase() === "suspended") throw erreur("Établissement suspendu : la validation ne lève pas une suspension.", 409, "ENTREPRISE_SUSPENDUE");

    const avant = { utilisateur: extraire(utilisateur, CHAMPS_UTILISATEUR), entreprise: extraire(entreprise, CHAMPS_ENTREPRISE) };
    const u = (await client.query(
      `UPDATE users
          SET admin_validated_at = NOW(), admin_validated_by = $2, admin_validation_reason = $3,
              verification_required = false,
              account_status = CASE WHEN COALESCE(account_status,'') IN ('', 'pending_verification') THEN 'active' ELSE account_status END,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 RETURNING *`, [utilisateur.id, par.id, raison])).rows[0];
    const c = (await client.query(
      `UPDATE companies
          SET admin_validated_at = NOW(), admin_validated_by = $2,
              account_status = CASE WHEN COALESCE(account_status,'') IN ('', 'pending_verification') THEN 'active' ELSE account_status END,
              updated_at = CURRENT_TIMESTAMP
        WHERE id = $1 RETURNING *`, [entreprise.id, par.id])).rows[0];
    const apres = { utilisateur: extraire(u, CHAMPS_UTILISATEUR), entreprise: extraire(c, CHAMPS_ENTREPRISE) };
    const journal = (await client.query(
      `INSERT INTO account_admin_validations (company_id, user_id, validated_by, reason, state_before, state_after, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
      [entreprise.id, utilisateur.id, par.id, raison, JSON.stringify(avant), JSON.stringify(apres), source])).rows[0];
    await client.query(
      `INSERT INTO audit_logs (user_id, user_email, user_role, company_id, action, entity_type, entity_id, ip_address, user_agent, details)
       VALUES ($1,$2,$3,$4,'admin_account_validation','user',$5,$6,$7,$8)`,
      [par.id, par.email || "", "super_admin", entreprise.id, utilisateur.id, ip, source,
       JSON.stringify({ journal_id: journal.id, motif: raison, email_verifie_inchange: avant.utilisateur.email_verified === apres.utilisateur.email_verified })]);
    await client.query("COMMIT");
    return { journal_id: journal.id, date: journal.created_at, avant, apres };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

const hacher = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const emailValide = (e) => /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/.test(String(e || "")) && String(e).length <= 160;

/**
 * Demande de changement d'email (utilisateur ou entreprise) : rien n'est
 * modifié tant que la NOUVELLE adresse n'a pas confirmé (lien ou code).
 */
async function demanderChangementEmail(pool, { sujet, sujetId, nouvelEmail, parId, tenant }) {
  const email = String(nouvelEmail || "").trim().toLowerCase();
  if (!emailValide(email)) throw erreur("Adresse email invalide.");
  const table = sujet === "company" ? "companies" : "users";
  const ligne = (await pool.query(`SELECT id, email, ${sujet === "company" ? "name AS nom" : "fullname AS nom, company_id"} FROM ${table} WHERE id=$1`, [sujetId])).rows[0];
  if (!ligne) throw erreur("Compte introuvable.", 404);
  if (String(ligne.email || "").toLowerCase() === email) throw erreur("C'est déjà l'adresse actuelle.");
  if (sujet === "user") {
    const pris = await pool.query(`SELECT 1 FROM users WHERE LOWER(email)=$1 AND id<>$2`, [email, sujetId]);
    if (pris.rows[0]) throw erreur("Cette adresse est déjà utilisée par un autre compte.", 409, "EMAIL_PRIS");
  }
  await pool.query(
    `UPDATE account_email_changes SET cancelled_at=NOW() WHERE subject_type=$1 AND subject_id=$2 AND confirmed_at IS NULL AND cancelled_at IS NULL`,
    [sujet, sujetId]);
  const jeton = crypto.randomBytes(24).toString("hex");
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  const demande = (await pool.query(
    `INSERT INTO account_email_changes (subject_type, subject_id, old_email, new_email, token_hash, code_hash, requested_by, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW() + INTERVAL '24 hours') RETURNING id`,
    [sujet, sujetId, ligne.email || "", email, hacher(jeton), await bcrypt.hash(code, 10), parId || null])).rows[0];
  const id = courriel.identite(tenant);
  const lien = `${id.url}/confirmer-email?token=${jeton}`;
  const { texte, html } = courriel.modeleCode({
    tenant, titre: "Confirmez votre nouvelle adresse email",
    intro: `Cette adresse va devenir celle ${sujet === "company" ? "de l'établissement" : "du compte"} « ${ligne.nom || ""} » sur ${id.nom}. Elle ne sera enregistrée qu'après votre confirmation.`,
    code, minutes: 24 * 60, lien, libelleLien: "Confirmer cette adresse",
  });
  const envoi = await courriel.envoyerCourriel(pool, {
    to: email, sujet: `${id.nom} — confirmez votre nouvelle adresse email`, texte, html, tenant, but: "changement_email",
    userId: sujet === "user" ? sujetId : null, companyId: sujet === "company" ? sujetId : ligne.company_id || null,
  });
  if (!envoi.accepte) {
    await pool.query(`UPDATE account_email_changes SET cancelled_at=NOW() WHERE id=$1`, [demande.id]);
  }
  return { demande_id: demande.id, envoi: envoi.statut, accepte: envoi.accepte, raison: envoi.raison, destinataire: courriel.masquer(email) };
}

/** Confirmation par la nouvelle adresse (lien ou code). */
async function confirmerChangementEmail(pool, { jeton, demandeId, code }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const d = jeton
      ? (await client.query(`SELECT * FROM account_email_changes WHERE token_hash=$1 FOR UPDATE`, [hacher(jeton)])).rows[0]
      : (await client.query(`SELECT * FROM account_email_changes WHERE id=$1 FOR UPDATE`, [Number(demandeId) || 0])).rows[0];
    if (!d || d.confirmed_at || d.cancelled_at || new Date(d.expires_at) < new Date()) throw erreur("Lien ou code expiré, déjà utilisé ou annulé.", 400, "DEMANDE_INVALIDE");
    if (!jeton) {
      if (d.attempts >= 5) throw erreur("Trop de tentatives : demandez un nouveau changement.", 429);
      if (!(await bcrypt.compare(String(code || ""), d.code_hash))) {
        await client.query(`UPDATE account_email_changes SET attempts=attempts+1 WHERE id=$1`, [d.id]);
        await client.query("COMMIT");
        throw erreur("Code incorrect.", 400, "CODE_INCORRECT");
      }
    }
    if (d.subject_type === "user") {
      const pris = await client.query(`SELECT 1 FROM users WHERE LOWER(email)=LOWER($1) AND id<>$2`, [d.new_email, d.subject_id]);
      if (pris.rows[0]) throw erreur("Cette adresse est désormais utilisée par un autre compte.", 409, "EMAIL_PRIS");
      // La nouvelle adresse vient d'être prouvée ; les sessions ouvertes sont fermées.
      await client.query(
        `UPDATE users SET email=$2, email_verified=true, tokens_valid_after=NOW(), updated_at=CURRENT_TIMESTAMP WHERE id=$1`,
        [d.subject_id, d.new_email]);
    } else {
      await client.query(`UPDATE companies SET email=$2, email_verified=true, updated_at=CURRENT_TIMESTAMP WHERE id=$1`, [d.subject_id, d.new_email]);
    }
    await client.query(`UPDATE account_email_changes SET confirmed_at=NOW() WHERE id=$1`, [d.id]);
    await client.query(
      `INSERT INTO audit_logs (user_id, user_email, user_role, company_id, action, entity_type, entity_id, ip_address, user_agent, details)
       VALUES ($1,'','confirmation_email',NULL,'email_change_confirmed',$2,$3,'','',$4)`,
      [d.subject_type === "user" ? d.subject_id : null, d.subject_type, d.subject_id,
       JSON.stringify({ demande_id: d.id, ancienne: courriel.masquer(d.old_email), nouvelle: courriel.masquer(d.new_email) })]);
    await client.query("COMMIT");
    return { sujet: d.subject_type, sujet_id: d.subject_id, nouvelle: courriel.masquer(d.new_email) };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { ROLES_ADMIN, identifier, validerAdministrativement, demanderChangementEmail, confirmerChangementEmail, emailValide, erreur };
