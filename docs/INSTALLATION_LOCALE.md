# Installation locale — Backend MaliLink

## Prérequis
PostgreSQL 14+ en local, Node.js 18+.

## 1. Utilisateur et base PostgreSQL dédiés

MaliLink utilise son propre rôle et sa propre base, séparés de Triangle WMS
(`triangle_wms` / `triangle_user`) et de Hafiya. Ne jamais réutiliser
`triangle_user` pour MaliLink.

```bash
# Créer le rôle (remplacer LE_MOT_DE_PASSE par celui de backend/.env)
psql -d postgres -c "CREATE ROLE malilink_user LOGIN PASSWORD 'LE_MOT_DE_PASSE';"

# Créer la base si absente
psql -d postgres -tc "SELECT 1 FROM pg_database WHERE datname='malilink_global'" | grep -q 1 \
  || psql -d postgres -c "CREATE DATABASE malilink_global OWNER malilink_user;"

# Si la base existait déjà avec un autre propriétaire :
psql -d postgres -c "ALTER DATABASE malilink_global OWNER TO malilink_user;"
psql -d malilink_global -c "ALTER SCHEMA public OWNER TO malilink_user;
GRANT ALL ON ALL TABLES IN SCHEMA public TO malilink_user;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO malilink_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO malilink_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO malilink_user;"
```

## 2. Fichier .env

Copier `.env.example` vers `.env` puis renseigner au minimum :

```
DATABASE_URL=postgresql://malilink_user:LE_MOT_DE_PASSE@localhost:5432/malilink_global
PORT=5052
JWT_SECRET=<openssl rand -hex 32>
DEFAULT_TENANT_ID=malilink
```

Côté frontend, si le backend n'écoute pas sur 5050, ajouter dans
`frontend/.env.local` : `BACKEND_URL=http://localhost:5052`.

## 3. Migrations

```bash
npm run migrate:status     # voir l'état

# Base NEUVE (vide) :
npm run migrate            # applique tout, 000 → dernière

# Base EXISTANTE déjà à jour (jamais suivie par le runner) :
npm run migrate:mark-all   # marque l'existant SANS exécuter (une seule fois)
npm run migrate            # applique uniquement les nouvelles
```

Note : `sql/000_permissions_triangle_user.sql` est réservé à la base
`triangle_wms` ; sur `malilink_global` il s'ignore automatiquement.

## 4. Démarrage

```bash
node server.js             # « Backend sécurisé démarré sur le port 5050 » (port réel = $PORT)
```

## 5. Dépannage

- `role "malilink_user" does not exist` → étape 1 non faite.
- `permission denied for schema public` → exécuter le bloc GRANT de l'étape 1.
- `JWT_SECRET absent` en production → normal, protection volontaire : renseigner `.env`.
