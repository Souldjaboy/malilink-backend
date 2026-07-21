# MaliLink Voyage (Travel) — Lot 4A : fondations

Fondations backend de l'agrégateur de transport. **Aucun paiement dans ce
lot** (Lot 4B) ; aucune modification des modules existants ; tout est préfixé
`travel_` et monté sous `/travel`.

## Périmètre livré (4A)
- Schéma complet (26 tables `travel_*`) : référentiels, partenaires,
  véhicules, lignes, horaires, prix, promotions, réservations, billets,
  scans, avis, paiements, remboursements, coupons, logs, notifications.
- Architecture Travel : **Repository** (accès données) · **Service** (règles
  métier) · **Controller** (`routes/travel.js`) · **Events** (noms d'événements).
- Recherche publique d'offres + comparateur (moins cher / plus rapide / mieux noté).
- Espace partenaire : devenir compagnie, agences, véhicules, lignes, horaires, prix.
- Amorçage : 10 villes du Mali, 6 modes actifs (bus, car, minibus, taxi,
  privé, avion) + 4 préparés (train, bateau, moto, hélico).

## Réutilisation (aucun doublon)
| Besoin | Réutilise |
|---|---|
| Auth / rôles / périmètre entreprise | `authenticateToken`, `isSuperAdminUser`, `getEffectiveCompanyId` |
| Partenaire ↔ entreprise | `travel_companies.company_id` → `companies(id)` |
| Signature billet (4B) | même HMAC que les reçus Wallet, secret `TRAVEL_TICKET_SECRET` indépendant |
| Paiement/commission (4B) | `services/wallet-ledger.js` — le moteur Wallet reste unique |

## Architecture
```
routes/travel.js            → Controller REST (/travel)
services/travel/
  travel-repository.js       → accès données (SQL paramétré)
  travel-service.js          → règles métier (tarif, promo, commission, comparateur, signTicket)
  travel-events.js           → noms d'événements (notifications/webhooks 4B)
```

## API (Lot 4A)
### Public
- `GET /travel/health`
- `GET /travel/modes`
- `GET /travel/cities?q=`
- `GET /travel/cities/:cityId/points`
- `GET /travel/companies`
- `GET /travel/search?origin=&destination=&date=&adults=&children=&mode=`
  → `{ count, comparator:{cheapest,fastest,best_rated}, offers:[…] }`

### Partenaire (authentifié)
- `POST /travel/partner/company` · `GET /travel/partner/company`
- `POST|GET /travel/partner/agencies`
- `POST|GET /travel/partner/vehicles`
- `POST|GET /travel/partner/routes`
- `POST /travel/partner/routes/:routeId/schedules`
- `POST /travel/partner/routes/:routeId/prices`

## Feature flags (`travel_feature_flags`)
| Flag | Défaut | Rôle |
|---|---|---|
| `travel_enabled` | true | Module actif |
| `travel_search_enabled` | true | Recherche publique |
| `travel_bookings_enabled` | **false** | Réservation — ouverte au Lot 4B |
| `travel_payments_enabled` | **false** | Paiement — ouvert au Lot 4B |

## Réglages (`travel_settings`)
- `commission_rate` = `0.08` (8 % commission MaliLink, prélevée au Lot 4B)
- `tax_rate` = `0`

## Déploiement VPS
1. Variable d'environnement (recommandée, requise en prod au Lot 4B) :
   `TRAVEL_TICKET_SECRET` = `openssl rand -hex 32` (indépendant de `JWT_SECRET`
   et `WALLET_RECEIPT_SECRET`).
2. Migration : `cd backend && npm run migrate` (applique `057_travel_foundations.sql`, idempotent).
3. Redémarrage : `pm2 restart malilink-backend` (jamais `pm2 restart all`).
4. Vérification :
   ```bash
   curl -s localhost:5050/travel/health
   curl -s "localhost:5050/travel/search?origin=1&destination=3&date=2026-07-22&adults=1"
   ```

## Tests
`services/travel/travel-service.test.js` — tarification, promotions,
commission, comparateur, signature billet, recherche (repo simulé).
Suite globale : `npm test` → **47/47 verts**.

## Suite
Lot 4B : réservation + choix de siège + paiement via Wallet (débit voyageur /
crédit transporteur net + commission plateforme) + billet e-ticket signé QR +
écritures comptables automatiques.
