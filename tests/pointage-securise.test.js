"use strict";

/**
 * Régression — faille /attendance/scan (audit du 2026-10-02).
 *
 * Avant : route publique, badge prévisible, recherche toutes sociétés,
 * réponse portant la ligne `users` complète (hash du mot de passe, taux).
 * Ces tests prouvent que chacun de ces défauts est fermé, et que le moteur
 * de pointage commun tient ses garanties (anti-rebond, verrou, ordre).
 */

const crypto = require("crypto");
const { q, appel, jeton, verifier, section, creerSociete, terminer } = require("./_outils");

const MODULES = { pointage: true, pointage_qr: true, badges: true };
const jetonBadge = () => crypto.randomBytes(24).toString("hex");

async function employe(societe, role, nom) {
  const u = (await q(
    `INSERT INTO users (fullname, email, password, role, company_id, badge_code, daily_rate, hourly_rate)
     VALUES ($1, $2, '$2b$12$HASHSECRETDETEST000000000000000000000000000000000000000', $3, $4, NULL, 9999, 1234)
     RETURNING id, role, company_id`,
    [nom, `${nom.replace(/\W/g, "").toLowerCase()}-${societe.id}@essai.test`, role, societe.id]))[0];
  await q(`UPDATE users SET badge_code = $1 WHERE id = $2`, [`TRIANGLE-EMP-${u.id}`, u.id]);
  const t = jetonBadge();
  await q(`INSERT INTO user_badges (tenant_id, company_id, user_id, badge_type, qr_token) VALUES ('malilink',$1,$2,'employe',$3)`,
    [societe.id, u.id, t]);
  return { ...u, token: jeton(u), badge: t };
}

const scan = (token, badge, action = "checkin", extra = {}) =>
  appel("POST", "/attendance/scan", token, { badge_code: badge, action_type: action, ...extra });

const CHAMPS_SENSIBLES = ["password", "email", "phone", "daily_rate", "hourly_rate", "badge_code", "payment_type"];
function fuite(corps) {
  const texte = JSON.stringify(corps || {});
  if (texte.includes("$2b$")) return "hash bcrypt";
  const trouve = [];
  const parcourir = (v) => {
    if (Array.isArray(v)) v.forEach(parcourir);
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) { if (CHAMPS_SENSIBLES.includes(k)) trouve.push(k); parcourir(x); }
    }
  };
  parcourir(corps);
  return trouve.join(",");
}

