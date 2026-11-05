import type { Channel } from "./pricing.js";

/**
 * Sites sans API publique, reliés par l'extension « OmniList Assistant » (docs/PLAN-EXTENSION.md).
 * L'extension prépare le formulaire du site ; le vendeur clique lui-même sur le bouton final.
 * Vinted n'en fait pas partie : il sanctionne déjà les outils tiers.
 */
export const ASSISTED_CHANNELS = ["POSHMARK", "MERCARI", "FACEBOOK_MARKETPLACE", "GRAILED"] as const satisfies readonly Channel[];
export type AssistedChannel = (typeof ASSISTED_CHANNELS)[number];

export const isAssistedChannel = (c: string): c is AssistedChannel => (ASSISTED_CHANNELS as readonly string[]).includes(c);

export interface AssistedSite {
  /** Domaines où l'extension a le droit d'agir (et rien d'autre). */
  hosts: string[];
  /** Page de création d'annonce, ouverte par l'extension pour une tâche « publier ». */
  newListingUrl: string;
  /** Plafond par défaut de publications par jour : prudent, réglable à la baisse seulement. */
  defaultDailyCap: number;
}

export const ASSISTED_SITES: Record<AssistedChannel, AssistedSite> = {
  POSHMARK: { hosts: ["poshmark.com"], newListingUrl: "https://poshmark.com/create-listing", defaultDailyCap: 20 },
  MERCARI: { hosts: ["mercari.com"], newListingUrl: "https://www.mercari.com/sell/", defaultDailyCap: 20 },
  // Le plus strict : plafond plus bas.
  FACEBOOK_MARKETPLACE: { hosts: ["facebook.com"], newListingUrl: "https://www.facebook.com/marketplace/create/item", defaultDailyCap: 10 },
  GRAILED: { hosts: ["grailed.com"], newListingUrl: "https://www.grailed.com/sell/new", defaultDailyCap: 20 },
};

/** Version du texte d'accord : l'augmenter demande un nouvel accord à chaque vendeur. */
export const ASSISTED_CONSENT_VERSION = 1;

/**
 * Raisons de mise en pause d'un site pour un vendeur.
 * - captcha, identity_check, site_warning, account_restricted : le site a montré une alerte ;
 * - too_many_failures : plusieurs échecs de suite ;
 * - manual : le vendeur a mis en pause.
 */
export const ASSISTED_ALERT_CODES = ["captcha", "identity_check", "site_warning", "account_restricted"] as const;
export type AssistedAlertCode = (typeof ASSISTED_ALERT_CODES)[number];
export const isAssistedAlert = (code: string): code is AssistedAlertCode => (ASSISTED_ALERT_CODES as readonly string[]).includes(code);

/** Échecs de suite (hors alertes) qui mettent le site en pause pour le vendeur. */
export const ASSISTED_FAILURE_STREAK = 5;

/** Une tâche ouverte dans le navigateur et jamais terminée revient dans la file au bout de ce délai. */
export const ASSISTED_CLAIM_TIMEOUT_MS = 30 * 60 * 1000;
