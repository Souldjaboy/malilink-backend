"use strict";

/**
 * Comptes : validation administrative, emails/OTP, Super Admin › Modifier.
 *
 * Deux exécutions :
 *   SMTP_HOST=127.0.0.1 SMTP_PORT=1025 SMTP_USER=essai SMTP_PASS=essai SMTP_FROM=noreply@malilink.test \
 *     scripts/test-integration.sh tests/comptes.test.js      (Mailpit : envois réels, lecture des boîtes)
 *   scripts/test-integration.sh tests/comptes.test.js        (SMTP absent : messages exacts, codes annulés)
 */

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { q, appel, jeton, verifier, section, creerSociete, terminer, BASE } = require("./_outils");

const SMTP = Boolean(process.env.SMTP_HOST);
const MAILPIT = "http://127.0.0.1:8025/api/v1";
const JOURNAL_SERVEUR = `/tmp/malilink_comptes-serveur.log`;
// Sauvegardes « état avant » du script VPS dans un dossier temporaire, pas dans le dépôt.
const ENV_SCRIPT = { ...process.env, MALILINK_SAUVEGARDES: fs.mkdtempSync(path.join(require("os").tmpdir(), "malilink-sauvegardes-")) };

async function boite(adresse) {
  const r = await fetch(`${MAILPIT}/search?query=${encodeURIComponent(`to:${adresse}`)}`).then((x) => x.json());
  const msgs = r.messages || [];
  if (!msgs.length) return null;
  const m = await fetch(`${MAILPIT}/message/${msgs[0].ID}`).then((x) => x.json());
  return { total: msgs.length, sujet: m.Subject, de: m.From, texte: m.Text, html: m.HTML };
}
const codeDe = (texte) => (String(texte).match(/Code : (\d{6})/) || [])[1];
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

async function connexion(email, password) {
  return appel("POST", "/login", null, { email, password });
}

