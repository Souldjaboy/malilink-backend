# MaliLink — livraison finale (révision 2) : comptes, OTP, espaces, Super Admin, directs

Révision 2 : corrige les défauts relevés par la revue de la première archive
(domaines, en-têtes client, rattachement automatique, comptes non prouvés côté
Super Admin, fichiers « nouveaux » au retour arrière, temps réel). Elle
remplace `malilink-livraison-finale-20261011.tar.gz`, qui ne doit pas être
déployée.

Une seule archive à déployer. Elle ne touche que `malilink-backend` et
`malilink-frontend` : ni Triangle, ni HAFIYA, ni Nginx, ni la facturation ADA.
Academy, les fonctions Éducation et le choix d'école par le Super Admin sont
conservés à l'identique (fichiers contrôlés par empreinte).

- `RAPPORT.md` : commits, fichiers modifiés, migrations, tests et limites.
- `EMPREINTES.sha256` : empreinte de chaque fichier du paquet.
- `livekit/` : procédure vérifiée pour le serveur média des directs et
  appels. Elle n'est pas copiée dans la production.

## Ce qui change pour les utilisateurs

- **Espaces** : chaque jeton porte l'espace vérifié du compte.
  - Espace d'une requête : celui du **domaine** reconnu (`malilinkglobal.com`
    et ses sous-domaines, liste exacte), sinon celui du déploiement
    (`DEFAULT_TENANT_ID`).
  - Un en-tête ou un paramètre client contraire est refusé (400).
  - `X-Forwarded-Host` n'est jamais pris en compte.
- **Reconnexion** : un jeton sans espace demande une reconnexion. C'est le cas
  des jetons OAuth, de ceux obtenus après saisie d'un code, et de ceux de
  l'inscription par téléphone. Les jetons de la connexion par mot de passe
  restent valables.
- **Anciens comptes sans société** (clients, livreurs, éventuellement un
  Super Admin sans société) : **aucun rattachement automatique**. Tant que
  leur espace n'est pas attribué explicitement, ils ne peuvent ni se
  connecter, ni utiliser un jeton existant, ni récupérer leur mot de passe.
  Le message leur indique de contacter le support. L'attribution se fait
  juste après le déploiement, par le script `attribuer-espace.js`
  (section 3), et elle est journalisée.
- **Super Admin** : écoles, utilisateurs et chiffres limités à son espace.
  L'école choisie doit appartenir à cet espace. Un compte dont
  l'appartenance à l'espace n'est pas **prouvée** est invisible et intouchable
  (modification, mot de passe, suppression).
- **Temps réel** : mêmes contrôles que l'API. Une session révoquée ou un
  compte désactivé est déconnecté aussitôt, et la présence n'est diffusée que
  dans l'espace.
- **Sessions** : après une récupération ou un changement de mot de passe, et
  après un mot de passe fixé par le Super Admin, les autres sessions sont
  fermées.

## 1. Sur le Mac

```bash
scp ~/Development/livraisons/malilink-livraison-finale-r2-20261011.tar.gz root@72.62.232.24:/root/
```

## 2. Sur le VPS

Dans `tmux`, pour qu'une coupure SSH n'interrompe rien. Le script la gère
aussi : en cas de coupure, il fait un retour arrière vérifié.

```bash
tmux new -s livraison
cd /root && sha256sum malilink-livraison-finale-r2-20261011.tar.gz
```

Comparer avec le SHA-256 communiqué, puis :

```bash
cd /root && tar xzf malilink-livraison-finale-r2-20261011.tar.gz && cd malilink-livraison-finale-r2
sha256sum -c --quiet EMPREINTES.sha256 && echo "paquet intègre"
bash precontrole.sh
```

**Précontrôle** (lecture seule) : à lire avant d'aller plus loin.

- Sections 1 à 4 :
  - dossiers et **ports** réellement utilisés par PM2, uploads ;
  - empreintes des 13 fichiers à remplacer ;
  - configuration sans secret ;
  - **moteur PostgreSQL** et migrations en attente (089, 090, 091) ;
  - méthode de répétition des migrations ;
  - infrastructure des directs.
- **A. Espaces** :
  - sociétés par espace ;
  - valeur de `DEFAULT_TENANT_ID` ;
  - **comptes sans société sans espace établi**, par rôle, et Super Admins
    sans société ni espace. Ces comptes ne pourront plus se connecter avant
    leur attribution (section 3).
  - Les sociétés hors de l'espace `malilink` ne se connectent déjà pas sur
    MaliLink et disparaîtront des listes du Super Admin : à examiner si la
    liste n'est pas vide.
- **B. École (société 8)** : nom, espace, statuts, administrateurs (emails
  masqués).
- **C. SMTP** : connexion et authentification réelles, **sans envoi**.

S'il s'arrête (« la production ne correspond pas… »), rien n'est modifié :
envoyez la sortie.

Déploiement :

```bash
bash deploy.sh --executer
```

Déroulement :

1. Sauvegardes dans `/root/backups/malilink-livraison-finale-<date>` :
   - base (`pg_dump` vérifié) ;
   - `.env` ;
   - définitions PM2 complètes, avec environnement, arguments et ports ;
   - fichiers remplacés ;
   - journal `deploiement.log`.
2. **Répétition des migrations sur une copie de la vraie base** (même moteur).
   En cas d'échec : arrêt, « production NON modifiée ».
