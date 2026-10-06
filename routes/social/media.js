"use strict";

/**
 * MaliLink Social — médias des publications (photos, vidéos).
 *
 * Ce que ce module garantit :
 * - le TYPE réel d'un fichier est lu dans ses premiers octets (signature
 *   binaire), jamais déduit du nom ni du type déclaré par le navigateur ;
 * - les fichiers sont rangés hors du dossier public `/uploads` servi tel
 *   quel : on ne les lit que par une URL SIGNÉE et limitée dans le temps,
 *   délivrée uniquement à qui a le droit de voir la publication ;
 * - la vidéo se lit par morceaux (en-têtes Range) : la page d'accueil ne
 *   télécharge jamais une vidéo entière qu'on ne regarde pas ;
 * - durée maximale (2 min par défaut), poids maximal, nombre de médias en
 *   attente par personne : tout est borné et configurable sans toucher au
 *   code (SOCIAL_VIDEO_MAX_SECONDS, SOCIAL_VIDEO_MAX_MB, SOCIAL_IMAGE_MAX_MB).
 *
 * ffprobe / ffmpeg sont FACULTATIFS : s'ils sont installés, ils mesurent la
 * durée de tout format et produisent la miniature quand le navigateur n'en
 * a pas envoyé. Sans eux, la durée d'un MP4 / MOV est lue dans l'en-tête du
 * fichier (boîte mvhd) et la miniature vient du navigateur.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { spawnSync } = require("child_process");

const MEDIA_DIR = process.env.SOCIAL_MEDIA_DIR || path.join(__dirname, "..", "..", "uploads", "social");
const TMP_DIR = path.join(MEDIA_DIR, "tmp");
const VIDEO_MAX_SECONDS = Number(process.env.SOCIAL_VIDEO_MAX_SECONDS || 120);
const VIDEO_MAX_BYTES = Number(process.env.SOCIAL_VIDEO_MAX_MB || 150) * 1024 * 1024;
const IMAGE_MAX_BYTES = Number(process.env.SOCIAL_IMAGE_MAX_MB || 10) * 1024 * 1024;
const POSTER_MAX_BYTES = 3 * 1024 * 1024;
const MAX_PENDING_PER_USER = 30;
const MAX_IMAGES_PER_POST = 10;
const URL_TTL_SECONDS = 6 * 3600;

try { fs.mkdirSync(TMP_DIR, { recursive: true }); } catch { /* déjà présent */ }

function binaireDisponible(nom) {
  try {
    return spawnSync(nom, ["-version"], { stdio: "ignore", timeout: 4000 }).status === 0;
  } catch {
    return false;
  }
}
const FFPROBE = process.env.SOCIAL_FFPROBE_PATH || (binaireDisponible("ffprobe") ? "ffprobe" : null);
const FFMPEG = process.env.SOCIAL_FFMPEG_PATH || (binaireDisponible("ffmpeg") ? "ffmpeg" : null);

/* ---------------------------------------------------------------------
   Signature binaire : le seul juge du type d'un fichier.
   --------------------------------------------------------------------- */
function lireDebut(fichier, taille = 64) {
  const fd = fs.openSync(fichier, "r");
  try {
    const tampon = Buffer.alloc(taille);
    const lus = fs.readSync(fd, tampon, 0, taille, 0);
    return tampon.subarray(0, lus);
  } finally {
    fs.closeSync(fd);
  }
}

