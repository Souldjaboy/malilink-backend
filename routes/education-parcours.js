"use strict";

/**
 * MaliLink Éducation — le parcours administratif, en un seul endroit :
 *
 *   Inscription → affectation → paiement → badge → présence → notes → bulletin
 *
 * POST /education/inscriptions crée, dans UNE transaction : le dossier de
 * l'élève (matricule automatique, ou manuel si l'établissement l'autorise),
 * son inscription (année, classe, niveau, série), son échéancier (frais
 * d'inscription, autres frais, mensualités nettes de réduction et de
 * bourse), le premier paiement avec son reçu numéroté et son écriture
 * comptable. Il n'existe plus de second formulaire qui crée un élève.
 *
 * Fichiers privés (photo d'élève, logo, sceau, signature, cachet) : rangés
 * sous uploads/ (pour être conservés d'une release à l'autre) mais jamais
 * servis tels quels ; on les lit par une URL signée et limitée dans le temps.
 * Isolation : chaque requête est bornée à l'établissement de l'utilisateur,
 * et chaque identifiant reçu (classe, année, élève) est revérifié en base.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");

const RACINE_UPLOADS = path.join(__dirname, "..", "uploads");
const DOSSIERS = {
  eleve: path.join(RACINE_UPLOADS, "eleves"),
  etablissement: path.join(RACINE_UPLOADS, "etablissements"),
};
for (const d of Object.values(DOSSIERS)) {
  try { fs.mkdirSync(d, { recursive: true }); } catch { /* déjà présent */ }
}

const MODES_PAIEMENT = {
  especes: "Espèces",
  wave: "Wave",
  orange_money: "Orange Money",
  virement: "Virement",
  cheque: "Chèque",
  autre: "Autre",
};
const RELATIONS = ["pere", "mere", "tuteur", "tutrice", "frere", "soeur", "oncle", "tante", "grand_parent", "autre"];
const ETATS_INSCRIPTION = ["inscrit", "preinscrit", "abandon", "transfere", "termine"];
const MODELES_CARTE = ["academique", "moderne", "premium", "minimaliste", "institutionnel", "creatif"];
const MODELES_BULLETIN = ["institutionnel", "academique", "moderne", "premium", "compact", "elegant"];
const FICHIERS_ETABLISSEMENT = { logo: "logo_key", sceau: "seal_key", signature: "signature_key", cachet: "stamp_key" };

/* ----------------------------- Fichiers privés ----------------------------- */
function detecterImage(fichier) {
  const fd = fs.openSync(fichier, "r");
  try {
    const b = Buffer.alloc(16);
    fs.readSync(fd, b, 0, 16, 0);
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
    if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
    if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

const CLE_URL = crypto
  .createHmac("sha256", String(process.env.EDU_FILES_SECRET || process.env.JWT_SECRET || "malilink-edu-dev"))
  .update("malilink-edu-fichiers-v1")
  .digest();
const signerFichier = (type, cle, exp) =>
  crypto.createHmac("sha256", CLE_URL).update(`${type}|${cle}|${exp}`).digest("base64url").slice(0, 32);

function urlFichier(type, cle) {
  if (!cle) return null;
  const exp = Math.ceil((Math.floor(Date.now() / 1000) + 6 * 3600) / 3600) * 3600;
  // Le dossier (société) et le fichier sont deux segments : un %2F encodé
  // n'aurait pas survécu à tous les proxys.
  return `/education-fichiers/${type}/${cle}?e=${exp}&s=${signerFichier(type, cle, exp)}`;
}

function cheminFichier(type, cle) {
  const dossier = DOSSIERS[type];
  if (!dossier || !/^\d+\/[A-Za-z0-9_-]{16,64}\.(jpg|png|webp)$/.test(String(cle || ""))) return null;
  const chemin = path.join(dossier, cle);
  return chemin.startsWith(path.resolve(dossier) + path.sep) ? chemin : null;
}

/* GET /education-fichiers/:type/:dossier/:fichier — hors authentification
   (une balise <img> n'envoie pas de jeton), mais uniquement par URL signée. */
async function serveFichier(req, res) {
  try {
    const type = String(req.params.type || "");
    const cle = `${String(req.params.dossier || "")}/${String(req.params.fichier || "")}`;
    const exp = String(req.query.e || "");
    const sig = String(req.query.s || "");
    const chemin = cheminFichier(type, cle);
    if (!chemin || !/^\d{9,11}$/.test(exp) || Number(exp) < Date.now() / 1000) return res.status(404).end();
    const attendue = signerFichier(type, cle, exp);
    if (sig.length !== attendue.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(attendue))) {
      return res.status(404).end();
    }
    const stat = await fs.promises.stat(chemin).catch(() => null);
    if (!stat) return res.status(404).end();
    res.setHeader("Content-Type", cle.endsWith(".png") ? "image/png" : cle.endsWith(".webp") ? "image/webp" : "image/jpeg");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Content-Length", String(stat.size));
    fs.createReadStream(chemin).pipe(res);
  } catch {
    if (!res.headersSent) res.status(404).end();
  }
}

const televersementImage = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, RACINE_UPLOADS),
    filename: (req, file, cb) => cb(null, `edu-${Date.now()}-${crypto.randomBytes(10).toString("hex")}.part`),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
}).single("file");

/* Range une image reçue (type lu dans le fichier) dans le dossier privé. */
function rangerImage(fichierTemporaire, type, companyId) {
  const ext = detecterImage(fichierTemporaire);
  if (!ext) {
    fs.promises.unlink(fichierTemporaire).catch(() => {});
    const e = new Error("Image refusée : JPEG, PNG ou WebP uniquement.");
    e.status = 415;
    throw e;
  }
  fs.mkdirSync(path.join(DOSSIERS[type], String(companyId)), { recursive: true });
  const cle = `${companyId}/${crypto.randomBytes(18).toString("base64url")}.${ext}`;
  fs.renameSync(fichierTemporaire, path.join(DOSSIERS[type], cle));
  return cle;
}

function supprimerFichier(type, cle) {
  const chemin = cheminFichier(type, cle);
  if (chemin) fs.promises.unlink(chemin).catch(() => {});
}

/* ------------------------------- Utilitaires ------------------------------- */
const texte = (v, max = 200) => String(v ?? "").trim().slice(0, max);
const montant = (v) => {
  const n = Math.round(Number(v || 0) * 100) / 100;
  return Number.isFinite(n) && n >= 0 ? n : NaN;
};
const dateIso = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null);
const erreur = (message, status = 400, code) => Object.assign(new Error(message), { status, code });

