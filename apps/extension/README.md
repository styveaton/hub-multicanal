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

## Remplissage automatique (phase 2)

- **Poshmark** (version 0.2.0) : sur la page Poshmark de la tâche, le vendeur ouvre l'extension et
  clique sur « Remplir le formulaire ». L'extension met les photos (nouvelle annonce seulement), le
  titre, la description, l'état, la marque, le prix (en dollars entiers) et le SKU.
- Le vendeur garde : le recadrage des photos, la catégorie, la taille, la couleur, la suggestion de
  marque, le prix d'origine, puis « Next » et « List ». L'extension ne clique jamais sur ces boutons.
- Si la page montre un CAPTCHA, ou si le formulaire a changé, rien n'est rempli et l'extension
  propose de le signaler (le site passe en pause).
- Code : `src/sites/poshmark.ts`. Les repères de la page ont été relevés le 9 novembre 2026.
- Mercari, Facebook Marketplace et Grailed restent en copier-coller pour l'instant.

## Droits demandés

- `storage` : le jeton et la tâche en cours.
- `alarms` : le relevé des tâches.
- `activeTab` et `scripting` : remplir le formulaire de l'onglet affiché, seulement quand le vendeur
  clique sur « Remplir ». Aucun accès permanent aux sites de vente.
- Accès à `omnilist.1handbiz.com` (et `localhost:3000` en développement) seulement.

## Compiler et essayer

```bash
npm run build -w @hub/extension
```

Cette version (celle à publier) ne parle qu'à `omnilist.1handbiz.com`. Pour essayer avec le site local
(`localhost:3000`), compiler la version de développement :

```bash
npm run build:dev -w @hub/extension
```

Dans Chrome : `chrome://extensions`, activer le mode développeur, puis « Charger l'extension non
empaquetée » et choisir le dossier `apps/extension/dist`.
