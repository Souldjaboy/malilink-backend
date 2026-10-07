#!/usr/bin/env bash
#
# DÉPLOIEMENT MALILINK — SOCIAL (Réseau, médias, appels) + ÉDUCATION
# (inscription unique, carte scolaire, bulletins, vérification QR).
#
# Principe : une NOUVELLE release à côté de l'active, jamais de modification
# de la release en service. Aucun « git reset --hard », aucun « git clean ».
# Seuls les processus PM2 malilink-backend et malilink-frontend sont touchés
# (Triangle et HAFIYA jamais). Le dossier uploads est COPIÉ (l'original reste).
#
#   ./deploy-malilink-social-education.sh              # audit seul : n'écrit rien
#   ./deploy-malilink-social-education.sh --preparer   # sauvegarde + nouvelle release
#                                                      # + migrations + build + tests,
#                                                      # SANS toucher PM2
#   ./deploy-malilink-social-education.sh --executer   # tout, puis bascule PM2 ciblée
#   ./deploy-malilink-social-education.sh --retour     # revient à la release précédente
#
# Le script s'arrête au premier problème, avant toute étape suivante.
set -Eeuo pipefail

# ─────────────────────────── Ce qui est déployé ───────────────────────────
readonly SHA_BACKEND="7e2a6778f323b9afd4e0c8472b5ff0b20e9ee394"
readonly SHA_FRONTEND="da3ff0db53e0cdbd4ec033a50c5b8bdea89e057c"
readonly MIGRATIONS_ATTENDUES="084_social_reseau_medias.sql 085_education_parcours_inscription.sql 086_education_etablissement_cartes_bulletins.sql 087_education_bulletins_documents.sql 088_social_appels.sql"

readonly PM2_BACKEND="malilink-backend"
readonly PM2_FRONTEND="malilink-frontend"
readonly REMOTE_BACKEND="malilink-backend"
readonly REMOTE_FRONTEND="malilink-frontend"
readonly REMOTES_INTERDITS="triangle|hafiya"

readonly RACINE_RELEASES="${RACINE_RELEASES:-/var/www/releases}"
readonly DOSSIER_SAUVEGARDE="${BACKUP_DIR:-/var/backups/malilink}"
readonly HORODATAGE="$(date +%Y%m%d_%H%M%S)"
readonly NOUVELLE="${RACINE_RELEASES}/malilink-social-education-${HORODATAGE}"
readonly ETAT="${RACINE_RELEASES}/.malilink-precedente.json"
readonly PORT_ESSAI="${PORT_ESSAI:-5098}"
readonly SITE="${SITE:-https://malilinkglobal.com}"

MODE="audit"
case "${1:-}" in
  --preparer) MODE="preparer" ;;
  --executer) MODE="executer" ;;
  --retour) MODE="retour" ;;
  "") ;;
  *) echo "Option inconnue : $1"; exit 2 ;;
esac

titre()  { printf '\n\033[1m══ %s\033[0m\n' "$1"; }
info()   { printf '   %s\n' "$1"; }
ok()     { printf '   \033[32m✓\033[0m %s\n' "$1"; }
alerte() { printf '   \033[33m!\033[0m %s\n' "$1"; }
stop()   { printf '\n\033[31mARRÊT : %s\033[0m\n\n' "$1" >&2; exit 1; }
trap 'stop "commande en échec ligne $LINENO — arrêt avant toute étape suivante."' ERR

command -v pm2 >/dev/null || stop "pm2 introuvable."
command -v node >/dev/null || stop "node introuvable."
command -v git >/dev/null || stop "git introuvable."

