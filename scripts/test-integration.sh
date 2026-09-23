#!/usr/bin/env bash
# Lance un fichier de test d'intégration sur une base NEUVE et un vrai serveur.
#   scripts/test-integration.sh tests/offres.test.js
set -uo pipefail
cd "$(dirname "$0")/.."
TEST="${1:?fichier de test attendu}"
export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
BASE_NOM="malilink_$(basename "$TEST" .test.js | tr '-' '_')"
export PORT="${PORT:-5079}"
export JWT_SECRET="${JWT_SECRET:-secret-de-test-integration-2026}"
export DATABASE_URL="postgresql://postgres:malilink_test_password@127.0.0.1:5434/${BASE_NOM}"
export DEFAULT_TENANT_ID=malilink
export NODE_ENV=test
docker exec malilink-postgres-test psql -U postgres -qc "DROP DATABASE IF EXISTS ${BASE_NOM};" >/dev/null 2>&1
docker exec malilink-postgres-test psql -U postgres -qc "CREATE DATABASE ${BASE_NOM};" >/dev/null
node scripts/migrate.js >"/tmp/${BASE_NOM}-migrations.log" 2>&1 || { echo "migrations en échec"; tail -20 "/tmp/${BASE_NOM}-migrations.log"; exit 1; }
node server.js >"/tmp/${BASE_NOM}-serveur.log" 2>&1 &
SERVEUR=$!
trap 'kill $SERVEUR 2>/dev/null' EXIT
for _ in $(seq 1 60); do curl -s -o /dev/null "http://127.0.0.1:${PORT}/" && break; sleep 1; done
node "$TEST"
