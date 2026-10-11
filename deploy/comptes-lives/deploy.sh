#!/usr/bin/env bash
#
# MaliLink — comptes (validation administrative, emails/OTP, Super Admin ›
# Modifier) + directs MaliLink Social isolés par tenant.
#
#   bash deploy.sh                                AUDIT : vérifie tout, n'écrit rien
#   bash deploy.sh --executer                     déploiement
#   bash deploy.sh --retour-arriere <sauvegarde>  retour manuel à l'état d'avant
#
# Ne touche QUE malilink-backend et malilink-frontend (jamais Triangle,
# HAFIYA, Nginx, ADA/facturation). Academy est conservée : les fichiers
# modifiés sont contrôlés par empreinte contre la version de production.
#
# Sûreté :
#  - les migrations sont d'abord RÉPÉTÉES sur une copie de la base, sur le
#    même serveur PostgreSQL ; un échec arrête tout avant la moindre modification ;
#  - de la mise à jour du backend à la fin de la bascule du frontend, toute
#    erreur (ERR) ou interruption (INT, TERM, HUP) déclenche le retour arrière :
#    fichiers backend d'origine, ancienne release frontend relancée avec sa
#    définition PM2 complète (script, arguments, interpréteur, environnement) ;
#  - le retour arrière n'est annoncé « vérifié » qu'après contrôle du service
#    restauré : définition PM2 identique, processus en ligne et stable,
#    réponses HTTP attendues. Sinon : « NON VÉRIFIÉ » et code de sortie 3.
set -Eeuo pipefail
umask 077

HERE="$(cd -- "$(dirname -- "$0")" && pwd)"
SITE="${SITE:-https://malilinkglobal.com}"
STAMP="$(date +%Y%m%d_%H%M%S)"
APP_BACK=malilink-backend
APP_FRONT=malilink-frontend
MIGRATIONS_ATTENDUES="089_comptes_validation_courriels.sql 090_social_lives.sql"
MODE="audit"
case "${1:-}" in
  "") ;;
  --executer) MODE="executer" ;;
  --retour-arriere) MODE="retour"; SAVE="${2:?dossier de sauvegarde attendu}" ;;
  *) echo "usage : bash deploy.sh [--executer | --retour-arriere <dossier>]" >&2; exit 2 ;;
esac

titre()  { printf '\n\033[1m══ %s\033[0m\n' "$1"; }
ok()     { printf '   \033[32m✓\033[0m %s\n' "$1"; }
info()   { printf '   %s\n' "$1"; }
alerte() { printf '   \033[33m!\033[0m %s\n' "$1"; }
stop()   { printf '\n\033[31mARRÊT : %s\033[0m\n' "$1" >&2; exit 1; }
# Échec d'un contrôle : code 1 → set -e → piège EXIT (retour arrière si besoin).
echec()  { printf '   \033[31m✗\033[0m %s\n' "$1" >&2; return 1; }

exec 9>/root/malilink-comptes-lives.lock
flock -n 9 || stop "un déploiement est déjà en cours."
for c in pm2 node psql pg_dump pg_restore curl sha256sum; do command -v "$c" >/dev/null || stop "$c est nécessaire."; done
PM2="$(command -v pm2)"
# Le verrou (descripteur 9) n'est jamais transmis à PM2 : un démon lancé ici ne le garderait pas.
pm2c() { "$PM2" "$@" 9>&-; }
# Lancement à environnement vide : seul l'environnement ENREGISTRÉ de
# l'application compte, rien de la session en cours ne s'y mêle.
pm2_propre() { env -i HOME="$HOME" PATH="$PATH" ${PM2_HOME:+PM2_HOME="$PM2_HOME"} "$PM2" "$@" 9>&-; }

