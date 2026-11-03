# Feuille de route MVP

Ordre repris de ClickUp (dossier « Hub Multi-canal E-commerce »).

| Sprint | Contenu | État du dépôt |
| --- | --- | --- |
| 0 – Pré-requis | Accès eBay, Amazon SP-API, TikTok Shop, Stripe, domaines | Voir [DEMARCHES-EXTERNES.md](DEMARCHES-EXTERNES.md) |
| 1 – Fondations (US1) | Comptes, rôles, invitation par email, CI/CD, Docker, schéma DB, staging | **Comptes et invitations faits**, staging à faire |
| 2 – Fiche produit maître (US4-US5) | CRUD produits et variantes, médias, adaptation par canal | **Fait** (QA manuelle à compléter) |
| 2 bis – Depop | Connexion OAuth (PKCE), jetons chiffrés, publication et mise à jour via BullMQ, page Canaux | **Fait** contre un faux Depop ; attend les clés partenaire |
| 3 – eBay (US3, US6-US7) | OAuth eBay et publication, en réutilisant l'architecture Depop (`packages/channels`) | À venir |
| 4 – Ventes et stock (US8-US9) | Stock central, anti double vente, import des commandes | **Fait** (Depop ; les autres canaux suivront à leur branchement) |
| 5 – TikTok Shop + Amazon | Connecteurs, mapping, quotas | À venir |
| 6 – Facturation et lancement (US2, US10) | Stripe et paliers, dashboard, bêta fermée | À venir |

## Sprint 1 : ce qui est fait

- Monorepo `apps/web`, `apps/api`, `apps/worker`, `packages/db`, `packages/shared`
- Docker Compose local : Postgres, Redis, Mailpit
- Schéma Prisma : `User`, `Organization`, `Membership` (OWNER / EMPLOYEE), `Invitation`
- Règles de permissions US1 et garde `requirePermission` dans l'API, avec tests
- CI GitHub Actions : install, migration, typecheck, tests
- Modèles de variables pour local, staging et production
- Inscription du propriétaire avec création de la boutique, connexion et déconnexion (sessions en base, cookie httpOnly)
- Invitation d'un employé par email : création, renvoi, annulation, expiration après 7 jours, acceptation par lien
- Pages web provisoires : inscription, connexion, équipe, acceptation d'invitation
- 28 tests (dont 20 tests d'intégration US1 sur une base dédiée `hub_test`)

## Sprint 1 : ce qui reste

- [ ] **DEV** : déploiement continu vers staging (dépend du choix de l'hébergeur)
- [ ] **DEV** : limiter les tentatives de connexion (anti-force brute) et purger les sessions expirées
- [ ] **DEV** : mot de passe oublié (non demandé par US1, utile avant la bêta)
- [x] **DESIGN** : charte OmniList appliquée (couleurs, Inter, logo, emails) à toutes les pages existantes, voir docs/CHARTE.md
- [ ] **DESIGN** : maquettes onboarding et dashboard
- [ ] **QA** : plan de tests, environnement staging

## Sprint 2 : ce qui est fait

- Fiche maître : titre, description, marque, état, article unique (quantité 1) ou variantes (1 à 3 options, SKU, prix, quantité)
- Photos : 1 à 12, ordre réglable, stockage compatible S3 (SeaweedFS en local), type vérifié sur le contenu
- SKU uniques dans la boutique
- Onglets par canal (eBay, Amazon, TikTok Shop) : activation, titre spécifique (limite par canal), catégorie, prix maître / % / fixe
- Aperçu indicatif des frais par article ou variante, calculé de la même façon côté API et écran
- Écrans liste produits (recherche) et fiche avec onglets, responsive
- 47 nouveaux tests (36 API produits/photos, 11 prix et frais)

## Sprint 2 : ce qui reste

- [ ] **DEV** : catégories officielles par canal (avec l'API eBay au Sprint 3, puis Amazon et TikTok Shop)
- [ ] **DEV** : nettoyer les photos envoyées mais jamais rattachées à un produit (tâche planifiée)
- [ ] **DEV** : ajuster les taux de frais indicatifs avec les vrais contrats
- [ ] **QA** : tests manuels formulaires et envois sur plusieurs navigateurs

## Sprint 4 : ce qui est fait

- Stock central par SKU (`Sku.quantity`), seule source de vérité ; jamais négatif (contrainte en base)
- Moteur de ventes (`packages/channels/src/inventory.ts`) : verrou de ligne `SELECT … FOR UPDATE`, SKU verrouillés dans un ordre fixe (pas d'interblocage), commande enregistrée une seule fois (index unique boutique + canal + numéro de commande)
- Doubles ventes tracées (quantité vendue alors que le stock était à 0) au lieu d'être perdues
- Propagation immédiate et prioritaire vers les canaux après chaque vente, annulation ou correction : mise à jour de la quantité, annonce marquée vendue à 0, remise en vente au réassort
- Commandes Depop : webhook signé (HMAC-SHA256, rejeu refusé après 5 minutes) enregistré à la connexion, relevé de secours toutes les 2 minutes (30 s avec le faux Depop), annulation ou remboursement → stock remis
- Ventes saisies dans OmniList (en direct ou sur un canal pas encore branché, ex. Mercari), refusées si le stock ne suffit pas
- La fiche produit ne modifie plus le stock d'une variante existante : plus d'écrasement par une page restée ouverte
- Écrans : Stock (filtres rupture et stock faible, − / +, nouvelle valeur), Journal de synchronisation, Commandes (filtres canal et statut, saisie et annulation d'une vente)
- 13 nouveaux tests, dont 20 ventes simultanées sur un stock de 5 et 10 commandes de canal simultanées sur un stock de 3

## Sprint 4 : ce qui reste

- [x] **DEV** : Shopify et WooCommerce branchés sur le même moteur (publication, stock, commandes par webhook et relevé)
- [ ] **DEV** : brancher eBay et Etsy dès que les comptes développeur sont validés
- [ ] **DEV** : expédition des commandes Depop depuis OmniList (`mark-as-shipped`)
- [ ] **QA** : mesurer le taux de doubles ventes en bêta (objectif < 1 %) à partir du journal (`OVERSOLD`)
- [ ] **DESIGN** : maquettes définitives des écrans Stock, Journal et Commandes
