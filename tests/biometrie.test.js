"use strict";

/**
 * Biométrie + passkeys — intégration complète (vrai serveur, vraie base).
 *
 * Fournisseurs SIMULÉS (mock) : autorisés seulement ici (NODE_ENV=test +
 * BIOMETRIC_ALLOW_MOCK=1). Les passkeys sont signées par un authentificateur
 * logiciel et vérifiées par la vraie bibliothèque WebAuthn.
 *
 * PHASE=avec_cle : parcours complet.  PHASE=sans_cle : refus sans clé.
 */

const crypto = require("crypto");
const { q, appel, jeton, verifier, section, creerSociete, terminer, BASE } = require("./_outils");
const { AuthentificateurLogiciel } = require("./_webauthn");

const PHASE = process.env.PHASE || "avec_cle";
const MODULES = { biometrie: true, pointage: true, pointage_qr: true, badges: true };
const ORIGINE = (process.env.WEBAUTHN_ORIGINS || "http://localhost:3001").split(",")[0];
const RP = process.env.WEBAUTHN_RP_ID || "localhost";

async function personne(societe, role, nom) {
  const u = (await q(
    `INSERT INTO users (fullname, email, password, role, company_id, email_verified, phone_verified)
     VALUES ($1,$2,'x',$3,$4,TRUE,TRUE) RETURNING id, role, company_id`,
    [nom, `${nom.replace(/\W/g, "").toLowerCase()}-${societe.id}@essai.test`, role, societe.id]))[0];
  const badge = crypto.randomBytes(24).toString("hex");
  await q(`INSERT INTO user_badges (tenant_id, company_id, user_id, badge_type, qr_token) VALUES ('malilink',$1,$2,'employe',$3)`,
    [societe.id, u.id, badge]);
  return { ...u, token: jeton(u), badge };
}

const visage = (identite, extra = {}) => ({ mock_identite: identite, variation: 0.4, ...extra });

