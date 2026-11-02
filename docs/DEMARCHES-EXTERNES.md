# Démarches externes (Sprint 0) à faire soi-même

Ces étapes demandent de créer des comptes ou d'accepter des conditions au nom de l'entreprise. Elles ne sont pas automatisées. **À lancer dès la semaine 1** : les délais d'approbation sont externes et bloquent les Sprints 3 et 5.

## 1. eBay : compte développeur (bloque le Sprint 3)
Tâche ClickUp : « Demande d'accès développeur eBay (production) »
- [ ] Créer un compte sur developer.ebay.com
- [ ] Créer un jeu de clés **Sandbox** et reporter `EBAY_CLIENT_ID` et `EBAY_CLIENT_SECRET` dans `.env`
- [ ] Déposer la demande d'accès **Production**
- [ ] Configurer l'URL de redirection OAuth (RuName) une fois le domaine staging connu

## 2. Amazon SP-API (bloque le Sprint 5)
Tâche ClickUp : « Demande d'accès Amazon SP-API »
- [ ] Avoir un compte Seller Central (ou Solution Provider Portal pour un développeur tiers)
- [ ] Enregistrer l'application SP-API et passer le profil développeur
- [ ] Obtenir l'approbation des rôles nécessaires (Listings, Inventory, Orders)
- [ ] Reporter les identifiants LWA dans le gestionnaire de secrets

## 3. TikTok Shop Partner (bloque le Sprint 5)
Tâche ClickUp : « Demande d'accès TikTok Shop Partner »
- [ ] Créer le compte sur le TikTok Shop Partner Center
- [ ] Créer l'application et déposer la demande d'accès API
- [ ] Reporter `TIKTOK_SHOP_APP_KEY` et `TIKTOK_SHOP_APP_SECRET`

## 4. Stripe et environnements
Tâche ClickUp : « Compte Stripe + environnements staging/production »
- [ ] Créer le compte Stripe et rester en **mode test** jusqu'au Sprint 6
- [ ] Reporter la clé `sk_test_...` dans `.env` (local) et dans les secrets staging
- [ ] Réserver les noms de domaine (ex. `app.<domaine>` et `staging.<domaine>`)
- [ ] Choisir l'hébergeur (API, worker, Postgres et Redis managés) et créer les projets staging et production

## 5. Outillage du poste
- [ ] Installer **Docker Desktop** (WSL 2) pour lancer Postgres, Redis et Mailpit
- [ ] Créer le dépôt distant (GitHub) et pousser le code pour activer la CI

## Hors MVP (phase 2)
Facebook Marketplace, Vinted, Depop et Poshmark n'ont pas d'API publique : vérifier les conditions d'utilisation avant tout développement.