function publicBaseUrl(req) {
  const env = process.env.FRONTEND_PUBLIC_URL || process.env.NEXT_PUBLIC_FRONTEND_URL || process.env.PUBLIC_BASE_URL;
  if (env) return env.replace(/\/$/, "");
  const proto = req.get("x-forwarded-proto") || req.protocol;
  return `${proto}://${req.get("x-forwarded-host") || req.get("host")}`;
}

module.exports = function registerParcoursRoutes(router, ctx) {
  const {
    pool, schoolId, requireRoles, STAFF_ROLES, MONEY_ROLES, edupdf,
    nextEnrollmentRef, nextReceiptRef, recomputeFeePlan, buildInstallments, assertStudentAccess,
  } = ctx;
  const ROLES_FINANCES = [...new Set([...STAFF_ROLES, ...MONEY_ROLES])];

  /* ---------- Établissement : paramètres fusionnés avec l'entreprise ---------- */
  async function etablissement(db, companyId) {
    const { rows } = await db.query(
      `SELECT es.*, co.name AS company_name,
              cs.company_name AS cs_name, cs.address AS cs_address, cs.phone AS cs_phone, cs.email AS cs_email,
              cs.website AS cs_website, cs.slogan AS cs_slogan, cs.whatsapp_number AS cs_whatsapp,
              cs.logo_url AS cs_logo_url, cs.city AS cs_city,
              y.label AS active_year_label
         FROM companies co
         LEFT JOIN edu_schools es ON es.company_id = co.id
         LEFT JOIN company_settings cs ON cs.company_id = co.id
         LEFT JOIN edu_school_years y ON y.id = es.active_school_year_id AND y.company_id = co.id
        WHERE co.id = $1
        LIMIT 1`,
      [companyId]
    );
    const r = rows[0] || {};
    const officiel = r.official_name || r.cs_name || r.company_name || "";
    return {
      company_id: companyId,
      official_name: officiel,
      short_name: r.short_name || "",
      slogan: r.slogan || r.cs_slogan || "",
      address: r.address || r.cs_address || "",
      city: r.cs_city || "",
      phone: r.phone || r.cs_phone || "",
      whatsapp: r.whatsapp || r.cs_whatsapp || "",
      email: r.email || r.cs_email || "",
      website: r.website || r.cs_website || "",
      director_name: r.director_name || "",
      school_type: r.school_type || "ecole",
      grading_system: r.grading_system || "malien",
      grade_max: Number(r.grade_max || 20),
      color_primary: r.color_primary || "#0f1b3d",
      color_secondary: r.color_secondary || "#d4a23c",
      active_school_year_id: r.active_school_year_id || null,
      active_year_label: r.active_year_label || "",
      matricule_prefix: r.matricule_prefix || "",
      matricule_manual_allowed: r.matricule_manual_allowed === true,
      card_template: r.card_template || "academique",
      card_options: r.card_options || {},
      report_template: r.report_template || "institutionnel",
      report_options: r.report_options || {},
      logo_key: r.logo_key || null,
      seal_key: r.seal_key || null,
      signature_key: r.signature_key || null,
      stamp_key: r.stamp_key || null,
      logo_url_public: r.logo_url || r.cs_logo_url || "",
    };
  }

  const vueEtablissement = (e) => {
    const { logo_key, seal_key, signature_key, stamp_key, ...reste } = e;
    return {
      ...reste,
      logo: urlFichier("etablissement", logo_key),
      sceau: urlFichier("etablissement", seal_key),
      signature: urlFichier("etablissement", signature_key),
      cachet: urlFichier("etablissement", stamp_key),
    };
  };

  router.get("/etablissement", async (req, res) => {
    try {
      res.json(vueEtablissement(await etablissement(pool, schoolId(req))));
    } catch (e) {
      console.error("ERREUR EDU ETABLISSEMENT :", e.message);
      res.status(500).json({ error: "Erreur chargement de l'établissement." });
    }
  });

  router.put("/etablissement", requireRoles(STAFF_ROLES), async (req, res) => {
    try {
      const cid = schoolId(req);
      const b = req.body || {};
      const couleur = (v, defaut) => (/^#[0-9A-Fa-f]{6}$/.test(String(v || "")) ? String(v) : defaut);
      let anneeActive = null;
      if (b.active_school_year_id) {
        const y = await pool.query(`SELECT id FROM edu_school_years WHERE id=$1 AND company_id=$2`, [Number(b.active_school_year_id), cid]);
        if (!y.rows[0]) return res.status(404).json({ error: "Année scolaire introuvable." });
        anneeActive = y.rows[0].id;
      }
      const prefixe = texte(b.matricule_prefix, 12).toUpperCase();
      if (prefixe && !/^[A-Z0-9-]{1,12}$/.test(prefixe)) {
        return res.status(400).json({ error: "Préfixe de matricule : lettres, chiffres et tirets (12 au plus)." });
      }
      const modeleCarte = MODELES_CARTE.includes(b.card_template) ? b.card_template : "academique";
      const modeleBulletin = MODELES_BULLETIN.includes(b.report_template) ? b.report_template : "institutionnel";
      const options = (o, cles) => Object.fromEntries(cles.filter((c) => o && typeof o[c] === "boolean").map((c) => [c, o[c]]));
      const carteOptions = {
        ...options(b.card_options, ["afficher_photo", "afficher_niveau", "afficher_naissance", "afficher_signature", "afficher_slogan", "afficher_tuteur"]),
        orientation: b.card_options?.orientation === "portrait" ? "portrait" : "paysage",
      };
      const bulletinOptions = options(b.report_options,
        ["afficher_logo", "afficher_photo", "afficher_rang", "afficher_moyenne_classe", "afficher_appreciations", "afficher_signature", "afficher_cachet"]);
      const { rows } = await pool.query(
        `INSERT INTO edu_schools (company_id, school_type, grading_system, grade_max, director_name, address, phone,
            official_name, short_name, slogan, whatsapp, email, website, color_primary, color_secondary,
            active_school_year_id, matricule_prefix, matricule_manual_allowed, card_template, card_options,
            report_template, report_options, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,NOW())
         ON CONFLICT (company_id) DO UPDATE SET
           school_type=EXCLUDED.school_type, grading_system=EXCLUDED.grading_system, grade_max=EXCLUDED.grade_max,
           director_name=EXCLUDED.director_name, address=EXCLUDED.address, phone=EXCLUDED.phone,
           official_name=EXCLUDED.official_name, short_name=EXCLUDED.short_name, slogan=EXCLUDED.slogan,
           whatsapp=EXCLUDED.whatsapp, email=EXCLUDED.email, website=EXCLUDED.website,
           color_primary=EXCLUDED.color_primary, color_secondary=EXCLUDED.color_secondary,
           active_school_year_id=EXCLUDED.active_school_year_id, matricule_prefix=EXCLUDED.matricule_prefix,
           matricule_manual_allowed=EXCLUDED.matricule_manual_allowed, card_template=EXCLUDED.card_template,
           card_options=EXCLUDED.card_options, report_template=EXCLUDED.report_template,
           report_options=EXCLUDED.report_options, updated_at=NOW()
         RETURNING company_id`,
        [cid, texte(b.school_type, 40) || "ecole", texte(b.grading_system, 40) || "malien",
         Math.min(Math.max(Number(b.grade_max) || 20, 5), 100), texte(b.director_name, 120), texte(b.address, 300),
         texte(b.phone, 40), texte(b.official_name, 200), texte(b.short_name, 40), texte(b.slogan, 200),
         texte(b.whatsapp, 40), texte(b.email, 120), texte(b.website, 200),
         couleur(b.color_primary, "#0f1b3d"), couleur(b.color_secondary, "#d4a23c"), anneeActive, prefixe,
         b.matricule_manual_allowed === true, modeleCarte, JSON.stringify(carteOptions), modeleBulletin,
         JSON.stringify(bulletinOptions)]
      );
      if (anneeActive) {
        await pool.query(`UPDATE edu_school_years SET is_active = (id = $2) WHERE company_id=$1`, [cid, anneeActive]);
      }
      res.json(vueEtablissement(await etablissement(pool, rows[0].company_id)));
    } catch (e) {
      console.error("ERREUR EDU ETABLISSEMENT MAJ :", e.message);
      res.status(500).json({ error: "Erreur enregistrement de l'établissement." });
    }
  });

  /* Logo, sceau, signature, cachet : une fois, réutilisés partout. */
  router.post("/etablissement/fichiers/:nature", requireRoles(STAFF_ROLES), (req, res) => {
    const colonne = FICHIERS_ETABLISSEMENT[req.params.nature];
    if (!colonne) return res.status(404).json({ error: "Fichier inconnu." });
    televersementImage(req, res, async (erreurMulter) => {
      try {
        if (erreurMulter) return res.status(erreurMulter.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: "Image refusée (5 Mo au plus)." });
        if (!req.file) return res.status(400).json({ error: "Aucune image reçue." });
        const cid = schoolId(req);
        const cle = rangerImage(req.file.path, "etablissement", cid);
        const ancien = (await pool.query(`SELECT ${colonne} AS cle FROM edu_schools WHERE company_id=$1`, [cid])).rows[0]?.cle;
        await pool.query(
          `INSERT INTO edu_schools (company_id, ${colonne}) VALUES ($1,$2)
           ON CONFLICT (company_id) DO UPDATE SET ${colonne}=EXCLUDED.${colonne}, updated_at=NOW()`,
          [cid, cle]
        );
        if (ancien) supprimerFichier("etablissement", ancien);
        res.status(201).json({ success: true, url: urlFichier("etablissement", cle) });
      } catch (e) {
        if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
        res.status(e.status || 500).json({ error: e.status ? e.message : "Erreur enregistrement du fichier." });
      }
    });
  });

  router.delete("/etablissement/fichiers/:nature", requireRoles(STAFF_ROLES), async (req, res) => {
    const colonne = FICHIERS_ETABLISSEMENT[req.params.nature];
    if (!colonne) return res.status(404).json({ error: "Fichier inconnu." });
    const cid = schoolId(req);
    const ancien = (await pool.query(`SELECT ${colonne} AS cle FROM edu_schools WHERE company_id=$1`, [cid])).rows[0]?.cle;
    await pool.query(`UPDATE edu_schools SET ${colonne}=NULL, updated_at=NOW() WHERE company_id=$1`, [cid]);
    if (ancien) supprimerFichier("etablissement", ancien);
    res.json({ success: true });
  });

  /* ---------- Matricule : automatique (compteur), manuel si autorisé ---------- */
  async function genererMatricule(db, companyId, prefixe) {
    const annee = new Date().getFullYear();
    for (let essai = 0; essai < 50; essai += 1) {
      const { rows } = await db.query(
        `INSERT INTO edu_matricule_counters (company_id, year, last_seq)
         VALUES ($1, $2, (SELECT COUNT(*) FROM edu_students WHERE company_id=$1) + 1)
         ON CONFLICT (company_id, year) DO UPDATE SET last_seq = edu_matricule_counters.last_seq + 1
         RETURNING last_seq`,
        [companyId, annee]
      );
      const seq = String(rows[0].last_seq).padStart(4, "0");
      const matricule = prefixe ? `${prefixe}-${annee}-${seq}` : `ML${annee}-${String(companyId).padStart(3, "0")}-${seq}`;
      const pris = await db.query(`SELECT 1 FROM edu_students WHERE company_id=$1 AND matricule=$2`, [companyId, matricule]);
      if (!pris.rows[0]) return matricule;
    }
    throw erreur("Impossible de générer un matricule unique.", 500);
  }

  async function verifierReferences(db, companyId, { classId, yearId }) {
    if (yearId) {
      const y = await db.query(`SELECT id, label FROM edu_school_years WHERE id=$1 AND company_id=$2`, [yearId, companyId]);
      if (!y.rows[0]) throw erreur("Année scolaire introuvable dans votre établissement.", 404);
    }
    if (classId) {
      const c = await db.query(`SELECT id, name, level, school_year_id FROM edu_classes WHERE id=$1 AND company_id=$2`, [classId, companyId]);
      if (!c.rows[0]) throw erreur("Classe introuvable dans votre établissement.", 404);
      return c.rows[0];
    }
    return null;
  }

  function lireEleve(b) {
    const prenom = texte(b.first_name, 80);
    const nom = texte(b.last_name, 80);
    if (!prenom || !nom) throw erreur("Prénom et nom de l'élève obligatoires.");
    const sexe = ["M", "F"].includes(b.gender) ? b.gender : null;
    const naissance = b.birth_date ? dateIso(b.birth_date) : null;
    if (b.birth_date && !naissance) throw erreur("Date de naissance invalide (AAAA-MM-JJ).");
    if (naissance && new Date(naissance) > new Date()) throw erreur("La date de naissance ne peut pas être dans le futur.");
    const relation = RELATIONS.includes(b.guardian_relation) ? b.guardian_relation : (b.guardian_name ? "tuteur" : "");
    return {
      first_name: prenom, last_name: nom, gender: sexe, birth_date: naissance,
      birth_place: texte(b.birth_place, 120), address: texte(b.address, 300),
      phone: texte(b.phone, 40), email: texte(b.email, 120),
      guardian_name: texte(b.guardian_name, 120), guardian_relation: relation,
      guardian_phone: texte(b.guardian_phone, 40), guardian_email: texte(b.guardian_email, 120),
    };
  }

  /* Crée un élève (matricule + code de badge aléatoire). */
  async function creerEleve(db, companyId, e, { matriculeManuel, classId, etab }) {
    let matricule;
    let source = "auto";
    if (matriculeManuel) {
      if (!etab.matricule_manual_allowed) throw erreur("Le matricule manuel n'est pas autorisé par l'établissement.", 403);
      matricule = texte(matriculeManuel, 40).toUpperCase();
      if (!/^[A-Z0-9][A-Z0-9/_-]{1,39}$/.test(matricule)) throw erreur("Matricule manuel invalide.");
      const pris = await db.query(`SELECT 1 FROM edu_students WHERE company_id=$1 AND matricule=$2`, [companyId, matricule]);
      if (pris.rows[0]) throw erreur("Ce matricule est déjà attribué.", 409, "MATRICULE_PRIS");
      source = "manuel";
    } else {
      matricule = await genererMatricule(db, companyId, etab.matricule_prefix);
    }
    const qrCode = `EDU-${crypto.randomBytes(12).toString("hex")}`;
    const { rows } = await db.query(
      `INSERT INTO edu_students
         (company_id, first_name, last_name, gender, birth_date, birth_place, address, phone, email,
          guardian_name, guardian_relation, guardian_phone, guardian_email, class_id, matricule, matricule_source, qr_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [companyId, e.first_name, e.last_name, e.gender, e.birth_date, e.birth_place, e.address, e.phone, e.email,
       e.guardian_name, e.guardian_relation, e.guardian_phone, e.guardian_email, classId || null, matricule, source, qrCode]
    );
    return rows[0];
  }

  /* Écriture comptable d'un encaissement (ou de son annulation). Ne fait
     jamais échouer le paiement : la comptabilité se rapproche ensuite. */
  async function ecrireCompta(db, { companyId, montant: m, sens, libelle, sourceId, partenaire, methode, userId, enTransaction = false }) {
    // Dans une transaction, un point de sauvegarde isole l'écriture : son
    // échec ne doit pas annuler l'encaissement.
    if (enTransaction) await db.query("SAVEPOINT ecriture_compta");
    try {
      const { rows } = await db.query(
        `INSERT INTO accounting_transactions
           (company_id, transaction_type, source_type, source_id, amount, currency, direction, category,
            partner_name, description, status, source_label, created_by, validated_by, validated_at)
         VALUES ($1,$2,'education',$3,$4,'FCFA',$5,'Scolarité',$6,$7,'validé',$8,$9,$9,NOW())
         RETURNING id`,
        [companyId, sens === "entrée" ? "encaissement_scolarite" : "annulation_scolarite", sourceId, m,
         sens, partenaire || "", libelle, MODES_PAIEMENT[methode] || methode || "", userId || null]
      );
      if (enTransaction) await db.query("RELEASE SAVEPOINT ecriture_compta");
      return rows[0]?.id || null;
    } catch (e) {
      if (enTransaction) await db.query("ROLLBACK TO SAVEPOINT ecriture_compta").catch(() => {});
      console.error("COMPTA EDUCATION (non bloquant) :", e.message);
      return null;
    }
  }

  /* L'inscription reflète la part de l'échéancier qui couvre ses frais. */
  async function synchroniserInscription(db, companyId, planId) {
    const plan = (await db.query(`SELECT enrollment_id FROM edu_feeplans WHERE id=$1 AND company_id=$2`, [planId, companyId])).rows[0];
    if (!plan?.enrollment_id) return null;
    const { rows } = await db.query(
      `UPDATE edu_enrollments e
          SET amount_paid = x.paye,
              status = CASE WHEN x.paye <= 0 THEN 'pending' WHEN x.paye >= e.enrollment_fee THEN 'paid' ELSE 'partially_paid' END,
              updated_at = NOW()
         FROM (SELECT COALESCE(SUM(amount_paid),0) AS paye FROM edu_feeplan_installments
                WHERE company_id=$1 AND plan_id=$2 AND kind='inscription') x
        WHERE e.id=$3 AND e.company_id=$1
        RETURNING e.*`,
      [companyId, planId, plan.enrollment_id]
    );
    return rows[0] || null;
  }

  /* Encaissement sur un échéancier : reçu numéroté, répartition en cascade
     (inscription, autres frais, puis mensualités), écriture comptable. */
  async function encaisser(db, { companyId, planId, montant: m, methode, reference, notes, userId, eleveNom }) {
    const receipt = await nextReceiptRef(companyId);
    const signature = edupdf.signRef(["RECU", receipt]);
    const { rows } = await db.query(
      `INSERT INTO edu_feeplan_payments
         (company_id, plan_id, receipt_number, amount, method, reference, status, signature, notes, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,'paid',$7,$8,$9) RETURNING *`,
      [companyId, planId, receipt, m, methode, texte(reference, 120), signature, texte(notes, 500), userId]
    );
    const ecriture = await ecrireCompta(db, {
      companyId, montant: m, sens: "entrée", libelle: `Reçu ${receipt} — scolarité ${eleveNom || ""}`.trim(),
      sourceId: rows[0].id, partenaire: eleveNom, methode, userId, enTransaction: true,
    });
    if (ecriture) await db.query(`UPDATE edu_feeplan_payments SET accounting_transaction_id=$1 WHERE id=$2`, [ecriture, rows[0].id]);
    return { ...rows[0], accounting_transaction_id: ecriture };
  }

  /* ---------- Options du formulaire d'inscription ---------- */
  router.get("/inscriptions/options", requireRoles(ROLES_FINANCES), async (req, res) => {
    try {
      const cid = schoolId(req);
      const [annees, classes, etab] = await Promise.all([
        pool.query(`SELECT id, label, start_date, end_date, is_active FROM edu_school_years WHERE company_id=$1 ORDER BY start_date DESC NULLS LAST, id DESC`, [cid]),
        pool.query(`SELECT c.id, c.name, c.level, c.school_year_id,
                           (SELECT COUNT(*)::int FROM edu_students s WHERE s.class_id=c.id AND s.status='actif' AND s.archived_at IS NULL) AS effectif
                      FROM edu_classes c WHERE c.company_id=$1 ORDER BY c.name`, [cid]),
        etablissement(pool, cid),
      ]);
      const active = etab.active_school_year_id || annees.rows.find((a) => a.is_active)?.id || annees.rows[0]?.id || null;
      res.json({
        annees: annees.rows, annee_active_id: active, classes: classes.rows,
        matricule: { manuel_autorise: etab.matricule_manual_allowed, prefixe: etab.matricule_prefix },
        modes_paiement: Object.entries(MODES_PAIEMENT).map(([code, libelle]) => ({ code, libelle })),
        relations: RELATIONS,
      });
    } catch (e) {
      console.error("ERREUR EDU OPTIONS :", e.message);
      res.status(500).json({ error: "Erreur chargement du formulaire." });
    }
  });

  /* ---------- Dossier d'inscription complet ---------- */
  router.post("/inscriptions", requireRoles(ROLES_FINANCES), async (req, res) => {
    const client = await pool.connect();
    try {
      const cid = schoolId(req);
      const b = req.body || {};
      const etab = await etablissement(client, cid);

      const yearId = Number(b.inscription?.school_year_id) || etab.active_school_year_id || null;
      const classId = Number(b.inscription?.class_id) || null;
      if (!yearId) throw erreur("Choisissez l'année scolaire (ou définissez l'année active dans Paramètres).");
      const frais = b.frais || {};
      const fraisInscription = montant(frais.inscription);
      const mensualite = montant(frais.mensualite);
      const mois = Math.round(Number(frais.mois ?? 9));
      const autres = montant(frais.autres);
      const reduction = montant(frais.reduction);
      const bourse = montant(frais.bourse);
      if ([fraisInscription, mensualite, autres, reduction, bourse].some(Number.isNaN)) throw erreur("Montants invalides.");
      if (!(mois >= 0 && mois <= 24)) throw erreur("Nombre de mensualités invalide (0 à 24).");
      const scolariteBrute = Math.round(mensualite * mois * 100) / 100;
      if (reduction + bourse > scolariteBrute + fraisInscription + autres) {
        throw erreur("La réduction et la bourse dépassent le montant dû.");
      }
      // Réduction et bourse portent d'abord sur la scolarité, le surplus sur les autres frais.
      let allegement = reduction + bourse;
      const scolariteNette = Math.max(0, scolariteBrute - allegement);
      allegement = Math.max(0, allegement - scolariteBrute);
      const autresNets = Math.max(0, autres - allegement);
      allegement = Math.max(0, allegement - autres);
      const inscriptionNette = Math.max(0, fraisInscription - allegement);
      const total = Math.round((inscriptionNette + autresNets + scolariteNette) * 100) / 100;

      const paiement = b.paiement || {};
      const verse = montant(paiement.montant);
      if (Number.isNaN(verse)) throw erreur("Montant payé invalide.");
      if (verse > total) throw erreur("Le montant payé dépasse le total dû.", 400, "MONTANT_EXCEDENTAIRE");
      const methode = MODES_PAIEMENT[paiement.mode] ? paiement.mode : null;
      if (verse > 0 && !methode) throw erreur("Mode de paiement invalide.");
      const etat = ETATS_INSCRIPTION.includes(b.inscription?.etat) ? b.inscription.etat : "inscrit";
      const dateInscription = dateIso(b.inscription?.date) || new Date().toISOString().slice(0, 10);

      await client.query("BEGIN");
      const classe = await verifierReferences(client, cid, { classId, yearId });

      // Élève : nouveau dossier, ou réinscription d'un élève existant.
      let eleve;
      if (b.eleve_id) {
        eleve = (await client.query(`SELECT * FROM edu_students WHERE id=$1 AND company_id=$2 FOR UPDATE`, [Number(b.eleve_id), cid])).rows[0];
        if (!eleve) throw erreur("Élève introuvable dans votre établissement.", 404);
        await client.query(`UPDATE edu_students SET class_id=$1, status='actif', archived_at=NULL, updated_at=NOW() WHERE id=$2`, [classId, eleve.id]);
      } else {
        eleve = await creerEleve(client, cid, lireEleve(b.eleve || {}), { matriculeManuel: b.eleve?.matricule, classId, etab });
      }
      const doublon = await client.query(
        `SELECT reference FROM edu_enrollments
          WHERE company_id=$1 AND student_id=$2 AND school_year_id=$3 AND enrollment_state NOT IN ('abandon','transfere')`,
        [cid, eleve.id, yearId]
      );
      if (doublon.rows[0]) throw erreur(`Cet élève est déjà inscrit pour cette année (${doublon.rows[0].reference}).`, 409, "DEJA_INSCRIT");

      const reference = await nextEnrollmentRef(cid);
      const inscription = (await client.query(
        `INSERT INTO edu_enrollments
           (company_id, reference, student_id, school_year_id, class_id, enrollment_fee, amount_paid, currency,
            payment_method, status, signature, notes, created_by, level, section, enrollment_date, enrollment_state,
            monthly_fee, months_count, other_fees, other_fees_label, discount_amount, scholarship_amount)
         VALUES ($1,$2,$3,$4,$5,$6,0,'FCFA',$7,'pending',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         RETURNING *`,
        [cid, reference, eleve.id, yearId, classId, inscriptionNette, methode || "", edupdf.signRef(["INSCRIPTION", reference]),
         texte(b.inscription?.notes, 500), req.user.id, texte(b.inscription?.niveau, 60) || classe?.level || "",
         texte(b.inscription?.serie, 60), dateInscription, etat, mensualite, mois, autresNets,
         texte(frais.autres_libelle, 120), reduction, bourse]
      )).rows[0];

      // Échéancier unique : inscription, autres frais, puis mensualités.
      const anneeLabel = (await client.query(`SELECT label FROM edu_school_years WHERE id=$1`, [yearId])).rows[0]?.label || "";
      const plan = (await client.query(
        `INSERT INTO edu_feeplans (company_id, student_id, school_year_id, class_id, label, total_amount,
            installments_count, currency, notes, created_by, enrollment_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'FCFA',$8,$9,$10) RETURNING *`,
        [cid, eleve.id, yearId, classId, `Scolarité ${anneeLabel}`.trim(), total, mois, reference, req.user.id, inscription.id]
      )).rows[0];
      let seq = 0;
      const echeance = async (libelle, somme, date, nature) => {
        if (!(somme > 0)) return;
        seq += 1;
        await client.query(
          `INSERT INTO edu_feeplan_installments (company_id, plan_id, seq, label, due_date, amount, kind)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [cid, plan.id, seq, libelle, date, somme.toFixed(2), nature]
        );
      };
      await echeance("Frais d'inscription", inscriptionNette, dateInscription, "inscription");
      await echeance(texte(frais.autres_libelle, 120) || "Autres frais", autresNets, dateInscription, "autre");
      if (mois > 0 && scolariteNette > 0) {
        const premiere = dateIso(frais.premiere_echeance) || dateInscription;
        for (const inst of buildInstallments(scolariteNette, mois, premiere)) {
          await echeance(inst.label, Number(inst.amount), inst.due_date, "mensualite");
        }
      }
      await client.query(`UPDATE edu_enrollments SET fee_plan_id=$1 WHERE id=$2`, [plan.id, inscription.id]);

      let paiementCree = null;
      if (verse > 0) {
        paiementCree = await encaisser(client, {
          companyId: cid, planId: plan.id, montant: verse, methode, reference: paiement.reference,
          notes: paiement.notes, userId: req.user.id, eleveNom: `${eleve.first_name} ${eleve.last_name}`,
        });
      }
      await client.query("COMMIT");

      // Répartition et état de l'inscription, hors transaction (lectures simples).
      const etatPlan = await recomputeFeePlan(cid, plan.id);
      const inscriptionFinale = (await synchroniserInscription(pool, cid, plan.id)) || inscription;
      res.status(201).json({
        success: true,
        eleve: { ...eleve, photo_url: urlFichier("eleve", eleve.photo_key) },
        inscription: inscriptionFinale,
        echeancier: { ...etatPlan, total_amount: total, reste: Math.max(0, total - verse) },
        paiement: paiementCree,
        recu_url: paiementCree ? `/education/fee-payments/${paiementCree.id}/receipt` : null,
        fiche_url: `/education/enrollments/${inscription.id}/pdf`,
      });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      if (e.code === "23505") return res.status(409).json({ error: "Doublon : ce dossier existe déjà.", code: "DOUBLON" });
      console.error("ERREUR EDU INSCRIPTION :", e.message);
      res.status(500).json({ error: "Erreur enregistrement de l'inscription." });
    } finally {
      client.release();
    }
  });

  /* ---------- Paiement sur le dossier d'un élève ---------- */
  router.post("/fee-plans/:id/encaissements", requireRoles(MONEY_ROLES), async (req, res) => {
    const client = await pool.connect();
    try {
      const cid = schoolId(req);
      const m = montant(req.body?.montant ?? req.body?.amount);
      const methode = MODES_PAIEMENT[req.body?.mode] ? req.body.mode : MODES_PAIEMENT[req.body?.method] ? req.body.method : null;
      if (!(m > 0)) return res.status(400).json({ error: "Montant invalide." });
      if (!methode) return res.status(400).json({ error: "Mode de paiement invalide." });
      await client.query("BEGIN");
      const plan = (await client.query(
        `SELECT p.*, s.first_name, s.last_name,
                COALESCE((SELECT SUM(amount) FROM edu_feeplan_payments fp WHERE fp.plan_id=p.id AND fp.status='paid'),0) AS deja
           FROM edu_feeplans p JOIN edu_students s ON s.id=p.student_id
          WHERE p.id=$1 AND p.company_id=$2 AND p.status <> 'cancelled' FOR UPDATE OF p`,
        [Number(req.params.id), cid]
      )).rows[0];
      if (!plan) throw erreur("Échéancier introuvable.", 404);
      const reste = Math.round((Number(plan.total_amount) - Number(plan.deja)) * 100) / 100;
      if (m > reste + 0.001) throw erreur(`Le montant dépasse le reste à payer (${reste.toLocaleString("fr-FR")} FCFA).`, 400, "MONTANT_EXCEDENTAIRE");
      const p = await encaisser(client, {
        companyId: cid, planId: plan.id, montant: m, methode, reference: req.body?.reference, notes: req.body?.notes,
        userId: req.user.id, eleveNom: `${plan.first_name} ${plan.last_name}`,
      });
      await client.query("COMMIT");
      const etatPlan = await recomputeFeePlan(cid, plan.id);
      await synchroniserInscription(pool, cid, plan.id);
      res.status(201).json({ success: true, paiement: p, echeancier: etatPlan, recu_url: `/education/fee-payments/${p.id}/receipt` });
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("ERREUR EDU ENCAISSEMENT :", e.message);
      res.status(500).json({ error: "Erreur enregistrement du paiement." });
    } finally {
      client.release();
    }
  });

  /* ---------- Dossier d'un élève (gestion, badge, paiements) ---------- */
  router.get("/students/:id/dossier", async (req, res) => {
    try {
      const cid = schoolId(req);
      const eleve = await assertStudentAccess(req, req.params.id);
      if (!eleve) return res.status(404).json({ error: "Élève introuvable." });
      const voirFinances = ROLES_FINANCES.includes(req.eduRole) || req.eduRole === "parent";
      const [inscriptions, plans, carte, classe] = await Promise.all([
        pool.query(
          `SELECT e.id, e.reference, e.school_year_id, y.label AS year_label, e.class_id, c.name AS class_name,
                  e.level, e.section, e.enrollment_date, e.enrollment_state, e.enrollment_fee, e.amount_paid, e.status,
                  e.fee_plan_id, e.monthly_fee, e.months_count, e.other_fees, e.discount_amount, e.scholarship_amount, e.created_at
             FROM edu_enrollments e
             LEFT JOIN edu_school_years y ON y.id=e.school_year_id
             LEFT JOIN edu_classes c ON c.id=e.class_id
            WHERE e.company_id=$1 AND e.student_id=$2 ORDER BY e.created_at DESC`,
          [cid, eleve.id]
        ),
        voirFinances ? pool.query(
          `SELECT p.id, p.label, p.total_amount, p.status, p.enrollment_id,
                  COALESCE((SELECT SUM(amount) FROM edu_feeplan_payments fp WHERE fp.plan_id=p.id AND fp.status='paid'),0) AS total_paid,
                  (SELECT json_agg(json_build_object('id', i.id, 'seq', i.seq, 'label', i.label, 'due_date', i.due_date::text,
                          'amount', i.amount, 'amount_paid', i.amount_paid, 'status', i.status, 'kind', i.kind) ORDER BY i.seq)
                     FROM edu_feeplan_installments i WHERE i.plan_id=p.id) AS echeances,
                  (SELECT json_agg(json_build_object('id', fp.id, 'receipt_number', fp.receipt_number, 'amount', fp.amount,
                          'method', fp.method, 'reference', fp.reference, 'status', fp.status, 'created_at', fp.created_at)
                          ORDER BY fp.created_at DESC)
                     FROM edu_feeplan_payments fp WHERE fp.plan_id=p.id) AS paiements
             FROM edu_feeplans p WHERE p.company_id=$1 AND p.student_id=$2 ORDER BY p.created_at DESC`,
          [cid, eleve.id]
        ) : { rows: [] },
        pool.query(
          `SELECT reference, school_year_label, status, issued_at, valid_until FROM edu_document_verifications
            WHERE company_id=$1 AND student_id=$2 AND doc_type='carte' ORDER BY issued_at DESC LIMIT 1`,
          [cid, eleve.id]
        ).catch(() => ({ rows: [] })),
        eleve.class_id ? pool.query(`SELECT name, level FROM edu_classes WHERE id=$1 AND company_id=$2`, [eleve.class_id, cid]) : { rows: [] },
      ]);
      const { photo_key, ...donnees } = eleve;
      res.json({
        eleve: { ...donnees, photo_url: urlFichier("eleve", photo_key), class_name: classe.rows[0]?.name || null,
          class_level: classe.rows[0]?.level || null },
        inscriptions: inscriptions.rows,
        echeanciers: plans.rows,
        carte: carte.rows[0] || null,
      });
    } catch (e) {
      console.error("ERREUR EDU DOSSIER :", e.message);
      res.status(500).json({ error: "Erreur chargement du dossier." });
    }
  });

  /* Modifier le dossier (état civil, tuteur, affectation de classe). */
  router.patch("/students/:id", requireRoles(STAFF_ROLES), async (req, res) => {
    try {
      const cid = schoolId(req);
      // Date relue en texte : un objet Date se décalerait d'un jour selon le fuseau.
      const eleve = (await pool.query(
        `SELECT *, birth_date::text AS birth_date FROM edu_students WHERE id=$1 AND company_id=$2`,
        [Number(req.params.id), cid]
      )).rows[0];
      if (!eleve) return res.status(404).json({ error: "Élève introuvable." });
      const e = lireEleve({ ...eleve, ...req.body });
      let classId = eleve.class_id;
      if (Object.prototype.hasOwnProperty.call(req.body || {}, "class_id")) {
        classId = req.body.class_id ? Number(req.body.class_id) : null;
        await verifierReferences(pool, cid, { classId });
      }
      let matricule = eleve.matricule;
      if (req.body?.matricule && String(req.body.matricule).toUpperCase() !== eleve.matricule) {
        const etab = await etablissement(pool, cid);
        if (!etab.matricule_manual_allowed) return res.status(403).json({ error: "Le matricule manuel n'est pas autorisé." });
        matricule = texte(req.body.matricule, 40).toUpperCase();
        if (!/^[A-Z0-9][A-Z0-9/_-]{1,39}$/.test(matricule)) return res.status(400).json({ error: "Matricule invalide." });
        const pris = await pool.query(`SELECT 1 FROM edu_students WHERE company_id=$1 AND matricule=$2 AND id<>$3`, [cid, matricule, eleve.id]);
        if (pris.rows[0]) return res.status(409).json({ error: "Ce matricule est déjà attribué.", code: "MATRICULE_PRIS" });
      }
      const { rows } = await pool.query(
        `UPDATE edu_students SET first_name=$3, last_name=$4, gender=$5, birth_date=$6, birth_place=$7, address=$8,
            phone=$9, email=$10, guardian_name=$11, guardian_relation=$12, guardian_phone=$13, guardian_email=$14,
            class_id=$15, matricule=$16, updated_at=NOW()
          WHERE id=$1 AND company_id=$2 RETURNING *`,
        [eleve.id, cid, e.first_name, e.last_name, e.gender, e.birth_date, e.birth_place, e.address, e.phone, e.email,
         e.guardian_name, e.guardian_relation, e.guardian_phone, e.guardian_email, classId, matricule]
      );
      const { photo_key, ...donnees } = rows[0];
      res.json({ success: true, eleve: { ...donnees, photo_url: urlFichier("eleve", photo_key) } });
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message, code: e.code });
      console.error("ERREUR EDU MODIF ELEVE :", e.message);
      res.status(500).json({ error: "Erreur modification du dossier." });
    }
  });

  router.post("/students/:id/archive", requireRoles(STAFF_ROLES), async (req, res) => {
    const { rows } = await pool.query(
      // L'archivage se lit dans archived_at ; le statut scolaire reste intact.
      `UPDATE edu_students SET archived_at=NOW(), updated_at=NOW()
        WHERE id=$1 AND company_id=$2 AND archived_at IS NULL RETURNING id`,
      [Number(req.params.id), schoolId(req)]
    );
    if (!rows[0]) return res.status(404).json({ error: "Élève introuvable ou déjà archivé." });
    res.json({ success: true });
  });

  router.post("/students/:id/restore", requireRoles(STAFF_ROLES), async (req, res) => {
    const { rows } = await pool.query(
      `UPDATE edu_students SET archived_at=NULL, updated_at=NOW()
        WHERE id=$1 AND company_id=$2 AND archived_at IS NOT NULL RETURNING id`,
      [Number(req.params.id), schoolId(req)]
    );
    if (!rows[0]) return res.status(404).json({ error: "Élève introuvable." });
    res.json({ success: true });
  });

  /* Photo de l'élève : téléphone, webcam ou fichier ; réutilisée par la
     fiche, la carte et les documents autorisés. */
  router.post("/students/:id/photo", requireRoles(STAFF_ROLES), async (req, res) => {
    // L'élève est vérifié AVANT de recevoir le fichier : rien n'est écrit
    // sur le disque pour un élève d'un autre établissement.
    const cid = schoolId(req);
    let existant;
    try {
      existant = (await pool.query(`SELECT id FROM edu_students WHERE id=$1 AND company_id=$2`, [Number(req.params.id) || 0, cid])).rows[0];
    } catch { return res.status(500).json({ error: "Erreur enregistrement de la photo." }); }
    if (!existant) return res.status(404).json({ error: "Élève introuvable." });
    televersementImage(req, res, async (erreurMulter) => {
      try {
        if (erreurMulter) return res.status(erreurMulter.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: "Photo refusée (5 Mo au plus)." });
        if (!req.file) return res.status(400).json({ error: "Aucune photo reçue." });
        const eleve = (await pool.query(`SELECT id, photo_key FROM edu_students WHERE id=$1 AND company_id=$2`, [existant.id, cid])).rows[0];
        const cle = rangerImage(req.file.path, "eleve", cid);
        await pool.query(`UPDATE edu_students SET photo_key=$1, updated_at=NOW() WHERE id=$2`, [cle, eleve.id]);
        if (eleve.photo_key) supprimerFichier("eleve", eleve.photo_key);
        res.status(201).json({ success: true, photo_url: urlFichier("eleve", cle) });
      } catch (e) {
        if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
        res.status(e.status || 500).json({ error: e.status ? e.message : "Erreur enregistrement de la photo." });
      }
    });
  });

  /* ---------- Frais : tableau de bord et situation par élève ---------- */
  router.get("/finances/tableau-de-bord", requireRoles(ROLES_FINANCES), async (req, res) => {
    try {
      const cid = schoolId(req);
      const [jour, retard, avenir, reste, parClasse] = await Promise.all([
        pool.query(
          `SELECT COALESCE(SUM(amount),0) AS montant, COUNT(*)::int AS nombre FROM (
             SELECT amount FROM edu_feeplan_payments WHERE company_id=$1 AND status='paid' AND created_at::date = CURRENT_DATE
             UNION ALL
             SELECT amount FROM edu_enrollment_payments WHERE company_id=$1 AND status='paid' AND created_at::date = CURRENT_DATE
             UNION ALL
             SELECT amount FROM edu_fee_payments WHERE company_id=$1 AND COALESCE(paid_at, created_at)::date = CURRENT_DATE
           ) x`, [cid]),
        pool.query(
          `SELECT COALESCE(SUM(i.amount - i.amount_paid),0) AS montant, COUNT(DISTINCT p.student_id)::int AS eleves
             FROM edu_feeplan_installments i JOIN edu_feeplans p ON p.id=i.plan_id AND p.status <> 'cancelled'
            WHERE i.company_id=$1 AND i.status <> 'paid' AND i.due_date < CURRENT_DATE`, [cid]),
        pool.query(
          `SELECT COALESCE(SUM(i.amount - i.amount_paid),0) AS montant, COUNT(*)::int AS echeances
             FROM edu_feeplan_installments i JOIN edu_feeplans p ON p.id=i.plan_id AND p.status <> 'cancelled'
            WHERE i.company_id=$1 AND i.status <> 'paid' AND i.due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30`, [cid]),
        pool.query(
          `SELECT COALESCE(SUM(i.amount - i.amount_paid),0) AS montant
             FROM edu_feeplan_installments i JOIN edu_feeplans p ON p.id=i.plan_id AND p.status <> 'cancelled'
            WHERE i.company_id=$1 AND i.status <> 'paid'`, [cid]),
        pool.query(
          `SELECT c.id, c.name,
                  COALESCE(SUM(p.total_amount),0) AS du,
                  COALESCE(SUM((SELECT SUM(amount) FROM edu_feeplan_payments fp WHERE fp.plan_id=p.id AND fp.status='paid')),0) AS encaisse
             FROM edu_classes c
             LEFT JOIN edu_feeplans p ON p.class_id=c.id AND p.company_id=c.company_id AND p.status <> 'cancelled'
            WHERE c.company_id=$1
            GROUP BY c.id, c.name ORDER BY c.name`, [cid]),
      ]);
      res.json({
        encaisse_aujourdhui: Number(jour.rows[0].montant), paiements_aujourdhui: jour.rows[0].nombre,
        impayes: Number(retard.rows[0].montant), eleves_en_retard: retard.rows[0].eleves,
        echeances_30_jours: Number(avenir.rows[0].montant), nombre_echeances_30_jours: avenir.rows[0].echeances,
        reste_a_encaisser: Number(reste.rows[0].montant),
        par_classe: parClasse.rows.map((r) => ({ ...r, du: Number(r.du), encaisse: Number(r.encaisse),
          reste: Math.max(0, Number(r.du) - Number(r.encaisse)) })),
      });
    } catch (e) {
      console.error("ERREUR EDU FINANCES :", e.message);
      res.status(500).json({ error: "Erreur chargement des finances." });
    }
  });

  router.get("/finances/eleves", requireRoles(ROLES_FINANCES), async (req, res) => {
    try {
      const cid = schoolId(req);
      const classe = Number(req.query.class_id) || null;
      const recherche = texte(req.query.q, 60);
      const { rows } = await pool.query(
        `SELECT s.id, s.matricule, s.first_name, s.last_name, c.name AS class_name, s.guardian_phone,
                p.id AS plan_id, p.label, p.total_amount,
                COALESCE((SELECT SUM(amount) FROM edu_feeplan_payments fp WHERE fp.plan_id=p.id AND fp.status='paid'),0) AS paye,
                COALESCE((SELECT SUM(i.amount - i.amount_paid) FROM edu_feeplan_installments i
                           WHERE i.plan_id=p.id AND i.status <> 'paid' AND i.due_date < CURRENT_DATE),0) AS en_retard,
                (SELECT MIN(i.due_date)::text FROM edu_feeplan_installments i WHERE i.plan_id=p.id AND i.status <> 'paid') AS prochaine_echeance
           FROM edu_feeplans p
           JOIN edu_students s ON s.id=p.student_id AND s.company_id=p.company_id
           LEFT JOIN edu_classes c ON c.id=p.class_id
          WHERE p.company_id=$1 AND p.status <> 'cancelled'
            AND ($2::int IS NULL OR p.class_id=$2)
            AND ($3::text = '' OR s.last_name ILIKE '%'||$3||'%' OR s.first_name ILIKE '%'||$3||'%' OR s.matricule ILIKE '%'||$3||'%')
          ORDER BY s.last_name, s.first_name LIMIT 500`,
        [cid, classe, recherche]
      );
      res.json(rows.map((r) => ({ ...r, total_amount: Number(r.total_amount), paye: Number(r.paye),
        reste: Math.max(0, Number(r.total_amount) - Number(r.paye)), en_retard: Number(r.en_retard) })));
    } catch (e) {
      console.error("ERREUR EDU FINANCES ELEVES :", e.message);
      res.status(500).json({ error: "Erreur chargement des situations." });
    }
  });

  return { etablissement, urlFichier, synchroniserInscription, ecrireCompta, genererMatricule, verifierReferences, MODES_PAIEMENT, publicBaseUrl };
};

module.exports.serveFichier = serveFichier;
module.exports.urlFichier = urlFichier;
module.exports.cheminFichier = cheminFichier;
module.exports.publicBaseUrl = publicBaseUrl;
module.exports.MODES_PAIEMENT = MODES_PAIEMENT;
