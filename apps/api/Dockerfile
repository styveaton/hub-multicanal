# Image de l'API pour staging et production (contexte de build : racine du depot).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/api/package.json ./apps/api/package.json
RUN npm ci -w @hub/shared -w @hub/db -w @hub/api --include-workspace-root
COPY apps/api ./apps/api
RUN npm run build -w @hub/shared -w @hub/db -w @hub/api

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app ./
EXPOSE 4000
CMD ["node", "apps/api/dist/server.js"]
