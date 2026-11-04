#!/usr/bin/env bash
# Sauvegarde la base OmniList dans deploy/backups (garde les 14 dernières).
# À lancer chaque nuit par cron : 17 3 * * * /bin/bash /opt/omnilist/deploy/backup.sh
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p deploy/backups
out="deploy/backups/omnilist-$(date +%Y%m%d-%H%M%S).sql.gz"
docker compose -f deploy/docker-compose.yml exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip >"$out"
ls -1t deploy/backups/omnilist-*.sql.gz | tail -n +15 | xargs -r rm --
echo "Sauvegarde : $out"
