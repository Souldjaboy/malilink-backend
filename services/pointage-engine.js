"use strict";

/**
 * MOTEUR D'ÉCRITURE DU POINTAGE — un seul chemin pour toutes les méthodes.
 *
 * QR, manuel, visage, empreinte, confirmation par passkey : la méthode change
 * CE QUI déclenche le pointage, jamais LA RÈGLE qui l'écrit. Toutes passent
 * par `enregistrerPointage`, qui garantit pour chacune :
 *
 *   • la personne appartient à la société indiquée, est active et fait partie
 *     du personnel (un compte client ne pointe jamais) ;
 *   • un verrou par personne (pg_advisory_xact_lock) : deux lectures
 *     simultanées du même badge ne créent jamais deux pointages ;
 *   • l'anti-rebond : la même action répétée dans les 20 secondes renvoie le
 *     pointage déjà enregistré, sans erreur ni doublon ;
 *   • la cohérence entrée / pause / sortie : un ordre impossible est refusé ;
 *   • l'heure retenue est celle du SERVEUR, jamais celle de l'appareil ;
 *   • un événement d'historique complet : méthode, appareil, site, score de
 *     confiance biométrique, opérateur, société, tenant.
 *
 * Le moteur ne décide pas QUI a le droit de pointer pour qui : c'est le rôle
 * de la route appelante (droits propres à chaque système). Il refuse en
 * revanche tout ce qui serait incohérent quel que soit l'appelant.
 */

const METHODES = new Set(["QR", "MANUEL", "VISAGE", "EMPREINTE", "PASSKEY_CONFIRMATION"]);

const ACTIONS = {
  checkin: "Début travail",
  pause_start: "Début pause",
  pause_end: "Fin pause",
  checkout: "Fin travail",
};

// Anciens noms d'action encore envoyés par l'écran de pointage manuel.
const ALIAS_ACTIONS = {
  ARRIVEE: "checkin",
  DEPART_PAUSE: "pause_start",
  RETOUR_PAUSE: "pause_end",
  DEBAUCHE: "checkout",
};

/* Deux lectures du même geste à quelques secondes d'écart sont une seule
   intention : on renvoie le pointage existant au lieu d'une erreur rouge. */
const ANTI_REBOND_SECONDES = 20;

// Espace de verrou consultatif réservé au pointage (premier argument).
const ESPACE_VERROU = 481516;

const ROLES_NON_PERSONNEL = new Set(["customer", "client", "patient"]);

class PointageError extends Error {
  constructor(message, code, httpStatus = 400) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

function normaliserAction(action) {
  const brut = String(action || "").trim();
  const cle = ALIAS_ACTIONS[brut.toUpperCase()] || brut.toLowerCase();
  if (!ACTIONS[cle]) throw new PointageError("Action de pointage invalide.", "ACTION_INVALIDE", 400);
  return cle;
}

function normaliserMethode(methode) {
  const m = String(methode || "").trim().toUpperCase();
  if (!METHODES.has(m)) throw new PointageError("Méthode de pointage invalide.", "METHODE_INVALIDE", 400);
  return m;
}

/* Contrôle d'ordre : renvoie un refus explicite, ou null si l'action est
   possible sur la fiche du jour telle qu'elle est. */
function refusSequence(action, fiche) {
  const f = fiche || {};
  if (action === "checkin" && f.check_in) return "Arrivée déjà pointée aujourd'hui.";
  if (action === "pause_start") {
    if (!f.check_in) return "Arrivée non pointée.";
    if (f.check_out) return "Fin de travail déjà pointée.";
    if (f.break_out) return "Début de pause déjà pointé.";
  }
  if (action === "pause_end") {
    if (!f.break_out) return "Début de pause non pointé.";
    if (f.break_in) return "Fin de pause déjà pointée.";
  }
  if (action === "checkout") {
    if (!f.check_in) return "Arrivée non pointée.";
    if (f.check_out) return "Fin de travail déjà pointée.";
  }
  return null;
}

/**
 * Enregistre un pointage.
 *
 * @param pool  pg.Pool
 * @param o.companyId   société (obligatoire)
 * @param o.userId      personne pointée (obligatoire)
 * @param o.action      checkin | pause_start | pause_end | checkout (ou alias)
 * @param o.methode     QR | MANUEL | VISAGE | EMPREINTE | PASSKEY_CONFIRMATION
 * @param o.tenantId    tenant (facultatif, déduit de la société sinon)
 * @param o.deviceId    appareil déclaré (biometric_devices)
 * @param o.site        { id, name } site retenu
 * @param o.gps         { latitude, longitude, accuracy, distance, inside, status }
 * @param o.confidence  score biométrique 0..1
 * @param o.createdBy   opérateur, si différent de la personne pointée
 * @param o.requestId   identifiant de requête (traçabilité)
 * @param o.metadata    complément libre, JAMAIS de donnée biométrique
 * @returns { statut: 'enregistre'|'deja_enregistre', action, libelle, fiche, evenementId, personne }
 */
async function enregistrerPointage(pool, o) {
  const companyId = Number(o.companyId);
  const userId = Number(o.userId);
  if (!Number.isInteger(companyId) || companyId <= 0) {
    throw new PointageError("Société obligatoire.", "SOCIETE_REQUISE", 400);
  }
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new PointageError("Personne à pointer obligatoire.", "PERSONNE_REQUISE", 400);
  }
  const action = normaliserAction(o.action);
  const methode = normaliserMethode(o.methode);
  const confidence = o.confidence === undefined || o.confidence === null ? null : Number(o.confidence);
  if (confidence !== null && !(confidence >= 0 && confidence <= 1)) {
    throw new PointageError("Score de confiance invalide.", "SCORE_INVALIDE", 400);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1, $2)", [ESPACE_VERROU, userId]);

