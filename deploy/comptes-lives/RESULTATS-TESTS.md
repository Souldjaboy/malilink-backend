# Résultats des tests — révision du 11 octobre 2026

Tous les résultats ci-dessous ont été obtenus le 11 octobre 2026, sur un Mac,
avec le code livré :

- backend `0f23e91` (branche `main`) ;
- frontend `09e8f68` (branche `main`) ;
- `deploy.sh` d'empreinte SHA-256 `4633e11ca657b369737e9e287370baa5e8f0dea426c3ec9b862daa564d579414`.

**La production n'a pas été touchée.** Elle n'est pas accessible depuis le Mac
(SSH refusé). Rien n'a été déployé.

## 1. Directs : isolation par tenant (`tests/social-lives.test.js`)

Tests A/B entre les tenants `malilink` et `hafiya`. Comptes utilisés : membre,
hôte et Super Admin de chaque tenant, avec des jetons qui portent `tenant_id`
comme à la connexion. Toutes les routes ont été appelées avec l'identifiant d'un
direct de l'autre tenant :

- consultation, rejoindre, jeton, présence ;
- commentaires (lire, écrire, supprimer) ;
- spectateurs, exclusion, signalement, fin.

Contrôles positifs dans chaque tenant, absence de trace en base, et nettoyage
automatique limité au tenant de la requête.

| Exécution | Résultat |
|---|---|
| LiveKit non configuré (`MODE=absent`) | 13 réussis, 0 échoués |
| LiveKit configuré mais injoignable | 13 réussis, 0 échoués |
| LiveKit réel (Docker local), passage 1 | 42 réussis, 0 échoués |
| LiveKit réel (Docker local), passage 2 | 42 réussis, 0 échoués |
| **Contre-épreuve sur l'ANCIEN `lives.js`** | **7 réussis, 6 échoués** (le défaut est bien détecté) |

Ce que la contre-épreuve a montré sur l'ancien code :

- un membre du tenant A lisait le direct B et ses commentaires, et le signalait ;
- un Super Admin du tenant A pouvait terminer le direct B, en exclure un
  spectateur et y supprimer un commentaire ;
- le nettoyage automatique déclenché par A fermait aussi le direct B.

## 2. Autres suites backend (base PostgreSQL 16 neuve, vrai serveur)

| Suite | Résultat |
|---|---|
| `tests/social.test.js` | 69 réussis, 0 échoués |
| `tests/social-appels.test.js`, sans LiveKit | 4 réussis, 0 échoués |
| `tests/social-appels.test.js`, LiveKit réel | 23 réussis, 0 échoués |
| `tests/comptes.test.js`, SMTP réel local (Mailpit) | 54 réussis, 0 échoués |
| `tests/comptes.test.js`, sans SMTP | 41 réussis, 0 échoués |
| Academy : `node --test services/education/learning.test.js` (PGlite 0.5.8) | 12 tests, 12 réussis, 0 échoué |

Les tests Academy couvrent le contexte `x-active-company-id` : école choisie,
école non activée, identifiant invalide et identifiant inexistant. Les fichiers
Academy sont identiques à l'import de production : 6 fichiers backend,
6 fichiers frontend, et le bloc de montage dans `server.js`.

## 3. Navigateur : directs à deux comptes, WebRTC réel (Chromium, LiveKit local)

- **Passage 1 : 2 réussis, 4 échoués.** Le serveur de développement Next venait
  de redémarrer. Pendant qu'il compilait la page spectateur, il retenait les
  signaux de présence de l'hôte, qui passent par lui, pendant plus de 60 s. Le
  direct a donc été fermé automatiquement (« hôte déconnecté »), dans le bon
  tenant.
- **Passage 2, pages déjà compilées : 10 réussis, 0 échoués.** Le spectateur a
  reçu de vraies images (320×180) et le son. Ont aussi été vérifiés : le
  compteur du serveur média, le commentaire, l'exclusion et la fin du direct.
- Limite : même machine et même réseau. Aucun test sur deux appareils ou deux
  réseaux, ni de charge.

## 4. `deploy.sh` sur un VPS d'essai (conteneur Linux, `essai/` dans le dépôt backend)

Composition du VPS d'essai :

- copie de la production : backend réel `8f56fff`, Academy comprise, et les
  fichiers frontend de `dee116b` ;
