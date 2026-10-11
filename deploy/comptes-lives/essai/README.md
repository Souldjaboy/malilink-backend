# VPS d'essai pour `deploy.sh`

Rejoue le déploiement réel (`../deploy.sh`, tel que livré) dans un conteneur Debian
qui imite le VPS : PostgreSQL local (rôle applicatif SANS droit CREATEDB, compte
`postgres` local), Node 20, PM2, copie de la production MaliLink (backend réel,
Academy comprise), faux Nginx, applications témoins « Triangle » et « HAFIYA ».

Le frontend est un faux Next.js (`faux-next.js`) : même `npm run build` /
`npm start`, mêmes pages contrôlées, et des pannes à la demande lues au démarrage
(`/etc/essai/nouveau` ou `/etc/essai/ancien` : `plante`, `http500`, `lent`).
Le frontend d'origine est lancé avec `PORT` et `MARQUEUR_ESSAI` présents
UNIQUEMENT dans sa définition PM2 : leur présence après une bascule ou un
retour arrière prouve que l'environnement complet a été restitué.

## Préparer (une fois par variante)

    git -C .. archive 8f56fff > backend-prod.tar            # backend de production (Academy)
    git -C ../../frontend archive dee116b > frontend-prod.tar
    docker build -t vps-essai:pg16 --build-arg PGV=16 .     # PGV=14, PM2V=5.4.3 : variantes
    docker run -d --name prep -e POSTGRES_PASSWORD=essai -v "$PWD:/essai:ro" vps-essai:pg16
    docker exec prep bash /essai/preparer.sh
    docker stop prep && docker commit prep vps-essai:prod16 && docker rm prep

## Lancer

    PAQUET=<dossier du paquet malilink-comptes-lives> ./lancer.sh vps-essai:prod16 \
      audit succes pm2-start-echoue demarrage-plante http-echoue interruption-int \
      interruption-term interruption-hup retour-impossible backend-echoue migration-echoue

Chaque scénario part d'un conteneur neuf ; résultats et journaux dans `resultats/`.
