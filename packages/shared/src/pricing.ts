/**
 * US5 : prix par canal et aperçu indicatif des frais.
 * Partagé entre l'API (calcul de référence) et le front (aperçu en direct).
 * Tous les montants sont en centimes (entiers) pour éviter les erreurs d'arrondi.
 */

import type { Locale } from "./locale.js";

/** Places de marché les plus utilisées aux États-Unis, dans l'ordre des onglets. */
export const CHANNELS = [
  "EBAY",
  "AMAZON",
  "TIKTOK_SHOP",
  "WALMART",
  "ETSY",
  "SHOPIFY",
  "FACEBOOK_MARKETPLACE",
  "MERCARI",
  "POSHMARK",
  "DEPOP",
  "VINTED",
  "GRAILED",
] as const;
export type Channel = (typeof CHANNELS)[number];

export const CHANNEL_LABEL: Record<Channel, string> = {
  EBAY: "eBay",
  AMAZON: "Amazon",
  TIKTOK_SHOP: "TikTok Shop",
  WALMART: "Walmart",
  ETSY: "Etsy",
  SHOPIFY: "Shopify",
  FACEBOOK_MARKETPLACE: "Facebook Marketplace",
  MERCARI: "Mercari",
  POSHMARK: "Poshmark",
  DEPOP: "Depop",
  VINTED: "Vinted",
  GRAILED: "Grailed",
};

/** Longueur maximale du titre accepté par chaque canal. */
export const CHANNEL_TITLE_MAX: Record<Channel, number> = {
  EBAY: 80,
  AMAZON: 200,
  TIKTOK_SHOP: 255,
  WALMART: 75,
  ETSY: 140,
  SHOPIFY: 255,
  FACEBOOK_MARKETPLACE: 100,
  MERCARI: 80,
  POSHMARK: 80,
  DEPOP: 80,
  VINTED: 100,
  GRAILED: 60,
};

/**
 * Comment le canal sera relié :
 * - "api" : API officielle pour les vendeurs (compte développeur à créer) ;
 * - "assisted" : pas d'API publique, la publication passera par l'extension de navigateur.
 */
export type ChannelIntegration = "api" | "assisted";
export const CHANNEL_INTEGRATION: Record<Channel, ChannelIntegration> = {
  EBAY: "api",
  AMAZON: "api",
  TIKTOK_SHOP: "api",
  WALMART: "api",
  ETSY: "api",
  SHOPIFY: "api",
  FACEBOOK_MARKETPLACE: "assisted",
  MERCARI: "assisted",
  POSHMARK: "assisted",
  // Selling API officielle, accès sur demande auprès de Depop.
  DEPOP: "api",
  VINTED: "assisted",
  GRAILED: "assisted",
};

/** Canaux activés d'office sur une nouvelle fiche ; les autres s'activent dans leur onglet. */
export const CHANNEL_DEFAULT_ENABLED: Record<Channel, boolean> = {
  EBAY: true,
  AMAZON: true,
  TIKTOK_SHOP: true,
  WALMART: false,
  ETSY: false,
  SHOPIFY: false,
  FACEBOOK_MARKETPLACE: false,
  MERCARI: false,
  POSHMARK: false,
  DEPOP: false,
  VINTED: false,
  GRAILED: false,
};

export const DEFAULT_CURRENCY = "USD";

export type PriceRule =
  | { mode: "BASE" }
  | { mode: "FIXED"; priceCents: number }
  | { mode: "PERCENT"; percentBps: number }; // 1050 = +10,5 %, -500 = -5 %

/** Bornes du réglage en pourcentage : de -90 % à +300 %. */
export const PERCENT_BPS_MIN = -9000;
export const PERCENT_BPS_MAX = 30000;

/** Prix sur le canal à partir du prix maître. */
export function applyPriceRule(baseCents: number, rule: PriceRule): number {
  switch (rule.mode) {
    case "BASE":
      return baseCents;
    case "FIXED":
      return rule.priceCents;
    case "PERCENT":
      return Math.max(1, Math.round((baseCents * (10000 + rule.percentBps)) / 10000));
  }
}

export interface FeeRate {
  /** Commission en centièmes de % (1325 = 13,25 %). */
  percentBps: number;
  /** Frais fixes par commande, en centimes. */
  fixedCents: number;
  /** Frais minimum par commande, en centimes (ex. Facebook Marketplace). */
  minFeeCents?: number;
  /** Forfait sous un certain prix (ex. Poshmark : 2,95 $ sous 15 $). */
  flatBelow?: { priceCents: number; feeCents: number };
}

/**
 * Taux INDICATIFS, à ajuster selon votre contrat et vos catégories.
 * Ils servent uniquement à l'aperçu ; les frais réels sont fixés par chaque canal.
 */
