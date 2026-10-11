# Appels et directs MaliLink Social — mise en service LiveKit (VPS)

Le code est livré **inactif**. Tant que LiveKit n'est pas configuré ET
joignable ET que les drapeaux ne sont pas activés, l'application affiche
« Appels / Directs indisponibles » : aucun appel ni direct simulé. Le serveur
vérifie réellement LiveKit avant d'ouvrir quoi que ce soit.

Ce document ne fournit ni DNS, ni certificat, ni clé : tout se crée chez vous.
Toutes les commandes se lancent depuis ce dossier (celui des fichiers `*.example`).

Modèles vérifiés localement le 11/10/2026 : `livekit.yaml.example` démarre
LiveKit 1.13.8 avec son TURN (UDP 3478, TLS 5349, relais 30000-40000) ; les
deux fichiers Nginx passent `nginx -t` en 1.18 (Ubuntu 22.04) et 1.24
(Ubuntu 24.04). L'ancien modèle (`http2 on;`) échouait sur ces deux versions.

## 0. Prérequis (propriétaire du domaine)

1. DNS : enregistrement **A**, hôte **rtc**, valeur **l'IP publique du VPS**.
2. Vérifier depuis le VPS : `dig +short rtc.malilinkglobal.com` doit afficher
   cette IP. **Ne rien configurer côté Nginx avant que ce soit le cas.**
3. Pare-feu du fournisseur (panneau d'hébergement), s'il existe : ouvrir les
   mêmes ports qu'à l'étape 4.

## 1. Installer LiveKit et générer les clés

```bash
curl -sSL https://get.livekit.io | bash          # installe /usr/local/bin/livekit-server
livekit-server --version
livekit-server generate-keys                      # note la clé API et le secret (≥ 32 caractères)
useradd --system --no-create-home livekit
install -d -m 750 -o livekit -g livekit /etc/livekit
install -m 600 -o livekit -g livekit livekit.yaml.example /etc/livekit/livekit.yaml
nano /etc/livekit/livekit.yaml                    # remplacer CLE_API_A_REMPLACER: SECRET_... par la vraie paire
```

## 2. Nginx en deux temps (site dédié, aucun autre site touché)

```bash
cp nginx-rtc.malilinkglobal.com.http.conf.example /etc/nginx/sites-available/rtc.malilinkglobal.com
ln -s /etc/nginx/sites-available/rtc.malilinkglobal.com /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
certbot certonly --webroot -w /var/www/html -d rtc.malilinkglobal.com
cp nginx-rtc.malilinkglobal.com.conf.example /etc/nginx/sites-available/rtc.malilinkglobal.com
nginx -t && systemctl reload nginx
```

## 3. Certificat pour le TURN/TLS (crochet de renouvellement)

```bash
install -m 700 certbot-deploy-livekit.sh.example /etc/letsencrypt/renewal-hooks/deploy/livekit.sh
RENEWED_DOMAINS=rtc.malilinkglobal.com /etc/letsencrypt/renewal-hooks/deploy/livekit.sh
ls -l /etc/livekit/tls/                           # fullchain.pem et privkey.pem, propriétaire livekit
```

## 4. Pare-feu et démarrage

```bash
ufw allow 7881/tcp && ufw allow 7882/udp          # média WebRTC
ufw allow 3478/udp && ufw allow 5349/tcp          # TURN UDP et TLS
ufw allow 30000:40000/udp                         # ports de relais TURN
printf 'net.core.rmem_max=5000000\nnet.core.wmem_max=5000000\n' > /etc/sysctl.d/99-livekit.conf && sysctl --system   # tampon UDP conseillé par LiveKit
cp livekit.service.example /etc/systemd/system/livekit.service
systemctl daemon-reload && systemctl enable --now livekit
systemctl status livekit --no-pager
ss -lntup | grep -E ':(7880|7881|7882|3478|5349)\b'   # 7880 sur 127.0.0.1 seulement
```

Le port 7880 n'est jamais ouvert au public : Nginx le publie en `wss://`.

## 5. Brancher MaliLink

Dans le `.env` du backend MaliLink (jamais commité) :

```
LIVEKIT_URL=wss://rtc.malilinkglobal.com
LIVEKIT_API_URL=http://127.0.0.1:7880
LIVEKIT_API_KEY=<clé générée>
LIVEKIT_API_SECRET=<secret généré, 32 caractères ou plus>
```

Puis redémarrer **uniquement** le backend MaliLink (`pm2 restart malilink-backend`)
et activer :

```sql
UPDATE social_feature_flags SET enabled = true WHERE flag_key = 'social_calls_enabled';        -- appels audio
UPDATE social_feature_flags SET enabled = true WHERE flag_key = 'social_video_calls_enabled';  -- appels vidéo
UPDATE social_feature_flags SET enabled = true WHERE flag_key = 'social_lives_enabled';        -- directs
```

## 6. Contrôles (obligatoires avant d'annoncer que ça marche)

1. `curl -s https://rtc.malilinkglobal.com` → `OK`.
2. Avec un compte connecté, `GET /api/social/lives/config` →
   `"enabled": true` et `"verifications": { "serveur": true }`.
3. **Deux appareils sur deux réseaux différents** (un téléphone en 4G/5G,
   un ordinateur en Wi-Fi) :
   - direct : lancer depuis l'un, regarder depuis l'autre — image ET son reçus,
     compteur à 1, commentaire reçu, exclusion qui coupe le spectateur, fin ;
   - appel audio puis vidéo entre deux amis.
4. Si l'image ne passe pas sur le réseau mobile, ouvrir
   `chrome://webrtc-internals` : une paire de candidats « relay » doit
   apparaître ; sinon revoir les ports 3478/5349/30000-40000.

Tant que le point 3 n'est pas validé, les directs ne sont **pas** opérationnels.
Aucun test de charge n'a été fait : 100 personnes par salle au plus
(`max_participants`), capacité réelle inconnue au-delà de quelques dizaines.

## 7. Retour arrière

Immédiat, sans redémarrage : remettre les trois drapeaux à `false` (les boutons
disparaissent en moins d'une minute). Pour arrêter le serveur média :
`systemctl disable --now livekit` ; pour retirer le site :
`rm /etc/nginx/sites-enabled/rtc.malilinkglobal.com && nginx -t && systemctl reload nginx`.