- PostgreSQL local, avec un rôle applicatif sans droit CREATEDB ;
- PM2 avec le frontend lancé par `npm start` ;
- un faux Nginx ;
- des témoins « Triangle » et « HAFIYA ».

Le frontend d'origine porte `PORT` et `MARQUEUR_ESSAI` uniquement dans sa
définition PM2. Les retrouver après une bascule ou un retour arrière prouve que
l'environnement complet a été restitué. Chaque scénario part d'un conteneur
neuf.

Les pannes sont réelles :

- `pm2 start` qui échoue ;
- une release qui plante au démarrage ;
- une page qui répond 500 ;
- un signal INT, TERM ou HUP envoyé pendant la bascule ;
- une ancienne release elle-même défaillante au moment du retour ;
- un contrôle du backend en échec ;
- une migration impossible.

| Variante | Scénario | Résultat |
|---|---|---|
| PostgreSQL 16.15 · PM2 7.0.4 · Node 20 | `audit` | 4 réussis, 0 échoués |
| PostgreSQL 16.15 · PM2 7.0.4 · Node 20 | `succes` | 11 réussis, 0 échoués |
| PostgreSQL 16.15 · PM2 7.0.4 · Node 20 | `pm2-start-echoue` | 10 réussis, 0 échoués |
| PostgreSQL 16.15 · PM2 7.0.4 · Node 20 | `demarrage-plante` | 10 réussis, 0 échoués |
| PostgreSQL 16.15 · PM2 7.0.4 · Node 20 | `http-echoue` | 10 réussis, 0 échoués |
| PostgreSQL 16.15 · PM2 7.0.4 · Node 20 | `interruption-int` | 10 réussis, 0 échoués |
| PostgreSQL 16.15 · PM2 7.0.4 · Node 20 | `interruption-term` | 10 réussis, 0 échoués |
| PostgreSQL 16.15 · PM2 7.0.4 · Node 20 | `interruption-hup` | 10 réussis, 0 échoués |
| PostgreSQL 16.15 · PM2 7.0.4 · Node 20 | `retour-impossible` | 4 réussis, 0 échoués |
| PostgreSQL 16.15 · PM2 7.0.4 · Node 20 | `backend-echoue` | 11 réussis, 0 échoués |
| PostgreSQL 16.15 · PM2 7.0.4 · Node 20 | `migration-echoue` | 4 réussis, 0 échoués |
| PostgreSQL 14.24 · PM2 7.0.4 · Node 20 | `audit` | 4 réussis, 0 échoués |
| PostgreSQL 14.24 · PM2 7.0.4 · Node 20 | `succes` | 11 réussis, 0 échoués |
| PostgreSQL 14.24 · PM2 7.0.4 · Node 20 | `http-echoue` | 10 réussis, 0 échoués |
| PostgreSQL 14.24 · PM2 7.0.4 · Node 20 | `migration-echoue` | 4 réussis, 0 échoués |
| PostgreSQL 16.15 · PM2 5.4.3 · Node 20 | `succes` | 11 réussis, 0 échoués |
| PostgreSQL 16.15 · PM2 5.4.3 · Node 20 | `pm2-start-echoue` | 10 réussis, 0 échoués |
| PostgreSQL 16.15 · PM2 5.4.3 · Node 20 | `http-echoue` | 10 réussis, 0 échoués |
| PostgreSQL 16.15 · PM2 5.4.3 · Node 20 | `interruption-term` | 10 réussis, 0 échoués |
| PostgreSQL 16.15 · PM2 5.4.3 · Node 20 | `retour-impossible` | 4 réussis, 0 échoués |

**Total : 168 vérifications réussies, 0 échouées.**

## Détail exact des vérifications

### PostgreSQL 16.15 · PM2 7.0.4 · Node 20 — `audit`

```
  ✓ audit : code 0, « AUDIT TERMINÉ »
  ✓ moteur réel affiché : moteur 16.15 (Debian 16.15-1.pgdg12+2)
  ✓ répétition possible via le compte postgres local (rôle applicatif sans CREATEDB)
  ✓ rien d'écrit : ni sauvegarde, ni fichier, ni processus touché
```

### PostgreSQL 16.15 · PM2 7.0.4 · Node 20 — `succes`

