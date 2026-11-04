#!/usr/bin/env bash
# Prépare le fichier d'environnement de production sur le serveur.
# - Crée env/production.env depuis le modèle s'il n'existe pas.
# - Remplit les secrets encore vides (mots de passe, clés de chiffrement), sans toucher aux valeurs déjà là.
# - Écrit les clés du stockage des photos dans deploy/seaweedfs/s3.json.
# Usage (depuis la racine du dépôt) : bash deploy/setup-env.sh omnilist.1handbiz.com
set -euo pipefail
cd "$(dirname "$0")/.."

DOMAIN="${1:-omnilist.1handbiz.com}"
FILE="${OMNILIST_ENV_FILE:-env/production.env}"
[ -f "$FILE" ] || cp env/production.env.example "$FILE"
chmod 600 "$FILE"

get() { grep -E "^$1=" "$FILE" | head -n1 | cut -d= -f2- || true; }
put() {
  if grep -qE "^$1=" "$FILE"; then sed -i "s|^$1=.*|$1=$2|" "$FILE"; else printf '%s=%s\n' "$1" "$2" >>"$FILE"; fi
}
# N'écrit que si la valeur est vide (ou un modèle du type <domaine-production>).
fill() { local v; v="$(get "$1")"; if [ -z "$v" ] || [[ "$v" == *"<"* ]]; then put "$1" "$2"; fi; }
hex() { openssl rand -hex "${1:-24}"; }

fill NODE_ENV production
fill APP_ENV production
fill WEB_URL "https://$DOMAIN"
fill PUBLIC_API_URL "https://$DOMAIN/api"
fill API_URL "http://api:4000"
fill REDIS_URL "redis://redis:6379"

fill POSTGRES_USER omnilist
fill POSTGRES_DB omnilist
fill POSTGRES_PASSWORD "$(hex 24)"
fill DATABASE_URL "postgresql://$(get POSTGRES_USER):$(get POSTGRES_PASSWORD)@postgres:5432/$(get POSTGRES_DB)"

fill SESSION_SECRET "$(hex 32)"
fill MEDIA_URL_SECRET "$(hex 32)"
fill TOKEN_ENCRYPTION_KEY "$(openssl rand -base64 32)"

fill S3_ENDPOINT "http://s3:8333"
fill S3_REGION us-east-1
fill S3_BUCKET omnilist-media
fill S3_ACCESS_KEY_ID omnilist
fill S3_SECRET_ACCESS_KEY "$(hex 24)"
put S3_FORCE_PATH_STYLE true

fill SMTP_PORT 587
fill MAIL_FROM "OmniList <no-reply@${DOMAIN#*.}>"

mkdir -p deploy/seaweedfs
cat >deploy/seaweedfs/s3.json <<EOF
{
  "identities": [
    {
      "name": "omnilist",
      "credentials": [{ "accessKey": "$(get S3_ACCESS_KEY_ID)", "secretKey": "$(get S3_SECRET_ACCESS_KEY)" }],
      "actions": ["Admin", "Read", "List", "Tagging", "Write"]
    }
  ]
}
EOF
chmod 600 deploy/seaweedfs/s3.json

echo "Fichier prêt : $FILE"
missing=""
for key in SMTP_HOST SMTP_USER SMTP_PASS; do [ -n "$(get "$key")" ] || missing="$missing $key"; done
[ -z "$missing" ] || echo "À compléter à la main pour envoyer les emails :$missing"