async function signer(appareil, secret, corps, { horodatage, signatureFausse } = {}) {
  const brut = JSON.stringify(corps);
  const ts = String(horodatage || Date.now());
  const signature = signatureFausse ? "00".repeat(32)
    : crypto.createHmac("sha256", secret).update(`${ts}.`).update(brut).digest("hex");
  const r = await fetch(`${BASE}/biometrics/devices/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-tenant-id": "malilink",
      "x-biometric-device": String(appareil), "x-biometric-timestamp": ts, "x-biometric-signature": signature },
    body: brut,
  });
  return { status: r.status, data: await r.json().catch(() => null) };
}

async function phaseSansCle() {
  const a = await creerSociete({ nom: "Bio sans clé", modules: MODULES });
  section("SANS BIOMETRIC_ENC_KEY : AUCUN ENREGISTREMENT POSSIBLE");
  const cfg = await appel("GET", "/biometrics/config", a.token);
  verifier("la configuration annonce le chiffrement absent", cfg.status === 200 && cfg.data?.chiffrement_configure === false);
  const r = await appel("PUT", "/biometrics/settings", a.token, { face_enabled: true, face_provider: "mock" });
  verifier("activer le visage : 503 CLE_BIOMETRIQUE_ABSENTE", r.status === 503 && r.data?.code === "CLE_BIOMETRIQUE_ABSENTE", JSON.stringify(r.data));
  const d = await appel("POST", "/biometrics/devices", a.token, { name: "Kiosque", device_type: "kiosque", serial: "K-0" });
  verifier("déclarer un appareil (secret à chiffrer) : 503", d.status === 503 && d.data?.code === "CLE_BIOMETRIQUE_ABSENTE");
  await q(`INSERT INTO biometric_settings (company_id, face_enabled, face_provider, require_known_device)
           VALUES ($1, TRUE, 'mock', FALSE)`, [a.id]);
  const u = await personne(a, "magasinier", "Sans Cle");
  await appel("POST", "/biometrics/consents", u.token, { accepte: true, modalities: ["face"], purposes: ["pointage"] });
  const e = await appel("POST", "/biometrics/enroll-face", a.token, { subject: { user_id: u.id }, capture: visage("sanscle") });
  verifier("même forcé en base, l'enrôlement est refusé sans clé", e.status === 503 && e.data?.code === "CLE_BIOMETRIQUE_ABSENTE", JSON.stringify(e.data));
  verifier("aucun profil créé", (await q(`SELECT count(*)::int AS n FROM biometric_profiles`))[0].n === 0);
  await terminer();
}

async function main() {
  if (PHASE === "sans_cle") return phaseSansCle();

  const a = await creerSociete({ nom: "Bio A", modules: MODULES });
  const b = await creerSociete({ nom: "Bio B", modules: MODULES });
  const sansModule = await creerSociete({ nom: "Bio Sans Module", modules: { pointage: true } });
  await q(`UPDATE users SET email_verified = TRUE, phone_verified = TRUE WHERE company_id IN ($1,$2)`, [a.id, b.id]);
  await q(`UPDATE companies SET email_verified = TRUE, phone_verified = TRUE WHERE id IN ($1,$2)`, [a.id, b.id]);
  const awa = await personne(a, "magasinier", "Awa Diarra");
  const moussa = await personne(a, "magasinier", "Moussa Keita");
  const kiosque = await personne(a, "kiosque", "Kiosque Entree");
  const client = await personne(a, "customer", "Client Patient");
  const fanta = await personne(b, "magasinier", "Fanta Traore");

  section("MODULE ET DROITS");
  {
    const m = await appel("GET", "/biometrics/config", sansModule.token);
    verifier("société sans le module Biométrie : 403 MODULE_DISABLED", m.status === 403 && m.data?.code === "MODULE_DISABLED", JSON.stringify(m.data));
    const p = await appel("GET", "/biometrics/profiles", awa.token);
    verifier("magasinier : liste des profils refusée", p.status === 403 && p.data?.code === "PERMISSION_REFUSEE");
    const ev = await appel("GET", "/biometrics/events", awa.token);
    verifier("magasinier : journal refusé", ev.status === 403);
    const cfg = await appel("GET", "/biometrics/config", awa.token);
    verifier("magasinier : configuration lisible, sans les réglages", cfg.status === 200 && cfg.data?.reglages === undefined
      && cfg.data?.droits?.["biometrie.enroler"] === false);
    verifier("l'alternative sans biométrie est annoncée", /badge QR et le pointage manuel/.test(cfg.data?.alternative || ""));
    const s = await appel("PUT", "/biometrics/settings", a.token, { face_enabled: true, face_provider: "mock",
      fingerprint_enabled: true, fingerprint_provider: "mock" });
    verifier("admin : activation visage + empreinte (simulateurs de test)", s.status === 200 && s.data?.reglages?.face_enabled === true, JSON.stringify(s.data));
    const s2 = await appel("PUT", "/biometrics/settings", awa.token, { face_enabled: false });
    verifier("magasinier : réglages refusés", s2.status === 403);
  }

  // Appareil de la société A (poste d'enrôlement / kiosque)
  const dev = await appel("POST", "/biometrics/devices", a.token, { name: "Kiosque entrée", device_type: "kiosque", serial: "K-1" });
  const appareil = { device_id: dev.data?.appareil?.id, device_key: dev.data?.secret };
  section("APPAREILS");
  {
    verifier("appareil déclaré, secret montré une fois", dev.status === 201 && typeof appareil.device_key === "string" && appareil.device_key.length >= 40);
    const liste = await appel("GET", "/biometrics/devices", a.token);
    verifier("la liste ne contient jamais le secret", liste.status === 200 && !JSON.stringify(liste.data).includes(appareil.device_key)
      && !JSON.stringify(liste.data).includes("secret_encrypted"));
    const stocke = (await q(`SELECT secret_encrypted FROM biometric_devices WHERE id = $1`, [appareil.device_id]))[0].secret_encrypted;
    verifier("secret stocké chiffré (bv1.)", stocke.startsWith("bv1.") && !stocke.includes(appareil.device_key));
    const doublon = await appel("POST", "/biometrics/devices", a.token, { name: "X", device_type: "kiosque", serial: "K-1" });
    verifier("numéro de série en double : 409", doublon.status === 409);
    const m = await appel("POST", "/biometrics/devices", awa.token, { name: "X", device_type: "kiosque", serial: "K-9" });
    verifier("magasinier : déclaration d'appareil refusée", m.status === 403);
  }

  section("CONSENTEMENT");
  {
    const sans = await appel("POST", "/biometrics/enroll-face", a.token, { subject: { user_id: awa.id }, capture: visage("awa"), ...appareil });
    verifier("enrôlement sans consentement : 403 CONSENTEMENT_ABSENT", sans.status === 403 && sans.data?.code === "CONSENTEMENT_ABSENT", JSON.stringify(sans.data));
    const pourAutrui = await appel("POST", "/biometrics/consents", a.token, { subject: { user_id: awa.id }, accepte: true,
      method: "ecran", modalities: ["face"], purposes: ["pointage"] });
    verifier("l'admin ne coche pas « j'accepte » à la place de l'employé", pourAutrui.status === 403 && pourAutrui.data?.code === "CONSENTEMENT_PERSONNEL");
    const nonAccepte = await appel("POST", "/biometrics/consents", awa.token, { modalities: ["face"], purposes: ["pointage"] });
    verifier("consentement sans acceptation explicite : refusé", nonAccepte.status === 400 && nonAccepte.data?.code === "CONSENTEMENT_NON_ACCEPTE");
    const c = await appel("POST", "/biometrics/consents", awa.token, { accepte: true, modalities: ["face", "fingerprint"],
      purposes: ["pointage", "action_sensible"] });
    verifier("Awa consent elle-même (écran)", c.status === 201 && c.data?.consentement?.method === "ecran");
    const txt = (await q(`SELECT text_version, text_hash FROM biometric_consents WHERE id = $1`, [c.data.consentement.id]))[0];
    verifier("version et empreinte du texte accepté enregistrées", txt.text_version === "v1" && /^[0-9a-f]{64}$/.test(txt.text_hash));
    const papier = await appel("POST", "/biometrics/consents", a.token, { subject: { user_id: moussa.id }, accepte: true,
      method: "papier", paper_reference: "FORM-2026-014", modalities: ["face", "fingerprint"], purposes: ["pointage"] });
    verifier("consentement papier référencé enregistré par l'admin", papier.status === 201);
    const cli = await appel("POST", "/biometrics/consents", a.token, { subject: { user_id: client.id }, accepte: true,
      method: "papier", paper_reference: "X", modalities: ["face"], purposes: ["pointage"] });
    verifier("compte client / patient : refusé", cli.status === 403 && cli.data?.code === "PAS_PERSONNEL", JSON.stringify(cli.data));
  }

  section("ENRÔLEMENT VISAGE");
  let profilAwa;
  {
    const sansAppareil = await appel("POST", "/biometrics/enroll-face", a.token, { subject: { user_id: awa.id }, capture: visage("awa") });
    verifier("sans appareil déclaré : 403 APPAREIL_INCONNU", sansAppareil.status === 403 && sansAppareil.data?.code === "APPAREIL_INCONNU");
    const mauvaiseCle = await appel("POST", "/biometrics/enroll-face", a.token, { subject: { user_id: awa.id }, capture: visage("awa"),
      device_id: appareil.device_id, device_key: "faux" });
    verifier("clé d'appareil fausse : 403", mauvaiseCle.status === 403 && mauvaiseCle.data?.code === "APPAREIL_INCONNU");
    const soi = await appel("POST", "/biometrics/enroll-face", awa.token, { capture: visage("awa"), ...appareil });
    verifier("auto-enrôlement désactivé par défaut : 403", soi.status === 403 && soi.data?.code === "PERMISSION_REFUSEE");
    const e = await appel("POST", "/biometrics/enroll-face", a.token, { subject: { user_id: awa.id }, capture: visage("awa"), ...appareil });
    profilAwa = e.data?.profil;
    verifier("enrôlement par l'admin : 201", e.status === 201 && profilAwa?.status === "actif", JSON.stringify(e.data));
    verifier("la réponse ne contient aucun gabarit", !JSON.stringify(e.data).includes("bv1.") && profilAwa?.has_server_template === true);
    const g = (await q(`SELECT template_encrypted, template_key_id FROM biometric_profiles WHERE id = $1`, [profilAwa.id]))[0];
    verifier("gabarit stocké chiffré, clé identifiée", g.template_encrypted.startsWith("bv1.") && g.template_key_id === "k1");
    const encore = await appel("POST", "/biometrics/enroll-face", a.token, { subject: { user_id: awa.id }, capture: visage("awa"), ...appareil });
    verifier("deuxième enrôlement : 409 PROFIL_EXISTANT", encore.status === 409 && encore.data?.code === "PROFIL_EXISTANT");
    const rempl = await appel("POST", "/biometrics/enroll-face", a.token, { subject: { user_id: awa.id }, capture: visage("awa"),
      replace: true, ...appareil });
    const ancien = (await q(`SELECT status, template_encrypted, revoke_reason FROM biometric_profiles WHERE id = $1`, [profilAwa.id]))[0];
    verifier("remplacement : nouveau profil, l'ancien révoqué SANS gabarit", rempl.status === 201 && ancien.status === "revoque"
      && ancien.template_encrypted === null && ancien.revoke_reason === "remplace");
    profilAwa = rempl.data.profil;
    const vivant = await appel("POST", "/biometrics/enroll-face", a.token, { subject: { user_id: moussa.id },
      capture: visage("moussa", { vivant: false }), ...appareil });
    verifier("photo (non vivant) : 422 VIVANT_REFUSE", vivant.status === 422 && vivant.data?.code === "VIVANT_REFUSE");
    const qualite = await appel("POST", "/biometrics/enroll-face", a.token, { subject: { user_id: moussa.id },
      capture: visage("moussa", { qualite: 0.2 }), ...appareil });
    verifier("qualité insuffisante : 422", qualite.status === 422 && qualite.data?.code === "QUALITE_INSUFFISANTE");
    const err = await appel("POST", "/biometrics/enroll-face", a.token, { subject: { user_id: moussa.id },
      capture: { mock_erreur: true }, ...appareil });
    verifier("erreur du fournisseur : 502, journalisée", err.status === 502 && err.data?.code === "FOURNISSEUR_ERREUR");
    const m = await appel("POST", "/biometrics/enroll-face", a.token, { subject: { user_id: moussa.id }, capture: visage("moussa"), ...appareil });
    verifier("Moussa enrôlé (consentement papier)", m.status === 201);
  }

  const defi = async (corps, token = a.token) =>
    (await appel("POST", "/biometrics/challenges", token, { biometric_type: "face", purpose: "pointage", ...appareil, ...corps })).data;

  section("VÉRIFICATION 1:1 ET ANTI-REJEU");
  {
    const d = await defi({ subject: { user_id: awa.id } });
    verifier("défi émis (nonce à usage unique)", typeof d?.nonce === "string" && d.challenge_id > 0, JSON.stringify(d));
    const v = await appel("POST", "/biometrics/verify-face", a.token, { subject: { user_id: awa.id }, capture: visage("awa", { variation: 0.8 }),
      challenge: d, purpose: "pointage", ...appareil });
    verifier("bonne personne : vérifiée, score ≥ seuil", v.status === 200 && v.data?.verified === true && v.data.confidence >= v.data.threshold, JSON.stringify(v.data));
    const rejeu = await appel("POST", "/biometrics/verify-face", a.token, { subject: { user_id: awa.id }, capture: visage("awa"),
      challenge: d, purpose: "pointage", ...appareil });
    verifier("défi rejoué : 409 DEFI_REJOUE", rejeu.status === 409 && rejeu.data?.code === "DEFI_REJOUE");
    const d2 = await defi({ subject: { user_id: awa.id } });
    const faux = await appel("POST", "/biometrics/verify-face", a.token, { subject: { user_id: awa.id }, capture: visage("imposteur"),
      challenge: d2, purpose: "pointage", ...appareil });
    verifier("mauvaise identité : refusée (401, non vérifiée)", faux.status === 401 && faux.data?.verified === false, JSON.stringify(faux.data));
    const d3 = await defi({ subject: { user_id: awa.id } });
    await q(`UPDATE biometric_challenges SET expires_at = now() - interval '1 second' WHERE id = $1`, [d3.challenge_id]);
    const exp = await appel("POST", "/biometrics/verify-face", a.token, { subject: { user_id: awa.id }, capture: visage("awa"),
      challenge: d3, purpose: "pointage", ...appareil });
    verifier("défi expiré : 410 DEFI_EXPIRE", exp.status === 410 && exp.data?.code === "DEFI_EXPIRE");
    const sansDefi = await appel("POST", "/biometrics/verify-face", a.token, { subject: { user_id: awa.id }, capture: visage("awa"),
      purpose: "pointage", ...appareil });
    verifier("sans défi : 400 DEFI_REQUIS", sansDefi.status === 400 && sansDefi.data?.code === "DEFI_REQUIS");
    const d4 = await defi({ subject: { user_id: awa.id } });
    const autre = await appel("POST", "/biometrics/verify-face", a.token, { subject: { user_id: moussa.id }, capture: visage("moussa"),
      challenge: d4, purpose: "pointage", ...appareil });
    verifier("défi d'Awa utilisé pour Moussa : refusé", autre.status === 400 && autre.data?.code === "DEFI_INVALIDE");
    const d5 = await defi({ subject: { user_id: awa.id }, purpose: "controle_acces" });
    const fin = await appel("POST", "/biometrics/verify-face", a.token, { subject: { user_id: awa.id }, capture: visage("awa"),
      challenge: d5, purpose: "controle_acces", ...appareil });
    verifier("finalité non consentie (contrôle d'accès) : 403", fin.status === 403 && fin.data?.code === "CONSENTEMENT_ABSENT");
    const mag = await appel("POST", "/biometrics/challenges", awa.token, { biometric_type: "face", purpose: "pointage",
      subject: { user_id: moussa.id }, ...appareil });
    verifier("magasinier : défi pour un collègue refusé", mag.status === 403);
  }

  section("EMPREINTE (SIMULATEUR) : PLUSIEURS DOIGTS");
  {
    const navigateur = await appel("POST", "/biometrics/enroll-fingerprint", awa.token, { finger_index: 1, capture: { mock_doigt: "awa-1" }, ...appareil });
    verifier("pas d'auto-enrôlement d'empreinte : 403", navigateur.status === 403);
    const f1 = await appel("POST", "/biometrics/enroll-fingerprint", a.token, { subject: { user_id: awa.id }, finger_index: 1,
      capture: { mock_doigt: "awa-1" }, ...appareil });
    const f6 = await appel("POST", "/biometrics/enroll-fingerprint", a.token, { subject: { user_id: awa.id }, finger_index: 6,
      capture: { mock_doigt: "awa-6" }, ...appareil });
    verifier("deux doigts enrôlés", f1.status === 201 && f6.status === 201, JSON.stringify([f1.data, f6.data]));
    const doigt = await appel("POST", "/biometrics/enroll-fingerprint", a.token, { subject: { user_id: awa.id }, finger_index: 12,
      capture: { mock_doigt: "x" }, ...appareil });
    verifier("doigt hors 0–9 : 400", doigt.status === 400 && doigt.data?.code === "DOIGT_INVALIDE");
    const d = await defi({ subject: { user_id: awa.id }, biometric_type: "fingerprint" });
    const ok = await appel("POST", "/biometrics/verify-fingerprint", a.token, { subject: { user_id: awa.id },
      capture: { mock_doigt: "awa-6" }, challenge: d, purpose: "pointage", ...appareil });
    verifier("empreinte valide (2e doigt) : vérifiée", ok.status === 200 && ok.data?.verified === true, JSON.stringify(ok.data));
    const d2 = await defi({ subject: { user_id: awa.id }, biometric_type: "fingerprint" });
    const ko = await appel("POST", "/biometrics/verify-fingerprint", a.token, { subject: { user_id: awa.id },
      capture: { mock_doigt: "moussa-1" }, challenge: d2, purpose: "pointage", ...appareil });
    verifier("empreinte invalide : refusée", ko.status === 401 && ko.data?.verified === false);
  }

  section("POINTAGE BIOMÉTRIQUE : BADGE + VISAGE 1:1");
  {
    await q(`INSERT INTO user_permissions (user_id, module_key, can_view, can_create) VALUES ($1, 'biometrie.pointage', TRUE, TRUE)`, [kiosque.id]);
    const sansDroit = await appel("POST", "/biometrics/challenges", moussa.token, { biometric_type: "face", purpose: "pointage",
      badge: awa.badge, ...appareil });
    verifier("un employé ne lance pas le pointage biométrique d'un collègue", sansDroit.status === 403);
    const d = await defi({ badge: `https://malilinkglobal.com/badge/${awa.badge}` }, kiosque.token);
    verifier("défi lié à la personne du badge", d?.subject?.user_id === awa.id, JSON.stringify(d));
    const p = await appel("POST", "/biometrics/attendance", kiosque.token, { badge: awa.badge, action: "checkin",
      biometric_type: "face", capture: visage("awa", { variation: 0.6 }), challenge: d, ...appareil });
    verifier("arrivée pointée par le visage", p.status === 200 && p.data?.success === true, JSON.stringify(p.data));
    const ev = (await q(`SELECT method, biometric_confidence, device_id, created_by FROM attendance_history
                          WHERE user_id = $1 ORDER BY id DESC LIMIT 1`, [awa.id]))[0];
    verifier("événement : VISAGE, score, appareil, opérateur", ev?.method === "VISAGE" && Number(ev.biometric_confidence) > 0.85
      && ev.device_id === appareil.device_id && ev.created_by === kiosque.id, JSON.stringify(ev));
    const d2 = await defi({ badge: moussa.badge }, kiosque.token);
    const imposteur = await appel("POST", "/biometrics/attendance", kiosque.token, { badge: moussa.badge, action: "checkin",
      biometric_type: "face", capture: visage("awa"), challenge: d2, ...appareil });
    verifier("visage d'Awa sur le badge de Moussa : refusé", imposteur.status === 401 && imposteur.data?.code === "NON_CORRESPONDANT");
    verifier("… et aucun pointage pour Moussa", (await q(`SELECT count(*)::int AS n FROM attendance_history WHERE user_id = $1`, [moussa.id]))[0].n === 0);
  }

  section("ISOLATION ENTRE SOCIÉTÉS");
  {
    const e = await appel("POST", "/biometrics/enroll-face", a.token, { subject: { user_id: fanta.id }, capture: visage("fanta"), ...appareil });
    verifier("admin A : enrôler une personne de B → introuvable", e.status === 404 && e.data?.code === "PERSONNE_INTROUVABLE");
    await appel("PUT", "/biometrics/settings", b.token, { face_enabled: true, face_provider: "mock" });
    await appel("POST", "/biometrics/consents", fanta.token, { accepte: true, modalities: ["face"], purposes: ["pointage"] });
    const appareilDeA = await appel("POST", "/biometrics/enroll-face", b.token, { subject: { user_id: fanta.id }, capture: visage("fanta"), ...appareil });
    verifier("admin B : appareil de A refusé", appareilDeA.status === 403 && appareilDeA.data?.code === "APPAREIL_INCONNU");
    const pB = await appel("GET", "/biometrics/profiles", b.token);
    verifier("admin B ne voit aucun profil de A", pB.status === 200 && pB.data.profils.every((x) => x.user_id !== awa.id));
    const st = await appel("GET", `/biometrics/status?user_id=${awa.id}`, b.token);
    verifier("admin B : état d'Awa → introuvable", st.status === 404);
    const badgeB = await appel("POST", "/biometrics/challenges", kiosque.token, { biometric_type: "face", purpose: "pointage",
      badge: fanta.badge, ...appareil });
    verifier("kiosque A : badge de B → inconnu", badgeB.status === 404 && badgeB.data?.code === "BADGE_INCONNU");
  }

  section("COMPTES CLIENTS / PATIENTS : REFUS EN BASE");
  {
    let refuse = false;
    try {
      const consent = (await q(`SELECT id FROM biometric_consents LIMIT 1`))[0];
      await q(`INSERT INTO biometric_profiles (company_id, subject_type, user_id, biometric_type, provider, external_reference, consent_id)
               VALUES ($1, 'user', $2, 'face', 'terminal', 'ref', $3)`, [a.id, client.id, consent.id]);
    } catch (e) {
      refuse = /client ou patient/.test(e.message);
    }
    verifier("insertion SQL directe d'un profil client : refusée par le déclencheur", refuse);
    let autreSociete = false;
    try {
      const consent = (await q(`SELECT id FROM biometric_consents LIMIT 1`))[0];
      await q(`INSERT INTO biometric_profiles (company_id, subject_type, user_id, biometric_type, provider, external_reference, consent_id)
               VALUES ($1, 'user', $2, 'face', 'terminal', 'ref', $3)`, [a.id, fanta.id, consent.id]);
    } catch (e) {
      autreSociete = /n'appartient pas/.test(e.message);
    }
    verifier("profil d'une personne d'une autre société : refusé par le déclencheur", autreSociete);
    let clair = false;
    try {
      const consent = (await q(`SELECT id FROM biometric_consents LIMIT 1`))[0];
      await q(`INSERT INTO biometric_profiles (company_id, subject_type, user_id, biometric_type, provider, template_encrypted, consent_id)
               VALUES ($1, 'user', $2, 'face', 'mock', 'gabarit-en-clair', $3)`, [a.id, moussa.id, consent.id]);
    } catch (e) {
      clair = e.code === "23514";
    }
    verifier("gabarit non chiffré : refusé par une contrainte", clair);
  }

  section("TERMINAL BIOMÉTRIQUE : ÉVÉNEMENTS SIGNÉS");
  {
    await appel("PUT", "/biometrics/settings", b.token, { fingerprint_enabled: true, fingerprint_provider: "terminal" });
    const t = await appel("POST", "/biometrics/devices", b.token, { name: "Terminal empreinte", device_type: "terminal_empreinte",
      serial: "ZK-001", provider: "zkteco" });
    const term = { id: t.data?.appareil?.id, secret: t.data?.secret };
    await appel("POST", "/biometrics/consents", b.token, { subject: { user_id: fanta.id }, accepte: true, method: "papier",
      paper_reference: "FORM-B-1", modalities: ["fingerprint"], purposes: ["pointage"] });
    const e = await appel("POST", "/biometrics/enroll-fingerprint", b.token, { subject: { user_id: fanta.id }, finger_index: 1,
      external_reference: "Z-17", device_id: term.id, device_key: term.secret });
    verifier("enrôlement « terminal » : aucun gabarit côté serveur", e.status === 201 && e.data?.profil?.has_server_template === false, JSON.stringify(e.data));
    const ok = await signer(term.id, term.secret, { events: [{ ref: "e1", type: "fingerprint", reference: "Z-17", resultat: "match",
      score: 0.97, action: "checkin" }] });
    verifier("événement signé valide : pointage écrit", ok.status === 200 && ok.data?.resultats?.[0]?.pointage?.statut === "enregistre", JSON.stringify(ok.data));
    const ev = (await q(`SELECT method, device_id FROM attendance_history WHERE user_id = $1`, [fanta.id]))[0];
    verifier("méthode EMPREINTE, terminal tracé", ev?.method === "EMPREINTE" && ev.device_id === term.id);
    const rejeu = await signer(term.id, term.secret, { events: [{ ref: "e1", type: "fingerprint", reference: "Z-17", resultat: "match", action: "checkin" }] });
    verifier("même événement rejoué : ignoré (doublon)", rejeu.data?.resultats?.[0]?.statut === "doublon");
    const fausse = await signer(term.id, term.secret, { events: [] }, { signatureFausse: true });
    verifier("signature fausse : 401", fausse.status === 401 && fausse.data?.code === "SIGNATURE_INVALIDE");
    const vieux = await signer(term.id, term.secret, { events: [] }, { horodatage: Date.now() - 10 * 60 * 1000 });
    verifier("horodatage de 10 minutes : 401 (rejeu)", vieux.status === 401 && vieux.data?.code === "SIGNATURE_EXPIREE");
    const inconnu = await signer(term.id, term.secret, { events: [{ ref: "e2", type: "fingerprint", reference: "INCONNU", resultat: "match", action: "checkout" }] });
    verifier("personne inconnue du terminal : refusée", inconnu.data?.resultats?.[0]?.code === "PROFIL_INCONNU");
    const nm = await signer(term.id, term.secret, { events: [{ ref: "e3", type: "fingerprint", reference: "Z-17", resultat: "no_match", action: "checkout" }] });
    verifier("non-correspondance : aucun pointage", nm.data?.resultats?.[0]?.code === "NON_CORRESPONDANT"
      && (await q(`SELECT count(*)::int AS n FROM attendance_history WHERE user_id = $1`, [fanta.id]))[0].n === 1);
    const autre = await signer(appareil.device_id, appareil.device_key, { events: [{ ref: "e9", type: "fingerprint", reference: "Z-17", resultat: "match", action: "checkout" }] });
    verifier("kiosque de A avec la référence d'un employé de B : refusé", autre.data?.resultats?.[0]?.code !== undefined
      && autre.data.resultats[0].statut === "refuse");
    await appel("POST", `/biometrics/devices/${term.id}/status`, b.token, { enabled: false });
    const off = await signer(term.id, term.secret, { events: [] });
    verifier("terminal désactivé : 401", off.status === 401 && off.data?.code === "APPAREIL_INCONNU");
  }

  section("PASSKEYS (WEBAUTHN) ET VALIDATION RENFORCÉE");
  const cle = new AuthentificateurLogiciel({ origine: ORIGINE, rpId: RP });
  {
    const o = await appel("POST", "/auth/passkeys/register/options", a.token, {});
    verifier("options d'enregistrement : vérification utilisateur exigée", o.status === 200
      && o.data?.authenticatorSelection?.userVerification === "required", JSON.stringify(o.data));
    const r = await appel("POST", "/auth/passkeys/register/verify", a.token, { response: cle.creer(o.data), name: "iPhone de la direction" });
    verifier("passkey enregistrée", r.status === 201 && r.data?.passkey?.name === "iPhone de la direction", JSON.stringify(r.data));
    const stockee = (await q(`SELECT public_key, credential_id FROM auth_passkeys WHERE user_id = $1`, [a.admin.id]))[0];
    verifier("le serveur ne garde qu'une clé publique (aucune donnée biométrique)", stockee && stockee.public_key.length > 40);
    const rejeuEnr = await appel("POST", "/auth/passkeys/register/verify", a.token, { response: cle.creer(o.data) });
    verifier("défi d'enregistrement rejoué : refusé", rejeuEnr.status === 409 && rejeuEnr.data?.code === "DEFI_REJOUE");

    const lo0 = await appel("POST", "/auth/passkeys/login/options", null, {});
    const nonVerifie = await appel("POST", "/auth/passkeys/login/verify", null, { response: cle.obtenir(lo0.data) });
    verifier("compte non vérifié : la passkey ne contourne pas la vérification", nonVerifie.status === 403
      && nonVerifie.data?.code === "verification_required", JSON.stringify(nonVerifie.data));
    await q(`UPDATE users SET verification_required = FALSE, account_status = 'active' WHERE id = $1`, [a.admin.id]);
    await q(`UPDATE companies SET account_status = 'active' WHERE id = $1`, [a.id]);
    const lo = await appel("POST", "/auth/passkeys/login/options", null, {});
    const assertion = cle.obtenir(lo.data);
    const login = await appel("POST", "/auth/passkeys/login/verify", null, { response: assertion });
    verifier("connexion par passkey : jeton de session émis", login.status === 200 && typeof login.data?.token === "string"
      && login.data?.user?.id === a.admin.id, JSON.stringify(login.data).slice(0, 300));
    const rejeu = await appel("POST", "/auth/passkeys/login/verify", null, { response: assertion });
    verifier("assertion rejouée : refusée", rejeu.status === 409 && rejeu.data?.code === "DEFI_REJOUE");
    const lo2 = await appel("POST", "/auth/passkeys/login/options", null, {});
    const origine = await appel("POST", "/auth/passkeys/login/verify", null, { response: cle.obtenir(lo2.data, { origine: "https://faux-site.example" }) });
    verifier("autre origine (hameçonnage) : refusée", origine.status === 401 && origine.data?.code === "PASSKEY_INVALIDE");
    const lo3 = await appel("POST", "/auth/passkeys/login/options", null, {});
    const sansUV = await appel("POST", "/auth/passkeys/login/verify", null, { response: cle.obtenir(lo3.data, { sansVerification: true }) });
    verifier("sans vérification biométrique de l'appareil (UV) : refusée", sansUV.status === 401);

    const sans = await appel("PUT", "/biometrics/settings", a.token, { require_liveness: true });
    verifier("action sensible sans validation renforcée : 403 STEP_UP_REQUIS", sans.status === 403 && sans.data?.code === "STEP_UP_REQUIS");
    const so = await appel("POST", "/auth/step-up/options", a.token, { scope: "biometrie.parametres" });
    const sv = await appel("POST", "/auth/step-up/verify", a.token, { response: cle.obtenir(so.data), scope: "biometrie.parametres" });
    verifier("validation renforcée accordée (5 min)", sv.status === 200 && typeof sv.data?.step_up_token === "string", JSON.stringify(sv.data));
    const avec = await appel("PUT", "/biometrics/settings", a.token, { require_liveness: true }, { "x-step-up-token": sv.data.step_up_token });
    verifier("action sensible avec validation : 200", avec.status === 200);
    const autreScope = await appel("POST", "/biometrics/devices/" + appareil.device_id + "/secret", a.token, {}, { "x-step-up-token": sv.data.step_up_token });
    verifier("validation limitée à sa portée (autre action : refusée)", autreScope.status === 403 && autreScope.data?.code === "STEP_UP_REQUIS");
    await q(`UPDATE auth_stepup_grants SET expires_at = now() - interval '1 second'`);
    const expire = await appel("PUT", "/biometrics/settings", a.token, { require_liveness: true }, { "x-step-up-token": sv.data.step_up_token });
    verifier("validation expirée : refusée", expire.status === 403);

    const liste = await appel("GET", "/auth/passkeys", a.token);
    const id = liste.data?.passkeys?.[0]?.id;
    const ren = await appel("PATCH", `/auth/passkeys/${id}`, a.token, { name: "Téléphone pro" });
    verifier("renommer l'appareil", ren.status === 200 && ren.data?.passkey?.name === "Téléphone pro");
    const autrui = await appel("DELETE", `/auth/passkeys/${id}`, awa.token);
    verifier("supprimer la passkey d'autrui : impossible", autrui.status === 404);
    const del = await appel("DELETE", `/auth/passkeys/${id}`, a.token);
    const lo4 = await appel("POST", "/auth/passkeys/login/options", null, {});
    const apres = await appel("POST", "/auth/passkeys/login/verify", null, { response: cle.obtenir(lo4.data) });
    verifier("passkey supprimée : plus de connexion", del.status === 200 && apres.status === 401 && apres.data?.code === "PASSKEY_INCONNUE");
  }

  section("VISAGE POUR UNE ACTION SENSIBLE (SOI-MÊME)");
  {
    const d = (await appel("POST", "/biometrics/challenges", awa.token, { biometric_type: "face", purpose: "action_sensible", ...appareil })).data;
    const v = await appel("POST", "/biometrics/verify-face", awa.token, { capture: visage("awa"), challenge: d,
      purpose: "action_sensible", scope: "paie.validation", ...appareil });
    verifier("visage vérifié → validation renforcée accordée", v.status === 200 && v.data?.step_up?.method === "visage", JSON.stringify(v.data));
  }

  section("RÉVOCATION ET RETRAIT DU CONSENTEMENT");
  {
    const st = await appel("GET", "/biometrics/status", awa.token);
    const face = st.data?.profils?.find((p) => p.biometric_type === "face" && p.status === "actif");
    verifier("Awa voit son propre état (sans gabarit)", st.status === 200 && face && !JSON.stringify(st.data).includes("bv1."));
    const autre = await appel("POST", "/biometrics/revoke", moussa.token, { profile_id: face.id });
    verifier("un collègue ne révoque pas le profil d'Awa", autre.status === 403);
    const r = await appel("POST", "/biometrics/revoke", awa.token, { profile_id: face.id });
    const ligne = (await q(`SELECT status, template_encrypted FROM biometric_profiles WHERE id = $1`, [face.id]))[0];
    verifier("Awa révoque son visage : gabarit effacé", r.status === 200 && ligne.status === "revoque" && ligne.template_encrypted === null);
    const d = await defi({ subject: { user_id: awa.id } });
    const apres = await appel("POST", "/biometrics/verify-face", a.token, { subject: { user_id: awa.id }, capture: visage("awa"),
      challenge: d, purpose: "pointage", ...appareil });
    verifier("après révocation : plus de vérification possible", apres.status === 404 && apres.data?.code === "PROFIL_ABSENT");
    const cm = (await q(`SELECT id FROM biometric_consents WHERE user_id = $1 AND withdrawn_at IS NULL`, [moussa.id]))[0];
    const w = await appel("POST", `/biometrics/consents/${cm.id}/withdraw`, a.token, { reason: "Demande de l'employé" });
    verifier("retrait du consentement de Moussa : profils révoqués", w.status === 200 && w.data?.profils_revoques >= 1, JSON.stringify(w.data));
    verifier("… aucun gabarit restant pour Moussa",
      (await q(`SELECT count(*)::int AS n FROM biometric_profiles WHERE user_id = $1 AND template_encrypted IS NOT NULL`, [moussa.id]))[0].n === 0);
  }

  section("JOURNAL ET IDENTIFICATION 1:N");
  {
    const j = await appel("GET", "/biometrics/events?limit=500", a.token);
    const brut = JSON.stringify(j.data);
    verifier("journal lisible par l'admin, sans gabarit ni secret", j.status === 200 && j.data.evenements.length > 10
      && !brut.includes("bv1.") && !brut.includes("template"));
    verifier("refus journalisés avec leur motif", ["DEFI_REJOUE", "VIVANT_REFUSE", "CONSENTEMENT_ABSENT", "NON_CORRESPONDANT"]
      .every((c) => j.data.evenements.some((e) => e.reason_code === c)));
    const id = await appel("POST", "/biometrics/identify", a.token, { biometric_type: "face", capture: visage("awa"), ...appareil });
    verifier("identification 1:N désactivée par défaut : 403", id.status === 403 && id.data?.code === "IDENTIFICATION_INTERDITE");
    const purge = await appel("POST", "/biometrics/purge", a.token, {});
    verifier("purge de conservation exécutable", purge.status === 200 && typeof purge.data?.evenements === "number");
  }

  await terminer();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
