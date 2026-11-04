# Démarches externes (Sprint 0) à faire soi-même

Ces étapes demandent de créer des comptes ou d'accepter des conditions au nom de l'entreprise. Elles ne sont pas automatisées. **À lancer dès la semaine 1** : les délais d'approbation sont externes et bloquent les Sprints 3 et 5.

## 1. eBay : compte développeur (bloque le Sprint 3)
Tâche ClickUp : « Demande d'accès développeur eBay (production) »
- [x] Créer un compte sur developer.ebay.com
- [x] Créer un jeu de clés **Sandbox** « OmniList » et reporter `EBAY_CLIENT_ID` et `EBAY_CLIENT_SECRET` dans `.env`
- [x] Créer le jeu de clés **Production** « OmniList » (clés rangées dans `env/production.env`, ignoré par git)
- [ ] Activer les clés Production (Application Keys › Production › **Notifications**) : eBay les laisse
      désactivées tant que l'adresse des avis « suppression / fermeture de compte » n'est pas validée.
      Pas de dispense possible : OmniList garde des données d'acheteurs eBay (commandes).
      - Adresse : `https://<adresse publique de l'API>/webhooks/ebay/account-deletion` (= `PUBLIC_API_URL` + `/webhooks/ebay/account-deletion`)
      - Jeton de vérification : la valeur de `EBAY_VERIFICATION_TOKEN` (déjà générée dans `env/production.env`)
      - eBay envoie un défi à l'enregistrement : l'API doit être en ligne avec ces deux valeurs avant de cliquer sur « Save ».
- [ ] Créer l'adresse de retour OAuth (RuName), en Sandbox puis en Production
      (Application Keys › User Tokens › « Get a Token from eBay via Your Application » › Add eBay Redirect URL) :
      - Auth accepted URL : `https://<domaine du site>/api/channels/ebay/callback`
      - Auth declined URL : `https://<domaine du site>/api/channels/ebay/callback?error=access_denied`
      - Privacy policy URL : la page de politique de confidentialité d'OmniList
      - Reporter le nom généré (ex. `OneHandb-OmniList-xxxx`) dans `EBAY_RUNAME`
- [ ] Sur le serveur : `EBAY_ENV=sandbox` (staging) ou `production`, avec `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`,
      `EBAY_RUNAME` et `EBAY_VERIFICATION_TOKEN`
- Chaque vendeur doit avoir des règles de vente eBay (expédition, paiement, retours). OmniList prend les
  premières de chaque type ; sans elles, l'annonce affiche l'erreur et le lien à suivre.
- En local, `EBAY_ENV=fake` : faux eBay intégré, aucune clé ni domaine nécessaire.

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

## 6. Autres places de marché avec API officielle (à planifier)
Ces canaux sont déjà dans l'application (onglets de la fiche produit). La publication réelle demande un compte développeur.