```
  ✓ déploiement : code 0, « DÉPLOIEMENT TERMINÉ »
  ✓ répétition sur copie : 089 et 090 appliquées sur le moteur réel
  ✓ migrations 089 et 090 en production, base de répétition supprimée
  ✓ backend : fichiers du paquet, même définition PM2
  ✓ nouveau backend actif (nouveau message de renvoi d'OTP)
  ✓ frontend : nouvelle release /var/www/releases/malilink-comptes-lives-20261011_022423/frontend
  ✓ frontend : même script, arguments, interpréteur et environnement (PORT, MARQUEUR) qu'avant
  ✓ témoins jamais redémarrés, dump PM2 sur la nouvelle release
   → retour arrière manuel : bash /root/backups/malilink-comptes-lives-20261011_022423/rollback.sh
  ✓ retour manuel : code 0, « RETOUR ARRIÈRE VÉRIFIÉ »
  ✓ retour manuel : définition PM2 du frontend identique à l'origine, ancienne release servie
  ✓ retour manuel : fichiers backend d'origine, définition identique, témoins intacts
```

### PostgreSQL 16.15 · PM2 7.0.4 · Node 20 — `pm2-start-echoue`

```
  ✓ pm2 start de la nouvelle release a bien échoué (code ≠ 0)
  ✓ code de sortie d'échec (ni 0, ni 3) : 1
  ✓ « RETOUR ARRIÈRE VÉRIFIÉ » annoncé
  ✓ frontend : définition PM2 complète identique (script, args, interpréteur, cwd, env)
  ✓ frontend servi par l'ancienne release, PORT et MARQUEUR d'origine : {"release":"ancienne","cwd":"/var/www/releases/academy-essai/frontend","PORT":"3020","MARQUEUR_ESSAI":"lancement-origine-7f3a"}
  ✓ backend : fichiers d'origine (empreintes) et définition PM2 identique
  ✓ Academy toujours protégée (401)
  ✓ témoins Triangle/HAFIYA/Nginx jamais redémarrés
  ✓ aucune base de répétition restante
  ✓ sauvegarde PM2 (dump) : ancienne release
```

### PostgreSQL 16.15 · PM2 7.0.4 · Node 20 — `demarrage-plante`

```
  ✓ nouvelle release plantée au démarrage, détectée
  ✓ code de sortie d'échec (ni 0, ni 3) : 1
  ✓ « RETOUR ARRIÈRE VÉRIFIÉ » annoncé
  ✓ frontend : définition PM2 complète identique (script, args, interpréteur, cwd, env)
  ✓ frontend servi par l'ancienne release, PORT et MARQUEUR d'origine : {"release":"ancienne","cwd":"/var/www/releases/academy-essai/frontend","PORT":"3020","MARQUEUR_ESSAI":"lancement-origine-7f3a"}
  ✓ backend : fichiers d'origine (empreintes) et définition PM2 identique
  ✓ Academy toujours protégée (401)
  ✓ témoins Triangle/HAFIYA/Nginx jamais redémarrés
  ✓ aucune base de répétition restante
  ✓ sauvegarde PM2 (dump) : ancienne release
```

### PostgreSQL 16.15 · PM2 7.0.4 · Node 20 — `http-echoue`

```
  ✓ contrôle HTTP en échec détecté (/confirmer-email 500)
  ✓ code de sortie d'échec (ni 0, ni 3) : 1
  ✓ « RETOUR ARRIÈRE VÉRIFIÉ » annoncé
  ✓ frontend : définition PM2 complète identique (script, args, interpréteur, cwd, env)
  ✓ frontend servi par l'ancienne release, PORT et MARQUEUR d'origine : {"release":"ancienne","cwd":"/var/www/releases/academy-essai/frontend","PORT":"3020","MARQUEUR_ESSAI":"lancement-origine-7f3a"}
  ✓ backend : fichiers d'origine (empreintes) et définition PM2 identique
  ✓ Academy toujours protégée (401)
  ✓ témoins Triangle/HAFIYA/Nginx jamais redémarrés
  ✓ aucune base de répétition restante
  ✓ sauvegarde PM2 (dump) : ancienne release
```

### PostgreSQL 16.15 · PM2 7.0.4 · Node 20 — `interruption-int`