# Outils PM2 (lecture de « pm2 jlist » sur l'entrée standard).
#   definition NOM [CWD]        → écosystème complet du processus (cwd remplaçable)
#   comparer NOM FICHIER        → processus en ligne ET définition identique (sinon écarts, code 1)
#   etat NOM                    → « statut redémarrages pid cwd »
#   autres NOM1,NOM2            → autres processus : « nom pid redémarrages »
#   executer FICHIER CMD ARGS…  → lance CMD avec l'environnement enregistré (pas de stdin)
read -r -d '' JS_PM2 <<'JS' || true
const fs = require("fs");
const [mode, ...a] = process.argv.slice(1);
const liste = () => JSON.parse(fs.readFileSync(0, "utf8"));
const trouver = (nom) => liste().find((x) => x.name === nom);
const SECRET = /PASS|SECRET|TOKEN|KEY|DATABASE_URL|PRIVATE/i;
function definition(p, cwd) {
  const e = p.pm2_env, interne = new Set(["unique_id", "_", e.name]);
  const env = {};
  for (const k of Object.keys(e.env || {}).sort()) if (!interne.has(k) && !k.startsWith("PM2_")) env[k] = e.env[k];
  const app = { name: e.name, script: e.pm_exec_path, args: e.args || [], cwd: cwd || e.pm_cwd, interpreter: e.exec_interpreter,
    node_args: e.node_args || [], exec_mode: e.exec_mode === "cluster_mode" ? "cluster" : "fork", instances: Number(e.instances) || 1, env };
  for (const [k, source] of [["max_memory_restart"], ["autorestart"], ["watch"], ["namespace"], ["merge_logs"], ["kill_timeout"],
    ["listen_timeout"], ["min_uptime"], ["max_restarts"], ["restart_delay"], ["exp_backoff_restart_delay"], ["log_date_format"],
    ["time"], ["treekill"], ["out_file", "pm_out_log_path"], ["error_file", "pm_err_log_path"]]) {
    const v = e[source || k];
    if (v !== undefined && v !== null) app[k] = v;
  }
  return app;
}
const tri = (o) => (Array.isArray(o) ? o.map(tri) : o && typeof o === "object" ? Object.fromEntries(Object.keys(o).sort().map((k) => [k, tri(o[k])])) : o);
if (mode === "definition") {
  const p = trouver(a[0]);
  if (!p) { console.error(`processus ${a[0]} absent de PM2`); process.exit(1); }
  console.log(JSON.stringify({ apps: [definition(p, a[1])] }, null, 1));
} else if (mode === "comparer") {
  const p = trouver(a[0]);
  if (!p) { console.log(`   processus ${a[0]} absent`); process.exit(1); }
  const attendu = JSON.parse(fs.readFileSync(a[1], "utf8")).apps[0], reel = definition(p);
  const ecarts = [];
  if (p.pm2_env.status !== "online") ecarts.push(`statut ${p.pm2_env.status}`);
  // Champs de la définition enregistrée (PM2 peut ajouter ses valeurs par défaut) ; environnement : dans les deux sens.
  for (const k of Object.keys(attendu)) {
    if (k === "env") continue;
    if (JSON.stringify(tri(attendu[k])) !== JSON.stringify(tri(reel[k]))) ecarts.push(`${k} : ${JSON.stringify(attendu[k])} → ${JSON.stringify(reel[k])}`);
  }
  for (const k of new Set([...Object.keys(attendu.env), ...Object.keys(reel.env)])) {
    if (attendu.env[k] === reel.env[k]) continue;
    const m = (v) => (v === undefined ? "(absente)" : SECRET.test(k) ? "(valeur masquée)" : JSON.stringify(v));
    ecarts.push(`env ${k} : ${m(attendu.env[k])} → ${m(reel.env[k])}`);
  }
  for (const x of ecarts) console.log(`   écart ${x}`);
  process.exit(ecarts.length ? 1 : 0);
} else if (mode === "etat") {
  const p = trouver(a[0]);
  console.log(p ? `${p.pm2_env.status} ${p.pm2_env.restart_time} ${p.pid} ${p.pm2_env.pm_cwd}` : "absent");
} else if (mode === "autres") {
  const nos = new Set(a[0].split(","));
  for (const p of liste().filter((x) => !nos.has(x.name)).sort((x, y) => x.pm_id - y.pm_id)) console.log(`${p.name} ${p.pid} ${p.pm2_env.restart_time}`);
} else if (mode === "executer") {
  const app = JSON.parse(fs.readFileSync(a[0], "utf8")).apps[0];
  const env = { ...app.env, PATH: app.env.PATH || process.env.PATH, NEXT_PUBLIC_APP_PRODUCT: app.env.NEXT_PUBLIC_APP_PRODUCT || "malilink" };
  const r = require("child_process").spawnSync(a[1], a.slice(2), { env, stdio: ["ignore", "inherit", "inherit"] });
  process.exit(r.status === null ? 1 : r.status);
}
JS
pm2js() { pm2c jlist | node -e "$JS_PM2" "$@"; }

cwd_de() { local pid; pid="$(pm2c pid "$1" 2>/dev/null || true)"; [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1; readlink -f "/proc/$pid/cwd"; }

# En ligne, puis STABLE : même pid et aucun redémarrage pendant 8 s.
attendre_stable() {
  local e1="" e2 i
  for i in $(seq 1 40); do e1="$(pm2js etat "$1")"; [[ "$e1" == online* ]] && break; sleep 1; done
  [[ "$e1" == online* ]] || { info "$1 : ${e1:-absent}"; return 1; }
  sleep 8
  e2="$(pm2js etat "$1")"
  [ "$e1" = "$e2" ] || { info "$1 instable : « $e1 » puis « $e2 »"; return 1; }
}
DERNIER_CODE=""
attendre_http() {  # chemin  codes (regex)  délai en secondes
  local limite=$((SECONDS + ${3:-90}))
  while :; do
    DERNIER_CODE="$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$SITE$1" || true)"
    [[ "$DERNIER_CODE" =~ ^($2)$ ]] && return 0
    [ "$SECONDS" -ge "$limite" ] && return 1
    sleep 2
  done
}

# ───────────────────────────── Retour arrière (automatique ou manuel) ──────────
BACK_TOUCHE=0; FRONT_TOUCHE=0; REPET_BASE=""; REPET_PAR=""; SIGNAL=""; LIGNE=""; CMD=""

