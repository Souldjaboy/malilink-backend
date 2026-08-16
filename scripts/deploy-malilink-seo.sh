#!/usr/bin/env bash
#
# DÉPLOIEMENT MALILINK — PHASE 1 SEO
#
# Rejouable : relancé après un succès, il ne refait que ce qui manque.
# 072 est idempotente, `git merge --ff-only` sur un HEAD déjà à jour ne fait
# rien, et les dépendances ne sont réinstallées que si leur verrou a changé.
#
# Ne touche QUE MaliLink. Les dépôts sont identifiés par leur remote Git —
# la vérité, contrairement à un nom de dossier — et le script s'interrompt
# s'il rencontre Triangle ou Hafiya.
#
# Par défaut il n'écrit rien : il inspecte, affiche et s'arrête. L'exécution
# réelle exige --executer.
#
#   ./deploy-malilink-seo.sh              # audit seul, aucune écriture
#   ./deploy-malilink-seo.sh --executer   # déploiement
#
set -Eeuo pipefail

# ─────────────────────────── Ce qui est déployé ───────────────────────────
readonly SHA_BACKEND="9a5c148f88b72abea264ec3d8c77e671c9c68320"
readonly SHA_FRONTEND="272c6774428930c9aa1ccfa6f387cbe8be45bce3"

readonly REMOTE_BACKEND="malilink-backend"
readonly REMOTE_FRONTEND="malilink-frontend"

readonly MIGRATION="072_seo_public_profiles.sql"
readonly MIGRATION_SHA256="49916eec481dc50c807aad26ef9b5aa6dad3ec0cdce79bc36c2264d566f32909"

readonly PM2_BACKEND="malilink-backend"
readonly PM2_FRONTEND="malilink-frontend"

# Tout projet dont le remote correspond est interdit de modification.
readonly REMOTES_INTERDITS="triangle-wms|hafiya|triangle-logistics"

readonly DOSSIER_SAUVEGARDE="${BACKUP_DIR:-/var/backups/malilink}"
readonly HORODATAGE="$(date +%Y%m%d-%H%M%S)"

EXECUTER=0
if [ "${1:-}" = "--executer" ]; then EXECUTER=1; fi

# ────────────────────────────── Présentation ──────────────────────────────
titre()  { printf '\n\033[1m══ %s\033[0m\n' "$1"; }
info()   { printf '   %s\n' "$1"; }
ok()     { printf '   \033[32m✓\033[0m %s\n' "$1"; }
alerte() { printf '   \033[33m!\033[0m %s\n' "$1"; }
stop()   { printf '\n\033[31mARRÊT : %s\033[0m\n\n' "$1" >&2; exit 1; }

# Toute commande non gérée qui échoue arrête le script. Les étapes destructives
# n'arrivent qu'après les contrôles : un arrêt précoce ne laisse rien à défaire.
trap 'stop "commande en échec ligne $LINENO — arrêt avant toute étape suivante."' ERR

# Exécute, ou décrit seulement si on est en audit.
faire() {
  if [ "$EXECUTER" -eq 1 ]; then
    "$@"
  else
    printf '   \033[90m(audit) %s\033[0m\n' "$*"
  fi
}

# ═══════════════════════════════════════════════════════════════════════════
titre "1. IDENTIFICATION DES DÉPÔTS MALILINK"
# ═══════════════════════════════════════════════════════════════════════════