```
   → signal INT envoyé à deploy.sh pendant la bascule
  ✓ interruption INT prise en charge pendant la bascule
  ✓ code de sortie d'échec (ni 0, ni 3) : 130
  ✓ « RETOUR ARRIÈRE VÉRIFIÉ » annoncé
  ✓ frontend : définition PM2 complète identique (script, args, interpréteur, cwd, env)
  ✓ frontend servi par l'ancienne release, PORT et MARQUEUR d'origine : {"release":"ancienne","cwd":"/var/www/releases/academy-essai/frontend","PORT":"3020","MARQUEUR_ESSAI":"lancement-origine-7f3a"}
  ✓ backend : fichiers d'origine (empreintes) et définition PM2 identique
  ✓ Academy toujours protégée (401)
  ✓ témoins Triangle/HAFIYA/Nginx jamais redémarrés
  ✓ aucune base de répétition restante
  ✓ sauvegarde PM2 (dump) : ancienne release
```

### PostgreSQL 16.15 · PM2 7.0.4 · Node 20 — `interruption-term`

```
   → signal TERM envoyé à deploy.sh pendant la bascule
  ✓ interruption TERM prise en charge pendant la bascule
  ✓ code de sortie d'échec (ni 0, ni 3) : 143
  ✓ « RETOUR ARRIÈRE VÉRIFIÉ » annoncé
  ✓ frontend : définition PM2 complète identique (script, args, interpréteur, cwd, env)
  ✓ frontend servi par l'ancienne release, PORT et MARQUEUR d'origine : {"release":"ancienne","cwd":"/var/www/releases/academy-essai/frontend","PORT":"3020","MARQUEUR_ESSAI":"lancement-origine-7f3a"}
  ✓ backend : fichiers d'origine (empreintes) et définition PM2 identique
  ✓ Academy toujours protégée (401)
  ✓ témoins Triangle/HAFIYA/Nginx jamais redémarrés
  ✓ aucune base de répétition restante
  ✓ sauvegarde PM2 (dump) : ancienne release
```

### PostgreSQL 16.15 · PM2 7.0.4 · Node 20 — `interruption-hup`

```
   → signal HUP envoyé à deploy.sh pendant la bascule
  ✓ interruption HUP prise en charge pendant la bascule
  ✓ code de sortie d'échec (ni 0, ni 3) : 129
  ✓ « RETOUR ARRIÈRE VÉRIFIÉ » annoncé
  ✓ frontend : définition PM2 complète identique (script, args, interpréteur, cwd, env)
  ✓ frontend servi par l'ancienne release, PORT et MARQUEUR d'origine : {"release":"ancienne","cwd":"/var/www/releases/academy-essai/frontend","PORT":"3020","MARQUEUR_ESSAI":"lancement-origine-7f3a"}
  ✓ backend : fichiers d'origine (empreintes) et définition PM2 identique
  ✓ Academy toujours protégée (401)
  ✓ témoins Triangle/HAFIYA/Nginx jamais redémarrés
  ✓ aucune base de répétition restante
  ✓ sauvegarde PM2 (dump) : ancienne release
```

### PostgreSQL 16.15 · PM2 7.0.4 · Node 20 — `retour-impossible`

```
   → ancienne release rendue défaillante pendant la bascule
  ✓ code de sortie 3
  ✓ « RETOUR ARRIÈRE NON VÉRIFIÉ » annoncé, jamais « VÉRIFIÉ »
  ✓ dump PM2 non réécrit avec un état non vérifié
  ✓ backend tout de même restauré et vérifié
```

### PostgreSQL 16.15 · PM2 7.0.4 · Node 20 — `backend-echoue`

```
  ✓ contrôle du backend en échec détecté
  ✓ frontend jamais touché (même pid, aucun redémarrage)
  ✓ code de sortie d'échec (ni 0, ni 3) : 1
  ✓ « RETOUR ARRIÈRE VÉRIFIÉ » annoncé
  ✓ frontend : définition PM2 complète identique (script, args, interpréteur, cwd, env)
  ✓ frontend servi par l'ancienne release, PORT et MARQUEUR d'origine : {"release":"ancienne","cwd":"/var/www/releases/academy-essai/frontend","PORT":"3020","MARQUEUR_ESSAI":"lancement-origine-7f3a"}
  ✓ backend : fichiers d'origine (empreintes) et définition PM2 identique
  ✓ Academy toujours protégée (401)
  ✓ témoins Triangle/HAFIYA/Nginx jamais redémarrés
  ✓ aucune base de répétition restante
  ✓ sauvegarde PM2 (dump) : ancienne release
```

### PostgreSQL 16.15 · PM2 7.0.4 · Node 20 — `migration-echoue`

```
  ✓ répétition en échec sur la copie, arrêt « production NON modifiée »
  ✓ code ≠ 0, aucun retour arrière nécessaire
  ✓ production intacte : aucune migration, fichiers et processus inchangés
  ✓ base de répétition supprimée
```