**Walmart Marketplace**
- [ ] Faire approuver un compte vendeur sur sellercenter.walmart.com (dossier d'entreprise, délai de plusieurs semaines)
- [ ] Créer les clés API dans le Developer Portal (developer.walmart.com) : `WALMART_CLIENT_ID`, `WALMART_CLIENT_SECRET`
- [ ] Pour proposer l'app à d'autres vendeurs : demander le statut **Solution Provider**

**Etsy** (intégration codée et testée contre un faux Etsy, `ETSY_ENV=fake`)
- [ ] Créer une application sur etsy.com/developers (Open API v3, OAuth 2 avec PKCE)
- [ ] Déclarer l'adresse de retour : `https://<domaine du site>/api/channels/etsy/callback`
- [ ] Demander l'accès **commercial** (l'accès personnel ne sert qu'à sa propre boutique)
- [ ] Reporter `ETSY_KEYSTRING` et `ETSY_SHARED_SECRET` (page « Your Apps »), puis `ETSY_ENV=live`
- Droits demandés au vendeur : listings_r, listings_w, listings_d, shops_r, shops_w, transactions_r
- Chaque vendeur doit avoir un profil d'expédition Etsy. S'il n'a pas de profil de préparation,
  OmniList en crée un (« prêt à expédier sous 1 à 3 jours »).
- Etsy n'envoie pas de webhook de commande : les ventes arrivent par le relevé (toutes les 2 min).

**Shopify** (intégration codée et testée contre un faux Shopify, `SHOPIFY_ENV=fake`)
- [ ] Créer un compte Shopify Partner (partners.shopify.com), puis une application publique et une boutique de développement pour essayer
- [ ] Reporter le Client ID et le Client secret dans `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET`, passer `SHOPIFY_ENV=live`
- [ ] URL de redirection autorisée : `<WEB_URL>/api/channels/shopify/callback` ; scopes : `read_products, write_products, read_inventory, write_inventory, read_orders, read_locations`
- [ ] Webhooks RGPD obligatoires (customers/data_request, customers/redact, shop/redact) : `<PUBLIC_API_URL>/webhooks/shopify/compliance`
- [ ] Commandes de plus de 60 jours : demander le scope `read_all_orders` (inutile au lancement)
- [ ] Passer la revue de l'App Store Shopify avant d'ouvrir l'app à tous les marchands

**WooCommerce** (intégration codée et testée contre un faux WooCommerce, `WOO_ENV=fake`)
- Aucun compte développeur : chaque marchand crée ses clés dans WordPress (WooCommerce › Réglages › Avancé › API REST, droits Lecture/Écriture) et les colle dans OmniList
- [ ] Passer `WOO_ENV=live` en staging et production ; le site du marchand doit être en HTTPS
- [ ] Webhooks de commandes : enregistrés automatiquement si `PUBLIC_API_URL` est en HTTPS

## 7. Depop : accès partenaire à la Selling API (premier canal branché)
L'intégration est codée et testée contre un faux Depop (`DEPOP_ENV=fake` en local). Pour publier pour de vrai :
- [ ] Demander l'accès par email (adresse sur https://partnerapi.depop.com/api-docs/) : OmniList, outil multi-canal pour vendeurs aux États-Unis
- [ ] Recevoir le client OAuth de test (bac à sable `partnerapi-staging.depop.com`) : reporter `DEPOP_CLIENT_ID` et `DEPOP_CLIENT_SECRET`, passer `DEPOP_ENV=staging`
- [ ] Faire enregistrer l'URL de retour OAuth : `<WEB_URL>/api/channels/depop/callback` (staging puis production)
- [ ] Déployer sur une adresse publique (`PUBLIC_API_URL`) : Depop télécharge les photos par lien signé, impossible depuis localhost
- [ ] Générer `TOKEN_ENCRYPTION_KEY` et `MEDIA_URL_SECRET` pour staging et production
- [ ] Plus tard : webhooks Depop (vente sur Depop → retrait sur les autres canaux)

La liste des catégories et tailles Depop est figée dans `packages/shared/src/depop-taxonomy.ts` (extraite le 3 novembre 2026). À rafraîchir depuis un navigateur si Depop refuse une catégorie.

## 8. Places de marché sans API publique
Facebook Marketplace, Mercari, Poshmark, Vinted et Grailed n'ont pas d'API ouverte pour publier des annonces. Les outils du marché (Vendoo, List Perfectly, Closo…) passent par une **extension de navigateur** qui remplit les formulaires dans la session du vendeur.
- [ ] Lire les conditions d'utilisation de chaque site sur l'automatisation avant de développer l'extension
- [ ] Facebook : les boutiques Facebook/Instagram passent par le catalogue Meta Commerce (API Graph) ; Marketplace entre particuliers n'a pas d'API

Les frais et limites de titre affichés dans l'app sont **indicatifs** (sources : sites des plateformes et calculateurs, novembre 2026). À revérifier sur le centre d'aide de chaque site, en particulier les limites de titre de Vinted et Grailed (Depop n'a pas de titre : description de 1000 caractères).