export const INDICATIVE_FEES: Record<Channel, FeeRate> = {
  EBAY: { percentBps: 1325, fixedCents: 40 },
  AMAZON: { percentBps: 1500, fixedCents: 0 },
  TIKTOK_SHOP: { percentBps: 800, fixedCents: 0 },
  WALMART: { percentBps: 1500, fixedCents: 0 },
  ETSY: { percentBps: 950, fixedCents: 45 },
  SHOPIFY: { percentBps: 290, fixedCents: 30 },
  FACEBOOK_MARKETPLACE: { percentBps: 1000, fixedCents: 0, minFeeCents: 80 },
  MERCARI: { percentBps: 1000, fixedCents: 0 },
  POSHMARK: { percentBps: 2000, fixedCents: 0, flatBelow: { priceCents: 1500, feeCents: 295 } },
  DEPOP: { percentBps: 330, fixedCents: 45 },
  VINTED: { percentBps: 0, fixedCents: 0 },
  GRAILED: { percentBps: 1249, fixedCents: 49 },
};

/** Explication des taux, affichée à côté de l'aperçu. */
export const FEE_NOTES: Record<Channel, Record<Locale, string>> = {
  EBAY: {
    fr: "Frais de vente finale ~13,25 % + 0,40 $ par commande (la plupart des catégories, États-Unis).",
    en: "Final value fee ~13.25% + $0.40 per order (most categories, United States).",
  },
  AMAZON: {
    fr: "Commission de parrainage ~15 % (varie de 8 à 17 % selon la catégorie), hors abonnement vendeur.",
    en: "Referral fee ~15% (8 to 17% depending on the category), excluding the seller subscription.",
  },
  TIKTOK_SHOP: {
    fr: "Commission ~8 % par commande (États-Unis), hors frais de paiement éventuels.",
    en: "Commission ~8% per order (United States), excluding any payment processing fees.",
  },
  WALMART: {
    fr: "Commission ~15 % (de 6 à 15 % selon la catégorie), sans abonnement ni frais de mise en vente.",
    en: "Referral fee ~15% (6 to 15% depending on the category), no subscription or listing fee.",
  },
  ETSY: {
    fr: "Commission 6,5 % + paiement 3 % + 0,25 $, plus 0,20 $ de mise en vente (États-Unis).",
    en: "Transaction fee 6.5% + payment processing 3% + $0.25, plus a $0.20 listing fee (United States).",
  },
  SHOPIFY: {
    fr: "Aucune commission : frais de paiement Shopify Payments ~2,9 % + 0,30 $, hors abonnement mensuel.",
    en: "No commission: Shopify Payments processing ~2.9% + $0.30, excluding the monthly plan.",
  },
  FACEBOOK_MARKETPLACE: {
    fr: "Commandes expédiées : ~10 % (0,80 $ minimum). Remise en main propre : gratuit.",
    en: "Shipped orders: ~10% ($0.80 minimum). Local pickup: free.",
  },
  MERCARI: {
    fr: "Frais de vente ~10 % du prix de l'article, sans frais de paiement en plus.",
    en: "Selling fee ~10% of the item price, with no extra payment processing fee.",
  },
  POSHMARK: {
    fr: "Forfait 2,95 $ sous 15 $, puis 20 % ; l'étiquette d'expédition est incluse.",
    en: "Flat $2.95 under $15, then 20%; the shipping label is included.",
  },
  DEPOP: {
    fr: "Aucuns frais de vente aux États-Unis : seulement le paiement ~3,3 % + 0,45 $ (hors mise en avant).",
    en: "No selling fee in the United States: only payment processing ~3.3% + $0.45 (excluding boosting).",
  },
  VINTED: {
    fr: "Aucuns frais pour le vendeur : c'est l'acheteur qui paie la protection.",
    en: "No seller fees: the buyer pays the protection fee.",
  },
  GRAILED: {
    fr: "Commission 9 % (6 % sous 120 $) + paiement ~3,49 % + 0,49 $.",
    en: "Commission 9% (6% under $120) + payment processing ~3.49% + $0.49.",
  },
};

export interface FeePreview {
  priceCents: number;
  feeCents: number;
  netCents: number;
}

/** Aperçu indicatif : frais estimés et montant net pour une vente au prix donné. */
export function feePreview(
  priceCents: number,
  channel: Channel,
  rates: Partial<Record<Channel, FeeRate>> = INDICATIVE_FEES,
): FeePreview {
  const rate = rates[channel] ?? INDICATIVE_FEES[channel];
  let feeCents =
    rate.flatBelow && priceCents < rate.flatBelow.priceCents
      ? rate.flatBelow.feeCents
      : Math.round((priceCents * rate.percentBps) / 10000) + rate.fixedCents;
  if (rate.minFeeCents != null) feeCents = Math.max(feeCents, rate.minFeeCents);
  // Les frais ne dépassent jamais le prix de vente.
  feeCents = Math.min(feeCents, priceCents);
  return { priceCents, feeCents, netCents: priceCents - feeCents };
}

/** Formate un montant en centimes, ex. 1999 → « 19,99 $US » (fr-FR) ou « $19.99 » (en-US). */
export function formatMoney(cents: number, currency: string = DEFAULT_CURRENCY, locale = "fr-FR"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / 100);
}
