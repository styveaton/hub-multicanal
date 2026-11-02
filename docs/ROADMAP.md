# Feuille de route MVP

Ordre repris de ClickUp (dossier « Hub Multi-canal E-commerce »).

| Sprint | Contenu | État du dépôt |
| --- | --- | --- |
| 0 – Pré-requis | Accès eBay, Amazon SP-API, TikTok Shop, Stripe, domaines | Voir [DEMARCHES-EXTERNES.md](DEMARCHES-EXTERNES.md) |
| 1 – Fondations (US1) | Comptes, rôles, invitation par email, CI/CD, Docker, schéma DB, staging | **Squelette en place** |
| 2 – Fiche produit maître (US4-US5) | CRUD produits et variantes, médias, adaptation par canal | À venir |
| 3 – eBay (US3, US6-US7) | OAuth eBay, jetons chiffrés, publication via BullMQ | À venir |
| 4 – Ventes et stock (US8-US9) | Stock central, anti double vente, import des commandes | À venir |
| 5 – TikTok Shop + Amazon | Connecteurs, mapping, quotas | À venir |
| 6 – Facturation et lancement (US2, US10) | Stripe et paliers, dashboard, bêta fermée | À venir |

## Sprint 1 : ce qui est fait

- Monorepo `apps/web`, `apps/api`, `apps/worker`, `packages/db`, `packages/shared`
- Docker Compose local : Postgres, Redis, Mailpit
- Schéma Prisma : `User`, `Organization`, `Membership` (OWNER / EMPLOYEE), `Invitation`
- Règles de permissions US1 et garde `requirePermission` dans l'API, avec tests
- CI GitHub Actions : install, migration, typecheck, tests
- Modèles de variables pour local, staging et production

## Sprint 1 : ce qui reste

- [ ] **DEV** : inscription et connexion (sessions), création de l'organisation, routes d'invitation (créer, accepter, révoquer) avec envoi d'email
- [ ] **DEV** : déploiement continu vers staging
- [ ] **DESIGN** : charte graphique, maquettes onboarding et dashboard
- [ ] **QA** : plan de tests, environnement staging
