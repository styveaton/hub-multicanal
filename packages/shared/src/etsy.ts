/**
 * Règles Etsy partagées par l'API (contrôles), le worker (envoi) et le front (formulaire).
 * Référence : https://developers.etsy.com/documentation/reference (Open API v3, createDraftListing).
 */

/** Qui a fabriqué l'objet (champ obligatoire d'Etsy). */
export const ETSY_WHO_MADE = [
  { id: "i_did", fr: "Moi", en: "I did" },
  { id: "collective", fr: "Un membre de ma boutique", en: "A member of my shop" },
  { id: "someone_else", fr: "Une autre entreprise ou personne", en: "Another company or person" },
] as const;
export type EtsyWhoMade = (typeof ETSY_WHO_MADE)[number]["id"];

/** Quand l'objet a été fabriqué (champ obligatoire). Avant 2007 = vintage pour Etsy. */
export const ETSY_WHEN_MADE = [
  { id: "made_to_order", fr: "Fabriqué à la commande", en: "Made to order" },
  { id: "2020_2026", fr: "2020 – 2026", en: "2020 – 2026" },
  { id: "2010_2019", fr: "2010 – 2019", en: "2010 – 2019" },
  { id: "2007_2009", fr: "2007 – 2009", en: "2007 – 2009" },
  { id: "2000_2006", fr: "2000 – 2006 (vintage)", en: "2000 – 2006 (vintage)" },
  { id: "1990s", fr: "Années 1990 (vintage)", en: "1990s (vintage)" },
  { id: "1980s", fr: "Années 1980 (vintage)", en: "1980s (vintage)" },
  { id: "1970s", fr: "Années 1970 (vintage)", en: "1970s (vintage)" },
  { id: "1960s", fr: "Années 1960 (vintage)", en: "1960s (vintage)" },
  { id: "1950s", fr: "Années 1950 (vintage)", en: "1950s (vintage)" },
  { id: "1940s", fr: "Années 1940 (vintage)", en: "1940s (vintage)" },
  { id: "1930s", fr: "Années 1930 (vintage)", en: "1930s (vintage)" },
  { id: "1920s", fr: "Années 1920 (vintage)", en: "1920s (vintage)" },
  { id: "1910s", fr: "Années 1910 (vintage)", en: "1910s (vintage)" },
  { id: "1900s", fr: "Années 1900 (vintage)", en: "1900s (vintage)" },
  { id: "1800s", fr: "XIXe siècle (vintage)", en: "1800s (vintage)" },
  { id: "1700s", fr: "XVIIIe siècle (vintage)", en: "1700s (vintage)" },
  { id: "before_1700", fr: "Avant 1700 (vintage)", en: "Before 1700 (vintage)" },
] as const;
export type EtsyWhenMade = (typeof ETSY_WHEN_MADE)[number]["id"];

/** Prix minimum accepté par Etsy. */
export const ETSY_MIN_PRICE_CENTS = 20;
/** Etsy accepte au plus 3 options de variation personnalisées. */
export const ETSY_MAX_OPTIONS = 3;
export const ETSY_MAX_IMAGES = 10;

/** Champs Etsy enregistrés sur la fiche (ProductChannel.details). */
export interface EtsyDetails {
  whoMade?: EtsyWhoMade;
  whenMade?: EtsyWhenMade;
}

export type EtsyIssue =
  | { code: "etsy_who_made_missing" }
  | { code: "etsy_when_made_missing" }
  | { code: "etsy_too_many_options"; max: number }
  | { code: "price_too_low"; sku?: string };

/** Ce qui empêche la publication sur Etsy (codes seulement : le front traduit). */
export function etsyIssues(input: {
  details: EtsyDetails;
  items: Array<{ sku: string; priceCents: number; attributes?: Record<string, string> }>;
}): EtsyIssue[] {
  const issues: EtsyIssue[] = [];
  if (!input.details.whoMade) issues.push({ code: "etsy_who_made_missing" });
  if (!input.details.whenMade) issues.push({ code: "etsy_when_made_missing" });
  const options = new Set(input.items.flatMap((i) => Object.keys(i.attributes ?? {})));
  if (options.size > ETSY_MAX_OPTIONS) issues.push({ code: "etsy_too_many_options", max: ETSY_MAX_OPTIONS });
  for (const item of input.items) {
    if (item.priceCents < ETSY_MIN_PRICE_CENTS) issues.push({ code: "price_too_low", sku: item.sku });
  }
  return issues;
}