async function main() {
  if (SMTP) await fetch(`${MAILPIT}/messages`, { method: "DELETE" });
  const superAdmin = (await q(`INSERT INTO users (fullname, email, password, role, company_id, is_super_admin, is_active)
    VALUES ('Super Admin', 'sa-comptes@essai.test', 'x', 'super_admin', NULL, true, true) RETURNING id, role, company_id, is_super_admin`))[0];
  const tSA = jeton(superAdmin);

  section("1. VALIDATION ADMINISTRATIVE D'UN COMPTE ÉCOLE");
  const ecole = await creerSociete({ nom: "MALILINK SCOOL", type: "ecole", modules: { education: true } });
  const motDePasse = "Ecole2026ok";
  const hache = require("bcryptjs").hashSync(motDePasse, 4);
  await q(`UPDATE users SET email='directeur-ecole@essai.test', password=$2, email_verified=false, verification_required=true,
           account_status='pending_verification' WHERE id=$1`, [ecole.admin.id, hache]);
  await q(`UPDATE companies SET email_verified=false, account_status='pending_verification' WHERE id=$1`, [ecole.id]);
  const abonnementAvant = (await q(`SELECT status, end_date::text, plan_id FROM subscriptions WHERE company_id=$1`, [ecole.id]))[0];
  {
    const bloque = await connexion("directeur-ecole@essai.test", motDePasse);
    verifier("avant validation : connexion refusée (vérification requise)", bloque.status === 403 && bloque.data?.code === "verification_required");
    const tAdmin = jeton(ecole.admin);
    const pasSA = await appel("POST", `/super-admin/entreprises/${ecole.id}/administrateurs/${ecole.admin.id}/validation`, tAdmin, { motif: "Je me valide" });
    verifier("un admin d'entreprise ne peut pas valider (403)", pasSA.status === 403);
    const faux = jeton({ id: ecole.admin.id, role: "super_admin", company_id: ecole.id, is_super_admin: true });
    const usurpe = await appel("POST", `/super-admin/entreprises/${ecole.id}/administrateurs/${ecole.admin.id}/validation`, faux, { motif: "Jeton falsifié" });
    verifier("jeton forgé « super_admin » sans droit en base : 403", usurpe.status === 403);
    const autre = await creerSociete({ nom: "Autre école", type: "ecole" });
    const croise = await appel("POST", `/super-admin/entreprises/${ecole.id}/administrateurs/${autre.admin.id}/validation`, tSA, { motif: "Mauvaise cible" });
    verifier("administrateur d'une autre entreprise : refusé", croise.status === 404);
    const court = await appel("POST", `/super-admin/entreprises/${ecole.id}/administrateurs/${ecole.admin.id}/validation`, tSA, { motif: "ok" });
    verifier("motif obligatoire", court.status === 400);

    const sortie = execFileSync("node", ["scripts/comptes/valider-compte-ecole.js", "--identifier", "--societe", String(ecole.id)], { env: ENV_SCRIPT, encoding: "utf8" });
    verifier("script VPS --identifier : société, admin, email masqué, rien modifié", sortie.includes(`Société ${ecole.id}`) && sortie.includes("correspond au nom attendu")
      && sortie.includes("d***@e***.test") && !sortie.includes("directeur-ecole@essai.test"), sortie.slice(0, 400));
    let refusNom = 0;
    try {
      execFileSync("node", ["scripts/comptes/valider-compte-ecole.js", "--valider", "--societe", String(ecole.id), "--utilisateur", String(ecole.admin.id),
        "--nom", "MALILINK SCHOOL", "--par", "auto", "--motif", "Validation demandée", "--oui"], { env: ENV_SCRIPT, encoding: "utf8", stdio: "pipe" });
    } catch (e) { refusNom = e.status; }
    const toujours = (await q(`SELECT admin_validated_at FROM users WHERE id=$1`, [ecole.admin.id]))[0];
    verifier("script VPS : nom approximatif → arrêt sans modification", refusNom === 1 && !toujours.admin_validated_at);

    const sortieV = execFileSync("node", ["scripts/comptes/valider-compte-ecole.js", "--valider", "--societe", String(ecole.id), "--utilisateur", String(ecole.admin.id),
      "--nom", "MALILINK SCOOL", "--par", "sa-comptes@essai.test", "--motif", "Validation administrative demandée par le propriétaire", "--oui"], { env: ENV_SCRIPT, encoding: "utf8" });
    verifier("script VPS --valider : validation journalisée", /VALIDATION_ADMINISTRATIVE_EFFECTUEE · journal n°\d+/.test(sortieV), sortieV.slice(-400));
    const apres = (await q(`SELECT email_verified, admin_validated_at, admin_validated_by, account_status, verification_required FROM users WHERE id=$1`, [ecole.admin.id]))[0];
    verifier("email TOUJOURS non vérifié (validation ≠ preuve de l'email)", apres.email_verified === false && Boolean(apres.admin_validated_at) && apres.admin_validated_by === superAdmin.id
      && apres.account_status === "active" && apres.verification_required === false);
    const journal = (await q(`SELECT state_before, state_after, source FROM account_admin_validations WHERE user_id=$1`, [ecole.admin.id]))[0];
    verifier("journal : états avant/après conservés", journal?.state_before?.utilisateur?.account_status === "pending_verification" && journal.state_after.utilisateur.account_status === "active" && journal.source === "script_vps");
    const audit = await q(`SELECT 1 FROM audit_logs WHERE action='admin_account_validation' AND entity_id=$1`, [String(ecole.admin.id)]);
    verifier("audit_logs : action admin_account_validation", audit.length === 1);
    const abonnementApres = (await q(`SELECT status, end_date::text, plan_id FROM subscriptions WHERE company_id=$1`, [ecole.id]))[0];
    verifier("abonnement inchangé", JSON.stringify(abonnementAvant) === JSON.stringify(abonnementApres));
    const autreIntact = (await q(`SELECT admin_validated_at FROM users WHERE id=$1`, [autre.admin.id]))[0];
    verifier("aucun autre compte modifié", !autreIntact.admin_validated_at);
    const ok = await connexion("directeur-ecole@essai.test", motDePasse);
    verifier("après validation : connexion réelle réussie (jeton émis)", ok.status === 200 && Boolean(ok.data?.token), JSON.stringify(ok.data).slice(0, 160));
  }

  section("2. EMAILS ET OTP");
  const planId = (await q(`SELECT id FROM subscription_plans WHERE commercial_code='business' OR TRUE ORDER BY (commercial_code='business') DESC, id LIMIT 1`))[0].id;
  {
    const email = `nouvelle-ecole-${Date.now()}@essai.test`;
    const r = await appel("POST", "/register-saas", null, {
      company_name: "École Kalanso", business_type: "ecole", responsible_name: "Awa Kanté", email, password: "Kalanso2026", phone: "", plan_id: planId,
    });
    if (r.status !== 201) console.log("   inscription :", r.status, JSON.stringify(r.data).slice(0, 300));
    verifier("inscription : le lien/jeton de validation n'est plus renvoyé au navigateur", r.status === 201 && !JSON.stringify(r.data).includes("verify-") && !("verify_url" in (r.data?.verification || {})),
      String(JSON.stringify(r.data?.verification)).slice(0, 200));
    const userId = r.data?.user?.id;
    if (SMTP) {
      verifier("inscription : envoi « accepté » par le serveur SMTP", r.data.verification.delivery?.statut === "accepte");
      await attendre(500);
      const m = await boite(email);
      verifier("email reçu : expéditeur et sujet MaliLink, aucune mention Triangle", m && /MaliLink Global/.test(m.de?.Name || "") && /MaliLink Global/.test(m.sujet) && !/Triangle/i.test(m.texte + m.html),
        JSON.stringify(m && { de: m.de, sujet: m.sujet }));
      verifier("lien de l'email vers l'URL publique MaliLink", /https?:\/\/[^\s]*\/verify-email\?token=/.test(m.texte) && !/trianglewmspro/.test(m.texte));
      const premierCode = codeDe(m.texte);
      const tropTot = await appel("POST", "/verification/resend", null, { target_type: "email", target_value: email, user_id: userId });
      verifier("renvoi immédiat refusé (60 s)", tropTot.status === 429 && tropTot.data?.retry_after > 0);
      await q(`UPDATE verification_codes SET created_at = created_at - INTERVAL '70 seconds' WHERE user_id=$1`, [userId]);
      const renvoi = await appel("POST", "/verification/resend", null, { target_type: "email", target_value: email, user_id: userId });
      verifier("renvoi : « accepté par le serveur d'envoi », adresse masquée", renvoi.status === 200 && renvoi.data.envoi === "accepte" && renvoi.data.message.includes("n***@e***.test"), JSON.stringify(renvoi.data));
      await attendre(500);
      const m2 = await boite(email);
      const nouveauCode = codeDe(m2.texte);
      verifier("deuxième email reçu, nouveau code", m2.total === 2 && nouveauCode && nouveauCode !== premierCode);
      const ancien = await appel("POST", "/verification/verify", null, { code: premierCode, target_type: "email", target_value: email, user_id: userId });
      verifier("l'ancien code n'est plus valable (usage unique)", ancien.status === 400);
      const ok = await appel("POST", "/verification/verify", null, { code: nouveauCode, target_type: "email", target_value: email.toUpperCase(), user_id: userId });
      verifier("vérification par le code reçu (adresse en majuscules acceptée)", ok.status === 200 && Boolean(ok.data?.token));
      const reutilise = await appel("POST", "/verification/verify", null, { code: nouveauCode, target_type: "email", target_value: email, user_id: userId });
      verifier("code déjà utilisé : refusé", reutilise.status === 400);
      const log = fs.existsSync(JOURNAL_SERVEUR) ? fs.readFileSync(JOURNAL_SERVEUR, "utf8") : "";
      verifier("aucun code OTP dans les journaux du serveur", !log.includes(premierCode) && !log.includes(nouveauCode));
      const deja = await appel("POST", "/verification/resend", null, { target_type: "email", target_value: email });
      verifier("compte vérifié : pas de nouveau code", deja.data?.deja_verifie === true);
    } else {
      verifier("SMTP absent : l'inscription dit « non configuré » (pas « envoyé »)", r.data.verification.delivery?.statut === "non_configure" && r.data.verification.delivery?.sent === false);
      await q(`UPDATE verification_codes SET created_at = created_at - INTERVAL '70 seconds' WHERE user_id=$1`, [userId]);
      const renvoi = await appel("POST", "/verification/resend", null, { target_type: "email", target_value: email, user_id: userId });
      verifier("renvoi sans SMTP : 503 explicite, success false", renvoi.status === 503 && renvoi.data.success === false && renvoi.data.envoi === "non_configure", JSON.stringify(renvoi.data));
      const actifs = await q(`SELECT COUNT(*)::int AS n FROM verification_codes WHERE user_id=$1 AND used_at IS NULL`, [userId]);
      verifier("le code non envoyé est annulé aussitôt", actifs[0].n === 0);
    }
    const inconnu = await appel("POST", "/verification/resend", null, { target_type: "email", target_value: "personne@nulle.part" });
    verifier("contact inconnu : réponse neutre (pas d'énumération)", inconnu.status === 200 && inconnu.data.envoi === "indetermine");
    const usurpation = await appel("POST", "/verification/resend", null, { target_type: "email", target_value: "pirate@essai.test", user_id: userId });
    verifier("identifiant d'un autre compte + autre adresse : aucun envoi", usurpation.data.envoi === "indetermine");
    const vide = await appel("POST", "/verification/resend", null, { target_type: "email", user_id: userId });
    verifier("renvoi sans contact : refusé", vide.status === 400);
    const journal = await q(`SELECT recipient_masked, status FROM email_delivery_log ORDER BY id DESC LIMIT 1`);
    verifier("journal d'envoi : adresse masquée, statut exact", journal[0] && journal[0].recipient_masked.includes("***") && ["accepte", "non_configure"].includes(journal[0].status));
    // Limitation des tentatives de code.
    const essai = (await appel("POST", "/register-saas", null, { company_name: "École Essai", business_type: "ecole", responsible_name: "X Y", email: `essai-${Date.now()}@essai.test`, password: "Essai2026ok", plan_id: planId })).data;
    if (SMTP) {
      for (let i = 0; i < 5; i++) await appel("POST", "/verification/verify", null, { code: "000000", target_type: "email", target_value: essai.user.email, user_id: essai.user.id });
      const bloque = await appel("POST", "/verification/verify", null, { code: "000000", target_type: "email", target_value: essai.user.email, user_id: essai.user.id });
      verifier("5 codes faux : blocage (429)", bloque.status === 429);
    }
  }

  section("3. SUPER ADMIN › ENTREPRISES › MODIFIER");
  {
    const cible = await creerSociete({ nom: "Lycée Askia Modèle", type: "ecole" });
    await q(`UPDATE users SET email='chef-askia@essai.test', email_verified=true, verification_required=false, account_status='active', password=$2 WHERE id=$1`, [cible.admin.id, hache]);
    await q(`UPDATE companies SET email_verified=true, account_status='active' WHERE id=$1`, [cible.id]);
    const fiche = await appel("GET", `/super-admin/entreprises/${cible.id}`, tSA);
    verifier("fiche : entreprise et administrateurs séparés", fiche.status === 200 && fiche.data.entreprise.id === cible.id && fiche.data.administrateurs.some((a) => a.id === cible.admin.id)
      && !JSON.stringify(fiche.data).includes('"password"'));
    const refus = await appel("GET", `/super-admin/entreprises/${cible.id}`, jeton(cible.admin));
    verifier("fiche réservée au Super Admin", refus.status === 403);
    const maj = await appel("PUT", `/super-admin/entreprises/${cible.id}`, tSA, { name: "Lycée Askia Mohamed", phone: "+223 20 21 22 23", city: "Gao", website: "https://askia.ml" });
    const c = (await q(`SELECT name, phone FROM companies WHERE id=$1`, [cible.id]))[0];
    const reg = (await q(`SELECT city, website FROM company_settings WHERE company_id=$1`, [cible.id]))[0];
    verifier("modification enregistrée (entreprise + réglages)", maj.status === 200 && c.name === "Lycée Askia Mohamed" && c.phone === "+223 20 21 22 23" && reg?.city === "Gao" && reg.website === "https://askia.ml");
    const audit = (await q(`SELECT details FROM audit_logs WHERE action='super_admin_company_update' AND company_id IS NOT DISTINCT FROM company_id ORDER BY id DESC LIMIT 1`))[0];
    verifier("audit : valeurs avant/après", audit?.details?.modifications?.name?.avant === "Lycée Askia Modèle" && audit.details.modifications.name.apres === "Lycée Askia Mohamed");
    verifier("validation : téléphone invalide refusé", (await appel("PUT", `/super-admin/entreprises/${cible.id}`, tSA, { phone: "abc" })).status === 400);
    verifier("validation : email interdit hors procédure", (await appel("PUT", `/super-admin/entreprises/${cible.id}`, tSA, { email: "x@y.z" })).data?.code === "EMAIL_VERIFICATION");
    verifier("ID invalide refusé", (await appel("GET", "/super-admin/entreprises/abc", tSA)).status === 400);
    const admin = await appel("PUT", `/super-admin/entreprises/${cible.id}/administrateurs/${cible.admin.id}`, tSA, { fullname: "Moussa Askia", phone: "+223 70 11 22 33" });
    verifier("administrateur : nom et téléphone modifiés", admin.status === 200 && (await q(`SELECT fullname FROM users WHERE id=$1`, [cible.admin.id]))[0].fullname === "Moussa Askia");

    const premiere = await connexion("chef-askia@essai.test", motDePasse);
    if (!premiere.data?.token) console.log("   connexion admin :", premiere.status, JSON.stringify(premiere.data).slice(0, 200));
    const tAdmin = premiere.data?.token;
    verifier("l'administrateur a une session ouverte", Boolean(tAdmin));
    const reset = await appel("POST", `/super-admin/entreprises/${cible.id}/administrateurs/${cible.admin.id}/mot-de-passe`, tSA, { envoyer_email: SMTP });
    const temp = reset.data?.mot_de_passe_temporaire;
    verifier("réinitialisation : mot de passe temporaire fort, montré une fois", reset.status === 200 && /^MaliLink-[0-9a-f]{6}-[0-9A-F]{6}9$/.test(temp || ""), JSON.stringify(reset.data).slice(0, 160));
    await attendre(1100);
    const ancienneSession = await appel("GET", "/rbac/me", tAdmin);
    verifier("sessions ouvertes révoquées (401)", ancienneSession.status === 401 && ancienneSession.data?.code === "session_revoquee", JSON.stringify(ancienneSession.data));
    verifier("ancien mot de passe refusé", (await connexion("chef-askia@essai.test", motDePasse)).status === 401);
    const nouvelle = await connexion("chef-askia@essai.test", temp);
    verifier("connexion avec le temporaire : changement exigé", nouvelle.status === 200 && nouvelle.data?.user?.force_password_change === true);
    const hash = (await q(`SELECT password FROM users WHERE id=$1`, [cible.admin.id]))[0].password;
    verifier("mot de passe stocké haché (bcrypt), jamais en clair", /^\$2[aby]\$/.test(hash) && !hash.includes(temp));
    if (SMTP) {
      await attendre(500);
      const m = await boite("chef-askia@essai.test");
      verifier("email de réinitialisation MaliLink reçu", m && /MaliLink Global/.test(m.sujet));
    }

    const croise = await appel("POST", `/super-admin/entreprises/${cible.id}/administrateurs/${ecole.admin.id}/mot-de-passe`, tSA, {});
    verifier("ID d'administrateur d'une autre entreprise : refusé", croise.status === 404);

    const demande = await appel("POST", `/super-admin/entreprises/${cible.id}/administrateurs/${cible.admin.id}/email`, tSA, { email: "nouveau-chef@essai.test" });
    const emailActuel = (await q(`SELECT email FROM users WHERE id=$1`, [cible.admin.id]))[0].email;
    verifier("changement d'email : rien n'est modifié avant confirmation", emailActuel === "chef-askia@essai.test");
    const pris = await appel("POST", `/super-admin/entreprises/${cible.id}/administrateurs/${cible.admin.id}/email`, tSA, { email: "directeur-ecole@essai.test" });
    verifier("adresse déjà utilisée par un autre compte : refusée", pris.status === 409);
    if (SMTP) {
      verifier("demande envoyée à la NOUVELLE adresse (202)", demande.status === 202 && demande.data.envoi === "accepte");
      await attendre(500);
      const m = await boite("nouveau-chef@essai.test");
      const jetonLien = (String(m?.texte).match(/confirmer-email\?token=([0-9a-f]{48})/) || [])[1];
      const tSession = nouvelle.data.token;
      const conf = await appel("POST", "/comptes/changement-email/confirmer", null, { token: jetonLien });
      const u = (await q(`SELECT email, email_verified FROM users WHERE id=$1`, [cible.admin.id]))[0];
      verifier("confirmation par le lien reçu : email changé et prouvé", conf.status === 200 && u.email === "nouveau-chef@essai.test" && u.email_verified === true);
      await attendre(1100);
      verifier("sessions fermées après changement d'email", (await appel("GET", "/rbac/me", tSession)).status === 401);
      verifier("lien à usage unique", (await appel("POST", "/comptes/changement-email/confirmer", null, { token: jetonLien })).status === 400);
    } else {
      verifier("sans SMTP : demande non envoyée (503), email inchangé", demande.status === 503 && emailActuel === "chef-askia@essai.test");
    }
    const journal = await appel("GET", `/super-admin/entreprises/${cible.id}/journal`, tSA);
    verifier("journal de l'entreprise consultable", journal.status === 200 && journal.data.some((j) => j.action === "super_admin_company_update"));
  }

  await terminer();
}

main().catch(async (e) => { console.error(e); await terminer(); });
