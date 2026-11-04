#!/usr/bin/env bash
# Met OmniList à jour sur le serveur : récupère le code, reconstruit l'image, applique les migrations, relance.
# Usage (depuis la racine du dépôt) : bash deploy/update.sh
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
docker compose -f deploy/docker-compose.yml up -d --build
docker image prune -f >/dev/null
docker compose -f deploy/docker-compose.yml ps
