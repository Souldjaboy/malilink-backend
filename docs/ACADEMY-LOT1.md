# MaliLink Academy — finalisation locale

Date : 9 octobre 2026. Statut : code local finalisé et testé, **pas déployé et pas encore validé en préproduction**.

## Architecture retenue

- MaliLink Academy est un sous-module optionnel `education.learning` de MaliLink Éducation.
- Il réutilise l'authentification, les utilisateurs, `company_id`, `tenant_id`, `company_modules`, les plans et le RBAC existants.
- Il est fermé par défaut pour toutes les sociétés existantes. Une activation explicite par établissement est obligatoire.
- Le nom affiché est configurable par école : l'école pilote peut utiliser « MaliTech Academy » sans dupliquer le produit.
- L'Éducation standard, ADA/facturation et le chantier Social/RTC restent séparés.

Sources de base : backend `b78bd6c28387adf2535992a700b6395528de8226`, frontend `f91855e067bfdc88e58b582f8de4717137b4aaf7`.
Branche des deux dépôts : `feature/malilink-academy`.

## Fonctions livrées

- Éditeur professeur/direction : parcours, classe, cours publiés, leçons, QCM, seuil, tentatives et explications.
- Brouillon modifiable, duplication, archivage et publication figée avec copie pédagogique stable.
- Ressources par leçon : PDF, image, audio, vidéo, DOCX/PPTX privés, ou liens HTTPS.
- Stockage privé hors `/uploads`, téléchargement authentifié, contrôle société/tenant/classe/progression et journal d'accès.
- Contrôle du type déclaré et de la signature des fichiers ; limite 50 Mo et 12 ressources par leçon.
- Publication ciblée à la classe et notification des élèves possédant un compte actif.
- Création transactionnelle du compte élève dans la table `users` existante, rôle `student`, changement de mot de passe obligatoire.
- Activation/blocage du compte élève par la direction sans supprimer son historique.
- Espace élève : contenu, ressources, quiz, correction serveur, progression séquentielle et historique.
- Réponses correctes jamais exposées avant soumission ; le serveur calcule le score et contrôle chaque déblocage.
- Succès durables, animation/son facultatifs et attestation PDF personnelle après validation de tout le parcours.
- Rapport professeur/direction et autorisation justifiée de tentatives supplémentaires.
- Paramètres d'identité : nom Academy, message d'accueil, couleur et célébration.
- Isolation stricte école A/B, contrôle des identifiants secondaires, refus RBAC, module, sous-module et plan.
- Les scores Academy ne modifient pas automatiquement les bulletins scolaires.

## Migrations additives

- `sql/087_education_learning.sql` : parcours, tentatives, autorisations, audit, catalogue du module et désactivation par défaut.
- `sql/088_education_learning_finalization.sql` : paramètres, ressources privées, succès, attestations, archivage, date de publication et filiation de copie.

Les deux migrations sont sans `DROP` ni `TRUNCATE`. Elles ont été exécutées puis rejouées dans PostgreSQL embarqué PGlite. Elles n'ont pas été appliquées au VPS.

## Routes API

- `GET/PUT /education/learning/settings`
- `POST /education/learning/assets`
- `GET /education/learning/assets/:id/download`
- `POST /education/learning/students/:id/account`
- `PUT /education/learning/students/:id/account/status`
- `GET/POST /education/learning/programs`
- `GET/PUT /education/learning/programs/:id`
- `POST /education/learning/programs/:id/publish`
- `POST /education/learning/programs/:id/duplicate`
- `PUT /education/learning/programs/:id/archive`
- `GET /education/learning/programs/:id/report`
- `PUT /education/learning/programs/:id/allowance`
- `POST /education/learning/programs/:id/start`
- `POST /education/learning/attempts/:id/submit`
- `GET /education/learning/programs/:id/certificate.pdf`

## Validation exécutée

| Contrôle | Résultat | Portée / limite |
|---|---|---|
| Suite backend | PASS — 99/99 | `npm test` |
| Academy | PASS — 9 scénarios | PGlite, services et Express HTTP |
| Moteur d'accès | PASS — 27/27 | `tests/access-control.unit.test.js` |
| RBAC | PASS — 12/12 | `tests/rbac.test.js` |
| Migrations 087/088 exécutées deux fois | PASS | Schéma de test minimal, pas copie de production |
| Fichier falsifié / vrai PDF privé | PASS | HTTP réel de test |
| TypeScript | PASS | `npx tsc --noEmit` |
| Lint ciblé | PASS | pages Academy et Éducation |
| Build frontend | PASS | Next.js 16.2.6, 169 routes |
| `git diff --check` | PASS | backend et frontend |
| Mobile 375/390, tablette, desktop réels | SKIP | navigateur/appareils non disponibles ici |
| PostgreSQL de préproduction et concurrence | SKIP | environnement de préproduction non fourni |
| Login réel directeur/professeur/élève | SKIP | comptes de test serveur non fournis |
| Antivirus des documents téléversés | SKIP | moteur externe non configuré ; types/signatures contrôlés |
| Production | SKIP | aucun accès ou changement VPS effectué |

Tests négatifs inclus : société et tenant étrangers, professeur non affecté, élève suspendu, compte désactivé, module désactivé, permission refusée, plan exclu, ID étranger, tentative étrangère, leçon verrouillée, essais épuisés, fichier falsifié et accès privé non autorisé.

## Étapes obligatoires avant production

1. Auditer la release réellement exécutée par PM2. Le dernier état communiqué comporte des correctifs locaux frontend dans `PublicUtilityBar.tsx`, `layout.tsx` et `package.json`, un port 3020 et des fichiers backend `uploads` à préserver.
2. Sauvegarder code, patchs locaux, `.env` sans afficher les secrets, uploads, stockage Academy et base PostgreSQL ; vérifier le dump par une restauration de test.
3. Intégrer les commits Academy dans une nouvelle release, jamais directement dans le dossier PM2 actif.
4. Exécuter les migrations 087/088 sur la base restaurée de test, puis tous les tests et le build.
5. Tester les trois vrais rôles, deux écoles A/B, 375/390 px, tablette et ordinateur.
6. Activer `education.learning` uniquement pour l'école pilote depuis le mécanisme Super Admin existant.
7. Après validation explicite, basculer les deux services MaliLink seulement et effectuer les contrôles de santé.

Rollback : conserver la release précédente et les configurations PM2, rebasculer uniquement `malilink-backend` et `malilink-frontend`, puis désactiver `education.learning` pour l'école pilote. Ne jamais restaurer aveuglément une ancienne base sur des données récentes. Les tables additives peuvent rester en place.
