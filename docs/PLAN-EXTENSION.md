# Plan : extension de navigateur « OmniList Assistant »

Canaux visés : Facebook Marketplace, Poshmark, Mercari, Grailed (Vinted en dernier).
Aucun de ces sites n'a d'API publique pour publier des annonces aux États-Unis : l'extension
travaille dans le navigateur du vendeur, sur sa propre session.

## 1. Le principe de sécurité

Les conditions de ces sites interdisent, d'après leur texte ou d'après les outils du marché, les
outils automatisés non autorisés :
- **Facebook** : Meta interdit la collecte de données « par des moyens automatisés » sans
  autorisation écrite, connecté ou non.
- **Vinted** : ses conditions interdisent les logiciels externes (bots, scraping). Des vendeurs
  ont été suspendus 24 h, et Crosslist n'accepte plus de nouveaux utilisateurs Vinted.
- **Poshmark** : ses conditions interdiraient l'automatisation par des tiers. Seuls des articles
  de fournisseurs de bots le disent, le texte officiel reste à lire.
- **Mercari et Grailed** : texte officiel non trouvé. Les sources se contredisent.

**Aucune technique ne garantit qu'un site ne bloquera pas.** OmniList choisit donc de rester dans
ce qu'un site tolère : l'extension est un **assistant**, pas un robot. Elle prépare le travail et
le vendeur valide chaque action. Nous refusons de déguiser l'extension : pas de faux navigateur,
pas de proxy, pas de contournement de CAPTCHA, pas de délais aléatoires pour imiter un humain.
Ces techniques aggravent les sanctions quand elles sont détectées, et elles sont contraires à
nos engagements.

## 2. Les garde-fous (protéger OmniList et les vendeurs)

1. **Le vendeur clique toujours sur le bouton final.** L'extension remplit le formulaire du site
   (titre, description, prix, état, taille, photos), mais c'est le vendeur qui clique sur
   « Publier », « Modifier » ou « Supprimer ». Il n'y a aucune action en arrière-plan ni dans un
   onglet caché.
