# Charte OmniList

Planche de référence : [brand/charte-omnilist.jpg](brand/charte-omnilist.jpg).

- **Nom du produit** : OmniList (le projet s'appelle « Hub Multi-canal E-commerce » dans ClickUp)
- **Slogan** : *List once. Sync everywhere.* (gardé en anglais, comme dans le logo)
- **Accroche FR** : « Publiez une fois. Vendez partout. »
- **Mots-clés** : Centralisé · Synchronisé · Évolutif · Intelligent

## Couleurs

| Nom | Hex | Usage | Variable CSS |
| --- | --- | --- | --- |
| Navy | `#0B1F44` | Texte principal, barre d'app, confiance | `--navy` |
| Electric Blue | `#2563FF` | Actions (boutons, liens), « List » du logo | `--blue` |
| Teal | `#14B8A6` | Synchronisation, succès, croissance | `--teal` |
| Accent Purple | `#8B5CF6` | Innovation, fonctions « intelligentes » (IA) | `--purple` |
| Light Gray | `#F3F6FB` | Fond des pages | `--surface` |

Toutes les variables sont définies dans [apps/web/app/globals.css](../apps/web/app/globals.css). Ne pas écrire de couleur en dur dans les composants.

## Typographie

- **Inter** (chargée par `next/font`), repli Manrope puis police système.
- Titres : graisse 800, interlettrage serré (-0.02 à -0.035em).
- Texte courant : graisse 400, couleur navy ; texte secondaire `--text-muted`.

## Logo

- Composants : `Logo` (icône + mot « OmniList ») et `LogoIcon` dans [apps/web/app/components/Logo.tsx](../apps/web/app/components/Logo.tsx).
- `variant="inverse"` sur fond navy (barre d'app, panneau des écrans de connexion).
- Mot-symbole : « Omni » en navy (blanc sur fond navy), « List » en bleu.
- Favicon / icône d'app : [apps/web/app/icon.svg](../apps/web/app/icon.svg) (carré navy arrondi).

> Le logo est une **version vectorielle redessinée** d'après la planche. Dès que le fichier source (SVG ou PNG haute définition) est disponible, le remplacer dans `Logo.tsx` et `icon.svg`.

## Composants

| Classe | Rôle |
| --- | --- |
| `.btn`, `.btn--secondary`, `.btn--ghost` | Boutons (action principale en bleu) |
| `.input`, `.field`, `.field-hint` | Champs de formulaire |
| `.card`, `.card-header` | Blocs de contenu blancs |
| `.badge--owner`, `.badge--employee` | Rôles |
| `.alert--error`, `.alert--success` | Messages |
| `.keyword` | Mots-clés de marque |

## Emails

Gabarit commun dans [apps/api/src/lib/mailer.ts](../apps/api/src/lib/mailer.ts) (`brandedEmail`) : en-tête navy « OmniList », carte blanche, bouton bleu, slogan en pied de page.