# Description PM2 d'un processus : cwd, script, arguments, interprète, mode.
pm2_info() {
  pm2 jlist 2>/dev/null | node -e '
    const nom = process.argv[1];
    const l = JSON.parse(require("fs").readFileSync(0, "utf8") || "[]");
    const p = l.find((x) => x.name === nom);
    if (!p) process.exit(3);
    const e = p.pm2_env || {};
    // Environnement propre au processus (NODE_ENV, PORT, variables posées dans PM2) :
    // il est rejoué tel quel à la bascule, sans les champs internes de PM2.
    const env = Object.fromEntries(Object.entries(e.env || {}).filter(([k, v]) =>
      typeof v === "string" && !/^(pm_|PM2_|unique_id$|NODE_APP_INSTANCE$|axm_|km_|vizion|treekill|restart_time$|status$|pm_id$)/i.test(k)));
    console.log(JSON.stringify({
      cwd: e.pm_cwd, script: e.pm_exec_path, args: e.args || [], interpreter: e.exec_interpreter || "node",
      node_args: e.node_args || [], instances: e.instances || 1, exec_mode: e.exec_mode || "fork_mode", status: e.status, env,
    }));' "$1"
}

# (Re)démarre un processus PM2 à partir de sa description, dans un dossier
# donné : fichier de configuration temporaire (droits 600, contient l'env).
demarrer() {
  local nom="$1" info_json="$2" cwd="$3" fichier
  fichier="$(mktemp /tmp/malilink-pm2-XXXXXX)"
  mv "$fichier" "$fichier.json"
  fichier="$fichier.json"
  chmod 600 "$fichier"
  node -e '
    const [nom, info, cwd, fichier] = process.argv.slice(1);
    const i = JSON.parse(info);
    const ancien = i.cwd.replace(/\/$/, "");
    const script = i.script.startsWith(ancien + "/") ? cwd + i.script.slice(ancien.length) : i.script;
    if (!require("fs").existsSync(script)) { console.error("script introuvable : " + script); process.exit(4); }
    const app = { name: nom, script, cwd, args: i.args, interpreter: i.interpreter, node_args: i.node_args,
      instances: i.instances, exec_mode: i.exec_mode.replace(/_mode$/, ""), env: i.env };
    require("fs").writeFileSync(fichier, JSON.stringify({ apps: [app] }, null, 2), { mode: 0o600 });
  ' "$nom" "$info_json" "$cwd" "$fichier" || { rm -f "$fichier"; return 1; }
  pm2 delete "$nom" >/dev/null 2>&1 || true
  pm2 start "$fichier" >/dev/null
  rm -f "$fichier"
}
champ() { node -e 'const o=JSON.parse(process.argv[1]); const v=o[process.argv[2]]; console.log(Array.isArray(v)?v.join(" "):(v??""))' "$1" "$2"; }

verifier_remote() {
  local dossier="$1" attendu="$2" remote
  remote="$(git -C "$dossier" remote get-url origin 2>/dev/null || true)"
  printf '%s' "$remote" | grep -qiE "$REMOTES_INTERDITS" && stop "$dossier pointe vers $remote (projet interdit)."
  printf '%s' "$remote" | grep -qE "${attendu}(\.git)?/?$" || stop "$dossier : remote inattendu ($remote), attendu $attendu."
}

# ═════════════════════════════ Retour arrière ═════════════════════════════
if [ "$MODE" = "retour" ]; then
  titre "RETOUR À LA RELEASE PRÉCÉDENTE"
  [ -f "$ETAT" ] || stop "aucune release précédente enregistrée ($ETAT)."
  for nom in "$PM2_BACKEND" "$PM2_FRONTEND"; do
    conf="$(node -e 'const s=require(process.argv[1]); console.log(JSON.stringify(s[process.argv[2]]))' "$ETAT" "$nom")"
    cwd="$(champ "$conf" cwd)"
    [ -d "$cwd" ] || stop "release précédente absente : $cwd"
    demarrer "$nom" "$conf" "$cwd" || stop "$nom : redémarrage impossible sur $cwd"
    ok "$nom → $cwd"
  done
  pm2 save >/dev/null
  ok "retour effectué (les migrations additives restent : l'ancienne version les ignore)."
  exit 0
fi