# Cherche un dépôt Git dont le remote correspond au motif attendu.
localiser_depot() {
  local motif="$1" chemin
  for chemin in \
      /var/www/malilink/backend /var/www/malilink/frontend \
      /var/www/malilink/* /var/www/* /opt/malilink/* /srv/malilink/* /home/*/malilink/*; do
    [ -d "$chemin/.git" ] || continue
    local remote
    remote="$(git -C "$chemin" remote get-url origin 2>/dev/null || true)"
    [ -n "$remote" ] || continue
    if printf '%s' "$remote" | grep -qE "$motif(\.git)?/?$"; then
      printf '%s' "$chemin"
      return 0
    fi
  done
  # Rien trouvé : on rend une chaîne vide plutôt qu'un code d'échec. Avec
  # set -E, un `return 1` dans $( ) déclencherait la trappe ERR du sous-shell
  # avant même que le `||` de l'appelant ne puisse le traiter.
  printf ''
  return 0
}

CHEMIN_BACKEND="$(localiser_depot "$REMOTE_BACKEND")"
[ -n "$CHEMIN_BACKEND" ] \
  || stop "dépôt $REMOTE_BACKEND introuvable sous /var/www, /opt ou /srv. Renseignez CHEMIN_BACKEND en dur et relancez."
CHEMIN_FRONTEND="$(localiser_depot "$REMOTE_FRONTEND")"
[ -n "$CHEMIN_FRONTEND" ] \
  || stop "dépôt $REMOTE_FRONTEND introuvable sous /var/www, /opt ou /srv."

for chemin in "$CHEMIN_BACKEND" "$CHEMIN_FRONTEND"; do
  remote="$(git -C "$chemin" remote get-url origin)"
  if printf '%s' "$remote" | grep -qiE "$REMOTES_INTERDITS"; then
    stop "$chemin pointe vers un projet interdit ($remote)."
  fi
  info "$chemin"
  info "  remote  : $remote"
  info "  branche : $(git -C "$chemin" rev-parse --abbrev-ref HEAD)"
  info "  HEAD    : $(git -C "$chemin" rev-parse HEAD)"
  info "  état    : $(git -C "$chemin" status --porcelain --untracked-files=no | wc -l | tr -d ' ') fichier(s) suivi(s) modifié(s)"
done
ok "les deux dépôts sont bien MaliLink"

# ═══════════════════════════════════════════════════════════════════════════
titre "2. PROCESSUS PM2 CONCERNÉS"
# ═══════════════════════════════════════════════════════════════════════════

command -v pm2 >/dev/null || stop "pm2 est introuvable dans le PATH."

# Un nom peut mentir : on retient les processus dont le répertoire de travail
# est réellement l'un des deux dépôts identifiés.
PM2_CIBLES="$(pm2 jlist 2>/dev/null | node -e '
  const cibles = process.argv.slice(1);
  let entree = "";
  process.stdin.on("data", (c) => (entree += c)).on("end", () => {
    const liste = JSON.parse(entree || "[]");
    const retenus = liste.filter((p) => cibles.includes(p.pm2_env?.pm_cwd || ""));
    console.log(retenus.map((p) => p.name).join(" "));
  });
' "$CHEMIN_BACKEND" "$CHEMIN_FRONTEND")"

if [ -z "$PM2_CIBLES" ]; then
  alerte "aucun processus PM2 n'a pour répertoire l'un des dépôts MaliLink."
  alerte "repli sur les noms attendus : $PM2_BACKEND $PM2_FRONTEND"
  PM2_CIBLES="$PM2_BACKEND $PM2_FRONTEND"
fi

for nom in $PM2_CIBLES; do
  case "$nom" in
    *triangle*|*hafiya*) stop "$nom n'est pas un processus MaliLink." ;;
  esac
  info "processus retenu : $nom"
done

info ""
info "Processus PM2 présents sur la machine, pour information :"
pm2 jlist 2>/dev/null | node -e '
  let e = ""; process.stdin.on("data", (c) => (e += c)).on("end", () => {
    JSON.parse(e || "[]").forEach((p) =>
      console.log(`     ${p.name.padEnd(24)} ${p.pm2_env?.status} ${p.pm2_env?.pm_cwd || ""}`));
  });'
ok "aucun processus Triangle ou Hafiya ne sera redémarré"

# ═══════════════════════════════════════════════════════════════════════════
titre "3. ENVIRONNEMENT"
# ═══════════════════════════════════════════════════════════════════════════

[ -f "$CHEMIN_BACKEND/.env" ] || stop "$CHEMIN_BACKEND/.env absent."
set -a; . "$CHEMIN_BACKEND/.env"; set +a
[ -n "${DATABASE_URL:-}" ] || stop "DATABASE_URL absent du .env backend."
PORT_BACKEND="${PORT:-5050}"
info "port backend : $PORT_BACKEND"

# Le dépôt sert trois produits : bâtir MaliLink avec la mauvaise valeur
# déploierait Triangle ou Hafiya sur malilinkglobal.com.
# Lit une variable d'un fichier d'environnement. `sed -n` rend 0 même sans
# correspondance, là où `grep` rendrait 1 et ferait échouer la substitution
# sous pipefail — masquant le message d'aide par une erreur générique.
lire_var() {
  sed -n "s/^$1=//p" "$2" | head -1 | tr -d "\"' "
}

FICHIER_ENV_FRONT="$CHEMIN_FRONTEND/.env.local"
[ -f "$FICHIER_ENV_FRONT" ] || FICHIER_ENV_FRONT="$CHEMIN_FRONTEND/.env"
[ -f "$FICHIER_ENV_FRONT" ] || stop "aucun fichier d'environnement frontend."

PRODUIT="$(lire_var NEXT_PUBLIC_APP_PRODUCT "$FICHIER_ENV_FRONT")"
[ "$PRODUIT" = "malilink" ] \
  || stop "NEXT_PUBLIC_APP_PRODUCT vaut « ${PRODUIT:-absent} » et non « malilink » dans $FICHIER_ENV_FRONT."
ok "NEXT_PUBLIC_APP_PRODUCT = malilink"

# Les pages produit et boutique sont rendues par le serveur : sans cette
# variable, elles interrogeraient un backend inexistant et rendraient des 404.
URL_BACKEND="$(lire_var BACKEND_URL "$FICHIER_ENV_FRONT")"
if [ -z "$URL_BACKEND" ]; then
  stop "BACKEND_URL absent de $FICHIER_ENV_FRONT. Le rendu serveur des fiches produit en dépend ; ajoutez BACKEND_URL=http://127.0.0.1:$PORT_BACKEND puis relancez."
fi
ok "BACKEND_URL = $URL_BACKEND"

PORT_FRONTEND="$(lire_var PORT "$FICHIER_ENV_FRONT")"
PORT_FRONTEND="${PORT_FRONTEND:-3000}"
info "port frontend : $PORT_FRONTEND"

# Informations officielles encore absentes : elles ne bloquent rien, le
# JSON-LD omet simplement les propriétés inconnues.
MANQUANTES=""
for v in NEXT_PUBLIC_ORG_ADDRESS NEXT_PUBLIC_ORG_CITY NEXT_PUBLIC_ORG_DISTRICT \
         NEXT_PUBLIC_ORG_REGION NEXT_PUBLIC_ORG_COUNTRY NEXT_PUBLIC_ORG_HOURS \
         NEXT_PUBLIC_ORG_LAT NEXT_PUBLIC_ORG_LNG \
         NEXT_PUBLIC_SOCIAL_FACEBOOK NEXT_PUBLIC_SOCIAL_INSTAGRAM NEXT_PUBLIC_SOCIAL_TIKTOK; do
  grep -qE "^$v=." "$FICHIER_ENV_FRONT" || MANQUANTES="$MANQUANTES $v"
done
if [ -n "$MANQUANTES" ]; then
  alerte "informations officielles non renseignées (non bloquant) :"
  for v in $MANQUANTES; do info "    $v"; done
  info "  Le JSON-LD omettra ces propriétés. N'y mettez jamais de valeur approximative."
fi

# ═══════════════════════════════════════════════════════════════════════════
titre "4. SAUVEGARDE POSTGRESQL"
# ═══════════════════════════════════════════════════════════════════════════

DUMP="$DOSSIER_SAUVEGARDE/malilink-avant-072-$HORODATAGE.dump"
faire mkdir -p "$DOSSIER_SAUVEGARDE"
info "destination : $DUMP"
faire pg_dump --format=custom --no-owner --no-privileges --file="$DUMP" "$DATABASE_URL"

if [ "$EXECUTER" -eq 1 ]; then
  [ -s "$DUMP" ] || stop "le dump est absent ou vide."
  TAILLE=$(wc -c < "$DUMP" | tr -d ' ')
  [ "$TAILLE" -ge 51200 ] || stop "dump suspect : $TAILLE octets seulement."
  # Un fichier non vide peut rester illisible : on vérifie qu'il se relit.
  pg_restore --list "$DUMP" > /dev/null 2>&1 || stop "le dump est illisible par pg_restore."
  ok "dump vérifié : $TAILLE octets, table des matières lisible"
fi

# ═══════════════════════════════════════════════════════════════════════════
titre "5. CONTRÔLES AVANT MIGRATION"
# ═══════════════════════════════════════════════════════════════════════════

q() { psql "$DATABASE_URL" -tAX -c "$1"; }

AVANT_COMPANIES=$(q "SELECT count(*) FROM companies")
AVANT_PRODUITS=$(q "SELECT count(*) FROM products")
AVANT_MP=$(q "SELECT count(*) FROM marketplace_products")
AVANT_USERS=$(q "SELECT count(*) FROM users")
info "companies             : $AVANT_COMPANIES"
info "products              : $AVANT_PRODUITS"
info "marketplace_products  : $AVANT_MP"
info "users                 : $AVANT_USERS"

if [ "$(q "SELECT to_regclass('public.company_public_profile') IS NOT NULL")" = "t" ]; then
  alerte "company_public_profile existe déjà : 072 a déjà été appliquée, elle ne refera rien."
fi

# ═══════════════════════════════════════════════════════════════════════════
titre "6. RÉCUPÉRATION DES COMMITS VALIDÉS"
# ═══════════════════════════════════════════════════════════════════════════

# Avance sans jamais écraser : un dépôt modifié à la main ou divergent
# interrompt le déploiement au lieu de perdre le travail présent.
avancer_vers() {
  local chemin="$1" sha="$2" nom="$3"
  info "$nom"

  # Seuls les fichiers SUIVIS comptent. Un .env, un dossier uploads/ ou un
  # journal non suivis sont normaux sur un serveur, et `merge --ff-only` ne
  # peut pas les écraser : git refuse de lui-même la fusion qui écraserait un
  # fichier non suivi. Les inclure ici bloquerait tout déploiement réel.
  local sales
  sales="$(git -C "$chemin" status --porcelain --untracked-files=no)"
  if [ -n "$sales" ]; then
    printf '%s\n' "$sales" | sed 's/^/       /'
    stop "$chemin contient des modifications non validées sur des fichiers suivis. Rien n'est écrasé : traitez-les puis relancez."
  fi

  faire git -C "$chemin" fetch origin --tags
  if [ "$EXECUTER" -eq 1 ]; then
    git -C "$chemin" cat-file -e "${sha}^{commit}" 2>/dev/null \
      || stop "le commit $sha est absent de $chemin après fetch."

    local actuel; actuel="$(git -C "$chemin" rev-parse HEAD)"
    if [ "$actuel" = "$sha" ]; then
      ok "  déjà sur $sha"
      return 0
    fi
    # --ff-only refuse toute divergence : pas de reset, pas de perte.
    git -C "$chemin" merge --ff-only "$sha" \
      || stop "avance impossible sans écraser $chemin (HEAD $actuel diverge de $sha). Aucune modification faite."
    ok "  $actuel → $sha"
  fi
}

avancer_vers "$CHEMIN_BACKEND"  "$SHA_BACKEND"  "backend"
avancer_vers "$CHEMIN_FRONTEND" "$SHA_FRONTEND" "frontend"

# ═══════════════════════════════════════════════════════════════════════════
titre "7. CONTENU ET EMPREINTE DE LA MIGRATION"
# ═══════════════════════════════════════════════════════════════════════════

FICHIER_MIGRATION="$CHEMIN_BACKEND/sql/$MIGRATION"
[ -f "$FICHIER_MIGRATION" ] || stop "$FICHIER_MIGRATION introuvable."

EMPREINTE="$(sha256sum "$FICHIER_MIGRATION" 2>/dev/null | awk '{print $1}')"
[ -n "$EMPREINTE" ] || EMPREINTE="$(shasum -a 256 "$FICHIER_MIGRATION" | awk '{print $1}')"

info "attendue : $MIGRATION_SHA256"
info "lue      : $EMPREINTE"
[ "$EMPREINTE" = "$MIGRATION_SHA256" ] \
  || stop "l'empreinte de $MIGRATION ne correspond pas à la version auditée."
ok "migration conforme à la version validée"

echo
echo "───────── $MIGRATION ─────────"
cat "$FICHIER_MIGRATION"
echo "──────────────────────────────────────────────"

# ═══════════════════════════════════════════════════════════════════════════
titre "8. EXÉCUTION DE LA MIGRATION"
# ═══════════════════════════════════════════════════════════════════════════

# Le runner applique TOUTES les migrations en attente. Sur une base dont
# l'historique aurait été appliqué à la main, il rejouerait tout : on refuse
# donc de continuer si autre chose que 072 est en attente.
cd "$CHEMIN_BACKEND"
# Classes POSIX plutôt que \s : celui-ci n'est pas reconnu par grep/sed BSD.
ETAT="$(node scripts/migrate.js --status 2>&1 | grep -E '^[[:space:]]+- ' | sed 's/^[[:space:]]*-[[:space:]]*//' || true)"
NB_ATTENTE="$(printf '%s' "$ETAT" | grep -c . || true)"
# grep -c rend 1 quand il ne compte rien : le || true garde la valeur « 0 ».

if [ "$NB_ATTENTE" -eq 0 ]; then
  ok "aucune migration en attente : la base est déjà à jour"
elif [ "$NB_ATTENTE" -eq 1 ] && [ "$ETAT" = "$MIGRATION" ]; then
  info "une seule migration en attente : $MIGRATION"
  # migrate.js enveloppe chaque fichier dans BEGIN/COMMIT et fait ROLLBACK
  # puis s'arrête à la première erreur.
  faire node scripts/migrate.js
  ok "migration appliquée dans sa transaction"
else
  echo "$ETAT" | sed 's/^/       /'
  stop "$NB_ATTENTE migration(s) en attente au lieu de la seule $MIGRATION. Le runner les appliquerait toutes. Vérifiez schema_migrations avant de continuer."
fi

# ═══════════════════════════════════════════════════════════════════════════
titre "9. CONTRÔLES APRÈS MIGRATION"
# ═══════════════════════════════════════════════════════════════════════════

if [ "$EXECUTER" -eq 1 ]; then
  verifier_objet() {
    [ "$(q "$2")" = "1" ] && ok "$1" || stop "$1 : absent après migration."
  }
  verifier_objet "table company_public_profile" \
    "SELECT count(*) FROM information_schema.tables WHERE table_name='company_public_profile'"
  verifier_objet "colonne marketplace_products.slug" \
    "SELECT count(*) FROM information_schema.columns WHERE table_name='marketplace_products' AND column_name='slug'"
  verifier_objet "index company_public_profile_slug_key" \
    "SELECT count(*) FROM pg_indexes WHERE indexname='company_public_profile_slug_key'"
  verifier_objet "index company_public_profile_public_idx" \
    "SELECT count(*) FROM pg_indexes WHERE indexname='company_public_profile_public_idx'"
  verifier_objet "index marketplace_products_slug_idx" \
    "SELECT count(*) FROM pg_indexes WHERE indexname='marketplace_products_slug_idx'"

  # ── Aucune donnée métier ne doit avoir bougé ──
  for couple in "companies:$AVANT_COMPANIES" "products:$AVANT_PRODUITS" \
                "marketplace_products:$AVANT_MP" "users:$AVANT_USERS"; do
    table="${couple%%:*}"; avant="${couple##*:}"
    apres="$(q "SELECT count(*) FROM $table")"
    [ "$apres" = "$avant" ] || stop "$table est passée de $avant à $apres lignes. 072 est pourtant purement additive."
    ok "$table inchangée ($apres)"
  done

  RENSEIGNES="$(q "SELECT count(*) FROM marketplace_products WHERE NULLIF(slug,'') IS NOT NULL")"
  info "slugs produits renseignés : $RENSEIGNES (la colonne est vide au départ, l'URL est dérivée du titre)"
fi

# ═══════════════════════════════════════════════════════════════════════════
titre "10. DÉPENDANCES ET CONSTRUCTION"
# ═══════════════════════════════════════════════════════════════════════════

# Réinstalle seulement si le verrou a changé depuis la dernière pose.
installer_si_besoin() {
  local chemin="$1" nom="$2" options="$3"
  local temoin="$chemin/node_modules/.verrou-deploye"
  local empreinte
  empreinte="$(sha256sum "$chemin/package-lock.json" 2>/dev/null | awk '{print $1}')" \
    || empreinte="$(shasum -a 256 "$chemin/package-lock.json" | awk '{print $1}')"

  if [ -f "$temoin" ] && [ "$(cat "$temoin")" = "$empreinte" ]; then
    ok "$nom : dépendances déjà à jour, rien à installer"
    return 0
  fi
  info "$nom : installation des dépendances"
  faire npm --prefix "$chemin" ci $options
  if [ "$EXECUTER" -eq 1 ]; then printf '%s' "$empreinte" > "$temoin"; fi
}

installer_si_besoin "$CHEMIN_BACKEND"  "backend"  "--omit=dev"
installer_si_besoin "$CHEMIN_FRONTEND" "frontend" ""

faire node --check "$CHEMIN_BACKEND/server.js"

# Le build précède tout redémarrage : s'il échoue, la production tourne
# encore sur la version précédente, intacte.
info "construction du frontend (produit : malilink)"
if [ "$EXECUTER" -eq 1 ]; then
  ( cd "$CHEMIN_FRONTEND" && NEXT_PUBLIC_APP_PRODUCT=malilink npm run build ) \
    || stop "build frontend en échec. Rien n'a été redémarré, la production est intacte."
  ok "build réussi"
else
  info "   (audit) npm run build dans $CHEMIN_FRONTEND"
fi

# ═══════════════════════════════════════════════════════════════════════════
titre "11. REDÉMARRAGE DES PROCESSUS MALILINK"
# ═══════════════════════════════════════════════════════════════════════════

for nom in $PM2_CIBLES; do
  case "$nom" in
    *triangle*|*hafiya*) stop "refus de redémarrer $nom." ;;
  esac
  info "redémarrage de $nom"
  faire pm2 restart "$nom" --update-env
