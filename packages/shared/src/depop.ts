/**
 * Règles Depop partagées par l'API (contrôles), le worker (envoi) et le front (formulaire).
 * Référence : https://partnerapi.depop.com/api-docs/ (Selling API).
 */
import { DEPOP_TAXONOMY } from "./depop-taxonomy.js";

export { DEPOP_TAXONOMY };

export const DEPOP_DESCRIPTION_MAX = 1000;
export const DEPOP_MAX_HASHTAGS = 5;
export const DEPOP_MAX_PICTURES = 8;
export const DEPOP_MIN_PRICE_CENTS = 100;
export const DEPOP_SKU_MAX = 50;

export const DEPOP_DEPARTMENTS = [
  { id: "womenswear", en: "Women", fr: "Femme" },
  { id: "menswear", en: "Men", fr: "Homme" },
  { id: "kidswear", en: "Kids", fr: "Enfants" },
  { id: "everything-else", en: "Everything else", fr: "Tout le reste" },
] as const;
export type DepopDepartment = (typeof DEPOP_DEPARTMENTS)[number]["id"];

/** Champs Depop enregistrés sur la fiche (ProductChannel.details). */
export interface DepopDetails {
  department?: DepopDepartment;
  productType?: string;
  /** Taille choisie pour un article unique (les variantes la déduisent de leur option Taille). */
  sizeId?: number;
  /** Frais de port aux États-Unis, en centimes (0 = livraison offerte). */
  shippingCents?: number;
}

export interface DepopProductType {
  id: string;
  en: string;
  fr: string;
  group: { id: string; en: string; fr: string };
}

/** Types de produit disponibles pour un rayon, groupés comme dans l'app Depop. */
export function depopProductTypes(department: string): DepopProductType[] {
  return DEPOP_TAXONOMY.groups.flatMap((g) =>
    g.types
      .filter(([, , , departments]) => departments.includes(department))
      .map(([id, en, fr]) => ({ id, en, fr, group: { id: g.id, en: g.en, fr: g.fr } })),
  );
}

export function isDepopProductType(department: string, productType: string): boolean {
  return depopProductTypes(department).some((t) => t.id === productType);
}

/** Grille de tailles US pour ce rayon et ce type, ou undefined si Depop n'en demande pas. */
export function depopSizeSetId(department: string, productType: string): number | undefined {
  return DEPOP_TAXONOMY.sizeMap[`${department}/${productType}`];
}

export function depopSizes(sizeSetId: number): Array<{ id: number; name: string }> {
  return (DEPOP_TAXONOMY.sizeSets[String(sizeSetId)] ?? []).map(([id, name]) => ({ id, name }));
}