# ═══════════════════════════ 1. Release active ═══════════════════════════
titre "1. RELEASE ACTIVE (lue dans PM2)"
INFO_BACK="$(pm2_info "$PM2_BACKEND")" || stop "processus $PM2_BACKEND introuvable dans PM2."
INFO_FRONT="$(pm2_info "$PM2_FRONTEND")" || stop "processus $PM2_FRONTEND introuvable dans PM2."
BACK_ACTIF="$(champ "$INFO_BACK" cwd)"
FRONT_ACTIF="$(champ "$INFO_FRONT" cwd)"
info "backend  : $BACK_ACTIF ($(champ "$INFO_BACK" status))"
info "frontend : $FRONT_ACTIF ($(champ "$INFO_FRONT" status))"
verifier_remote "$BACK_ACTIF" "$REMOTE_BACKEND"
verifier_remote "$FRONT_ACTIF" "$REMOTE_FRONTEND"
ok "dépôts MaliLink identifiés par leur remote"
[ -f "$BACK_ACTIF/.env" ] || stop "$BACK_ACTIF/.env absent."
info "modifications locales du frontend actif (seront reportées) :"
git -C "$FRONT_ACTIF" status --short | sed 's/^/     /'
git -C "$FRONT_ACTIF" diff --quiet HEAD -- . ':!next-env.d.ts' && alerte "aucune modification locale suivie dans le frontend actif."
[ -d "$BACK_ACTIF/uploads" ] || stop "$BACK_ACTIF/uploads absent : arrêt (le dossier doit être conservé)."
TAILLE_UPLOADS="$(du -sk "$BACK_ACTIF/uploads" | cut -f1)"
LIBRE="$(df -Pk "$RACINE_RELEASES" | awk 'NR==2 {print $4}')"
info "uploads : $((TAILLE_UPLOADS / 1024)) Mo ; espace libre : $((LIBRE / 1024)) Mo"
[ "$LIBRE" -gt $((TAILLE_UPLOADS * 2 + 2 * 1024 * 1024)) ] || stop "espace disque insuffisant pour copier uploads et construire."

# ═════════════════════════ 2. Code et migrations ═════════════════════════
titre "2. CODE À DÉPLOYER ET MIGRATIONS"
git -C "$BACK_ACTIF" ls-remote origin >/dev/null 2>&1 || stop "accès au dépôt GitHub du backend impossible depuis le serveur."
info "backend  $SHA_BACKEND"
info "frontend $SHA_FRONTEND"
DATABASE_URL_PROD="$(grep -E '^DATABASE_URL=' "$BACK_ACTIF/.env" | head -1 | cut -d= -f2- | sed 's/^"//; s/"$//')"
[ -n "$DATABASE_URL_PROD" ] || stop "DATABASE_URL absent du .env du backend actif."
command -v psql >/dev/null || stop "psql introuvable."
psql "$DATABASE_URL_PROD" -Atqc "SELECT 1" >/dev/null || stop "connexion PostgreSQL impossible."
psql "$DATABASE_URL_PROD" -Atqc "SELECT to_regclass('schema_migrations') IS NOT NULL" | grep -q t \
  || stop "table schema_migrations absente : le suivi des migrations n'est pas initialisé (voir scripts/migrate.js --mark-all), arrêt."
DEJA="$(psql "$DATABASE_URL_PROD" -Atqc "SELECT filename FROM schema_migrations WHERE filename >= '084' ORDER BY 1" | tr '\n' ' ')"
info "migrations ≥ 084 déjà appliquées : ${DEJA:-aucune}"

if [ "$MODE" = "audit" ]; then
  titre "AUDIT TERMINÉ — rien n'a été modifié"
  info "Préparer sans basculer : $0 --preparer"
  info "Déployer et basculer   : $0 --executer"
  exit 0
fi

# ═══════════════════════════ 3. Sauvegarde PostgreSQL ═══════════════════════════
titre "3. SAUVEGARDE POSTGRESQL"
install -d -m 700 "$DOSSIER_SAUVEGARDE"
DUMP="$DOSSIER_SAUVEGARDE/malilink_avant_social_education_${HORODATAGE}.dump"
pg_dump -Fc "$DATABASE_URL_PROD" -f "$DUMP"
pg_restore --list "$DUMP" >/dev/null || stop "sauvegarde illisible : $DUMP"
ok "sauvegarde : $DUMP ($(du -h "$DUMP" | cut -f1))"

