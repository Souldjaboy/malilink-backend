# Déploiement — Phase 0 (durcissement)

Instructions pour appliquer la Phase 0 sur le VPS. Aucune action destructive ;
tout est idempotent et rétrocompatible (dégradation contrôlée si une
variable optionnelle n'est pas fournie).

## 1. Variables d'environnement (`backend/.env`)

| Variable | Requis | Rôle | Génération |
|---|---|---|---|
| `JWT_SECRET` | **Oui (prod)** | Signature des JWT | `openssl rand -hex 32` |
| `WALLET_RECEIPT_SECRET` | **Oui (prod)** | Signature des reçus Wallet — **doit être différent de `JWT_SECRET`** | `openssl rand -hex 32` |
| `WALLET_SECRET_ENC_KEY` | Recommandé | Chiffrement au repos des secrets webhooks (AES-256-GCM), 32 octets | `openssl rand -hex 32` |
| `PG_POOL_MAX` | Non (défaut 20) | Connexions PG max par instance | — |
| `PG_IDLE_TIMEOUT_MS` | Non (défaut 30000) | Fermeture connexion inactive | — |
| `PG_CONNECTION_TIMEOUT_MS` | Non (défaut 5000) | Timeout d'obtention d'une connexion | — |
| `REDIS_URL` | Non | Active le rate-limit multi-instances (sinon mémoire) | ex. `redis://127.0.0.1:6379` |

> Au démarrage, `config/env-guard.js` vérifie ces secrets. En **production**,
> le serveur **refuse de démarrer** si `JWT_SECRET` ou `WALLET_RECEIPT_SECRET`
> sont absents, faibles, ou identiques entre eux. En dev, il émet seulement
> des avertissements. Les valeurs ne sont jamais affichées.

**Important :** si `WALLET_RECEIPT_SECRET` change, les reçus signés
précédemment ne seront plus vérifiables (nouvelle clé). Fixer une valeur
stable et la conserver.

## 2. Migration base de données

```bash
cd backend
npm run migrate        # applique 056_phase0_hardening.sql (idempotent)
```

Effets : index de performance (`wallet_entries(transaction_id)` + secondaires),
table `wallet_reconciliation_state`, colonnes `mode/from_entry_id/to_entry_id`
sur les rapports, colonnes `secret_enc/secret_format` sur les webhooks et
`secret` rendu nullable.

## 3. Redémarrage (uniquement les process MaliLink)

```bash
pm2 restart malilink-backend
# NE PAS faire « pm2 restart all » (Triangle/Hafiya ne doivent pas être touchés)
```

Vérifier les logs de démarrage : le pool annonce ses réglages, l'env-guard
signale d'éventuels secrets manquants, le rate-limit indique mémoire ou Redis.

## 4. Réconciliation planifiée (cron)

Exécuter la réconciliation incrémentale régulièrement (ne rescanne jamais
tout le grand livre) :

```bash
# crontab -e  — toutes les 15 minutes
# (barre-oblique)15 * * * * cd /chemin/backend && node scripts/reconcile.js >> logs/reconcile.log 2>&1
```

- `node scripts/reconcile.js` → incrémental (rapide, curseur).
- `node scripts/reconcile.js --full` → contrôle complet (audit ponctuel).
- Code de sortie `2` si un écart est détecté (exploitable par la supervision).

## 5. Rollback

- Les index et colonnes ajoutés sont **non destructifs** ; en cas de besoin,
  les index peuvent être supprimés sans perte de données
  (`DROP INDEX IF EXISTS idx_wallet_entries_transaction;` etc.).
- Le code se dégrade proprement sans `WALLET_SECRET_ENC_KEY` (secrets webhooks
  en clair, format `plain`) et sans `REDIS_URL` (rate-limit mémoire).

## 6. Vérification post-déploiement

```bash
# Index présents
psql "$DATABASE_URL" -c "\di idx_wallet_entries_transaction"
# Réconciliation incrémentale opérationnelle
node scripts/reconcile.js
# Tests (sur une copie/CI, pas en prod)
npm test
```
