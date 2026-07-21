# Déploiement VPS — Lot 4A (MaliLink Voyage)

Guide à copier-coller, section par section. **N'exécute la suite qu'après avoir
vérifié la sortie de chaque étape.** Rien de destructif tant que tu n'as pas
confirmé l'étape 1 (sauvegarde).

## 0. Paramètres (à adapter UNE FOIS)

```bash
# Adapte ces 3 lignes à ton VPS, puis colle tout le bloc.
export BACKEND_DIR=/var/www/malilink/backend   # dossier du backend sur le VPS
export PM2_NAME=malilink-backend                # nom du process PM2
export PORT=5050                                # port du backend (voir .env / pm2)
export BASE="http://localhost:$PORT"
export TH='-H x-app-product:malilink -H x-tenant-id:malilink'
cd "$BACKEND_DIR" && pwd
```

---

## 1. Sauvegarde PostgreSQL (AVANT toute modification)

```bash
cd "$BACKEND_DIR"
DBURL=$(grep -E '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"')
mkdir -p ~/backups
STAMP=$(date +%Y%m%d_%H%M%S)
pg_dump "$DBURL" > ~/backups/malilink_before_lot4a_$STAMP.sql
ls -lh ~/backups/malilink_before_lot4a_$STAMP.sql   # doit afficher une taille > 0
echo "Sauvegarde : ~/backups/malilink_before_lot4a_$STAMP.sql"
```

> Ne continue que si le fichier existe et n'est pas vide.

---

## 2. Récupérer le code et vérifier le HEAD

```bash
cd "$BACKEND_DIR"
git fetch origin
git status                       # doit être propre ; sinon voir §14
git checkout main
git pull --ff-only origin main
git log --oneline -1             # HEAD attendu : eedacc8 (ou plus récent)
git merge-base --is-ancestor eedacc8 HEAD && echo "OK : le Lot 4A est présent" \
  || echo "ATTENTION : le commit eedacc8 du Lot 4A n'est pas dans HEAD"
```

---

## 3. Vérifier la présence des fichiers de migration 054 → 057

```bash
cd "$BACKEND_DIR"
ls -1 sql/054_wallet_qr_payments.sql \
      sql/055_wallet_reinforcement.sql \
      sql/056_phase0_hardening.sql \
      sql/057_travel_foundations.sql
# Les 4 fichiers doivent être listés sans erreur.
```

---

## 4. Voir quelles migrations sont déjà appliquées (n'exécute rien)

```bash
cd "$BACKEND_DIR"
npm run migrate:status
```

