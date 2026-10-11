#!/usr/bin/env bash
# Non-régression complète de la livraison MaliLink (comptes, OTP, espaces,
# Super Admin, Academy, Social et directs). Chaque suite d'intégration
# tourne sur une base PostgreSQL NEUVE et un vrai serveur.
#
#   scripts/test-livraison.sh            depuis le dossier backend
#
# Services locaux attendus (Docker) :
#   malilink-postgres-test (5434) · mailpit-essai (SMTP 1025, API 8025, auth acceptée)
#   mailpit-auth (SMTP 1026, auth « essai:bon-secret-2026 » exigée)
#   livekit-essai (7880-7882, clés « cleflocale: secretlocal0123456789abcdef0123456789 »)
# Résumé : un tableau « suite | résultat », code de sortie 1 au moindre échec.
set -uo pipefail
cd "$(dirname "$0")/.."
RESUME="${RESUME:-/tmp/malilink-test-livraison.txt}"
: > "$RESUME"
ECHECS=0

bilan() {  # nom  fichier-de-sortie  code
  local ligne
  ligne="$(sed 's/\x1b\[[0-9;]*m//g' "$2" | grep -E "BILAN|^ℹ (pass|fail) |^(✅|❌) " | tr '\n' ' ' | sed 's/  */ /g')"
  [ -n "$ligne" ] || ligne="(aucun bilan — voir $2)"
  if [ "$3" != 0 ] || echo "$ligne" | grep -qE "[1-9][0-9]* échoués|fail [1-9]"; then ECHECS=$((ECHECS + 1)); ligne="ÉCHEC · $ligne"; fi
  printf '%-58s %s\n' "$1" "$ligne" | tee -a "$RESUME"
}
suite() {  # nom  commande…
  local nom="$1"; shift
  local sortie="/tmp/malilink-livraison-$(echo "$nom" | tr -c 'a-zA-Z0-9' '_').log"
  ( "$@" ) > "$sortie" 2>&1
  bilan "$nom" "$sortie" $?
}
LK=(env MODE=reel LIVEKIT_URL=ws://127.0.0.1:7880 LIVEKIT_API_KEY=cleflocale LIVEKIT_API_SECRET=secretlocal0123456789abcdef0123456789)
LK_MUET=(env MODE=injoignable LIVEKIT_URL=ws://127.0.0.1:7999 LIVEKIT_API_KEY=cleflocale LIVEKIT_API_SECRET=secretlocal0123456789abcdef0123456789)
SMTP=(env SMTP_HOST=127.0.0.1 SMTP_PORT=1025 SMTP_USER=essai SMTP_PASS=essai SMTP_FROM=noreply@malilink.test)
SMTP_REFUS=(env SMTP_HOST=127.0.0.1 SMTP_PORT=1026 SMTP_USER=essai SMTP_PASS=mauvais-secret-XYZ-2026 SMTP_FROM=noreply@malilink.test)
OAUTH=(env INSTAGRAM_CLIENT_ID=essai INSTAGRAM_CLIENT_SECRET=essai-secret INSTAGRAM_AUTH_URL=http://127.0.0.1:5098/auth
  INSTAGRAM_TOKEN_URL=http://127.0.0.1:5098/token INSTAGRAM_USERINFO_URL=http://127.0.0.1:5098/me)
IT=scripts/test-integration.sh

# Unitaires (services/*.test.js : Academy sur PostgreSQL embarqué, espaces…)
suite "unitaires services (node --test)" node --test services/*.test.js services/**/*.test.js
suite "unitaire contrôle d'accès" node tests/access-control.unit.test.js
suite "unitaire biométrie" node tests/biometrie.unit.test.js

# Comptes, OTP, emails, espaces
suite "comptes — SMTP réel local (Mailpit)" "${SMTP[@]}" $IT tests/comptes.test.js
suite "comptes — sans SMTP" env -u SMTP_HOST $IT tests/comptes.test.js
suite "authentification multi-espace — SMTP + OAuth" "${SMTP[@]}" "${OAUTH[@]}" $IT tests/auth-espaces.test.js
suite "authentification multi-espace — sans SMTP, OAuth" "${OAUTH[@]}" $IT tests/auth-espaces.test.js
suite "erreurs SMTP — authentification refusée" "${SMTP_REFUS[@]}" $IT tests/smtp-erreurs.test.js

# Academy, Éducation, permissions
suite "Academy de bout en bout (vrai serveur)" $IT tests/academy.test.js
for t in education-parcours education-tenant-isolation education-cartes education-documents; do suite "$t" $IT tests/$t.test.js; done
suite "accès effectif (2 phases)" bash scripts/test-acces-effectif.sh

# Social, appels, directs
suite "social" $IT tests/social.test.js
suite "appels — sans LiveKit" env -u LIVEKIT_URL $IT tests/social-appels.test.js
suite "appels — LiveKit réel" "${LK[@]}" $IT tests/social-appels.test.js
suite "directs — sans LiveKit" env MODE=absent $IT tests/social-lives.test.js
suite "directs — LiveKit injoignable" "${LK_MUET[@]}" $IT tests/social-lives.test.js
suite "directs — LiveKit réel" "${LK[@]}" $IT tests/social-lives.test.js
suite "directs — sans LiveKit, Social dans 2 espaces" env MODE=absent SOCIAL_ESPACES=malilink,hafiya $IT tests/social-lives.test.js
suite "directs — LiveKit réel, Social dans 2 espaces" "${LK[@]}" SOCIAL_ESPACES=malilink,hafiya $IT tests/social-lives.test.js

# Reste de la plateforme (non-régression)
for t in abonnements marketing offres pointage-securise profil-public; do suite "$t" $IT tests/$t.test.js; done
suite "biométrie + passkeys (2 phases)" bash scripts/test-biometrie.sh
suite "caméras (sonde + 2 phases)" bash scripts/test-cameras.sh

echo
echo "Suites en échec : $ECHECS — résumé : $RESUME"
[ "$ECHECS" = 0 ]