2. **Aucune lecture de données au-delà du nécessaire.** L'extension n'agit que sur la page
   ouverte pour une tâche. Elle ne lit que le résultat de cette tâche (lien et identifiant de
   l'annonce du vendeur). Elle ne parcourt pas le site, ne collecte pas d'annonces d'autres
   personnes et ne lit ni cookies ni mots de passe.
3. **Des plafonds de volume par site.** Chaque vendeur a un nombre maximum de publications par
   jour, prudent par défaut et réglable à la baisse. Il évite les rafales qui déclenchent les
   règles anti-spam des sites. Ce plafond est fixe et affiché au vendeur, ce n'est pas un camouflage.
4. **Un arrêt en cas d'alerte.** Si le site affiche un CAPTCHA, une vérification d'identité, un
   avertissement ou une restriction de compte, l'extension s'arrête. Le canal est mis en pause
   pour ce vendeur, et le vendeur est prévenu avec la marche à suivre.
5. **Des interrupteurs à distance.**
   - Le serveur peut couper un site pour tous les vendeurs (site modifié, avertissement reçu de
     la plateforme) ou pour un seul vendeur.
   - L'extension vérifie l'interrupteur avant chaque tâche.
   - Les repères de page sont versionnés côté serveur : si un site change, on désactive le site
     plutôt que de remplir de travers.
6. **Une surveillance.** OmniList suit le taux d'échec par site et par vendeur, et met le site
   en pause automatiquement si les échecs augmentent d'un coup.
7. **Un accord éclairé du vendeur.** Pour chaque site, le vendeur active le canal après avoir lu
   un écran clair. Cet écran explique que le site n'a pas d'API, qu'il peut sanctionner les
   outils tiers, et quels risques le vendeur prend. L'accord est enregistré avec sa date. Les
   CGU et la page de confidentialité d'OmniList sont mises à jour.
8. **Des annonces propres.** OmniList refuse les doublons (une annonce par produit et par site),
   et contrôle la catégorie, les champs obligatoires et les articles interdits avant de préparer
   le formulaire. Les sanctions des sites viennent aussi beaucoup des annonces en double ou hors
   règles.
9. **Des droits minimaux pour l'extension.**
   - Elle n'accède qu'aux domaines des sites visés et à omnilist.1handbiz.com.
   - Elle se connecte à OmniList par un jeton propre à chaque appareil, révocable depuis OmniList.
   - Elle respecte les règles du Chrome Web Store : un seul usage, et une déclaration des données.
10. **La voie officielle d'abord.** OmniList demande en parallèle un partenariat à chaque site
    (Meta Marketplace Partnership Program, Mercari, Poshmark). Si une API ouvre, elle remplace
    l'extension pour ce site. Si une plateforme nous demande d'arrêter, nous coupons le site
    (point 5).

## 3. Les limites à afficher au vendeur

- **Retrait après vente :** il n'est pas instantané. Quand un article se vend ailleurs, OmniList
  crée une tâche « à retirer » et prévient le vendeur (email et badge de l'extension). Le
  retrait se fait quand le vendeur la traite. Les articles uniques restent exposés à une double
  vente pendant ce délai, et l'écran Stock le montre.
- **Ventes faites sur ces sites :** OmniList ne lit pas les pages de ventes. Il y a deux moyens
  de les enregistrer.
  - **Phase 1** : le vendeur marque l'article vendu dans OmniList, en un clic depuis l'extension.
  - **Phase 3** : le vendeur transfère automatiquement vers une adresse OmniList les emails
    « Vous avez vendu… » que ces sites lui envoient. OmniList lit ces emails et retire l'article
    des autres canaux. C'est sans danger pour le compte, car il n'y a aucune automatisation sur le site.

## 4. Architecture

```
OmniList (API)                         Extension Chrome (Manifest V3)
- tâches navigateur par canal  <---->  - appairage par jeton d'appareil
  (publier / modifier / retirer)       - liste des tâches (popup + badge)
- interrupteurs et plafonds            - module par site : ouvre la page du site,
- repères de page versionnés             remplit le formulaire, attend le clic du vendeur,
- journal et taux d'échec                renvoie le lien de l'annonce
```

- **Base de données :**
  - `ExtensionDevice` : jeton haché, nom, dernier contact, révocation.
  - `BrowserTask` : canal, type, annonce, statut, essais, erreur.
  - `ChannelConsent` : vendeur, site, date.
  - `SiteSwitch` : site, actif ou en pause, version des repères.
- **Annonces :** les statuts existants servent toujours (PENDING, LISTED, ERROR, REMOVED). On
  ajoute « en attente du vendeur » pour les tâches à valider dans le navigateur.
- **API :** `/extension/pair`, `/extension/tasks` (lister, prendre, terminer, échouer),
  `/extension/config` (interrupteurs, plafonds, repères).
- **Moteur commun :** stock, prix par canal et anti double vente restent dans OmniList. Le
  module d'un site ne fait que remplir et lire sa page.

## 5. Étapes

| Phase | Contenu | Durée indicative |
|---|---|---|
| 0. Vérifications | Lire les conditions actuelles des 5 sites (texte officiel) ; avis d'un juriste ; demandes de partenariat (Meta, Mercari, Poshmark) | 1 semaine, en parallèle |
| 1. Socle | Tables, API extension, appairage, interrupteurs, plafonds, écran d'accord, squelette de l'extension, tâches « à retirer » | 2 semaines |
| 2. Pilote : Poshmark | Module Poshmark (catalogue mode, tailles déjà gérées) ; essai sur 2-3 vendeurs volontaires | 1-2 semaines |
| 3. Autres sites | Mercari, puis Facebook Marketplace, puis Grailed ; lecture des emails de vente transférés | 1-2 semaines par site |
| 4. Vinted | Seulement si les conditions le permettent : Vinted Pro n'est pas ouvert aux États-Unis, et Vinted sanctionne déjà les outils tiers | à décider |

Le pilote commence par Poshmark : c'est le site le plus proche du catalogue actuel (vêtements,
tailles, état), et le plus utilisé par les revendeurs aux États-Unis. Facebook passe après, car
c'est le site le plus strict, et la demande de partenariat Meta peut ouvrir une voie officielle
d'ici là.

## Sources (novembre 2026)

- [Meta – Automated Data Collection](https://developers.facebook.com/docs/development/terms-and-policies/automated-data-collection/)
- [Meta – Marketplace Partnerships](https://developers.facebook.com/docs/marketplace/partnerships/)
- [Vinted – conditions (ancienne version)](https://www.vinted.com/old-terms-and-conditions)
- [Crosslist – arrêt de Vinted pour les nouveaux utilisateurs](https://crosslist.com/blog/vinted-cross-listing)
- [Crosslist – Vinted et les revendeurs](https://crosslist.com/blog/does-vinted-allow-resellers)
- [FlowLister – fonctionnement du crosslisting](https://flowlister.com/how-crosslisting-works/)
- [Vendoo – bots Poshmark](https://blog.vendoo.co/poshmark-bots-what-you-need-to-know-about-using-bots)
- [Closo – Closo est-il autorisé par les places de marché ?](https://closo.co/blogs/casestudies/is-closo-safe-allowed-by-marketplaces-what-i-learned-after-connecting-thousands-of-listings-across-poshmark-ebay-mercari-more)
- [Grailed – Terms of Service](https://www.grailed.com/about/terms)