done
if [ "$EXECUTER" -eq 1 ]; then sleep 6; fi

# ═══════════════════════════════════════════════════════════════════════════
titre "12. VÉRIFICATIONS HTTP DEPUIS LE VPS"
# ═══════════════════════════════════════════════════════════════════════════

ECHECS=0
BASE_FRONT="http://127.0.0.1:$PORT_FRONTEND"
BASE_BACK="http://127.0.0.1:$PORT_BACKEND"

controle() {
  local libelle="$1" attendu="$2" url="$3"
  local obtenu; obtenu="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$url" || echo 000)"
  if [ "$obtenu" = "$attendu" ]; then ok "$libelle ($obtenu)"
  else alerte "$libelle : attendu $attendu, obtenu $obtenu — $url"; ECHECS=$((ECHECS+1)); fi
}

contient() {
  local libelle="$1" motif="$2" url="$3"
  if curl -s --max-time 20 "$url" | grep -qF "$motif"; then ok "$libelle"
  else alerte "$libelle : « $motif » introuvable — $url"; ECHECS=$((ECHECS+1)); fi
}

absent_de() {
  local libelle="$1" motif="$2" url="$3"
  if curl -s --max-time 20 "$url" | grep -qF "$motif"; then
    alerte "FUITE — « $motif » présent dans $url"; ECHECS=$((ECHECS+1))
  else ok "$libelle"; fi
}