# ═══════════════════════════ 4. Nouvelle release backend ═══════════════════════════
titre "4. NOUVELLE RELEASE — BACKEND"
install -d "$NOUVELLE"
git clone -q --no-hardlinks "$BACK_ACTIF" "$NOUVELLE/backend"
git -C "$NOUVELLE/backend" remote set-url origin "$(git -C "$BACK_ACTIF" remote get-url origin)"
git -C "$NOUVELLE/backend" fetch -q origin
git -C "$NOUVELLE/backend" checkout -q --detach "$SHA_BACKEND"
cp -p "$BACK_ACTIF/.env" "$NOUVELLE/backend/.env"
rsync -a "$BACK_ACTIF/uploads/" "$NOUVELLE/backend/uploads/"
ok "code $SHA_BACKEND, .env et uploads copiés (l'original reste en place)"
(cd "$NOUVELLE/backend" && npm ci --omit=dev --no-audit --no-fund >/dev/null)
ok "dépendances installées"

titre "5. MIGRATIONS (additives)"
EN_ATTENTE="$(cd "$NOUVELLE/backend" && node scripts/migrate.js --status | sed -n 's/^  - //p' | tr '\n' ' ')"
info "en attente : ${EN_ATTENTE:-aucune}"
for f in $EN_ATTENTE; do
  case " $MIGRATIONS_ATTENDUES " in *" $f "*) ;; *) stop "migration inattendue en attente : $f (à examiner avant de continuer)." ;; esac
done
(cd "$NOUVELLE/backend" && node scripts/migrate.js)
ok "migrations appliquées"

titre "6. ESSAI DU NOUVEAU BACKEND (port $PORT_ESSAI, hors trafic)"
(cd "$NOUVELLE/backend" && PORT="$PORT_ESSAI" node server.js >"/tmp/malilink-essai-${HORODATAGE}.log" 2>&1 & echo $! >"/tmp/malilink-essai-${HORODATAGE}.pid")
for _ in $(seq 1 40); do curl -s -o /dev/null "http://127.0.0.1:${PORT_ESSAI}/" && break; sleep 1; done
code_verif="$(curl -s -o /tmp/verif.json -w '%{http_code}' "http://127.0.0.1:${PORT_ESSAI}/verification/AAAAAAAAAAAAAAAAAAAAAAAA" -H 'x-tenant-id: malilink')"
code_appels="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT_ESSAI}/social/calls/config" -H 'x-tenant-id: malilink')"
kill "$(cat "/tmp/malilink-essai-${HORODATAGE}.pid")" 2>/dev/null || true
[ "$code_verif" = "404" ] && grep -q '"authentique":false' /tmp/verif.json || stop "vérification publique inattendue ($code_verif) — voir /tmp/malilink-essai-${HORODATAGE}.log"
[ "$code_appels" = "401" ] || stop "route des appels inattendue ($code_appels)"
ok "le nouveau backend démarre et répond (vérification QR, appels protégés)"

# ═══════════════════════════ 7. Nouvelle release frontend ═══════════════════════════
titre "7. NOUVELLE RELEASE — FRONTEND"
git clone -q --no-hardlinks "$FRONT_ACTIF" "$NOUVELLE/frontend"
git -C "$NOUVELLE/frontend" remote set-url origin "$(git -C "$FRONT_ACTIF" remote get-url origin)"
git -C "$NOUVELLE/frontend" fetch -q origin
git -C "$NOUVELLE/frontend" checkout -q --detach "$SHA_FRONTEND"
PATCH="$NOUVELLE/modifications-locales-frontend.patch"
git -C "$FRONT_ACTIF" diff HEAD -- . ':!next-env.d.ts' >"$PATCH"
if [ -s "$PATCH" ]; then
  git -C "$NOUVELLE/frontend" apply --3way "$PATCH" \
    || stop "les modifications locales du frontend actif ne s'appliquent pas proprement ; voir $PATCH et $NOUVELLE/frontend (production intacte)."
  ok "modifications locales reportées : $(grep -c '^diff --git' "$PATCH") fichier(s)"