function detecterType(fichier) {
  const b = lireDebut(fichier);
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: "image", mime: "image/jpeg", ext: "jpg" };
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { kind: "image", mime: "image/png", ext: "png" };
  }
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    return { kind: "image", mime: "image/webp", ext: "webp" };
  }
  if (b.toString("latin1", 0, 6) === "GIF87a" || b.toString("latin1", 0, 6) === "GIF89a") {
    return { kind: "image", mime: "image/gif", ext: "gif" };
  }
  if (b.toString("latin1", 4, 8) === "ftyp") {
    const marque = b.toString("latin1", 8, 12);
    if (["heic", "heix", "hevc", "heim", "heis", "mif1", "msf1", "avif"].includes(marque)) {
      return { kind: "refuse", raison: "Format HEIC/AVIF non pris en charge : choisissez une photo JPEG ou PNG." };
    }
    if (marque === "qt  ") return { kind: "video", mime: "video/quicktime", ext: "mov" };
    return { kind: "video", mime: "video/mp4", ext: "mp4" };
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    return { kind: "video", mime: "video/webm", ext: "webm" };
  }
  return null;
}

/* Durée d'un MP4 / MOV lue dans moov > mvhd, sans charger le fichier. */
function dureeMp4(fichier) {
  const fd = fs.openSync(fichier, "r");
  try {
    const taille = fs.fstatSync(fd).size;
    const lire = (pos, n) => {
      const t = Buffer.alloc(n);
      fs.readSync(fd, t, 0, n, pos);
      return t;
    };
    const parcourir = (debut, fin, cible) => {
      let pos = debut;
      while (pos + 8 <= fin) {
        const entete = lire(pos, 16);
        let longueur = entete.readUInt32BE(0);
        const type = entete.toString("latin1", 4, 8);
        let corps = pos + 8;
        if (longueur === 1) {
          longueur = Number(entete.readBigUInt64BE(8));
          corps = pos + 16;
        } else if (longueur === 0) {
          longueur = fin - pos;
        }
        if (longueur < 8) return null;
        if (type === cible) return { debut: corps, fin: pos + longueur };
        pos += longueur;
      }
      return null;
    };
    const moov = parcourir(0, taille, "moov");
    if (!moov) return null;
    const mvhd = parcourir(moov.debut, moov.fin, "mvhd");
    if (!mvhd) return null;
    const c = lire(mvhd.debut, 32);
    const version = c[0];
    if (version === 1) {
      const echelle = c.readUInt32BE(20);
      const duree = Number(c.readBigUInt64BE(24));
      return echelle > 0 ? duree / echelle : null;
    }
    const echelle = c.readUInt32BE(12);
    const duree = c.readUInt32BE(16);
    return echelle > 0 ? duree / echelle : null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function dureeFfprobe(fichier) {
  if (!FFPROBE) return null;
  try {
    const r = spawnSync(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", fichier],
      { encoding: "utf8", timeout: 15000 });
    const d = Number(String(r.stdout || "").trim());
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch {
    return null;
  }
}

function posterFfmpeg(fichier, sortie) {
  if (!FFMPEG) return false;
  try {
    const r = spawnSync(FFMPEG, ["-y", "-v", "error", "-ss", "0.5", "-i", fichier, "-frames:v", "1",
      "-vf", "scale='min(960,iw)':-2", "-q:v", "4", sortie], { timeout: 30000 });
    return r.status === 0 && fs.existsSync(sortie);
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------------
   URL signées : seule porte d'accès aux fichiers.
   --------------------------------------------------------------------- */
const CLE_URL = crypto
  .createHmac("sha256", String(process.env.SOCIAL_MEDIA_SECRET || process.env.JWT_SECRET || "malilink-social-dev"))
  .update("malilink-social-media-v1")
  .digest();

function signer(publicId, variante, expiration) {
  return crypto.createHmac("sha256", CLE_URL).update(`${publicId}|${variante}|${expiration}`)
    .digest("base64url").slice(0, 32);
}

function urlSignee(publicId, variante = "o") {
  // Expiration arrondie à l'heure : la même URL resservie pendant une heure
  // reste en cache dans le navigateur au lieu de tout retélécharger.
  const maintenant = Math.floor(Date.now() / 1000);
  const expiration = Math.ceil((maintenant + URL_TTL_SECONDS) / 3600) * 3600;
  return `/social-media/${publicId}?v=${variante}&e=${expiration}&s=${signer(publicId, variante, expiration)}`;
}

function signatureValide(publicId, variante, expiration, signature) {
  if (!/^\d{9,11}$/.test(String(expiration || ""))) return false;
  if (Number(expiration) < Math.floor(Date.now() / 1000)) return false;
  const attendue = signer(publicId, variante, expiration);
  const recue = String(signature || "");
  return recue.length === attendue.length && crypto.timingSafeEqual(Buffer.from(recue), Buffer.from(attendue));
}

function vueMedia(row) {
  return {
    id: row.public_id,
    type: row.kind,
    src: urlSignee(row.public_id, "o"),
    poster: row.poster_key ? urlSignee(row.public_id, "p") : null,
    width: row.width || null,
    height: row.height || null,
    duration_seconds: row.duration_seconds === null || row.duration_seconds === undefined
      ? null : Number(row.duration_seconds),
  };
}

/* Anciennes publications : seuls les fichiers déjà hébergés par MaliLink
   sont rendus ; une URL externe saisie par un client ne l'est jamais. */
function mediasHerites(media) {
  if (!Array.isArray(media)) return [];
  return media
    .filter((m) => m && typeof m.url === "string" && /^\/(api\/)?uploads\/[A-Za-z0-9._\/-]+$/.test(m.url))
    .map((m) => ({ id: null, type: m.type === "video" ? "video" : "image", src: m.url.replace(/^\/api/, ""), poster: null,
      width: null, height: null, duration_seconds: null, herite: true }));
}

function createSocialMedia({ pool }) {
  const televersement = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, TMP_DIR),
      filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(12).toString("hex")}.part`),
    }),
    limits: { fileSize: Math.max(VIDEO_MAX_BYTES, IMAGE_MAX_BYTES), files: 2, fields: 10 },
  }).fields([{ name: "file", maxCount: 1 }, { name: "poster", maxCount: 1 }]);

  const supprimer = (fichier) => { if (fichier) fs.promises.unlink(fichier).catch(() => {}); };

  /* Joint les médias de chaque publication (URL signées) en une requête. */
  async function attachToPosts(posts) {
    if (!Array.isArray(posts) || posts.length === 0) return posts || [];
    const ids = posts.map((p) => p.id);
    const { rows } = await pool.query(
      `SELECT post_id, public_id, kind, poster_key, width, height, duration_seconds
         FROM social_media
        WHERE post_id = ANY($1) AND status='attached' AND deleted_at IS NULL
        ORDER BY post_id, position`,
      [ids]
    );
    const parPost = new Map();
    for (const r of rows) {
      if (!parPost.has(r.post_id)) parPost.set(r.post_id, []);
      parPost.get(r.post_id).push(vueMedia(r));
    }
    return posts.map((p) => ({
      ...p,
      media: parPost.get(p.id) || mediasHerites(p.media),
    }));
  }

  /* Rattache des médias en attente à une publication, dans la transaction
     de création. Renvoie une erreur lisible si une règle est enfreinte. */
  async function attachToPost(client, { userId, tenantId, postId, mediaIds }) {
    const ids = Array.isArray(mediaIds) ? [...new Set(mediaIds.map(String))].slice(0, MAX_IMAGES_PER_POST + 1) : [];
    if (ids.length === 0) return [];
    const { rows } = await client.query(
      `SELECT id, public_id, kind FROM social_media
        WHERE public_id = ANY($1) AND user_id=$2 AND tenant_id=$3 AND status='pending' AND deleted_at IS NULL
          AND created_at > NOW() - INTERVAL '24 hours'
        FOR UPDATE`,
      [ids, userId, tenantId]
    );
    if (rows.length !== ids.length) {
      const e = new Error("Un des médias est introuvable ou a expiré : ajoutez-le de nouveau.");
      e.status = 400;
      throw e;
    }
    const videos = rows.filter((r) => r.kind === "video").length;
    if (videos > 1 || (videos === 1 && rows.length > 1)) {
      const e = new Error("Une publication contient soit des photos (10 au plus), soit une seule vidéo.");
      e.status = 400;
      throw e;
    }
    if (rows.length > MAX_IMAGES_PER_POST) {
      const e = new Error(`${MAX_IMAGES_PER_POST} photos au plus par publication.`);
      e.status = 400;
      throw e;
    }
    const ordre = new Map(ids.map((id, i) => [id, i]));
    for (const r of rows) {
      await client.query(
        `UPDATE social_media SET status='attached', post_id=$1, position=$2 WHERE id=$3`,
        [postId, ordre.get(r.public_id), r.id]
      );
    }
    return rows;
  }

  /* POST /social/media — un fichier (et sa miniature pour une vidéo). */
  function registerUploadRoutes(router) {
    router.post("/media", (req, res) => {
      televersement(req, res, async (erreurMulter) => {
        const fichier = req.files?.file?.[0]?.path;
        const miniature = req.files?.poster?.[0]?.path;
        const nettoyer = () => { supprimer(fichier); supprimer(miniature); };
        try {
          if (erreurMulter) {
            nettoyer();
            const tropGros = erreurMulter.code === "LIMIT_FILE_SIZE";
            return res.status(tropGros ? 413 : 400).json({
              error: tropGros ? "Fichier trop volumineux." : "Téléversement refusé.",
            });
          }
          if (!fichier) return res.status(400).json({ error: "Aucun fichier reçu." });

          const enAttente = (await pool.query(
            `SELECT COUNT(*)::int AS n FROM social_media
              WHERE user_id=$1 AND status='pending' AND deleted_at IS NULL
                AND created_at > NOW() - INTERVAL '24 hours'`,
            [req.user.id]
          )).rows[0].n;
          if (enAttente >= MAX_PENDING_PER_USER) {
            nettoyer();
            return res.status(429).json({ error: "Trop de médias en attente : publiez ou retirez-en d'abord." });
          }

          const type = detecterType(fichier);
          if (!type || type.kind === "refuse") {
            nettoyer();
            return res.status(415).json({ error: type?.raison || "Format non pris en charge (JPEG, PNG, WebP, GIF, MP4, MOV, WebM)." });
          }
          const taille = fs.statSync(fichier).size;
          if (type.kind === "image" && taille > IMAGE_MAX_BYTES) {
            nettoyer();
            return res.status(413).json({ error: `Photo trop lourde (${Math.round(IMAGE_MAX_BYTES / 1048576)} Mo au plus).` });
          }
          if (type.kind === "video" && taille > VIDEO_MAX_BYTES) {
            nettoyer();
            return res.status(413).json({ error: `Vidéo trop lourde (${Math.round(VIDEO_MAX_BYTES / 1048576)} Mo au plus).` });
          }

          let duree = null;
          if (type.kind === "video") {
            duree = dureeFfprobe(fichier) ?? (type.ext === "webm" ? null : dureeMp4(fichier));
            const declaree = Number(req.body?.duration);
            if (duree === null && Number.isFinite(declaree) && declaree > 0) duree = declaree;
            if (duree !== null && duree > VIDEO_MAX_SECONDS + 0.5) {
              nettoyer();
              return res.status(422).json({
                error: `Vidéo trop longue : ${Math.round(VIDEO_MAX_SECONDS / 60 * 10) / 10} minutes au plus.`,
                code: "VIDEO_TROP_LONGUE",
              });
            }
          } else {
            supprimer(miniature);
          }

          const publicId = crypto.randomBytes(18).toString("base64url");
          const maintenant = new Date();
          const sousDossier = `${maintenant.getUTCFullYear()}/${String(maintenant.getUTCMonth() + 1).padStart(2, "0")}`;
          fs.mkdirSync(path.join(MEDIA_DIR, sousDossier), { recursive: true });
          const cle = `${sousDossier}/${publicId}.${type.ext}`;
          fs.renameSync(fichier, path.join(MEDIA_DIR, cle));

          let clePoster = null;
          if (type.kind === "video") {
            const typePoster = miniature ? detecterType(miniature) : null;
            const tailleOk = miniature && fs.statSync(miniature).size <= POSTER_MAX_BYTES;
            if (typePoster?.kind === "image" && typePoster.mime !== "image/gif" && tailleOk) {
              clePoster = `${sousDossier}/${publicId}.poster.${typePoster.ext}`;
              fs.renameSync(miniature, path.join(MEDIA_DIR, clePoster));
            } else {
              supprimer(miniature);
              const sortie = path.join(MEDIA_DIR, `${sousDossier}/${publicId}.poster.jpg`);
              if (posterFfmpeg(path.join(MEDIA_DIR, cle), sortie)) clePoster = `${sousDossier}/${publicId}.poster.jpg`;
            }
          }

          const largeur = Math.round(Number(req.body?.width)) || null;
          const hauteur = Math.round(Number(req.body?.height)) || null;
          const { rows } = await pool.query(
            `INSERT INTO social_media
               (tenant_id, user_id, public_id, kind, mime, size_bytes, storage_key, poster_key,
                width, height, duration_seconds)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             RETURNING public_id, kind, poster_key, width, height, duration_seconds`,
            [req.tenant_id || "malilink", req.user.id, publicId, type.kind, type.mime, taille, cle, clePoster,
             largeur && largeur < 20000 ? largeur : null, hauteur && hauteur < 20000 ? hauteur : null,
             duree === null ? null : Math.round(duree * 100) / 100]
          );
          res.status(201).json({ success: true, media: vueMedia(rows[0]) });
        } catch (error) {
          nettoyer();
          console.error("ERREUR SOCIAL MEDIA UPLOAD :", error.message);
          res.status(500).json({ error: "Erreur téléversement du média." });
        }
      });
    });

    /* Retirer un média avant publication. */
    router.delete("/media/:publicId", async (req, res) => {
      try {
        const { rows } = await pool.query(
          `UPDATE social_media SET status='deleted', deleted_at=NOW()
            WHERE public_id=$1 AND user_id=$2 AND status='pending' RETURNING storage_key, poster_key`,
          [String(req.params.publicId), req.user.id]
        );
        if (!rows[0]) return res.status(404).json({ error: "Média introuvable." });
        supprimer(path.join(MEDIA_DIR, rows[0].storage_key));
        if (rows[0].poster_key) supprimer(path.join(MEDIA_DIR, rows[0].poster_key));
        res.json({ success: true });
      } catch (error) {
        res.status(500).json({ error: "Erreur retrait du média." });
      }
    });

    router.get("/media/config", (req, res) => {
      res.json({
        video_max_seconds: VIDEO_MAX_SECONDS,
        video_max_mb: Math.round(VIDEO_MAX_BYTES / 1048576),
        image_max_mb: Math.round(IMAGE_MAX_BYTES / 1048576),
        images_max: MAX_IMAGES_PER_POST,
        mesure_serveur: Boolean(FFPROBE),
      });
    });
  }

  /* GET /social-media/:publicId — lecture d'un fichier par URL signée,
     hors authentification (une balise <img>/<video> n'envoie pas de jeton).
     Gère Range : la vidéo se charge par morceaux. */
  async function serve(req, res) {
    try {
      const publicId = String(req.params.publicId || "");
      const variante = req.query.v === "p" ? "p" : "o";
      if (!/^[A-Za-z0-9_-]{20,40}$/.test(publicId) || !signatureValide(publicId, variante, req.query.e, req.query.s)) {
        return res.status(404).end();
      }
      const { rows } = await pool.query(
        `SELECT m.kind, m.mime, m.storage_key, m.poster_key, m.status, po.deleted_at AS post_supprime
           FROM social_media m
           LEFT JOIN social_posts po ON po.id=m.post_id
          WHERE m.public_id=$1 AND m.deleted_at IS NULL AND m.status <> 'deleted'`,
        [publicId]
      );
      const media = rows[0];
      if (!media || media.post_supprime) return res.status(404).end();
      const cle = variante === "p" ? media.poster_key : media.storage_key;
      if (!cle) return res.status(404).end();
      const chemin = path.join(MEDIA_DIR, cle);
      if (!chemin.startsWith(path.resolve(MEDIA_DIR) + path.sep)) return res.status(404).end();
      const stat = await fs.promises.stat(chemin).catch(() => null);
      if (!stat) return res.status(404).end();
      const type = variante === "p" ? (cle.endsWith(".png") ? "image/png" : cle.endsWith(".webp") ? "image/webp" : "image/jpeg")
        : media.mime;

      res.setHeader("Content-Type", type);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Disposition", "inline");
      res.setHeader("Cache-Control", "private, max-age=3600");
      res.setHeader("Accept-Ranges", "bytes");

      const plage = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
      if (plage && (plage[1] !== "" || plage[2] !== "")) {
        let debut = plage[1] === "" ? stat.size - Number(plage[2]) : Number(plage[1]);
        let fin = plage[1] !== "" && plage[2] !== "" ? Number(plage[2]) : stat.size - 1;
        debut = Math.max(0, debut);
        fin = Math.min(fin, stat.size - 1);
        if (debut > fin) {
          res.setHeader("Content-Range", `bytes */${stat.size}`);
          return res.status(416).end();
        }
        res.status(206);
        res.setHeader("Content-Range", `bytes ${debut}-${fin}/${stat.size}`);
        res.setHeader("Content-Length", String(fin - debut + 1));
        if (req.method === "HEAD") return res.end();
        return fs.createReadStream(chemin, { start: debut, end: fin }).pipe(res);
      }
      res.setHeader("Content-Length", String(stat.size));
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(chemin).pipe(res);
    } catch (error) {
      console.error("ERREUR SOCIAL MEDIA SERVE :", error.message);
      if (!res.headersSent) res.status(500).end();
    }
  }

  /* Ménage : un média jamais publié disparaît au bout de 24 h. */
  async function purgerEnAttente() {
    try {
      const { rows } = await pool.query(
        `UPDATE social_media SET status='deleted', deleted_at=NOW()
          WHERE status='pending' AND created_at < NOW() - INTERVAL '24 hours'
          RETURNING storage_key, poster_key`
      );
      for (const r of rows) {
        supprimer(path.join(MEDIA_DIR, r.storage_key));
        if (r.poster_key) supprimer(path.join(MEDIA_DIR, r.poster_key));
      }
      // Fichiers temporaires orphelins (téléversement interrompu).
      for (const nom of await fs.promises.readdir(TMP_DIR).catch(() => [])) {
        const p = path.join(TMP_DIR, nom);
        const st = await fs.promises.stat(p).catch(() => null);
        if (st && Date.now() - st.mtimeMs > 6 * 3600 * 1000) supprimer(p);
      }
    } catch (error) {
      if (!/social_media/.test(error.message)) console.error("ERREUR SOCIAL MEDIA PURGE :", error.message);
    }
  }
  if (process.env.NODE_ENV !== "test") {
    const minuterie = setInterval(purgerEnAttente, 3600 * 1000);
    minuterie.unref?.();
  }

  return {
    registerUploadRoutes, attachToPosts, attachToPost, serve, purgerEnAttente,
    config: { MEDIA_DIR, VIDEO_MAX_SECONDS, VIDEO_MAX_BYTES, IMAGE_MAX_BYTES, MAX_IMAGES_PER_POST, FFPROBE: Boolean(FFPROBE) },
  };
}

// Exposé pour les tests unitaires.
module.exports = { createSocialMedia, detecterType, dureeMp4, signatureValide, urlSignee, mediasHerites };