if [ "$EXECUTER" -eq 1 ]; then
  controle "accueil"        200 "$BASE_FRONT/"
  controle "marketplace"    200 "$BASE_FRONT/marketplace"
  controle "robots.txt"     200 "$BASE_FRONT/robots.txt"
  controle "sitemap.xml"    200 "$BASE_FRONT/sitemap.xml"
  controle "page inconnue"  404 "$BASE_FRONT/page-qui-nexiste-pas"

  contient "robots annonce le sitemap" "Sitemap:"          "$BASE_FRONT/robots.txt"
  contient "robots interdit /login"    "Disallow: /login"  "$BASE_FRONT/robots.txt"
  contient "sitemap contient des URL"  "<loc>"             "$BASE_FRONT/sitemap.xml"

  # ── Fiche produit réelle, prise dans la base ──
  ID_PRODUIT="$(q "SELECT mp.id FROM marketplace_products mp
                     LEFT JOIN products p ON p.id = mp.product_id
                    WHERE (mp.status='published' OR mp.is_published=true)
                      AND p.is_sellable IS NOT FALSE AND p.is_active IS NOT FALSE
                    ORDER BY mp.updated_at DESC NULLS LAST LIMIT 1")"

  if [ -z "$ID_PRODUIT" ]; then
    alerte "aucun produit publié en base : les contrôles de fiche produit sont sautés."
    alerte "Le sitemap ne listera aucun produit tant qu'aucun n'est publié."
  else
    URL_CANONIQUE="$(curl -s --max-time 20 "$BASE_BACK/public/products/$ID_PRODUIT" \
      | node -e 'let e="";process.stdin.on("data",c=>e+=c).on("end",()=>{try{console.log(JSON.parse(e).product.url)}catch{console.log("")}})')"
    [ -n "$URL_CANONIQUE" ] || stop "l'API publique ne renvoie pas d'URL pour le produit $ID_PRODUIT."
    info "produit témoin : $ID_PRODUIT → $URL_CANONIQUE"

    controle "fiche produit"                200 "$BASE_FRONT$URL_CANONIQUE"
    contient "titre rendu par le serveur"   "<title>"       "$BASE_FRONT$URL_CANONIQUE"
    contient "canonical présent"            'rel="canonical"' "$BASE_FRONT$URL_CANONIQUE"
    contient "données structurées Product"  '"@type":"Product"' "$BASE_FRONT$URL_CANONIQUE"
    contient "Open Graph présent"           'property="og:title"' "$BASE_FRONT$URL_CANONIQUE"

    # ── Ancienne URL → URL canonique ──
    REDIR="$(curl -s -o /dev/null -w '%{redirect_url}' --max-time 20 "$BASE_FRONT/marketplace/product/$ID_PRODUIT")"
    CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$BASE_FRONT/marketplace/product/$ID_PRODUIT")"
    case "$REDIR" in
      *"$URL_CANONIQUE") ok "ancienne URL redirigée en $CODE vers $URL_CANONIQUE" ;;
      *) alerte "ancienne URL : $CODE → « $REDIR », attendu $URL_CANONIQUE"; ECHECS=$((ECHECS+1)) ;;
    esac

    # ── Étanchéité de l'API publique ──
    for champ in location_code warehouse minimum_stock available_stock display_stock; do
      absent_de "API publique sans $champ" "\"$champ\"" "$BASE_BACK/marketplace/products/$ID_PRODUIT"
      absent_de "fiche HTML sans $champ"   "\"$champ\"" "$BASE_FRONT$URL_CANONIQUE"
    done
    absent_de "API publique sans niveau de stock" '"stock"' "$BASE_BACK/marketplace/products/$ID_PRODUIT"
    absent_de "liste publique sans emplacement"   'location_code' "$BASE_BACK/marketplace/products"
  fi

  # ── /partenaires reste privé ──
  ID_PARTENAIRE="$(q "SELECT id FROM partners ORDER BY id LIMIT 1" 2>/dev/null || echo "")"
  if [ -n "$ID_PARTENAIRE" ]; then
    CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$BASE_FRONT/partenaires/$ID_PARTENAIRE")"
    case "$CODE" in
      301|302|307|308) ok "/partenaires/$ID_PARTENAIRE toujours protégé (redirection $CODE)" ;;
      *) alerte "/partenaires/$ID_PARTENAIRE renvoie $CODE — la fiche CRM privée doit rediriger vers la connexion."; ECHECS=$((ECHECS+1)) ;;
    esac
    contient "robots interdit /partenaires" "Disallow: /partenaires" "$BASE_FRONT/robots.txt"
  fi

  # ── Vitrine publique ──
  SLUG_BOUTIQUE="$(q "SELECT cpp.slug FROM company_public_profile cpp
                        JOIN companies c ON c.id = cpp.company_id
                       WHERE cpp.is_public AND c.status='active' AND NULLIF(cpp.slug,'') IS NOT NULL
                       LIMIT 1")"
  if [ -n "$SLUG_BOUTIQUE" ]; then
    controle "vitrine /boutique/$SLUG_BOUTIQUE" 200 "$BASE_FRONT/boutique/$SLUG_BOUTIQUE"
    contient "vitrine avec données structurées" 'application/ld+json' "$BASE_FRONT/boutique/$SLUG_BOUTIQUE"
  else
    alerte "aucune entreprise n'a encore publié son profil : /boutique reste vide."
    alerte "C'est attendu — l'écran de saisie de company_public_profile est prévu en phase suivante."
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════
titre "13. JOURNAUX"
# ═══════════════════════════════════════════════════════════════════════════

