#!/usr/bin/env bash
# P0 — accès effectif. Base NEUVE à chaque lancement, deux phases séparées
# par un vrai redémarrage du serveur (persistance des décisions).
set -uo pipefail
cd "$(dirname "$0")/.."

export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
BASE_NOM="${BASE_NOM:-malilink_p0}"
export PORT="${PORT:-5078}"
export JWT_SECRET="${JWT_SECRET:-secret-de-test-acces-effectif-2026}"
export DATABASE_URL="postgresql://postgres:malilink_test_password@127.0.0.1:5434/${BASE_NOM}"
export DEFAULT_TENANT_ID=malilink
export NODE_ENV=test

docker exec malilink-postgres-test psql -U postgres -qc "DROP DATABASE IF EXISTS ${BASE_NOM};" >/dev/null
docker exec malilink-postgres-test psql -U postgres -qc "CREATE DATABASE ${BASE_NOM};" >/dev/null
node scripts/migrate.js >/tmp/p0-migrations.log 2>&1 || { echo "migrations en échec"; tail -20 /tmp/p0-migrations.log; exit 1; }
echo "migrations : $(grep -c '^  OK' /tmp/p0-migrations.log) appliquées"

demarrer() {
  node server.js >"/tmp/p0-serveur-$1.log" 2>&1 &
  SERVEUR=$!
  for _ in $(seq 1 60); do curl -s -o /dev/null "http://127.0.0.1:${PORT}/" && return 0; sleep 1; done
  echo "serveur injoignable"; tail -30 "/tmp/p0-serveur-$1.log"; return 1
}

demarrer 1 || exit 1
node tests/acces-effectif.test.js --phase=1
CODE1=$?
kill $SERVEUR 2>/dev/null; wait $SERVEUR 2>/dev/null

demarrer 2 || exit 1
node tests/acces-effectif.test.js --phase=2
CODE2=$?
kill $SERVEUR 2>/dev/null; wait $SERVEUR 2>/dev/null

[ $CODE1 -eq 0 ] && [ $CODE2 -eq 0 ]
