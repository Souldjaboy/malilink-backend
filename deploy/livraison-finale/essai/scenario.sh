#!/usr/bin/env bash
# Un scénario de déploiement sur le VPS d'essai (dans le conteneur, en root).
#   bash /essai/scenario.sh <audit|succes|pm2-start-echoue|demarrage-plante|http-echoue|
#                            interruption-int|interruption-term|interruption-hup|
#                            retour-impossible|backend-echoue|migration-echoue>
# Le paquet est dans /root/malilink-comptes-lives, exactement comme livré.
set -uo pipefail
S="$1"
export SITE=http://127.0.0.1:8080
PAQ=/root/malilink-livraison-finale
R=/var/www/releases/academy-essai
LOG=/root/deploiement-$S.log
DB=postgresql://malilink_app:motdepasse-app@127.0.0.1:5432/malilink_prod
NB_OK=0; NB_KO=0
verifier() { if eval "$2"; then echo "  ✓ $1"; NB_OK=$((NB_OK + 1)); else echo "  ✗ $1${3:+ — $3}"; NB_KO=$((NB_KO + 1)); fi; }

# Démarrage comme après un redémarrage du VPS : base, puis processus PM2 enregistrés.
until pg_isready -q -h 127.0.0.1; do sleep 1; done
# Faux Next à jour dans la release d'origine (l'image en garde la copie de sa préparation).
cp /essai/faux-next.js "$R/frontend/faux-next.js"
pm2 resurrect >/dev/null 2>&1
for _ in $(seq 1 60); do
  curl -sf -o /dev/null "$SITE/" && [ "$(curl -s -o /dev/null -w '%{http_code}' "$SITE/api/education/learning/programs")" = 401 ] && break; sleep 1
done

PHOTO_JS='
const fs = require("fs"), [quoi, nom] = process.argv.slice(1);
const l = JSON.parse(fs.readFileSync(0, "utf8"));
const def = (p, sansCwd) => { const e = p.pm2_env, env = {};
  for (const k of Object.keys(e.env).sort()) if (!k.startsWith("PM2_") && !["unique_id", "_", e.name].includes(k)) env[k] = e.env[k];
  return JSON.stringify({ script: e.pm_exec_path, args: e.args, interpreter: e.exec_interpreter, node_args: e.node_args, mode: e.exec_mode,
    instances: Number(e.instances) || 1, max_memory_restart: e.max_memory_restart, cwd: sansCwd ? "-" : e.pm_cwd, env, status: e.status }); };
const p = l.find((x) => x.name === nom);
if (quoi === "def") console.log(p ? def(p) : "absent");
if (quoi === "def-sans-cwd") console.log(p ? def(p, true) : "absent");
if (quoi === "pid") console.log(p ? `${p.pid} ${p.pm2_env.restart_time}` : "absent");
if (quoi === "cwd") console.log(p ? p.pm2_env.pm_cwd : "absent");
if (quoi === "autres") for (const x of l.filter((x) => !x.name.startsWith("malilink-")).sort((a, b) => a.pm_id - b.pm_id)) console.log(`${x.name}:${x.pid}:${x.pm2_env.restart_time}`);'
pm2q() { pm2 jlist 2>/dev/null | node -e "$PHOTO_JS" "$@"; }
FICHIERS_BACK="$( (grep ' backend/' "$PAQ/avant.sha256" | awk '{print $2}'; grep '^backend/' "$PAQ/nouveaux.txt") | sed 's#^backend/##' | sort)"
empreintes_back() { for f in $FICHIERS_BACK; do printf '%s %s\n' "$(sha256sum "$R/backend/$f" 2>/dev/null | cut -c1-16 || true)" "$f"; done; }
empreintes_payload() { for f in $FICHIERS_BACK; do printf '%s %s\n' "$(sha256sum "$PAQ/payload/backend/$f" | cut -c1-16)" "$f"; done; }
mig091() { psql "$DB" -Atqc "SELECT count(*) FROM schema_migrations WHERE filename='091_espaces_comptes.sql'"; }
migrations() { psql "$DB" -Atqc "SELECT count(*) FROM schema_migrations WHERE filename IN ('089_comptes_validation_courriels.sql','090_social_lives.sql')"; }
repetitions() { runuser -u postgres -- psql -Atqc "SELECT string_agg(datname, ',') FROM pg_database WHERE datname LIKE 'malilink_repetition_%'"; }
essai() { curl -s -m 5 "$SITE/__essai"; }
dump_front() { node -e 'const d=JSON.parse(require("fs").readFileSync("/root/.pm2/dump.pm2","utf8")).find(x=>x.name==="malilink-frontend");console.log(d?d.pm_cwd:"absent")'; }

