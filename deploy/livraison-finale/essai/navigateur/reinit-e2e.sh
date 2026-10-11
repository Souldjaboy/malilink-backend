#!/usr/bin/env bash
# Base E2E neuve + backend E2E (port 5052) + profils Social. Jamais la base de développement.
set -euo pipefail
export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
D="$(cd "$(dirname "$0")" && pwd)"; BACK="${BACK:-$(cd "$D/../../../.." && pwd)}"
export DATABASE_URL=postgresql://postgres:malilink_test_password@127.0.0.1:5434/malilink_e2e JWT_SECRET=secret-e2e-navigateur-2026
pkill -f "secret-e2e-navigateur-2026" 2>/dev/null || true
lsof -nP -iTCP:5052 -sTCP:LISTEN -t | xargs -r kill 2>/dev/null || true; sleep 1
docker exec malilink-postgres-test psql -U postgres -qc "DROP DATABASE IF EXISTS malilink_e2e WITH (FORCE);" -c "CREATE DATABASE malilink_e2e;"
(cd "$BACK" && node scripts/migrate.js >/dev/null)
node "$D/seed-e2e.js" >/dev/null
(cd "$BACK" && env PORT=5052 DEFAULT_TENANT_ID=malilink LIVEKIT_URL=ws://localhost:7880 LIVEKIT_API_KEY=cleflocale \
  LIVEKIT_API_SECRET=secretlocal0123456789abcdef0123456789 SMTP_HOST=127.0.0.1 SMTP_PORT=1025 SMTP_USER=essai SMTP_PASS=essai \
  SMTP_FROM=noreply@malilink.test PUBLIC_BASE_URL=${PUBLIC_BASE_URL:-http://localhost:3000} E2E_MARQUEUR=secret-e2e-navigateur-2026 \
  nohup node server.js > "$D/../backend-e2e.log" 2>&1 &)
for _ in $(seq 1 60); do curl -s -o /dev/null localhost:5052/ && break; sleep 1; done
node -e '
const d=require(process.argv[1]);
(async()=>{for (const [n,t] of [["Fanta Hôte",d.jetons.hote],["Issa Spectateur",d.jetons.spectateur]]) {
 const r=await fetch("http://localhost:5052/social/profile",{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${t}`},body:JSON.stringify({display_name:n,birth_date:"1995-03-10",photo_url:"/uploads/photo-essai.jpg",city:"Bamako",is_public:true})});
 if (r.status!==201) throw new Error(n+" "+r.status);}})()' "$D/e2e-donnees.json"
echo "E2E prêt (backend 5052, base malilink_e2e)"