3. Nouveau frontend construit dans une nouvelle release, à côté de l'actuelle.
4. Backend : fichiers remplacés sur place (le dossier `uploads` n'est jamais
   touché), migrations, redémarrage, contrôles.
5. Bascule du frontend avec la **même définition PM2** (environnement,
   arguments, ports), contrôles HTTP, contrôle des ports.

Codes de sortie :

| Code | Signification |
|---|---|
| 0 | Déploiement terminé |
| 3 | « RETOUR ARRIÈRE NON VÉRIFIÉ » : appliquer les commandes affichées et envoyer la sortie |
| Autre | Échec, suivi de « RETOUR ARRIÈRE VÉRIFIÉ » ou de « production NON modifiée » |

## 3. Vérifications après déploiement

```bash
pm2 status
cd "$(readlink -f /proc/$(pm2 pid malilink-backend)/cwd)"
curl -s https://malilinkglobal.com/api/espace
```

La dernière commande doit afficher `{"tenant_id":"malilink","source":"domaine"}`
(ou `"deploiement"`). Le déploiement le contrôle aussi.

**Anciens comptes sans société : attribution explicite de l'espace.** À faire
juste après le déploiement : sans elle, ces comptes ne peuvent pas se
connecter.

```bash
node scripts/comptes/attribuer-espace.js --rapport
```

Le rapport est en lecture seule : comptes par rôle, liste des non rattachés,
emails et téléphones masqués. Ensuite, deux possibilités.

- Si **tous** ces comptes appartiennent à MaliLink (base dédiée à MaliLink),
  c'est votre décision explicite, journalisée :

```bash
node scripts/comptes/attribuer-espace.js --attribuer --espace malilink --tous-non-rattaches --par auto --motif "Comptes historiques de la base MaliLink Global" --oui
```

- Sinon, compte par compte (`--ids 12,15`), après vérification :

```bash
node scripts/comptes/attribuer-espace.js --attribuer --espace malilink --ids <IDS> --par auto --motif "<raison>" --preuve "<ticket, échange…>" --oui
```

Chaque attribution est inscrite dans `account_tenant_assignments` et
`audit_logs`. Un compte déjà rattaché n'est jamais modifié. `--par auto`
exige un seul Super Admin actif ; sinon, utilisez `--par <email>`.

**École (société 8)**. Identification, en lecture seule :

```bash
node scripts/comptes/valider-compte-ecole.js --identifier --societe 8
```

Puis, avec l'ID de l'administrateur et le nom EXACT affichés :

```bash
node scripts/comptes/valider-compte-ecole.js --valider --societe 8 --utilisateur <ID> --nom "<NOM EXACT>" --par auto --motif "Validation administrative demandée par le propriétaire" --oui
```

On peut aussi passer par l'écran Super Admin › Modifier › « Valider le compte ».
L'email reste « non vérifié » tant qu'aucun code n'est saisi. **Preuve finale :
se connecter avec ce compte.**

**Emails** (Gmail). Le test local est réussi. La réception n'est prouvée que si
l'email arrive dans Gmail.

```bash
node scripts/comptes/diagnostic-email.js --envoyer <votre-adresse>@gmail.com
```

- `accepte` = pris en charge par le serveur SMTP ; ouvrez Gmail, y compris
  les indésirables.
- `SMTP_EN_ECHEC : authentification SMTP refusée` = identifiants SMTP du
  prestataire à corriger dans le `.env`, puis `pm2 restart malilink-backend`.

**Navigateur** :

1. connexion Super Admin ;
2. ouverture de « Modifier » sur l'école ;
3. connexion de l'administrateur de l'école ;
4. accès Academy de l'école ;
5. changement de mot de passe dans Paramètres : la session reste ouverte, les
   autres sont fermées.

**Diagnostic** :

```bash
pm2 logs malilink-backend --lines 80 --nostream
pm2 logs malilink-frontend --lines 80 --nostream
less /root/backups/malilink-livraison-finale-*/deploiement.log
```

```sql
-- derniers envois
SELECT created_at, purpose, recipient_masked, status, error FROM email_delivery_log ORDER BY id DESC LIMIT 10;
-- attributions d'espace et validations
SELECT created_at, action, entity_id, details FROM audit_logs WHERE action IN ('attribution_espace_compte','admin_account_validation') ORDER BY id DESC LIMIT 20;
```

**Directs** : ils restent « indisponibles » tant que LiveKit n'est pas installé.
La procédure vérifiée est dans `livekit/README.md` (dans ce paquet). Ils ne sont pas opérationnels avant un essai réel sur deux appareils
et deux réseaux.

## 4. Retour arrière et limites

- **Automatique** : en cas d'échec ou d'interruption pendant la bascule.
- **Manuel** : `bash /root/backups/malilink-livraison-finale-<date>/rollback.sh`.
  Il remet le code et la définition PM2 d'origine, et contrôle le service.
- **Données** : la base n'est **jamais** restaurée automatiquement. Les
  migrations 089, 090 et 091 sont additives : l'ancien code les ignore. Les
  comptes rattachés et les validations faites restent en base.
- **Restaurer la sauvegarde `base-avant.dump`** effacerait tout ce qui a été
  saisi depuis le déploiement. C'est une décision manuelle, de dernier recours,
  à prendre services arrêtés.
