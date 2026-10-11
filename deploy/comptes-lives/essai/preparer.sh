#!/usr/bin/env bash
# Copie de la production MaliLink dans le VPS d'essai (exécuté dans le conteneur, en root).
set -euo pipefail
until pg_isready -q -h 127.0.0.1; do sleep 1; done
R=/var/www/releases/academy-essai
mkdir -p $R/backend $R/frontend /etc/essai /root/backups
tar xf /essai/backend-prod.tar -C $R/backend
(cd $R/backend && npm ci --omit=dev --no-audit --no-fund --loglevel=error >/dev/null)
cat > $R/backend/.env <<ENV
DATABASE_URL=postgresql://malilink_app:motdepasse-app@127.0.0.1:5432/malilink_prod
JWT_SECRET=secret-du-vps-essai-2026
PORT=5050
DEFAULT_TENANT_ID=malilink
WALLET_SECRET_ENC_KEY=$(openssl rand -hex 32 2>/dev/null || node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')
WALLET_RECEIPT_SECRET=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')
EDU_DOC_SECRET=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')
TRAVEL_TICKET_SECRET=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')
ENV
runuser -u postgres -- psql -q -c "CREATE ROLE malilink_app LOGIN PASSWORD 'motdepasse-app'" -c "CREATE DATABASE malilink_prod OWNER malilink_app"
(cd $R/backend && node scripts/migrate.js > /root/migrations-initiales.log 2>&1)
# Quelques données réelles : une école, son administrateur, un client.
psql postgresql://malilink_app:motdepasse-app@127.0.0.1:5432/malilink_prod -q -c "
  INSERT INTO companies (id, name, business_type, status, tenant_id) VALUES (8, 'MALILINK SCOOL', 'ecole', 'active', 'malilink');
  INSERT INTO users (fullname, email, password, role, company_id, tenant_id) VALUES ('Directeur', 'directeur@ecole.test', 'x', 'admin', 8, 'malilink'), ('Client', 'client@essai.test', 'x', 'customer', NULL, 'malilink');"
tar xf /essai/frontend-prod.tar -C $R/frontend
cp /essai/faux-next.js $R/frontend/faux-next.js
node -e 'const f=process.argv[1],p=require(f);p.scripts={build:"node faux-next.js build",start:"node faux-next.js start"};require("fs").writeFileSync(f,JSON.stringify(p,null,2))' $R/frontend/package.json
mkdir -p $R/frontend/node_modules/livekit-client
(cd $R/frontend && node faux-next.js build >/dev/null)
# Processus PM2 comme en production : l'environnement de lancement d'origine
# (PORT, MARQUEUR_ESSAI) n'existe QUE dans la définition PM2.
(cd $R/backend && NODE_ENV=production pm2 start server.js --name malilink-backend >/dev/null)
(cd $R/frontend && env PORT=3020 MARQUEUR_ESSAI=lancement-origine-7f3a NODE_ENV=production pm2 start npm --name malilink-frontend --max-memory-restart 700M -- start >/dev/null)
PORT=4101 NOM_TEMOIN=triangle pm2 start /essai/temoin.js --name triangle-backend >/dev/null
PORT=4102 NOM_TEMOIN=hafiya pm2 start /essai/temoin.js --name hafiya-frontend >/dev/null
pm2 start /essai/faux-nginx.js --name nginx-essai >/dev/null
pm2 save --force >/dev/null
for i in $(seq 1 30); do curl -sf -o /dev/null http://127.0.0.1:8080/ && curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/education/learning/programs | grep -qE '401|403' && break; sleep 1; done
echo "PRODUCTION D'ESSAI PRÊTE : $(curl -s http://127.0.0.1:8080/__essai) · Academy $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/education/learning/programs)"