if [ "$EXECUTER" -eq 1 ]; then
  for nom in $PM2_CIBLES; do
    echo; info "── $nom ──"
    pm2 logs "$nom" --lines 25 --nostream 2>/dev/null || true
  done
  for nom in $PM2_CIBLES; do
    if pm2 logs "$nom" --lines 60 --nostream 2>/dev/null \
       | grep -qiE "cannot find module|eaddrinuse|unhandledrejection|econnrefused"; then
      alerte "$nom : erreur repérée dans les journaux ci-dessus."
      ECHECS=$((ECHECS+1))
    fi
  done
fi

# ═══════════════════════════════════════════════════════════════════════════
titre "14. CONCLUSION"
# ═══════════════════════════════════════════════════════════════════════════

if [ "$EXECUTER" -ne 1 ]; then
  echo
  info "AUDIT TERMINÉ — aucune écriture n'a eu lieu."
  info "Relancez avec --executer pour déployer."
  echo
  exit 0
fi

if [ "$ECHECS" -gt 0 ]; then
  echo
  alerte "$ECHECS contrôle(s) en échec. pm2 save n'est PAS exécuté :"
  alerte "la configuration enregistrée reste celle d'avant, pour qu'un redémarrage"
  alerte "de la machine ne fige pas un état défaillant."
  echo
  echo "  Retour arrière — dans l'ordre :"
  echo "    cd $CHEMIN_BACKEND  && git merge --ff-only \$(git rev-parse HEAD@{1}) || git checkout \$(git rev-parse HEAD@{1})"
  echo "    cd $CHEMIN_FRONTEND && git checkout \$(git rev-parse HEAD@{1}) && npm run build"
  echo "    pm2 restart $PM2_CIBLES --update-env"
  echo "    # La base : 072 est purement additive, la laisser en place est sans effet"
  echo "    # sur l'application précédente. Ne restaurer le dump que si la base est"
  echo "    # réellement abîmée, car cela ANNULE toute écriture faite depuis :"
  echo "    #   pg_restore --clean --if-exists --no-owner -d \"\$DATABASE_URL\" $DUMP"
  echo
  exit 1
fi

pm2 save
ok "pm2 save effectué après succès complet"

echo
ok "DÉPLOIEMENT TERMINÉ"
info "backend  $SHA_BACKEND"
info "frontend $SHA_FRONTEND"
info "sauvegarde conservée : $DUMP"
echo