### PostgreSQL 14.24 · PM2 7.0.4 · Node 20 — `audit`

```
  ✓ audit : code 0, « AUDIT TERMINÉ »
  ✓ moteur réel affiché : moteur 14.24 (Debian 14.24-1.pgdg12+2)
  ✓ répétition possible via le compte postgres local (rôle applicatif sans CREATEDB)
  ✓ rien d'écrit : ni sauvegarde, ni fichier, ni processus touché
```

### PostgreSQL 14.24 · PM2 7.0.4 · Node 20 — `succes`

```
  ✓ déploiement : code 0, « DÉPLOIEMENT TERMINÉ »
  ✓ répétition sur copie : 089 et 090 appliquées sur le moteur réel
  ✓ migrations 089 et 090 en production, base de répétition supprimée
  ✓ backend : fichiers du paquet, même définition PM2
  ✓ nouveau backend actif (nouveau message de renvoi d'OTP)
  ✓ frontend : nouvelle release /var/www/releases/malilink-comptes-lives-20261011_034025/frontend
  ✓ frontend : même script, arguments, interpréteur et environnement (PORT, MARQUEUR) qu'avant
  ✓ témoins jamais redémarrés, dump PM2 sur la nouvelle release
   → retour arrière manuel : bash /root/backups/malilink-comptes-lives-20261011_034025/rollback.sh
  ✓ retour manuel : code 0, « RETOUR ARRIÈRE VÉRIFIÉ »
  ✓ retour manuel : définition PM2 du frontend identique à l'origine, ancienne release servie
  ✓ retour manuel : fichiers backend d'origine, définition identique, témoins intacts
```

### PostgreSQL 14.24 · PM2 7.0.4 · Node 20 — `http-echoue`

```
  ✓ contrôle HTTP en échec détecté (/confirmer-email 500)
  ✓ code de sortie d'échec (ni 0, ni 3) : 1
  ✓ « RETOUR ARRIÈRE VÉRIFIÉ » annoncé
  ✓ frontend : définition PM2 complète identique (script, args, interpréteur, cwd, env)
  ✓ frontend servi par l'ancienne release, PORT et MARQUEUR d'origine : {"release":"ancienne","cwd":"/var/www/releases/academy-essai/frontend","PORT":"3020","MARQUEUR_ESSAI":"lancement-origine-7f3a"}
  ✓ backend : fichiers d'origine (empreintes) et définition PM2 identique
  ✓ Academy toujours protégée (401)
  ✓ témoins Triangle/HAFIYA/Nginx jamais redémarrés
  ✓ aucune base de répétition restante
  ✓ sauvegarde PM2 (dump) : ancienne release
```

### PostgreSQL 14.24 · PM2 7.0.4 · Node 20 — `migration-echoue`

```
  ✓ répétition en échec sur la copie, arrêt « production NON modifiée »
  ✓ code ≠ 0, aucun retour arrière nécessaire
  ✓ production intacte : aucune migration, fichiers et processus inchangés
  ✓ base de répétition supprimée
```

### PostgreSQL 16.15 · PM2 5.4.3 · Node 20 — `succes`

```
  ✓ déploiement : code 0, « DÉPLOIEMENT TERMINÉ »
  ✓ répétition sur copie : 089 et 090 appliquées sur le moteur réel
  ✓ migrations 089 et 090 en production, base de répétition supprimée
  ✓ backend : fichiers du paquet, même définition PM2
  ✓ nouveau backend actif (nouveau message de renvoi d'OTP)
  ✓ frontend : nouvelle release /var/www/releases/malilink-comptes-lives-20261011_034638/frontend
  ✓ frontend : même script, arguments, interpréteur et environnement (PORT, MARQUEUR) qu'avant
  ✓ témoins jamais redémarrés, dump PM2 sur la nouvelle release
   → retour arrière manuel : bash /root/backups/malilink-comptes-lives-20261011_034638/rollback.sh
  ✓ retour manuel : code 0, « RETOUR ARRIÈRE VÉRIFIÉ »
  ✓ retour manuel : définition PM2 du frontend identique à l'origine, ancienne release servie
  ✓ retour manuel : fichiers backend d'origine, définition identique, témoins intacts
```

### PostgreSQL 16.15 · PM2 5.4.3 · Node 20 — `pm2-start-echoue`

