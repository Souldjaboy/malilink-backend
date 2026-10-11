ARG PGV=16
FROM node:20-bookworm-slim AS node
FROM postgres:${PGV}-bookworm
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates util-linux iproute2 procps && rm -rf /var/lib/apt/lists/*
ARG PM2V=7.0.4
RUN npm install -g --no-audit --no-fund pm2@${PM2V} && pm2 --version
# Données PostgreSQL hors volume : conservées par « docker commit ».
ENV PGDATA=/var/lib/pg-essai