Interprétation :
- **Cas normal** : « En attente » liste uniquement `057_travel_foundations.sql`
  (ou 055/056/057 si tu n'avais pas encore déployé la Phase 0). → passe à §5.
- **Cas rare** : si TOUTES les migrations (`000_…` comprises) apparaissent « en
  attente », le suivi n'a jamais été initialisé alors que la base est déjà en
  service. Les fichiers 054→057 sont idempotents, mais **ne lance pas encore
  `migrate`** : copie-moi la sortie de `migrate:status` d'abord.

---

## 5. Ajouter les secrets forts dans `.env` (sans écraser l'existant)

```bash
cd "$BACKEND_DIR"
for KEY in WALLET_RECEIPT_SECRET WALLET_SECRET_ENC_KEY TRAVEL_TICKET_SECRET; do
  if grep -q "^${KEY}=" .env; then
    echo "$KEY : déjà présent, inchangé"
  else
    echo "${KEY}=$(openssl rand -hex 32)" >> .env
    echo "$KEY : ajouté"
  fi
done
```

Vérifier qu'ils sont forts, distincts entre eux ET différents de `JWT_SECRET`
(le script affiche seulement des empreintes, jamais les secrets) :

```bash
cd "$BACKEND_DIR"
node -e '
require("dotenv").config();
const c=require("crypto"); const fp=v=>v?c.createHash("sha256").update(v).digest("hex").slice(0,12):"(absent)";
const keys=["JWT_SECRET","WALLET_RECEIPT_SECRET","WALLET_SECRET_ENC_KEY","TRAVEL_TICKET_SECRET"];
const vals=keys.map(k=>process.env[k]);
keys.forEach((k,i)=>console.log(k.padEnd(24),"len",(vals[i]||"").length,"fp",fp(vals[i])));
const set=new Set(vals.filter(Boolean));
console.log(set.size===vals.filter(Boolean).length ? "OK : tous distincts" : "ERREUR : au moins deux secrets identiques");
const enc=process.env.WALLET_SECRET_ENC_KEY||"";
console.log(/^[0-9a-f]{64}$/i.test(enc)?"OK : WALLET_SECRET_ENC_KEY = 32 octets hex":"ATTENTION : WALLET_SECRET_ENC_KEY doit faire 64 hex");
'
```

> Attends de voir « OK : tous distincts » avant de continuer.

---

## 6. Installer les dépendances (sans `npm audit fix --force`)

```bash
cd "$BACKEND_DIR"
npm install --no-audit --no-fund
```

---

## 7. Exécuter les migrations dans l'ordre

```bash
cd "$BACKEND_DIR"
npm run migrate
npm run migrate:status     # « En attente : 0 » attendu
```

Vérifier que le schéma Travel est en place :

```bash
cd "$BACKEND_DIR"
DBURL=$(grep -E '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"')
psql "$DBURL" -c "SELECT count(*) AS tables_travel FROM information_schema.tables WHERE table_name LIKE 'travel_%';"
# attendu : 26
psql "$DBURL" -c "\di idx_wallet_entries_transaction"   # index critique Phase 0 présent
```

---

## 8. Lancer tous les tests (attendu : 47/47)

```bash
cd "$BACKEND_DIR"
npm test 2>&1 | tail -12
# Doit afficher : tests 47 / pass 47 / fail 0
```

> Si un test échoue, **ne redémarre pas** : copie-moi la sortie.

---

## 9. Redémarrer UNIQUEMENT malilink-backend

```bash
pm2 restart "$PM2_NAME" --update-env
pm2 status "$PM2_NAME"
# NE JAMAIS faire « pm2 restart all » (Triangle / Hafiya ne doivent pas bouger).
```

---

## 10. Logs de démarrage + santé

```bash
pm2 logs "$PM2_NAME" --lines 40 --nostream
# Cherche : « Backend sécurisé démarré », d'éventuels avertissements [env],
# et AUCUNE erreur de montage de router.

curl -s $BASE/travel/health $TH ; echo
# attendu : {"module":"MaliLink Voyage","status":"ok","lot":"4A"}
```

---

## 11. Routes Travel publiques

```bash
# Modes de transport
curl -s $BASE/travel/modes $TH | head -c 400; echo

# Destinations (récupère les IDs de Bamako et Sikasso)
BKO=$(curl -s "$BASE/travel/cities?q=Bamako" $TH | node -pe 'JSON.parse(require("fs").readFileSync(0)).cities[0]?.id')
SIK=$(curl -s "$BASE/travel/cities?q=Sikasso" $TH | node -pe 'JSON.parse(require("fs").readFileSync(0)).cities[0]?.id')
echo "Bamako=$BKO  Sikasso=$SIK"

# Recherche + comparateur (peut renvoyer 0 offre si aucune ligne n'existe encore : normal)
curl -s "$BASE/travel/search?origin=$BKO&destination=$SIK&date=$(date -d '+1 day' +%F 2>/dev/null || date -v+1d +%F)&adults=1" $TH | head -c 600; echo
```

---

## 12. Parcours partenaire complet (crée puis nettoie des données de test)

```bash
cd "$BACKEND_DIR"
# Trouver un utilisateur réel pour signer le jeton de test (ex. super admin)
DBURL=$(grep -E '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"')
UID=$(psql "$DBURL" -tAc "SELECT id FROM users WHERE role='super_admin' ORDER BY id LIMIT 1")
echo "USER_ID=$UID"

# Jeton de test signé avec le JWT_SECRET du serveur (valable 1h, non stocké)
TOKEN=$(node -e '
require("dotenv").config(); const jwt=require("jsonwebtoken");
console.log(jwt.sign({id:Number(process.argv[1]),role:"super_admin",is_super_admin:true,company_id:null,tenant_id:"malilink",subscription_status:"active"},process.env.JWT_SECRET,{expiresIn:"1h"}));
' "$UID")
AUTH="-H Authorization:Bearer $TOKEN -H Content-Type:application/json"

# Récupérer les IDs de villes
BKO=$(curl -s "$BASE/travel/cities?q=Bamako" $TH | node -pe 'JSON.parse(require("fs").readFileSync(0)).cities[0].id')
SIK=$(curl -s "$BASE/travel/cities?q=Sikasso" $TH | node -pe 'JSON.parse(require("fs").readFileSync(0)).cities[0].id')

# 1) Devenir compagnie
CID=$(curl -s -X POST $BASE/travel/partner/company $TH $AUTH -d '{"name":"TEST Voyage (à supprimer)","phone":"+22300000000"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).company.id')
echo "travel_company_id=$CID"
# 2) Véhicule
VID=$(curl -s -X POST $BASE/travel/partner/vehicles $TH $AUTH -d '{"name":"Bus test","mode_code":"bus","capacity":50,"has_ac":true}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).vehicle.id')
# 3) Ligne
RID=$(curl -s -X POST $BASE/travel/partner/routes $TH $AUTH -d "{\"mode_code\":\"bus\",\"origin_city_id\":$BKO,\"destination_city_id\":$SIK,\"duration_minutes\":240,\"services\":[\"clim\",\"wifi\"]}" | node -pe 'JSON.parse(require("fs").readFileSync(0)).route.id')
echo "route_id=$RID"
# 4) Horaire
curl -s -X POST $BASE/travel/partner/routes/$RID/schedules $TH $AUTH -d "{\"vehicle_id\":$VID,\"departure_time\":\"08:00\",\"arrival_time\":\"12:00\",\"days_of_week\":[0,1,2,3,4,5,6],\"seats_total\":50}" | head -c 200; echo
# 5) Prix
curl -s -X POST $BASE/travel/partner/routes/$RID/prices $TH $AUTH -d '{"seat_class":"standard","base_price":6000,"child_price":3000}' | head -c 200; echo
# 6) Promotion -15% (via SQL, table travel_promotions)
psql "$DBURL" -c "INSERT INTO travel_promotions(travel_company_id,route_id,label,discount_type,discount_value,active) VALUES($CID,$RID,'Test','percent',15,true);"
# 7) Recherche publique : doit trouver l'offre avec remise
curl -s "$BASE/travel/search?origin=$BKO&destination=$SIK&date=$(date -d '+1 day' +%F 2>/dev/null || date -v+1d +%F)&adults=2&children=1" $TH | head -c 700; echo

# NETTOYAGE des données de test (cascade supprime véhicule/ligne/horaire/prix/promo)
psql "$DBURL" -c "DELETE FROM travel_companies WHERE id=$CID;"
echo "Données de test supprimées."
```

> Attendu à l'étape 7 : `subtotal` 15000, `discount` 2250, `total` 12750, et
> `comparator.cheapest` = l'offre trouvée.

---

## 13. Non-régression des modules existants (aucun 500 attendu)

```bash
# Public
printf "Wallet devises   : "; curl -s -o /dev/null -w "%{http_code}\n" $BASE/wallet/v1/currencies $TH
printf "Marketplace      : "; curl -s -o /dev/null -w "%{http_code}\n" $BASE/marketplace/products $TH

# Avec jeton (réutilise $TOKEN de l'étape 12 ; sinon reprends sa génération)
AUTH="-H Authorization:Bearer $TOKEN"
printf "Wallet /me       : "; curl -s -o /dev/null -w "%{http_code}\n" $BASE/wallet/me $TH $AUTH
printf "Finance overview : "; curl -s -o /dev/null -w "%{http_code}\n" $BASE/finance/overview $TH $AUTH
printf "Comptabilité     : "; curl -s -o /dev/null -w "%{http_code}\n" $BASE/accounting/dashboard $TH $AUTH
printf "POS settings     : "; curl -s -o /dev/null -w "%{http_code}\n" $BASE/pos/settings $TH $AUTH
printf "Social feed      : "; curl -s -o /dev/null -w "%{http_code}\n" $BASE/social/feed $TH $AUTH
```

Attendu : `200` partout (jamais `500`). Un `401/403` signifierait juste un
jeton invalide, pas une panne du module. Complète par un test visuel : connecte-toi
à l'app et ouvre Wallet, Marketplace, POS, Comptabilité, Social.

---

## 14. Rollback (en cas d'erreur)

**A. Le backend ne démarre pas / erreurs après le pull** — revenir au commit précédent :
```bash
cd "$BACKEND_DIR"
git log --oneline -5                       # repère le commit AVANT eedacc8 (ex. e228927)
git checkout e228927                       # ou le commit stable précédent
npm install --no-audit --no-fund
pm2 restart "$PM2_NAME" --update-env
curl -s $BASE/travel/health $TH ; echo
```

**B. Une migration a échoué / données incohérentes** — restaurer la sauvegarde :
```bash
cd "$BACKEND_DIR"
DBURL=$(grep -E '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"')
# ⚠️ écrase la base actuelle par la sauvegarde de l'étape 1
psql "$DBURL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
psql "$DBURL" < ~/backups/malilink_before_lot4a_<STAMP>.sql
pm2 restart "$PM2_NAME" --update-env
```

**C. Annuler seulement Travel (sans toucher au reste)** — le module est isolé :
```bash
# Désactiver le module sans rien supprimer
DBURL=$(grep -E '^DATABASE_URL=' .env | cut -d= -f2- | tr -d '"')
psql "$DBURL" -c "UPDATE travel_feature_flags SET enabled=false WHERE flag_key='travel_enabled';"
# Les routes /travel renvoient alors 503 ; aucun autre module n'est affecté.
```

Les tables `travel_*` sont préfixées et indépendantes : les supprimer
n'affecte aucun module existant (à ne faire qu'en dernier recours, base
sauvegardée).

---

### Checklist de validation
- [ ] Sauvegarde créée (§1)
- [ ] HEAD contient eedacc8 (§2)
- [ ] Migrations 054–057 présentes (§3) et appliquées (§7, « En attente : 0 »)
- [ ] 3 secrets forts, distincts, ≠ JWT_SECRET (§5)
- [ ] 47/47 tests OK (§8)
- [ ] `pm2 restart malilink-backend --update-env` seulement (§9)
- [ ] `/travel/health` = ok (§10)
- [ ] Modes / destinations / recherche OK (§11)
- [ ] Parcours partenaire → total 12750 (§12), données de test supprimées
- [ ] Modules existants : 200 partout (§13)