```
  ✓ pm2 start de la nouvelle release a bien échoué (code ≠ 0)
  ✓ code de sortie d'échec (ni 0, ni 3) : 1
  ✓ « RETOUR ARRIÈRE VÉRIFIÉ » annoncé
  ✓ frontend : définition PM2 complète identique (script, args, interpréteur, cwd, env)
  ✓ frontend servi par l'ancienne release, PORT et MARQUEUR d'origine : {"release":"ancienne","cwd":"/var/www/releases/academy-essai/frontend","PORT":"3020","MARQUEUR_ESSAI":"lancement-origine-7f3a"}
  ✓ backend : fichiers d'origine (empreintes) et définition PM2 identique
  ✓ Academy toujours protégée (401)
  ✓ témoins Triangle/HAFIYA/Nginx jamais redémarrés
  ✓ aucune base de répétition restante
  ✓ sauvegarde PM2 (dump) : ancienne release
```

### PostgreSQL 16.15 · PM2 5.4.3 · Node 20 — `http-echoue`

```
  ✓ contrôle HTTP en échec détecté (/confirmer-email 500)
  ✓ code de sortie d'échec (ni 0, ni 3) : 1
  ✓ « RETOUR ARRIÈRE VÉRIFIÉ » annoncé
  ✓ frontend : définition PM2 complète identique (script, args, interpréteur, cwd, env)
  ✓ frontend servi par l'ancienne release, PORT et MARQUEUR d'origine : {"release":"ancienne","cwd":"/var/www/releases/academy-essai/frontend","PORT":"3020","MARQUEUR_ESSAI":"lancement-origine-7f3a"}
  ✓ backend : fichiers d'origine (empreintes) et définition PM2 identique
  ✓ Academy toujours protégée (401)
  ✓ témoins Triangle/HAFIYA/Nginx jamais redémarrés
  ✓ aucune base de répétition restante
  ✓ sauvegarde PM2 (dump) : ancienne release
```

### PostgreSQL 16.15 · PM2 5.4.3 · Node 20 — `interruption-term`

```
   → signal TERM envoyé à deploy.sh pendant la bascule
  ✓ interruption TERM prise en charge pendant la bascule
  ✓ code de sortie d'échec (ni 0, ni 3) : 143
  ✓ « RETOUR ARRIÈRE VÉRIFIÉ » annoncé
  ✓ frontend : définition PM2 complète identique (script, args, interpréteur, cwd, env)
  ✓ frontend servi par l'ancienne release, PORT et MARQUEUR d'origine : {"release":"ancienne","cwd":"/var/www/releases/academy-essai/frontend","PORT":"3020","MARQUEUR_ESSAI":"lancement-origine-7f3a"}
  ✓ backend : fichiers d'origine (empreintes) et définition PM2 identique
  ✓ Academy toujours protégée (401)
  ✓ témoins Triangle/HAFIYA/Nginx jamais redémarrés
  ✓ aucune base de répétition restante
  ✓ sauvegarde PM2 (dump) : ancienne release
```

### PostgreSQL 16.15 · PM2 5.4.3 · Node 20 — `retour-impossible`

```
   → ancienne release rendue défaillante pendant la bascule
  ✓ code de sortie 3
  ✓ « RETOUR ARRIÈRE NON VÉRIFIÉ » annoncé, jamais « VÉRIFIÉ »
  ✓ dump PM2 non réécrit avec un état non vérifié
  ✓ backend tout de même restauré et vérifié
```

## 5. Limites restantes

- **Moteur de production inconnu d'ici.** Les migrations ont été vérifiées sur
  PostgreSQL 16.15 et 14.24. Sur le VPS, `deploy.sh` affiche le moteur réel et
  répète les migrations sur une copie de la vraie base avant de les appliquer.
- Le VPS d'essai remplace Next.js par un faux serveur. La vraie construction
  Next.js, déjà faite localement (`npm run build` réussi), n'y est pas rejouée.
- SMTP de production, compte de l'école (société 8) et directs en production :
  non prouvés. Il faut d'abord lancer `--identifier` et `diagnostic-email.js`
  sur le VPS, puis installer LiveKit (DNS, TURN).
- Jetons sans `tenant_id` (connexion par réseau social, inscription par
  téléphone) : pour un compte sans société, le tenant vient du domaine ou de
  l'en-tête de la requête. Ce point dépasse les directs et n'est pas modifié ici.
