#!/usr/bin/env bash
# Lance des scénarios, chacun dans un VPS d'essai neuf.  lancer.sh <image> <scénario>...
set -uo pipefail
V="$(cd "$(dirname "$0")" && pwd)"; P="${PAQUET:?chemin du paquet}"; IMG="$1"; shift
export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
mkdir -p "$V/resultats"
for s in "$@"; do
  c="vps-$s-$$"
  docker run -d --name "$c" -e POSTGRES_PASSWORD=essai -v "$V:/essai:ro" "$IMG" >/dev/null
  docker cp "$P" "$c:/root/malilink-comptes-lives" >/dev/null
  docker exec "$c" bash /essai/scenario.sh "$s" 2>&1 | tee "$V/resultats/${IMG#*:}-$s.txt"
  docker exec "$c" bash -c "cat /root/deploiement-$s.log" > "$V/resultats/${IMG#*:}-$s.deploy.log" 2>/dev/null
  docker exec "$c" bash -c "cat /root/deploiement-$s.log.retour" > "$V/resultats/${IMG#*:}-$s.retour.log" 2>/dev/null || true
  docker rm -f "$c" >/dev/null
done