    const { rows: personnes } = await client.query(
      `SELECT u.id, u.fullname, u.role, u.company_id,
              COALESCE(u.is_active, TRUE) AS actif,
              COALESCE(c.tenant_id, u.tenant_id) AS tenant_id
         FROM users u
         LEFT JOIN companies c ON c.id = u.company_id
        WHERE u.id = $1 AND u.company_id = $2`,
      [userId, companyId]
    );
    const personne = personnes[0];
    // Même réponse qu'une personne inexistante : rien ne fuit d'une autre société.
    if (!personne) throw new PointageError("Personne introuvable.", "PERSONNE_INTROUVABLE", 404);
    if (!personne.actif) throw new PointageError("Compte désactivé : pointage impossible.", "PERSONNE_INACTIVE", 403);
    if (ROLES_NON_PERSONNEL.has(String(personne.role || "").toLowerCase())) {
      throw new PointageError("Seul le personnel de l'entreprise peut pointer.", "PAS_PERSONNEL", 403);
    }
    const tenantId = o.tenantId || personne.tenant_id || null;

    const { rows: recents } = await client.query(
      `SELECT id FROM attendance_history
        WHERE user_id = $1 AND company_id = $2 AND action_type = $3
          AND created_at > CURRENT_TIMESTAMP - ($4 || ' seconds')::interval
        ORDER BY id DESC LIMIT 1`,
      [userId, companyId, action, String(ANTI_REBOND_SECONDES)]
    );

    const { rows: fiches } = await client.query(
      `SELECT * FROM attendance_records WHERE user_id = $1 AND work_date = CURRENT_DATE FOR UPDATE`,
      [userId]
    );
    let fiche = fiches[0] || null;

    if (recents[0] && fiche) {
      await client.query("COMMIT");
      return { statut: "deja_enregistre", action, libelle: ACTIONS[action], fiche, evenementId: recents[0].id, personne };
    }

    const refus = refusSequence(action, fiche);
    if (refus) throw new PointageError(refus, "SEQUENCE_INVALIDE", 409);

