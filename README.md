# Hub Multi-canal E-commerce

Publier une fiche produit unique sur eBay, Amazon et TikTok Shop, synchroniser le stock (sans double vente) et centraliser les commandes.

Le suivi du projet se fait dans ClickUp (Space OneHandBusiness, dossier « Hub Multi-canal E-commerce »).

## Stack

| Partie | Techno | Dossier |
| --- | --- | --- |
| Front (onboarding, dashboard) | Next.js 15 + React 19 | `apps/web` |
| API (auth, rôles, invitations) | Fastify 5 + Zod | `apps/api` |
| Jobs de synchronisation | BullMQ + Redis | `apps/worker` |
| Base de données | PostgreSQL + Prisma | `packages/db` |
| Types et règles partagés | TypeScript | `packages/shared` |

Monorepo géré avec les **npm workspaces**, TypeScript strict partout.

## Démarrage local

Prérequis : Node 22 et Docker Desktop.

```bash
npm install
cp .env.example .env
npm run infra:up          # Postgres, Redis, Mailpit
npm run db:migrate        # crée les tables de la base de développement
npm run db:test:prepare   # crée et migre la base de test (hub_test)
npm run build -w @hub/shared -w @hub/db
npm run dev               # web :3000, API :4000 et worker en même temps
```

- Application : http://localhost:3000 (inscription, connexion, équipe)
- Postgres du projet : `localhost:5433` (le port 5432 est pris par le PostgreSQL 14 installé sur Windows)
- API : http://localhost:4000/health
- Emails d'invitation (Mailpit) : http://localhost:8025

Le front appelle l'API via `/api/*` (proxy Next.js), ce qui garde le cookie de session sur la même origine.

## Commandes

| Commande | Rôle |
| --- | --- |
| `npm test` | Tests (Vitest). Les tests de l'API tournent sur `hub_test`, jamais sur la base de développement |
| `npm run db:test:prepare` | Applique les migrations sur la base de test |
| `npm run typecheck` | Vérification TypeScript de tous les paquets |
| `npm run db:generate` | Régénère le client Prisma |
| `npm run infra:down` | Arrête les conteneurs |

## Environnements

| Environnement | Config | Stripe | eBay |
| --- | --- | --- | --- |
| local | `.env` (copie de `.env.example`) | mode test | sandbox |
| staging | `env/staging.env.example` | mode test | sandbox |
| production | `env/production.env.example` | mode live | production |

Les vrais secrets ne vont jamais dans le dépôt : ils vont dans le gestionnaire de secrets de l'hébergeur.

## Rôles (US1)

Défini dans `packages/shared/src/roles.ts` :

- **Propriétaire (OWNER)** : toutes les permissions.
- **Employé (EMPLOYEE)** : produits, stock, consultation des commandes. Il ne gère **ni l'abonnement ni les connexions de canaux**, et n'invite pas de membres.

Côté API, chaque route sensible utilise `requirePermission("...")` (`apps/api/src/plugins/auth.ts`).

## API comptes et invitations (US1)

| Route | Accès | Rôle |
| --- | --- | --- |
| `POST /auth/signup` | public | Crée le propriétaire et sa boutique, ouvre la session |
| `POST /auth/login` | public | Connexion |
| `POST /auth/logout` | connecté | Ferme la session |
| `GET /auth/me` | connecté | Utilisateur, boutique, rôle et permissions |
| `POST /invitations` | propriétaire | Invite un employé et envoie l'email (une nouvelle invitation annule la précédente) |
| `GET /invitations` | propriétaire | Invitations en attente |
| `DELETE /invitations/:id` | propriétaire | Annule une invitation |
| `POST /invitations/preview` | lien d'invitation | Boutique et email affichés sur la page d'acceptation |
| `POST /invitations/accept` | lien d'invitation | Crée le compte employé (ou rattache un compte existant) |

Sécurité :
- Mots de passe hachés avec scrypt.
- Jetons de session et d'invitation aléatoires : seul leur hash est stocké en base.
- Cookie `httpOnly`, `SameSite=Lax`, et `Secure` en production.
- Une invitation expire après 7 jours et ne peut servir qu'une fois.

## Feuille de route

Voir [docs/ROADMAP.md](docs/ROADMAP.md) et les démarches externes dans [docs/DEMARCHES-EXTERNES.md](docs/DEMARCHES-EXTERNES.md).