const normalizeSize = (s: string) =>
  s
    .toLowerCase()
    .replace(/^us\s*/, "")
    .replace(/["”]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** Retrouve la taille Depop d'après le texte d'une variante (ex. « M », « US 9 », « 32" »). */
export function matchDepopSize(sizeSetId: number, value: string): number | undefined {
  const wanted = normalizeSize(value);
  return depopSizes(sizeSetId).find((s) => normalizeSize(s.name) === wanted)?.id;
}

/** Noms d'option qui portent la taille d'une variante. */
const SIZE_OPTION_NAMES = ["taille", "size", "pointure", "shoe size"];
export function variantSizeValue(attributes: Record<string, string>): string | undefined {
  const key = Object.keys(attributes).find((k) => SIZE_OPTION_NAMES.includes(k.trim().toLowerCase()));
  return key ? attributes[key] : undefined;
}

export type ProductConditionCode = "NEW" | "USED_LIKE_NEW" | "USED_GOOD" | "USED_FAIR";
/** Neuf, Comme neuf, Très bon état, Bon état → états Depop. */
export const DEPOP_CONDITION: Record<ProductConditionCode, string> = {
  NEW: "brand_new",
  USED_LIKE_NEW: "used_like_new",
  USED_GOOD: "used_excellent",
  USED_FAIR: "used_good",
};

/** Depop n'a pas de titre : le titre ouvre la description, le tout limité à 1000 caractères. */
export function depopDescription(title: string, description: string): string {
  const text = `${title.trim()}\n\n${description.trim()}`;
  return text.length <= DEPOP_DESCRIPTION_MAX ? text : `${text.slice(0, DEPOP_DESCRIPTION_MAX - 1).trimEnd()}…`;
}

export const countHashtags = (text: string) => (text.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length;
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;

export type DepopIssueCode =
  | "department_missing"
  | "product_type_missing"
  | "size_missing"
  | "size_unmatched"
  | "brand_missing"
  | "shipping_missing"
  | "too_many_hashtags"
  | "email_in_description"
  | "price_too_low"
  // Réglage du compte connecté (page Canaux), pas de la fiche.
  | "ship_from_missing";

export interface DepopIssue {
  code: DepopIssueCode;
  /** SKU concerné, pour les contrôles par variante. */
  sku?: string;
}

export interface DepopCheckInput {
  mode: "SINGLE" | "VARIANTS";
  title: string;
  description: string;
  brand: string | null;
  details: DepopDetails;
  /** Articles vendables, avec le prix sur Depop (après la règle de prix du canal). */
  items: Array<{ sku: string; priceCents: number; attributes?: Record<string, string> }>;
}

/** Ce qui manque avant de pouvoir publier sur Depop. Liste vide = prêt. */
export function depopIssues(input: DepopCheckInput): DepopIssue[] {
  const issues: DepopIssue[] = [];
  const { department, productType, sizeId, shippingCents } = input.details;
  if (!department) issues.push({ code: "department_missing" });
  if (!productType || (department && !isDepopProductType(department, productType))) issues.push({ code: "product_type_missing" });
  const sizeSet = department && productType ? depopSizeSetId(department, productType) : undefined;
  if (sizeSet) {
    if (input.mode === "SINGLE") {
      if (!sizeId || !depopSizes(sizeSet).some((s) => s.id === sizeId)) issues.push({ code: "size_missing" });
    } else {
      for (const item of input.items) {
        const value = item.attributes ? variantSizeValue(item.attributes) : undefined;
        if (!value || !matchDepopSize(sizeSet, value)) issues.push({ code: "size_unmatched", sku: item.sku });
      }
    }
  }
  if (!input.brand?.trim()) issues.push({ code: "brand_missing" });
  if (shippingCents == null) issues.push({ code: "shipping_missing" });
  const text = depopDescription(input.title, input.description);
  if (countHashtags(text) > DEPOP_MAX_HASHTAGS) issues.push({ code: "too_many_hashtags" });
  if (EMAIL.test(text)) issues.push({ code: "email_in_description" });
  for (const item of input.items) {
    if (item.priceCents < DEPOP_MIN_PRICE_CENTS) issues.push({ code: "price_too_low", sku: item.sku });
  }
  return issues;
}

/** Taille Depop d'un article (unique ou variante), une fois les contrôles passés. */
export function depopSizeFor(
  details: DepopDetails,
  item: { attributes?: Record<string, string> },
): { sizeSetId: number; sizeId: number } | undefined {
  if (!details.department || !details.productType) return undefined;
  const sizeSetId = depopSizeSetId(details.department, details.productType);
  if (!sizeSetId) return undefined;
  const value = item.attributes ? variantSizeValue(item.attributes) : undefined;
  const sizeId = value ? matchDepopSize(sizeSetId, value) : details.sizeId;
  return sizeId ? { sizeSetId, sizeId } : undefined;
}

/** États américains (adresse d'expédition demandée par Depop). */
export const US_STATES: ReadonlyArray<readonly [string, string]> = [
  ["AL", "Alabama"], ["AK", "Alaska"], ["AZ", "Arizona"], ["AR", "Arkansas"], ["CA", "California"],
  ["CO", "Colorado"], ["CT", "Connecticut"], ["DE", "Delaware"], ["DC", "District of Columbia"], ["FL", "Florida"],
  ["GA", "Georgia"], ["HI", "Hawaii"], ["ID", "Idaho"], ["IL", "Illinois"], ["IN", "Indiana"],
  ["IA", "Iowa"], ["KS", "Kansas"], ["KY", "Kentucky"], ["LA", "Louisiana"], ["ME", "Maine"],
  ["MD", "Maryland"], ["MA", "Massachusetts"], ["MI", "Michigan"], ["MN", "Minnesota"], ["MS", "Mississippi"],
  ["MO", "Missouri"], ["MT", "Montana"], ["NE", "Nebraska"], ["NV", "Nevada"], ["NH", "New Hampshire"],
  ["NJ", "New Jersey"], ["NM", "New Mexico"], ["NY", "New York"], ["NC", "North Carolina"], ["ND", "North Dakota"],
  ["OH", "Ohio"], ["OK", "Oklahoma"], ["OR", "Oregon"], ["PA", "Pennsylvania"], ["RI", "Rhode Island"],
  ["SC", "South Carolina"], ["SD", "South Dakota"], ["TN", "Tennessee"], ["TX", "Texas"], ["UT", "Utah"],
  ["VT", "Vermont"], ["VA", "Virginia"], ["WA", "Washington"], ["WV", "West Virginia"], ["WI", "Wisconsin"],
  ["WY", "Wyoming"],
];
export const isUsState = (code: string) => US_STATES.some(([c]) => c === code);
