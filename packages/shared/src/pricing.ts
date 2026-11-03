/**
 * US5 : prix par canal et aperçu indicatif des frais.
 * Partagé entre l'API (calcul de référence) et le front (aperçu en direct).
 * Tous les montants sont en centimes (entiers) pour éviter les erreurs d'arrondi.
 */

import type { Locale } from "./locale.js";

export const CHANNELS = ["EBAY", "AMAZON", "TIKTOK_SHOP"] as const;
export type Channel = (typeof CHANNELS)[number];

export const CHANNEL_LABEL: Record<Channel, string> = {
  EBAY: "eBay",
  AMAZON: "Amazon",
  TIKTOK_SHOP: "TikTok Shop",
};

/** Longueur maximale du titre accepté par chaque canal. */
export const CHANNEL_TITLE_MAX: Record<Channel, number> = {
  EBAY: 80,
  AMAZON: 200,
  TIKTOK_SHOP: 255,
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
}

/**
 * Taux INDICATIFS, à ajuster selon votre contrat et vos catégories.
 * Ils servent uniquement à l'aperçu ; les frais réels sont fixés par chaque canal.
 */
export const INDICATIVE_FEES: Record<Channel, FeeRate> = {
  EBAY: { percentBps: 1325, fixedCents: 40 },
  AMAZON: { percentBps: 1500, fixedCents: 0 },
  TIKTOK_SHOP: { percentBps: 800, fixedCents: 0 },
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
};

export interface FeePreview {
  priceCents: number;
  feeCents: number;
  netCents: number;
}

/** Aperçu indicatif : frais estimés et montant net pour une vente au prix donné. */
export function feePreview(priceCents: number, channel: Channel, rates: Record<Channel, FeeRate> = INDICATIVE_FEES): FeePreview {
  const rate = rates[channel];
  const feeCents = Math.round((priceCents * rate.percentBps) / 10000) + rate.fixedCents;
  return { priceCents, feeCents, netCents: priceCents - feeCents };
}

/** Formate un montant en centimes, ex. 1999 → « 19,99 $US » (fr-FR) ou « $19.99 » (en-US). */
export function formatMoney(cents: number, currency: string = DEFAULT_CURRENCY, locale = "fr-FR"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(cents / 100);
}
