# OmniList Assistant (extension Chrome)

Extension pour les sites sans API : Poshmark, Mercari, Facebook Marketplace et Grailed.
Elle prépare le travail, et le vendeur clique lui-même sur le bouton final du site.
Les garde-fous sont décrits dans [docs/PLAN-EXTENSION.md](../../docs/PLAN-EXTENSION.md).

## Ce que fait cette version (phase 1)

- **Liaison du navigateur :** sur OmniList, page Canaux › Navigateurs reliés. Si l'extension est
  installée, elle récupère le jeton toute seule. Sinon, on colle le jeton dans sa fenêtre.
- **Badge :** le nombre de tâches à faire, relevé toutes les 5 minutes.
- **Tâches :** « Ouvrir » ouvre la page du site, au premier plan. La fenêtre affiche les informations
  de la fiche (titre, prix, description, marque, état, photos) avec des boutons Copier.
- **Résultat :** le vendeur indique le lien de l'annonce publiée, qui est repris de l'onglet ouvert.
  Il peut aussi signaler un problème (une alerte du site met ce site en pause) ou laisser la tâche
  pour plus tard.

Le remplissage automatique du formulaire de chaque site viendra en phase 2, en commençant par Poshmark.

## Droits demandés

- `storage` : le jeton et la tâche en cours.
- `alarms` : le relevé des tâches.
- Accès à `omnilist.1handbiz.com` (et `localhost:3000` en développement) seulement.

Aucun accès aux sites de vente pour l'instant : l'extension ne lit ni ne modifie leurs pages.

## Compiler et essayer

```bash
npm run build -w @hub/extension
```

Dans Chrome : `chrome://extensions`, activer le mode développeur, puis « Charger l'extension non
empaquetée » et choisir le dossier `apps/extension/dist`.
