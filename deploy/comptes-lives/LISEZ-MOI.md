# MaliLink — comptes, emails/OTP, Super Admin › Modifier, directs

Paquet révisé du 11 octobre 2026. Il remplace celui du 10 octobre. Il ne touche
que `malilink-backend` et `malilink-frontend`. Triangle, HAFIYA, Nginx et
ADA/facturation ne sont pas modifiés. Academy est conservée, y compris le
correctif de l'école choisie par le Super Admin.
Les résultats exacts des tests sont dans `RESULTATS-TESTS.md`.

## Changements depuis le paquet du 10 octobre

- **Directs isolés par tenant** : chaque recherche de direct, et le nettoyage
  automatique, se limite au tenant de la requête. Un direct d'un autre tenant
  répond « introuvable » sur les 11 routes, y compris pour un Super Admin.
- **`deploy.sh` réécrit** :
  - avant toute modification, les migrations sont répétées sur une copie de la
    vraie base, sur le même serveur PostgreSQL ;
  - de la mise à jour du backend à la fin de la bascule du frontend, une erreur
    ou une interruption (Ctrl-C, `kill`, coupure SSH) déclenche le retour arrière
    automatique ;
  - l'ancienne release du frontend est relancée avec sa définition PM2 complète :
    script, arguments, interpréteur et environnement ;
  - le retour arrière n'est annoncé « VÉRIFIÉ » qu'après un contrôle réel du
    service restauré.
- PGlite ajouté en dépendance de développement du backend, pour les tests
  Academy. Cela n'a aucun effet en production : ce n'est pas dans le paquet.

## Installation

Depuis le Mac :

    scp malilink-comptes-lives-20261011.tar.gz root@72.62.232.24:/root/

Sur le VPS, de préférence dans `tmux`, pour que le déploiement continue si la
connexion SSH coupe :

    tmux new -s deploiement
    cd /root && rm -rf malilink-comptes-lives && tar xzf malilink-comptes-lives-20261011.tar.gz
    bash malilink-comptes-lives/deploy.sh             # audit : n'écrit rien
    bash malilink-comptes-lives/deploy.sh --executer  # déploiement

L'audit affiche le moteur PostgreSQL réel et la méthode de répétition des
migrations. Il vérifie aussi les empreintes des 9 fichiers de production à
modifier. Si la production a changé, il s'arrête sans rien modifier.

Déroulement de `--executer` :

1. Sauvegardes dans `/root/backups/malilink-comptes-lives-<date>` : base
   (`pg_dump`), `.env`, définitions PM2 complètes, fichiers remplacés, journal
   `deploiement.log`.
2. Répétition des migrations 089 et 090 sur une copie temporaire de la base,
   avec les mêmes données, puis contrôle du schéma, de la rejouabilité et des
   données. La copie est ensuite supprimée. En cas d'échec, arrêt
   « production NON modifiée ».
3. Construction du nouveau frontend dans une copie, avec l'environnement
   enregistré du frontend.
4. Backend : fichiers remplacés, migrations, redémarrage, contrôles.
5. Bascule du frontend : même définition PM2, seul le dossier change, puis
   contrôles HTTP.

Codes de sortie :

| Code | Signification |
|---|---|
| 0 | Déploiement terminé |
| 3 | « RETOUR ARRIÈRE NON VÉRIFIÉ » : intervention manuelle, voir les commandes affichées |
| Autre | Échec, suivi de « RETOUR ARRIÈRE VÉRIFIÉ » ou de « production NON modifiée » |

Retour arrière manuel, vérifié de la même façon :

    bash /root/backups/malilink-comptes-lives-<date>/rollback.sh

Les migrations 089 et 090 restent en place après un retour arrière. Elles sont
additives et l'ancien code les ignore.

## Valider le compte de l'école (après le déploiement)

    BACK=$(readlink -f /proc/$(pm2 pid malilink-backend)/cwd)
    cd "$BACK" && node scripts/comptes/valider-compte-ecole.js --identifier --societe 8

Cette commande est en lecture seule. Elle affiche l'ID de la société, son nom,
ses statuts et ses administrateurs, avec les emails masqués. Ensuite, avec l'ID
de l'administrateur et le nom EXACT affichés :

    node scripts/comptes/valider-compte-ecole.js --valider --societe 8 --utilisateur <ID> \
      --nom "<NOM EXACT>" --par auto --motif "Validation administrative demandée par le propriétaire" --oui

`--par auto` ne fonctionne que s'il existe un seul Super Admin actif. Sinon,
utilisez `--par <email>`. L'email reste « non vérifié » : seule la saisie d'un
code reçu le prouve. Enfin, connectez-vous réellement avec ce compte : c'est la
seule preuve.

## Tester les emails

    cd "$BACK" && node scripts/comptes/diagnostic-email.js --envoyer <votre adresse>

« accepté » signifie seulement que le serveur SMTP a pris le message. La
réception n'est prouvée que si l'email arrive (vérifier aussi les indésirables).

## Directs

Les directs restent indisponibles tant que tout ceci n'est pas en place :

- DNS `rtc` → `72.62.232.24` ;
- LiveKit installé, ports média ouverts, TURN ;
- clés `LIVEKIT_*` dans le `.env` ;
- le drapeau `social_lives_enabled` activé :

      UPDATE social_feature_flags SET enabled=true WHERE flag_key='social_lives_enabled';

Le serveur vérifie réellement que LiveKit répond avant d'ouvrir les directs.
