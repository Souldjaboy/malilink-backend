#!/usr/bin/env bash
# PRÉCONTRÔLE de la livraison MaliLink — LECTURE SEULE : aucune modification
# de la production (ni fichier, ni base, ni processus, ni configuration).
# Lance l'audit de deploy.sh :
#   releases, dossiers et ports réellement utilisés par PM2 ; uploads ;
#   empreintes des fichiers à remplacer (Academy comprise) ; configuration
#   effective sans secret ; moteur PostgreSQL et migrations en attente ;
#   possibilité de répéter les migrations sur une copie ; infrastructure des
#   directs ; espaces ; identification de l'école (société 8) ; connexion et
#   authentification SMTP SANS envoi.
# Seuls des fichiers temporaires sont créés dans /tmp (verrou, diagnostic SMTP).
exec bash "$(cd -- "$(dirname -- "$0")" && pwd)/deploy.sh"
