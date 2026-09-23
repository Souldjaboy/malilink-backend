#!/usr/bin/env bash
# P2 — Caméras : sonde (unitaire), puis intégration deux fois — SANS clé de
# chiffrement (un secret doit être refusé) et AVEC (il doit être chiffré).
set -uo pipefail
cd "$(dirname "$0")/.."
node tests/camera-probe.unit.test.js || exit 1
echo; echo "════ SANS clé de chiffrement ════"
env -u WALLET_SECRET_ENC_KEY ./scripts/test-integration.sh tests/cameras.test.js; C1=$?
echo; echo "════ AVEC clé de chiffrement ════"
WALLET_SECRET_ENC_KEY="$(openssl rand -hex 32)" ./scripts/test-integration.sh tests/cameras.test.js; C2=$?
[ $C1 -eq 0 ] && [ $C2 -eq 0 ]