async function main() {
  const a = await creerSociete({ nom: "Pointage A", modules: MODULES });
  const b = await creerSociete({ nom: "Pointage B", modules: MODULES });
  const magasinier = await employe(a, "magasinier", "Moussa Magasin");
  const collegue = await employe(a, "magasinier", "Awa Collegue");
  const kiosque = await employe(a, "kiosque", "Kiosque Entree");
  const employeB = await employe(b, "magasinier", "Fanta Autre");

  section("SANS AUTHENTIFICATION");
  {
    const r = await scan(null, `TRIANGLE-EMP-${magasinier.id}`);
    verifier("scan sans jeton : 401", r.status === 401, `statut ${r.status}`);
    verifier("aucune donnée renvoyée", !fuite(r.data));
    const r2 = await scan(null, magasinier.badge);
    verifier("même avec un vrai jeton de badge : 401", r2.status === 401);
    const assign = await appel("PUT", `/attendance/assign-user/${magasinier.id}`, null, { daily_rate: 1 });
    verifier("affectation d'horaire sans jeton : 401 (route publique avant)", assign.status === 401, `statut ${assign.status}`);
    const taux = (await q(`SELECT daily_rate FROM users WHERE id = $1`, [magasinier.id]))[0].daily_rate;
    verifier("… et le taux n'a pas bougé", Number(taux) === 9999);
  }

  section("CODES PRÉVISIBLES ET AUTRES SOCIÉTÉS");
  {
    const r = await scan(a.token, `TRIANGLE-EMP-${magasinier.id}`);
    verifier("ancien code deviné (même société) : refusé, ancien format", r.status === 409 && r.data?.code === "BADGE_OBSOLETE", JSON.stringify(r.data));
    const rb = await scan(a.token, employeB.badge);
    const inconnu = await scan(a.token, jetonBadge());
    verifier("badge d'une autre société : refusé", rb.status === 404 && rb.data?.code === "BADGE_INCONNU");
    verifier("même message qu'un badge inconnu (rien ne fuit)", rb.data?.error === inconnu.data?.error && inconnu.status === 404);
    const codeB = await scan(a.token, `TRIANGLE-EMP-${employeB.id}`);
    verifier("ancien code d'une autre société : badge inconnu", codeB.status === 404 && codeB.data?.code === "BADGE_INCONNU");
    const pointagesB = await q(`SELECT count(*)::int AS n FROM attendance_history WHERE user_id = $1`, [employeB.id]);
    verifier("aucun pointage écrit pour la société B", pointagesB[0].n === 0);
  }

  section("SCAN VALIDE ET RÉPONSE MINIMALE");
  {
    const r = await scan(magasinier.token, magasinier.badge);
    verifier("magasinier pointe son arrivée : 200", r.status === 200 && r.data?.success === true, JSON.stringify(r.data));
    verifier("aucun champ sensible (hash, email, téléphone, taux, code)", !fuite(r.data), fuite(r.data));
    verifier("identité minimale : id + nom", r.data?.employee?.id === magasinier.id && r.data?.employee?.fullname === "Moussa Magasin");
    const ev = (await q(`SELECT method, company_id, created_by FROM attendance_history WHERE user_id = $1`, [magasinier.id]))[0];
    verifier("événement : méthode QR, société A", ev?.method === "QR" && ev?.company_id === a.id);
    const url = await scan(magasinier.token, `https://malilinkglobal.com/badge/${magasinier.badge}`, "pause_start");
    verifier("QR au format URL /badge/<jeton> accepté", url.status === 200, JSON.stringify(url.data));
  }

  section("POINTER POUR UN COLLÈGUE");
  {
    const r = await scan(magasinier.token, collegue.badge);
    verifier("un employé ne pointe pas un collègue : 403", r.status === 403 && r.data?.code === "POINTAGE_POUR_AUTRUI", JSON.stringify(r.data));
    const k = await scan(kiosque.token, collegue.badge);
    verifier("kiosque sans « Valider » : 403", k.status === 403 && k.data?.code === "POINTAGE_POUR_AUTRUI");
    await q(`INSERT INTO user_permissions (user_id, module_key, can_view, can_create, can_validate)
             VALUES ($1, 'administration.pointage', true, true, true)`, [kiosque.id]);
    const k2 = await scan(kiosque.token, collegue.badge);
    verifier("kiosque avec « Valider » : 200", k2.status === 200, JSON.stringify(k2.data));
    const ev = (await q(`SELECT created_by FROM attendance_history WHERE user_id = $1`, [collegue.id]))[0];
    verifier("l'opérateur est tracé (created_by)", ev?.created_by === kiosque.id);
    const admin = await scan(a.token, (await employe(a, "magasinier", "Ibrahim Trois")).badge);
    verifier("administrateur de la société : autorisé", admin.status === 200);
  }

  section("MOTEUR : ANTI-REBOND, VERROU, ORDRE");
  {
    const p = await employe(a, "magasinier", "Sali Rebond");
    const r1 = await scan(p.token, p.badge);
    const r2 = await scan(p.token, p.badge);
    verifier("deuxième lecture identique : pas d'erreur, « déjà enregistré »", r2.status === 200 && r2.data?.statut === "deja_enregistre", JSON.stringify(r2.data));
    verifier("un seul événement d'arrivée", (await q(`SELECT count(*)::int AS n FROM attendance_history WHERE user_id=$1 AND action_type='checkin'`, [p.id]))[0].n === 1 && r1.status === 200);

    const s = await employe(a, "magasinier", "Kadi Simultane");
    await scan(s.token, s.badge);
    const rafale = await Promise.all(Array.from({ length: 5 }, () => scan(s.token, s.badge, "pause_start")));
    verifier("5 lectures simultanées : toutes 200", rafale.every((x) => x.status === 200), rafale.map((x) => x.status).join(","));
    verifier("… mais un seul début de pause écrit", (await q(`SELECT count(*)::int AS n FROM attendance_history WHERE user_id=$1 AND action_type='pause_start'`, [s.id]))[0].n === 1);

    const o = await employe(a, "magasinier", "Oumar Ordre");
    const avant = await scan(o.token, o.badge, "checkout");
    verifier("fin de travail sans arrivée : 409", avant.status === 409 && avant.data?.code === "SEQUENCE_INVALIDE");
    const inv = await scan(o.token, o.badge, "envol");
    verifier("action inconnue : 400", inv.status === 400 && inv.data?.code === "ACTION_INVALIDE");
  }

  section("BADGE DÉSACTIVÉ, RÉGLAGES GPS DE LA SOCIÉTÉ");
  {
    const p = await employe(a, "magasinier", "Lamine Perdu");
    await q(`UPDATE user_badges SET status = 'perdu' WHERE user_id = $1`, [p.id]);
    const r = await scan(p.token, p.badge);
    verifier("badge déclaré perdu : 403", r.status === 403 && r.data?.code === "BADGE_INACTIF");

    await q(`INSERT INTO attendance_gps_settings (company_id, gps_required, allowed_radius_meters) VALUES ($1, true, 100)
             ON CONFLICT (company_id) DO UPDATE SET gps_required = true`, [b.id]);
    const g = await scan(employeB.token, employeB.badge);
    verifier("GPS obligatoire pour LA société B : refusé sans position", g.status === 403 && g.data?.code === "LOCALISATION_REQUISE", JSON.stringify(g.data));
    const pA = await employe(a, "magasinier", "Nana SansGps");
    const ga = await scan(pA.token, pA.badge);
    verifier("la société A, sans GPS obligatoire, n'est pas affectée", ga.status === 200);
  }

  section("POINTAGE MANUEL ET AFFECTATION");
  {
    const m = await employe(a, "magasinier", "Djeneba Manuel");
    const self = await appel("POST", "/attendance/check", m.token, { user_id: m.id, action_type: "ARRIVEE" });
    verifier("pointage manuel pour soi (magasinier) : 200", self.status === 200, JSON.stringify(self.data));
    const autre = await appel("POST", "/attendance/check", m.token, { user_id: collegue.id, action_type: "DEBAUCHE" });
    verifier("pointage manuel d'un collègue : 403", autre.status === 403);
    const ev = (await q(`SELECT method FROM attendance_history WHERE user_id = $1`, [m.id]))[0];
    verifier("méthode MANUEL tracée", ev?.method === "MANUEL");

    const assignAutre = await appel("PUT", `/attendance/assign-user/${employeB.id}`, a.token, { daily_rate: 1 });
    verifier("admin A ne modifie pas un employé de B : 404", assignAutre.status === 404);
    const assignEmp = await appel("PUT", `/attendance/assign-user/${collegue.id}`, magasinier.token, { daily_rate: 1 });
    verifier("un magasinier ne modifie pas les taux : 403", assignEmp.status === 403);
    const ok = await appel("PUT", `/attendance/assign-user/${collegue.id}`, a.token, { schedule_group_id: null });
    verifier("admin de la société : 200, réponse minimale", ok.status === 200 && !fuite(ok.data), JSON.stringify(ok.data));
  }

  section("JOURNAL ET LIMITATION DE DÉBIT");
  {
    const journal = await q(`SELECT accepted, refusal_code, token_hint FROM attendance_scan_log WHERE company_id = $1`, [a.id]);
    verifier("refus journalisés avec leur motif", journal.some((l) => !l.accepted && l.refusal_code === "BADGE_OBSOLETE")
      && journal.some((l) => !l.accepted && l.refusal_code === "POINTAGE_POUR_AUTRUI"));
    verifier("le jeton lu n'est jamais conservé en entier", journal.every((l) => l.token_hint.length <= 5));
    const salve = await Promise.all(Array.from({ length: 130 }, () => scan(collegue.token, jetonBadge())));
    verifier("au-delà de 120 lectures par minute : 429", salve.some((x) => x.status === 429), `${salve.filter((x) => x.status === 429).length} refus 429`);
  }

  await terminer();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
