#!/usr/bin/env bash
# Biométrie + passkeys : deux phases, serveur relancé entre les deux.
#   1. avec BIOMETRIC_ENC_KEY : parcours complet (simulateurs de test) ;
#   2. sans clé : tout enregistrement biométrique doit être refusé.
set -uo pipefail
cd "$(dirname "$0")/.."
export BIOMETRIC_ALLOW_MOCK=1
export WEBAUTHN_RP_ID=localhost
export WEBAUTHN_ORIGINS=http://localhost:3001
export WEBAUTHN_RP_NAME="MaliLink (tests)"
echo "═══ Phase 1 : avec BIOMETRIC_ENC_KEY"
BIOMETRIC_ENC_KEY="$(openssl rand -hex 32)" PHASE=avec_cle bash scripts/test-integration.sh tests/biometrie.test.js
c1=$?
echo "═══ Phase 2 : sans BIOMETRIC_ENC_KEY"
env -u BIOMETRIC_ENC_KEY -u BIOMETRIC_ENC_KEYS PHASE=sans_cle bash scripts/test-integration.sh tests/biometrie.test.js
c2=$?
exit $(( c1 || c2 ))