# Fichiers téléversés par les utilisateurs : ne doivent jamais bouger.
mkdir -p "$R/backend/uploads/essai" && for i in 1 2 3; do echo "photo $i" > "$R/backend/uploads/essai/photo-$i.jpg"; done
AV_DEF_FRONT="$(pm2q def malilink-frontend)"; AV_DEF_FRONT_SC="$(pm2q def-sans-cwd malilink-frontend)"
AV_DEF_BACK="$(pm2q def malilink-backend)"; AV_PID_FRONT="$(pm2q pid malilink-frontend)"
AV_AUTRES="$(pm2q autres)"; AV_ESSAI="$(essai)"; AV_FICHIERS="$(empreintes_back)"; AV_DUMP="$(sha256sum /root/.pm2/dump.pm2)"
echo "── scénario « $S » · état initial : $AV_ESSAI"
echo "   témoins : $(echo $AV_AUTRES)"

lancer() {  # lance deploy.sh --executer et attend sa fin ; $1 = signal à envoyer pendant la bascule (facultatif)
  set -m   # contrôle de tâches : SIGINT n'est pas ignoré par la tâche de fond
  bash "$PAQ/deploy.sh" --executer > "$LOG" 2>&1 &
  local pid=$!
  if [ -n "${1:-}" ] || [ -n "${APRES_BASCULE:-}" ]; then
    for _ in $(seq 1 600); do grep -q "9. FRONTEND : BASCULE" "$LOG" && break; sleep 0.5; done
    sleep 4
    [ -n "${APRES_BASCULE:-}" ] && eval "$APRES_BASCULE"
    [ -n "${1:-}" ] && { kill -"$1" "$pid"; echo "   → signal $1 envoyé à deploy.sh pendant la bascule"; }
  fi
  wait "$pid"; CODE=$?
  set +m
  sleep 1
}
retour_verifie() {  # l'état d'avant est réellement rétabli
  verifier "code de sortie d'échec (ni 0, ni 3) : $CODE" '[ "$CODE" != 0 ] && [ "$CODE" != 3 ]'
  verifier "« RETOUR ARRIÈRE VÉRIFIÉ » annoncé" 'grep -q "RETOUR ARRIÈRE VÉRIFIÉ" "$LOG" && ! grep -q "NON VÉRIFIÉ" "$LOG"'
  verifier "frontend : définition PM2 complète identique (script, args, interpréteur, cwd, env)" '[ "$(pm2q def malilink-frontend)" = "$AV_DEF_FRONT" ]' "$(pm2q def malilink-frontend | cut -c1-300)"
  verifier "frontend servi par l'ancienne release, PORT et MARQUEUR d'origine : $(essai)" '[ "$(essai)" = "$AV_ESSAI" ]'
  verifier "backend : fichiers d'origine (empreintes) et définition PM2 identique" '[ "$(empreintes_back)" = "$AV_FICHIERS" ] && [ "$(pm2q def malilink-backend)" = "$AV_DEF_BACK" ]'
  verifier "Academy toujours protégée (401)" '[ "$(curl -s -o /dev/null -w "%{http_code}" "$SITE/api/education/learning/programs")" = 401 ]'
  verifier "témoins Triangle/HAFIYA/Nginx jamais redémarrés" '[ "$(pm2q autres)" = "$AV_AUTRES" ]'
  verifier "aucune base de répétition restante" '[ -z "$(repetitions)" ]'
  verifier "uploads intacts (3 fichiers)" '[ "$(ls $R/backend/uploads/essai | wc -l)" = 3 ]'
  verifier "sauvegarde PM2 (dump) : ancienne release" '[ "$(dump_front)" = "$R/frontend" ]'
}