    if (!fiche) {
      const { rows } = await client.query(
        `INSERT INTO attendance_records (user_id, work_date, status, company_id, tenant_id)
         VALUES ($1, CURRENT_DATE, 'Absent', $2, $3)
         ON CONFLICT (user_id, work_date) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [userId, companyId, tenantId]
      );
      fiche = rows[0];
    }

    const g = o.gps || {};
    const site = o.site || {};
    let miseAJour;
    if (action === "checkin") {
      // Retard calculé sur l'horaire de la personne (08:00 par défaut), à l'heure du serveur.
      miseAJour = await client.query(
        `UPDATE attendance_records r
            SET check_in = CURRENT_TIMESTAMP,
                late_minutes = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (LOCALTIME - COALESCE(
                  (SELECT s.start_time FROM attendance_settings s WHERE s.user_id = r.user_id), TIME '08:00'))) / 60))::int,
                status = CASE WHEN LOCALTIME > COALESCE(
                  (SELECT s.start_time FROM attendance_settings s WHERE s.user_id = r.user_id), TIME '08:00')
                  THEN 'En retard' ELSE 'Présent' END,
                updated_at = CURRENT_TIMESTAMP
          WHERE r.id = $1 RETURNING *`,
        [fiche.id]
      );
    } else if (action === "pause_start") {
      miseAJour = await client.query(
        `UPDATE attendance_records SET break_out = CURRENT_TIMESTAMP, status = 'En pause',
                updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`,
        [fiche.id]
      );
    } else if (action === "pause_end") {
      miseAJour = await client.query(
        `UPDATE attendance_records SET break_in = CURRENT_TIMESTAMP, status = 'Présent',
                total_break_minutes = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - break_out)) / 60))::int,
                updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`,
        [fiche.id]
      );
    } else {
      miseAJour = await client.query(
        `UPDATE attendance_records SET check_out = CURRENT_TIMESTAMP, status = 'Terminé',
                total_work_minutes = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - check_in)) / 60)
                  - CASE WHEN break_out IS NOT NULL AND break_in IS NOT NULL
                         THEN FLOOR(EXTRACT(EPOCH FROM (break_in - break_out)) / 60) ELSE 0 END)::int,
                updated_at = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *`,
        [fiche.id]
      );
    }
    fiche = miseAJour.rows[0];

    if (o.gps || o.site) {
      fiche = (await client.query(
        `UPDATE attendance_records
            SET latitude = $1, longitude = $2, accuracy = $3, distance_meters = $4,
                is_inside_zone = $5, attendance_site_id = $6, attendance_site_name = $7,
                gps_status = $8, company_id = $9, tenant_id = COALESCE(tenant_id, $10)
          WHERE id = $11 RETURNING *`,
        [g.latitude ?? null, g.longitude ?? null, g.accuracy ?? null, g.distance ?? null,
          g.inside ?? null, site.id || null, site.name || "", g.status || "",
          companyId, tenantId, fiche.id]
      )).rows[0];
    } else if (!fiche.company_id) {
      fiche = (await client.query(
        `UPDATE attendance_records SET company_id = $1, tenant_id = COALESCE(tenant_id, $2) WHERE id = $3 RETURNING *`,
        [companyId, tenantId, fiche.id]
      )).rows[0];
    }

    const { rows: evenements } = await client.query(
      `INSERT INTO attendance_history
         (user_id, action_type, device_info, location_info, latitude, longitude, accuracy,
          distance_meters, is_inside_zone, attendance_site_id, attendance_site_name, gps_status,
          company_id, tenant_id, method, device_id, biometric_confidence, created_by, request_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING id`,
      [userId, action, methode,
        g.latitude != null && g.longitude != null ? `${g.latitude},${g.longitude}` : "",
        g.latitude ?? null, g.longitude ?? null, g.accuracy ?? null, g.distance ?? null, g.inside ?? null,
        site.id || null, site.name || "", g.status || "",
        companyId, tenantId, methode, o.deviceId || null, confidence,
        o.createdBy && Number(o.createdBy) !== userId ? Number(o.createdBy) : null,
        o.requestId ? String(o.requestId).slice(0, 80) : null,
        JSON.stringify(o.metadata || {})]
    );

    await client.query("COMMIT");
    return { statut: "enregistre", action, libelle: ACTIONS[action], fiche, evenementId: evenements[0].id, personne };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** La fiche du jour telle qu'un écran a le droit de la voir — sans montant. */
function ficheMinimale(fiche) {
  if (!fiche) return null;
  return {
    work_date: fiche.work_date,
    check_in: fiche.check_in,
    break_out: fiche.break_out,
    break_in: fiche.break_in,
    check_out: fiche.check_out,
    status: fiche.status,
    late_minutes: fiche.late_minutes,
    total_work_minutes: fiche.total_work_minutes,
    attendance_site_name: fiche.attendance_site_name || "",
  };
}

module.exports = {
  METHODES,
  ACTIONS,
  ANTI_REBOND_SECONDES,
  PointageError,
  normaliserAction,
  normaliserMethode,
  refusSequence,
  enregistrerPointage,
  ficheMinimale,
};
