# Appels audio/vidéo MaliLink Social — mise en service LiveKit

Le code des appels est livré **inactif**. Tant que LiveKit n'est pas configuré,
`GET /social/calls/config` répond `{ "enabled": false }`, aucun bouton d'appel
n'apparaît et la messagerie fonctionne normalement.

## Prérequis (à faire par le propriétaire du domaine)

1. DNS : enregistrement **A**, hôte **rtc**, valeur **72.62.232.24**.
2. Vérifier : `dig +short rtc.malilinkglobal.com` → `72.62.232.24`.
   **Ne rien configurer côté Nginx avant que cette commande réponde.**

## Installation (serveur, une fois le DNS actif)

```bash
curl -sSL https://get.livekit.io | bash          # installe /usr/local/bin/livekit-server
livekit-server generate-keys                      # affiche une clé API et un secret
useradd --system --no-create-home livekit
install -d -m 750 -o livekit -g livekit /etc/livekit
install -m 600 -o livekit -g livekit livekit.yaml.example /etc/livekit/livekit.yaml   # puis y mettre la clé et le secret
cp livekit.service.example /etc/systemd/system/livekit.service
systemctl daemon-reload && systemctl enable --now livekit
ufw allow 7881/tcp && ufw allow 7882/udp          # média (le 7880 reste local, derrière Nginx)
cp nginx-rtc.malilinkglobal.com.conf.example /etc/nginx/sites-available/rtc.malilinkglobal.com
ln -s /etc/nginx/sites-available/rtc.malilinkglobal.com /etc/nginx/sites-enabled/
certbot --nginx -d rtc.malilinkglobal.com && nginx -t && systemctl reload nginx
```

## Activation dans MaliLink

Dans le `.env` du backend MaliLink (jamais commité) :

```
LIVEKIT_URL=wss://rtc.malilinkglobal.com
LIVEKIT_API_KEY=<clé générée>
LIVEKIT_API_SECRET=<secret généré, 32 caractères ou plus>
```

Puis redémarrer **uniquement** `malilink-backend`, et activer les appels :

```sql
UPDATE social_feature_flags SET enabled = true WHERE flag_key = 'social_calls_enabled';        -- audio
UPDATE social_feature_flags SET enabled = true WHERE flag_key = 'social_video_calls_enabled';  -- vidéo
```

Retour arrière immédiat : remettre les drapeaux à `false` (les boutons
disparaissent en moins d'une minute, sans redémarrage).

## Contrôles

- `curl -s https://rtc.malilinkglobal.com` → réponse de LiveKit (« OK »).
- Deux comptes amis : appel audio, puis vidéo, depuis la messagerie ;
  l'historique apparaît dans l'onglet « Appels ».
