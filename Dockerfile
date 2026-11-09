# Image unique d'OmniList pour staging et production (contexte de build : racine du dépôt).
# Le même image sert l'API, le worker, le site et les migrations : seule la commande change
# (voir deploy/docker-compose.yml).
FROM node:22-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN npm ci
# Le site relaie /api vers l'API : l'adresse interne est figée au build par Next.js.
ENV NEXT_TELEMETRY_DISABLED=1 API_URL=http://api:4000
RUN npm run build -w @hub/shared -w @hub/db -w @hub/channels -w @hub/api -w @hub/worker -w @hub/web

FROM node:22-alpine
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /app ./
# Pas de root dans le conteneur.
USER node
EXPOSE 3000 4000
CMD ["node", "apps/api/dist/server.js"]
