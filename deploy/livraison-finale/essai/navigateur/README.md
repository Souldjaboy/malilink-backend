# Tests navigateur (Chromium réel)

Ils tournent sur la base `malilink_e2e` (jamais la base de développement),
avec le backend sur le port 5052, LiveKit et Mailpit locaux (voir
`scripts/test-livraison.sh`).

    npm i --no-save playwright-core@1.64.0 && npx playwright-core install chromium
    BACK=<dossier backend> PUBLIC_BASE_URL=http://localhost:3001 bash reinit-e2e.sh
    # frontend construit (BACKEND_URL=http://localhost:5052) lancé par : npx next start -p 3001
    BASE=http://localhost:3001 DATABASE_URL=postgresql://postgres:malilink_test_password@127.0.0.1:5434/malilink_e2e node superadmin.e2e.js
    BASE=http://localhost:3001 node live.e2e.js          # caméra et micro simulés par Chromium
    BASE=http://localhost:3001 node motdepasse.e2e.js    # à lancer en dernier (change le mot de passe du Super Admin)

- `superadmin.e2e.js` : Super Admin › Modifier (formulaire prérempli, sauvegarde relue en base, journal, mot de passe temporaire, changements d'email, validation administrative).
- `live.e2e.js` : direct entre deux comptes (WebRTC réel), compte d'un autre espace refusé.
- `motdepasse.e2e.js` : Paramètres › mot de passe, la session reste, les autres sont fermées.