restaurer_frontend() {
  info "frontend : relance de l'ancienne release avec sa définition PM2 d'origine"
  pm2c delete "$APP_FRONT" >/dev/null 2>&1 || true
  pm2_propre start "$SAVE/pm2-frontend-avant.json" >/dev/null 2>&1 || { info "pm2 start (ancienne définition) en échec"; return 1; }
}
verifier_frontend() {
  local bon=0
  attendre_stable "$APP_FRONT" || bon=1
  pm2js comparer "$APP_FRONT" "$SAVE/pm2-frontend-avant.json" || bon=1
  [ "$(cwd_de "$APP_FRONT" || true)" = "$FRONT" ] || { info "frontend : répertoire $(cwd_de "$APP_FRONT" || echo '?') au lieu de $FRONT"; bon=1; }
  attendre_http "/" "200" 90 || { info "frontend : / répond $DERNIER_CODE"; bon=1; }
  attendre_http "/education/academy" "200|307|308" 30 || { info "frontend : /education/academy répond $DERNIER_CODE"; bon=1; }
  [ "$bon" = 0 ] && ok "frontend restauré et vérifié : $FRONT (définition PM2 identique, stable, HTTP 200)"
  return "$bon"
}
restaurer_backend() {
  local h f rel
  info "backend : remise des fichiers d'origine"
  while read -r h f; do [[ "$f" == backend/* ]] || continue; rel="${f#backend/}"; cp -a "$SAVE/backend/$rel" "$BACK/$rel"; done < "$SAVE/avant.sha256"
  while read -r f; do [[ "$f" == backend/* ]] && rm -f "$BACK/${f#backend/}"; done < "$SAVE/nouveaux.txt"
  pm2c restart "$APP_BACK" >/dev/null 2>&1 || { info "pm2 restart $APP_BACK en échec"; return 1; }
}
verifier_backend() {
  local bon=0 h f rel
  while read -r h f; do
    [[ "$f" == backend/* ]] || continue; rel="${f#backend/}"
    [ "$(sha256sum "$BACK/$rel" 2>/dev/null | cut -d' ' -f1)" = "$h" ] || { info "backend : $rel différent de l'original"; bon=1; }
  done < "$SAVE/avant.sha256"
  while read -r f; do [[ "$f" == backend/* ]] && [ -e "$BACK/${f#backend/}" ] && { info "backend : ${f#backend/} encore présent"; bon=1; }; done < "$SAVE/nouveaux.txt"
  attendre_stable "$APP_BACK" || bon=1
  pm2js comparer "$APP_BACK" "$SAVE/pm2-backend-avant.json" || bon=1
  [ "$(cwd_de "$APP_BACK" || true)" = "$BACK" ] || { info "backend : mauvais répertoire"; bon=1; }
  attendre_http "/api/education/learning/programs" "401|403" 60 || { info "backend : Academy répond $DERNIER_CODE"; bon=1; }
  [ "$bon" = 0 ] && ok "backend restauré et vérifié : fichiers d'origine (empreintes), processus stable, Academy protégée"
  return "$bon"
}
retour_arriere() {
  local bon=0
  [ "$FRONT_TOUCHE" = 1 ] && { restaurer_frontend || bon=1; }
  [ "$BACK_TOUCHE" = 1 ] && { restaurer_backend || bon=1; }
  [ "$FRONT_TOUCHE" = 1 ] && { verifier_frontend || bon=1; }
  [ "$BACK_TOUCHE" = 1 ] && { verifier_backend || bon=1; }
  verifier_autres || true
  # La sauvegarde PM2 n'est réécrite que pour un état restauré ET vérifié.
  [ "$bon" = 0 ] && pm2c save --force >/dev/null 2>&1
  return "$bon"
}
supprimer_repetition() {
  [ -n "$REPET_BASE" ] || return 0
  if [ "$REPET_PAR" = postgres ]; then runuser -u postgres -- psql -qc "DROP DATABASE IF EXISTS \"$REPET_BASE\"" >/dev/null 2>&1
  else psql "$DATABASE_URL" -qc "DROP DATABASE IF EXISTS \"$REPET_BASE\"" >/dev/null 2>&1; fi \
    && { info "base de répétition $REPET_BASE supprimée"; REPET_BASE=""; } || alerte "base de répétition $REPET_BASE à supprimer à la main"
}
verifier_autres() {
  [ -f "${SAVE:-/nonexistent}/pm2-autres-avant.txt" ] || return 0
  if [ "$(pm2js autres "$APP_BACK,$APP_FRONT")" = "$(cat "$SAVE/pm2-autres-avant.txt")" ]; then
    ok "autres applications PM2 (Triangle, HAFIYA…) : mêmes pid, aucun redémarrage"
  else alerte "autres applications PM2 : état différent d'avant le déploiement (à examiner)"; fi
}
fin() {
  local code="$1"
  trap - ERR; trap '' INT TERM HUP
  set +e
  supprimer_repetition
  [ "$code" = 0 ] && exit 0
  if [ "$BACK_TOUCHE" = 0 ] && [ "$FRONT_TOUCHE" = 0 ]; then
    printf '\n\033[31mARRÊT (code %s%s) — production NON modifiée.\033[0m\n' "$code" "${SIGNAL:+, signal $SIGNAL}" >&2
    exit "$code"
  fi
  printf '\n\033[31mÉCHEC (code %s%s%s) : retour arrière automatique.\033[0m\n' "$code" "${SIGNAL:+, signal $SIGNAL}" "${LIGNE:+, ligne $LIGNE : $CMD}" >&2
  if retour_arriere; then
    printf '\n\033[32mRETOUR ARRIÈRE VÉRIFIÉ\033[0m — production remise dans son état d'"'"'avant (migrations additives conservées).\n'
    exit "$code"
  fi
  printf '\n\033[31mRETOUR ARRIÈRE NON VÉRIFIÉ\033[0m — intervention manuelle nécessaire :\n'
  info "pm2 status ; pm2 logs $APP_FRONT --lines 50 ; pm2 logs $APP_BACK --lines 50"
  info "définitions d'origine : $SAVE/pm2-frontend-avant.json ; nouvel essai : bash $SAVE/rollback.sh"
  exit 3
}
armer_pieges() {
  trap 'LIGNE=$LINENO; CMD=$BASH_COMMAND' ERR
  trap 'SIGNAL=INT; exit 130' INT
  trap 'SIGNAL=TERM; exit 143' TERM
  trap 'SIGNAL=HUP; exit 129' HUP
  trap 'fin $?' EXIT
}

# ───────────────────────────── Retour arrière manuel ──────────────────────────
if [ "$MODE" = "retour" ]; then
  SAVE="$(readlink -f "$SAVE")"
  [ -f "$SAVE/etat.env" ] && [ -f "$SAVE/pm2-frontend-avant.json" ] || stop "$SAVE n'est pas une sauvegarde de ce déploiement."
  # shellcheck disable=SC1091
  . "$SAVE/etat.env"
  SITE="$SITE_DEPLOIEMENT"
  exec > >(trap '' INT TERM HUP; exec tee -a "$SAVE/retour-arriere.log") 2>&1
  titre "RETOUR ARRIÈRE MANUEL vers l'état d'avant $SAVE"
  trap '' INT TERM HUP   # une restauration commencée va jusqu'au bout
  BACK_TOUCHE=1; FRONT_TOUCHE=1
  if retour_arriere; then printf '\n\033[32mRETOUR ARRIÈRE VÉRIFIÉ\033[0m (migrations additives conservées).\n'; exit 0; fi
  printf '\n\033[31mRETOUR ARRIÈRE NON VÉRIFIÉ\033[0m — voir ci-dessus ; pm2 status ; pm2 logs %s --lines 50\n' "$APP_FRONT"
  exit 3
fi

# ───────────────────────────── 1. Releases actives ─────────────────────────────
titre "1. RELEASES ACTIVES (lues dans PM2)"
BACK="$(cwd_de "$APP_BACK")" || stop "$APP_BACK n'est pas en ligne."
FRONT="$(cwd_de "$APP_FRONT")" || stop "$APP_FRONT n'est pas en ligne."
[[ "$BACK" == /var/www/* && "$FRONT" == /var/www/* ]] || stop "releases hors de /var/www : $BACK / $FRONT"
for d in "$BACK" "$FRONT"; do
  r="$(git -C "$d" remote get-url origin 2>/dev/null || true)"
  printf '%s' "$r" | grep -qiE "triangle|hafiya" && stop "$d appartient à un autre produit ($r)."
done
[ -f "$FRONT/package.json" ] || stop "$FRONT/package.json absent."
info "backend  : $BACK"
info "frontend : $FRONT"
info "frontend lancé par : $(pm2js definition "$APP_FRONT" | node -e 'const a=JSON.parse(require("fs").readFileSync(0,"utf8")).apps[0];console.log(`${a.script} ${a.args.join(" ")} (${a.exec_mode}, ${Object.keys(a.env).length} variables d\x27environnement)`)')"

# ───────────────────────────── 2. Paquet et empreintes ─────────────────────────
titre "2. PAQUET ET FICHIERS DE PRODUCTION"
(cd "$HERE" && sha256sum -c --quiet payload.sha256) || stop "paquet altéré (payload.sha256)."
ok "paquet intègre"
DIFFERENTS=""
while read -r h f; do
  rel="${f#*/}"; base="$BACK"; [[ "$f" == frontend/* ]] && base="$FRONT"
  [ -f "$base/$rel" ] || { DIFFERENTS="$DIFFERENTS\n   absent : $f"; continue; }
  [ "$(sha256sum "$base/$rel" | cut -d' ' -f1)" = "$h" ] || DIFFERENTS="$DIFFERENTS\n   modifié depuis l'export : $f"
done < "$HERE/avant.sha256"
while read -r f; do
  rel="${f#*/}"; base="$BACK"; [[ "$f" == frontend/* ]] && base="$FRONT"
  if [ -e "$base/$rel" ] && ! cmp -s "$base/$rel" "$HERE/payload/$f"; then DIFFERENTS="$DIFFERENTS\n   existe déjà avec un autre contenu : $f"; fi
done < "$HERE/nouveaux.txt"
[ -z "$DIFFERENTS" ] || stop "la production ne correspond pas à la version attendue :$(printf "$DIFFERENTS")\n   Envoyez ces fichiers pour adaptation ; rien n'a été modifié."
ok "les $(wc -l < "$HERE/avant.sha256") fichiers à modifier sont exactement ceux de production (Academy comprise)"
node -e 'if (typeof fetch !== "function" || !AbortSignal.timeout) process.exit(1)' || stop "Node.js 18 ou plus récent requis."
ok "Node.js $(node -v) · PM2 $(pm2c -v 2>/dev/null | tail -1)"

# ───────────────────────────── 3. Configuration et base ────────────────────────
titre "3. CONFIGURATION EFFECTIVE DE $APP_BACK (sans secret) ET BASE"
pm2c jlist | BACK="$BACK" node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync(0, "utf8")).find((x) => x.name === "malilink-backend");
  const env = (p && p.pm2_env && p.pm2_env.env) || {};
  const fichier = {};
  try { for (const l of fs.readFileSync(process.env.BACK + "/.env", "utf8").split(/\r?\n/)) { const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(l); if (m) fichier[m[1]] = m[2].replace(/^["\x27]|["\x27]$/g, ""); } } catch {}
  const masque = (k, v) => !v ? "" : /PASS|SECRET/.test(k) ? "(défini)" : /USER|FROM|KEY/.test(k) ? v.slice(0, 2) + "***" + (v.includes("@") ? "@" + v.split("@")[1].slice(0, 2) + "***" : "") : v;
  for (const k of ["SMTP_HOST","SMTP_PORT","SMTP_SECURE","SMTP_USER","SMTP_PASS","SMTP_FROM","PUBLIC_BASE_URL","LIVEKIT_URL","LIVEKIT_API_KEY","LIVEKIT_API_SECRET"]) {
    const v = env[k] || fichier[k] || "";
    console.log(`   ${k.padEnd(19)} ${v ? "présent " + masque(k, v) : "ABSENT"}  (${env[k] ? "PM2" : fichier[k] ? ".env" : "—"})`);
  }'
DATABASE_URL="$(pm2c jlist | node -e 'const p=JSON.parse(require("fs").readFileSync(0,"utf8")).find(x=>x.name==="malilink-backend");process.stdout.write((p&&p.pm2_env&&p.pm2_env.env&&p.pm2_env.env.DATABASE_URL)||"")')"
[ -n "$DATABASE_URL" ] || DATABASE_URL="$(grep -E '^DATABASE_URL=' "$BACK/.env" | head -1 | cut -d= -f2- | sed 's/^"//; s/"$//')"
[ -n "$DATABASE_URL" ] || stop "DATABASE_URL introuvable (PM2 ou $BACK/.env)."
psql "$DATABASE_URL" -Atqc "SELECT 1" >/dev/null || stop "connexion PostgreSQL impossible."
MOTEUR="$(psql "$DATABASE_URL" -Atqc "SHOW server_version")"
MOTEUR_MAJ="$(psql "$DATABASE_URL" -Atqc "SHOW server_version_num" | cut -c1-2)"
DUMP_MAJ="$(pg_dump --version | grep -oE '[0-9]+' | head -1)"
ok "PostgreSQL joignable : moteur $MOTEUR · pg_dump $(pg_dump --version | grep -oE '[0-9]+(\.[0-9]+)?' | head -1)"
[ "$DUMP_MAJ" -ge "$MOTEUR_MAJ" ] || stop "pg_dump $DUMP_MAJ est plus ancien que le serveur $MOTEUR_MAJ : sauvegarde impossible."
EN_ATTENTE=""
for f in "$BACK"/sql/*.sql "$HERE"/payload/backend/sql/*.sql; do
  n="$(basename "$f")"
  psql "$DATABASE_URL" -Atqc "SELECT 1 FROM schema_migrations WHERE filename='$n'" | grep -q 1 || EN_ATTENTE="$EN_ATTENTE $n"
done
EN_ATTENTE="$(printf '%s\n' $EN_ATTENTE | sort -u | tr '\n' ' ')"
info "migrations à appliquer : ${EN_ATTENTE:-aucune}"
for n in $EN_ATTENTE; do case " $MIGRATIONS_ATTENDUES " in *" $n "*) ;; *) stop "migration inattendue en attente : $n (à examiner d'abord)." ;; esac; done
if [ "$(psql "$DATABASE_URL" -Atqc "SELECT rolcreatedb OR rolsuper FROM pg_roles WHERE rolname=current_user")" = t ]; then
  REPET_PAR=app; ok "répétition des migrations possible : base temporaire créée par le rôle de l'application"
elif command -v runuser >/dev/null && runuser -u postgres -- psql -Atqc "SELECT 1" >/dev/null 2>&1; then
  REPET_PAR=postgres; ok "répétition des migrations possible : base temporaire créée par le compte postgres local"
else
  REPET_PAR=""; alerte "répétition des migrations IMPOSSIBLE (ni droit CREATEDB, ni compte postgres local) : le déploiement s'arrêtera."
fi

# ───────────────────────────── 4. Infrastructure des directs ───────────────────
titre "4. INFRASTRUCTURE DES DIRECTS (constat réel)"
RTC_IP="$(getent hosts rtc.malilinkglobal.com | awk '{print $1}' | head -1 || true)"
info "DNS rtc.malilinkglobal.com : ${RTC_IP:-NE RÉSOUT PAS}"
CODE_RTC="$(curl -s -m 8 -o /dev/null -w '%{http_code}' https://rtc.malilinkglobal.com/ 2>/dev/null || true)"
info "HTTPS rtc : $([ "${CODE_RTC:-000}" = 000 ] && echo injoignable || echo "$CODE_RTC")"
info "service livekit : $(systemctl is-active livekit 2>/dev/null || echo 'absent')"
info "ports à l'écoute : $( (ss -lntu 2>/dev/null | grep -E ':(7880|7881|7882|3478)\b' | awk '{print $1" "$5}' | tr '\n' ' ') || true)"
alerte "Sans serveur LiveKit joignable, l'application affiche « Directs indisponibles » (aucun direct simulé)."
[ -d "$FRONT/node_modules/livekit-client" ] && ok "livekit-client présent dans le frontend" || alerte "livekit-client absent : il sera installé dans la copie (sans modifier package.json)."

if [ "$MODE" = "audit" ]; then
  titre "AUDIT TERMINÉ — rien n'a été modifié"
  info "Pour déployer (de préférence dans tmux) : bash $HERE/deploy.sh --executer"
  exit 0
fi
[ -n "$REPET_PAR" ] || stop "répétition des migrations impossible : production intacte (voir section 3)."

# ───────────────────────────── 5. Sauvegardes ──────────────────────────────────
titre "5. SAUVEGARDES (code, configuration protégée, définitions PM2, base)"
SAVE="/root/backups/malilink-comptes-lives-$STAMP"
NEW_FRONT="/var/www/releases/malilink-comptes-lives-$STAMP/frontend"
install -d -m 700 "$SAVE" "$SAVE/backend"
# Journal complet ; tee ignore INT/TERM/HUP pour que le retour arrière reste tracé.
exec > >(trap '' INT TERM HUP; exec tee -a "$SAVE/deploiement.log") 2>&1
armer_pieges
cp "$HERE/avant.sha256" "$HERE/nouveaux.txt" "$SAVE/"
cp "$HERE/deploy.sh" "$SAVE/deploy.sh"
{ printf 'BACK=%q\n' "$BACK"; printf 'FRONT=%q\n' "$FRONT"; printf 'NEW_FRONT=%q\n' "$NEW_FRONT"; printf 'SITE_DEPLOIEMENT=%q\n' "$SITE"; } > "$SAVE/etat.env"
pm2c jlist > "$SAVE/pm2-private.json"
pm2js definition "$APP_FRONT" > "$SAVE/pm2-frontend-avant.json"
pm2js definition "$APP_FRONT" "$NEW_FRONT" > "$SAVE/pm2-frontend-nouveau.json"
pm2js definition "$APP_BACK" > "$SAVE/pm2-backend-avant.json"
pm2js autres "$APP_BACK,$APP_FRONT" > "$SAVE/pm2-autres-avant.txt"
pm2js comparer "$APP_FRONT" "$SAVE/pm2-frontend-avant.json" >/dev/null || stop "définition PM2 du frontend illisible."
cp -a "$BACK/.env" "$SAVE/backend.env" 2>/dev/null || true
for f in .env .env.local .env.production; do [ -f "$FRONT/$f" ] && cp -a "$FRONT/$f" "$SAVE/frontend$f"; done
git -C "$BACK" status --short > "$SAVE/backend-status.txt" 2>/dev/null || true
git -C "$FRONT" status --short > "$SAVE/frontend-status.txt" 2>/dev/null || true
while read -r h f; do [[ "$f" == backend/* ]] || continue; rel="${f#backend/}"; mkdir -p "$SAVE/backend/$(dirname "$rel")"; cp -a "$BACK/$rel" "$SAVE/backend/$rel"; done < "$HERE/avant.sha256"
pg_dump -Fc "$DATABASE_URL" -f "$SAVE/base-avant.dump"
pg_restore --list "$SAVE/base-avant.dump" >/dev/null || stop "sauvegarde de la base illisible."
ok "sauvegardes : $SAVE (base $(du -h "$SAVE/base-avant.dump" | cut -f1), définitions PM2 complètes)"
printf '#!/usr/bin/env bash\n# Retour à l'"'"'état d'"'"'avant le déploiement %s (les migrations additives restent).\nexec bash %q --retour-arriere %q\n' "$STAMP" "$SAVE/deploy.sh" "$SAVE" > "$SAVE/rollback.sh"
chmod 700 "$SAVE/rollback.sh"
ok "retour arrière manuel prêt : bash $SAVE/rollback.sh"

# ───────────────────────────── 6. Répétition des migrations ────────────────────
titre "6. RÉPÉTITION DES MIGRATIONS SUR UNE COPIE DE LA BASE (moteur $MOTEUR)"
TAILLE="$(psql "$DATABASE_URL" -Atqc "SELECT pg_database_size(current_database())")"
LIBRE="$(( $(df -Pk / | awk 'NR==2 {print $4}') * 1024 ))"
[ "$LIBRE" -gt $(( TAILLE * 2 + 1073741824 )) ] || stop "espace disque insuffisant pour la copie ($(( LIBRE / 1048576 )) Mo libres, base $(( TAILLE / 1048576 )) Mo) : production intacte."
REPET_NOM="malilink_repetition_${STAMP}"
ROLE_APP="$(psql "$DATABASE_URL" -Atqc "SELECT current_user")"
if [ "$REPET_PAR" = app ]; then psql "$DATABASE_URL" -qc "CREATE DATABASE \"$REPET_NOM\"" >/dev/null
else runuser -u postgres -- psql -qc "CREATE DATABASE \"$REPET_NOM\" OWNER \"$ROLE_APP\"" >/dev/null; fi
REPET_BASE="$REPET_NOM"
URL_REPET="$(DATABASE_URL="$DATABASE_URL" B="$REPET_NOM" node -e 'const u=new URL(process.env.DATABASE_URL);u.pathname="/"+process.env.B;process.stdout.write(u.toString())')"
# Avec le compte postgres : propriétaires et droits conservés comme en production
# (les migrations tournent ensuite avec le rôle de l'application, comme en vrai).
if [ "$REPET_PAR" = postgres ]; then runuser -u postgres -- pg_restore -d "$REPET_NOM" < "$SAVE/base-avant.dump" > "$SAVE/repetition-restauration.log" 2>&1
else pg_restore --no-owner --no-acl -d "$URL_REPET" "$SAVE/base-avant.dump" > "$SAVE/repetition-restauration.log" 2>&1; fi \
  || alerte "pg_restore a signalé des avertissements : $SAVE/repetition-restauration.log"
compter() { psql "$1" -Atqc "SELECT (SELECT count(*) FROM information_schema.tables WHERE table_schema='public')||' tables, '||(SELECT count(*) FROM schema_migrations)||' migrations, '||(SELECT count(*) FROM users)||' utilisateurs'"; }
AVANT_PROD="$(compter "$DATABASE_URL")"
[ "$(compter "$URL_REPET")" = "$AVANT_PROD" ] || echec "copie incomplète : $(compter "$URL_REPET") au lieu de $AVANT_PROD"
ok "copie conforme : $AVANT_PROD"
RUN="$SAVE/repetition"; mkdir -p "$RUN/scripts" "$RUN/sql"
cp "$BACK/scripts/migrate.js" "$RUN/scripts/"; cp "$BACK"/sql/*.sql "$HERE"/payload/backend/sql/*.sql "$RUN/sql/"; ln -s "$BACK/node_modules" "$RUN/node_modules"
(cd "$RUN" && DATABASE_URL="$URL_REPET" node scripts/migrate.js) > "$SAVE/repetition-migrations.log" 2>&1 \
  || { tail -15 "$SAVE/repetition-migrations.log"; echec "migrations en échec sur la copie : production intacte"; }
VERIF="$(psql "$URL_REPET" -Atqc "SELECT
   (SELECT count(*) FROM schema_migrations WHERE filename IN ('089_comptes_validation_courriels.sql','090_social_lives.sql')) = 2
   AND to_regclass('public.account_admin_validations') IS NOT NULL AND to_regclass('public.account_email_changes') IS NOT NULL
   AND to_regclass('public.email_delivery_log') IS NOT NULL AND to_regclass('public.social_lives') IS NOT NULL
   AND to_regclass('public.social_live_viewers') IS NOT NULL AND to_regclass('public.social_live_comments') IS NOT NULL
   AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='tokens_valid_after')
   AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='companies' AND column_name='admin_validated_at')
   AND (SELECT enabled FROM social_feature_flags WHERE flag_key='social_lives_enabled') IS FALSE")"
[ "$VERIF" = t ] || echec "schéma attendu absent après migration de la copie"
(cd "$RUN" && DATABASE_URL="$URL_REPET" node scripts/migrate.js --status) | grep -qE "En attente +: 0" || echec "migrations non idempotentes sur la copie"
[ "$(psql "$URL_REPET" -Atqc "SELECT count(*) FROM users")" = "$(psql "$DATABASE_URL" -Atqc "SELECT count(*) FROM users")" ] || echec "données modifiées par la migration"
ok "migrations 089 et 090 appliquées sur la copie (moteur $MOTEUR, données réelles), schéma conforme, rejouables sans effet"
supprimer_repetition

# ───────────────────────────── 7. Frontend construit à part ────────────────────
titre "7. FRONTEND : COPIE ET CONSTRUCTION (production intacte)"
install -d "$(dirname "$NEW_FRONT")"
cp -a "$FRONT" "$NEW_FRONT"
rm -rf "$NEW_FRONT/.next"
while read -r f; do [[ "$f" == frontend/* ]] && { mkdir -p "$NEW_FRONT/$(dirname "${f#frontend/}")"; cp "$HERE/payload/$f" "$NEW_FRONT/${f#frontend/}"; }; done < <(cd "$HERE/payload" && find frontend -type f)
if [ ! -d "$NEW_FRONT/node_modules/livekit-client" ]; then (cd "$NEW_FRONT" && npm install --no-save --no-audit --no-fund livekit-client@2.22.3 >/dev/null); fi
# Construction avec l'environnement enregistré du frontend (celui de la production).
(cd "$NEW_FRONT" && node -e "$JS_PM2" executer "$SAVE/pm2-frontend-avant.json" npm run build > "$SAVE/build-frontend.log" 2>&1) \
  || stop "build du frontend en échec : $SAVE/build-frontend.log (production intacte)."
ok "frontend construit : $NEW_FRONT"

# ───────────────────────────── 8. Backend + migrations ─────────────────────────
titre "8. BACKEND : MIGRATIONS ET MISE À JOUR"
for f in $(cd "$HERE/payload" && find backend -type f -name '*.js'); do node --check "$HERE/payload/$f"; done
BACK_TOUCHE=1
while read -r f; do rel="${f#backend/}"; mkdir -p "$BACK/$(dirname "$rel")"; cp "$HERE/payload/$f" "$BACK/$rel.nouveau"; mv "$BACK/$rel.nouveau" "$BACK/$rel"; done < <(cd "$HERE/payload" && find backend -type f)
(cd "$BACK" && node -e 'for (const m of ["./services/courriel","./services/comptes","./routes/super-admin-entreprises","./routes/social/index","./routes/social/lives"]) require(m)')
(cd "$BACK" && DATABASE_URL="$DATABASE_URL" node scripts/migrate.js)
ok "migrations appliquées (additives, répétées avec succès sur la copie)"
pm2c restart "$APP_BACK" >/dev/null
attendre_stable "$APP_BACK" || echec "le nouveau backend ne reste pas en ligne"
[ "$(cwd_de "$APP_BACK")" = "$BACK" ] || echec "backend : mauvais répertoire"
pm2js comparer "$APP_BACK" "$SAVE/pm2-backend-avant.json" || echec "définition PM2 du backend modifiée"
c1="$(curl -s -m 15 -o "$SAVE/controle-resend.json" -w '%{http_code}' -X POST -H 'Content-Type: application/json' -d '{}' "$SITE/api/verification/resend" || true)"
grep -q "Indiquez votre adresse email" "$SAVE/controle-resend.json" 2>/dev/null || echec "renvoi d'OTP : réponse inattendue ($c1)"
attendre_http "/api/social/lives/config" "401" 30 || echec "directs : $DERNIER_CODE au lieu de 401"
attendre_http "/api/super-admin/entreprises/1" "401" 30 || echec "super admin : $DERNIER_CODE au lieu de 401"
attendre_http "/api/education/learning/programs" "401|403" 30 || echec "Academy : $DERNIER_CODE au lieu de 401/403"
ok "nouveau backend en ligne, stable, définition PM2 inchangée (Academy toujours protégée)"

# ───────────────────────────── 9. Bascule du frontend ──────────────────────────
titre "9. FRONTEND : BASCULE (protégée jusqu'au dernier contrôle)"
FRONT_TOUCHE=1
pm2c delete "$APP_FRONT" >/dev/null
pm2_propre start "$SAVE/pm2-frontend-nouveau.json" >/dev/null
attendre_stable "$APP_FRONT" || echec "le nouveau frontend ne reste pas en ligne"
pm2js comparer "$APP_FRONT" "$SAVE/pm2-frontend-nouveau.json" || echec "définition PM2 du nouveau frontend inattendue"
for controle in "/:200" "/confirmer-email:200" "/social/lives:200|307|308" "/education/academy:200|307|308"; do
  attendre_http "${controle%%:*}" "${controle#*:}" 90 || echec "frontend : ${controle%%:*} répond $DERNIER_CODE"
done
info "accueil 200 · confirmer-email 200 · lives et academy accessibles"
pm2c save --force >/dev/null
BACK_TOUCHE=0; FRONT_TOUCHE=0
trap - ERR INT TERM HUP EXIT
set +e
ok "frontend en ligne : $NEW_FRONT (même définition PM2, même environnement)"
verifier_autres

# ───────────────────────────── 10. Diagnostic email (sans envoi) ───────────────
titre "10. DIAGNOSTIC EMAIL (configuration effective du processus, sans secret)"
ENVTMP="$(mktemp)"; chmod 600 "$ENVTMP"
pm2c jlist | node -e '
  const p = JSON.parse(require("fs").readFileSync(0, "utf8")).find((x) => x.name === "malilink-backend");
  const env = (p && p.pm2_env && p.pm2_env.env) || {};
  for (const k of Object.keys(env)) if (/^(SMTP_|PUBLIC_BASE_URL$|DATABASE_URL$)/.test(k)) console.log(`export ${k}=\x27${String(env[k]).replace(/\x27/g, "\x27\\\x27\x27")}\x27`);' > "$ENVTMP" || true
( set -a; . "$ENVTMP"; set +a; cd "$BACK" && node scripts/comptes/diagnostic-email.js ) || alerte "SMTP en échec : voir ci-dessus (les codes ne peuvent pas partir tant que ce n'est pas corrigé)."
rm -f "$ENVTMP"

titre "DÉPLOIEMENT TERMINÉ"
info "Journal : $SAVE/deploiement.log"
info "Retour arrière manuel : bash $SAVE/rollback.sh"
info "Étape suivante — identifier le compte école (lecture seule) :"
info "  cd $BACK && node scripts/comptes/valider-compte-ecole.js --identifier --societe 8"