fi
for f in .env .env.local .env.production .env.production.local; do
  [ -f "$FRONT_ACTIF/$f" ] && cp -p "$FRONT_ACTIF/$f" "$NOUVELLE/frontend/$f" && info "copié : $f"
done
(cd "$NOUVELLE/frontend" && (npm ci --no-audit --no-fund >/dev/null 2>&1 || npm install --no-audit --no-fund >/dev/null))
(cd "$NOUVELLE/frontend" && NEXT_PUBLIC_APP_PRODUCT=malilink npm run build >"/tmp/malilink-build-${HORODATAGE}.log" 2>&1) \
  || stop "build du frontend en échec : /tmp/malilink-build-${HORODATAGE}.log (production intacte)."
ok "frontend construit"

if [ "$MODE" = "preparer" ]; then
  titre "RELEASE PRÊTE — production inchangée"
  info "release : $NOUVELLE"
  info "basculer : $0 --executer  (refait une release fraîche) ou basculer à la main sur ce dossier."
  exit 0
fi

# ═══════════════════════════ 8. Bascule PM2 ciblée ═══════════════════════════
titre "8. BASCULE PM2 (MaliLink uniquement)"
node -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify({[process.argv[2]]: JSON.parse(process.argv[3]), [process.argv[4]]: JSON.parse(process.argv[5])}, null, 2), { mode: 0o600 })' \
  "$ETAT" "$PM2_BACKEND" "$INFO_BACK" "$PM2_FRONTEND" "$INFO_FRONT"
ok "release précédente mémorisée : $ETAT"

basculer() {
  local nom="$1" info_json="$2" nouveau_cwd="$3" ancien_cwd
  ancien_cwd="$(champ "$info_json" cwd)"
  demarrer "$nom" "$info_json" "$nouveau_cwd" || stop "$nom : configuration impossible pour la nouvelle release (ancienne release toujours active)."
  sleep 6
  if [ "$(pm2_info "$nom" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0)).status)')" != "online" ]; then
    alerte "$nom ne démarre pas : retour immédiat à l'ancienne release"
    demarrer "$nom" "$info_json" "$ancien_cwd" || true
    stop "$nom remis sur $ancien_cwd."
  fi
  ok "$nom → $nouveau_cwd"
}
basculer "$PM2_BACKEND" "$INFO_BACK" "$NOUVELLE/backend"
basculer "$PM2_FRONTEND" "$INFO_FRONT" "$NOUVELLE/frontend"
pm2 save >/dev/null
ok "configuration PM2 enregistrée"

# ═══════════════════════════ 9. Contrôles en production ═══════════════════════════
titre "9. CONTRÔLES EN PRODUCTION"
sleep 5
c_accueil="$(curl -s -o /dev/null -w '%{http_code}' "$SITE/")"
c_verif="$(curl -s -o /dev/null -w '%{http_code}' "$SITE/api/verification/AAAAAAAAAAAAAAAAAAAAAAAA")"
c_page="$(curl -s -o /dev/null -w '%{http_code}' "$SITE/verifier/AAAAAAAAAAAAAAAAAAAAAAAA")"
c_appels="$(curl -s -o /dev/null -w '%{http_code}' "$SITE/api/social/calls/config")"
info "accueil $c_accueil · vérification API $c_verif · page de vérification $c_page · appels (sans compte) $c_appels"
if [ "$c_accueil" = "200" ] && [ "$c_verif" = "404" ] && [ "$c_page" = "200" ] && [ "$c_appels" = "401" ]; then
  ok "production saine"
else
  alerte "contrôle inattendu : vérifier, et si besoin revenir en arrière : $0 --retour"
fi
titre "DÉPLOIEMENT TERMINÉ"
info "release : $NOUVELLE"
info "sauvegarde : $DUMP"
info "retour arrière : $0 --retour"