case "$S" in
  audit)
    bash "$PAQ/deploy.sh" > "$LOG" 2>&1; CODE=$?
    verifier "audit : code 0, « AUDIT TERMINÉ »" '[ "$CODE" = 0 ] && grep -q "AUDIT TERMINÉ" "$LOG"'
    verifier "moteur réel affiché : $(grep -o "moteur [0-9.]*[^·]*" "$LOG" | head -1)" 'grep -q "PostgreSQL joignable : moteur" "$LOG"'
    verifier "répétition possible via le compte postgres local (rôle applicatif sans CREATEDB)" 'grep -q "créée par le compte postgres local" "$LOG"'
    verifier "ports réellement écoutés détectés (backend 5050, frontend 3020)" 'grep -q "(ports écoutés : 5050)" "$LOG" && grep -q "(ports écoutés : 3020)" "$LOG"'
    verifier "école 8 identifiée en lecture seule, email masqué" 'grep -q "société 8 « MALILINK SCOOL » · espace malilink" "$LOG" && grep -q "d\*\*\*@e\*\*\*.test" "$LOG" && ! grep -q "directeur@ecole.test" "$LOG"'
    verifier "SMTP absent : signalé sans rien envoyer" 'grep -q "SMTP_EN_ECHEC" "$LOG"'
    verifier "rien d'écrit : ni sauvegarde, ni fichier, ni processus touché" '[ -z "$(ls /root/backups)" ] && [ "$(empreintes_back)" = "$AV_FICHIERS" ] && [ "$(pm2q pid malilink-frontend)" = "$AV_PID_FRONT" ] && [ "$(pm2q autres)" = "$AV_AUTRES" ]'
    ;;
  succes)
    lancer; NOUVEAU="$(pm2q cwd malilink-frontend)"
    verifier "déploiement : code 0, « DÉPLOIEMENT TERMINÉ »" '[ "$CODE" = 0 ] && grep -q "DÉPLOIEMENT TERMINÉ" "$LOG"' "code $CODE"
    verifier "répétition sur copie : 089, 090 et 091 appliquées sur le moteur réel" 'grep -q "migrations 089, 090 et 091 appliquées sur la copie" "$LOG" && grep -q "copie conforme" "$LOG"'
    verifier "migrations 089 et 090 en production, base de répétition supprimée" '[ "$(migrations)" = 2 ] && [ -z "$(repetitions)" ]'
    verifier "backend : fichiers du paquet, même définition PM2" '[ "$(empreintes_back)" = "$(empreintes_payload)" ] && [ "$(pm2q def malilink-backend)" = "$AV_DEF_BACK" ]'
    verifier "nouveau backend actif (nouveau message de renvoi d'OTP)" 'curl -s -X POST -H "Content-Type: application/json" -d "{}" "$SITE/api/verification/resend" | grep -q "Indiquez votre adresse email"'
    verifier "frontend : nouvelle release $NOUVEAU" '[[ "$NOUVEAU" == /var/www/releases/malilink-livraison-finale-*/frontend ]] && essai | grep -q "\"release\":\"nouvelle\""'
    verifier "frontend : même script, arguments, interpréteur et environnement (PORT, MARQUEUR) qu'avant" '[ "$(pm2q def-sans-cwd malilink-frontend)" = "$AV_DEF_FRONT_SC" ] && essai | grep -q "lancement-origine-7f3a"'
    verifier "témoins jamais redémarrés, dump PM2 sur la nouvelle release" '[ "$(pm2q autres)" = "$AV_AUTRES" ] && [ "$(dump_front)" = "$NOUVEAU" ] && [[ "$NOUVEAU" == */malilink-livraison-finale-*/frontend ]]'
    verifier "mêmes ports qu'avant (3020) et uploads intacts, annoncés et réels" 'grep -q "mêmes ports : 3020" "$LOG" && grep -q "uploads intacts : 3 avant" "$LOG" && [ "$(ls $R/backend/uploads/essai | wc -l)" = 3 ]'
    verifier "migration 091 en production (espaces des comptes)" '[ "$(mig091)" = 1 ]'
    SAVE="$(ls -d /root/backups/malilink-livraison-finale-*)"
    echo "   → retour arrière manuel : bash $SAVE/rollback.sh"
    bash "$SAVE/rollback.sh" > "$LOG.retour" 2>&1; CODE=$?
    verifier "retour manuel : code 0, « RETOUR ARRIÈRE VÉRIFIÉ »" '[ "$CODE" = 0 ] && grep -q "RETOUR ARRIÈRE VÉRIFIÉ" "$LOG.retour"' "code $CODE"
    verifier "retour manuel : définition PM2 du frontend identique à l'origine, ancienne release servie" '[ "$(pm2q def malilink-frontend)" = "$AV_DEF_FRONT" ] && [ "$(essai)" = "$AV_ESSAI" ]'
    verifier "retour manuel : fichiers backend d'origine, définition identique, témoins intacts" '[ "$(empreintes_back)" = "$AV_FICHIERS" ] && [ "$(pm2q def malilink-backend)" = "$AV_DEF_BACK" ] && [ "$(pm2q autres)" = "$AV_AUTRES" ]'
    ;;
  pm2-start-echoue)
    printf '#!/usr/bin/env bash\nif [ "${1:-}" = start ] && [[ "${2:-}" == *pm2-frontend-nouveau.json ]]; then echo "[essai] échec volontaire de pm2 start" >&2; exit 1; fi\nexec /usr/local/bin/pm2 "$@"\n' > /usr/local/sbin/pm2
    chmod +x /usr/local/sbin/pm2
    lancer; rm -f /usr/local/sbin/pm2
    verifier "pm2 start de la nouvelle release a bien échoué (code ≠ 0)" 'grep -q "\[essai\] échec volontaire de pm2 start" "$LOG"'
    retour_verifie ;;
  demarrage-plante)
    echo plante > /etc/essai/nouveau; lancer
    verifier "nouvelle release plantée au démarrage, détectée" 'grep -q "ne reste pas en ligne" "$LOG"'
    retour_verifie ;;
  http-echoue)
    echo http500 > /etc/essai/nouveau; lancer
    verifier "contrôle HTTP en échec détecté (/confirmer-email 500)" 'grep -q "/confirmer-email répond 500" "$LOG"'
    retour_verifie ;;
  interruption-int|interruption-term|interruption-hup)
    SIG="$(echo "${S#interruption-}" | tr a-z A-Z)"
    echo lent > /etc/essai/nouveau; lancer "$SIG"
    verifier "interruption $SIG prise en charge pendant la bascule" 'grep -q "signal $SIG" "$LOG"'
    retour_verifie ;;
  retour-impossible)
    echo http500 > /etc/essai/nouveau
    APRES_BASCULE='echo plante > /etc/essai/ancien; echo "   → ancienne release rendue défaillante pendant la bascule"'
    lancer
    verifier "code de sortie 3" '[ "$CODE" = 3 ]' "code $CODE"
    verifier "« RETOUR ARRIÈRE NON VÉRIFIÉ » annoncé, jamais « VÉRIFIÉ »" 'grep -q "RETOUR ARRIÈRE NON VÉRIFIÉ" "$LOG" && ! grep -q "RETOUR ARRIÈRE VÉRIFIÉ" "$LOG"'
    verifier "dump PM2 non réécrit avec un état non vérifié" '[ "$(sha256sum /root/.pm2/dump.pm2)" = "$AV_DUMP" ]'
    verifier "backend tout de même restauré et vérifié" 'grep -q "backend restauré et vérifié" "$LOG" && [ "$(empreintes_back)" = "$AV_FICHIERS" ]'
    ;;
  backend-echoue)
    echo resend-502 > /etc/essai/proxy; lancer; rm -f /etc/essai/proxy
    verifier "contrôle du backend en échec détecté" 'grep -q "renvoi d.OTP : réponse inattendue" "$LOG"'
    verifier "frontend jamais touché (même pid, aucun redémarrage)" '[ "$(pm2q pid malilink-frontend)" = "$AV_PID_FRONT" ]'
    retour_verifie ;;
  migration-echoue)
    psql "$DB" -qc "CREATE TABLE social_live_comments (id int)"
    lancer
    verifier "répétition en échec sur la copie, arrêt « production NON modifiée »" 'grep -q "migrations en échec sur la copie" "$LOG" && grep -q "production NON modifiée" "$LOG"' "code $CODE"
    verifier "code ≠ 0, aucun retour arrière nécessaire" '[ "$CODE" != 0 ] && ! grep -q "RETOUR ARRIÈRE" "$LOG"'
    verifier "production intacte : aucune migration, fichiers et processus inchangés" '[ "$(migrations)" = 0 ] && [ "$(empreintes_back)" = "$AV_FICHIERS" ] && [ "$(pm2q pid malilink-frontend)" = "$AV_PID_FRONT" ] && [ "$(pm2q autres)" = "$AV_AUTRES" ]'
    verifier "base de répétition supprimée" '[ -z "$(repetitions)" ]'
    ;;
  *) echo "scénario inconnu : $S"; exit 2 ;;
esac
echo "BILAN $S : $NB_OK réussis, $NB_KO échoués"
[ "$NB_KO" = 0 ]
