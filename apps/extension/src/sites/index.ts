import { fillPoshmark } from "./poshmark.js";
import type { FillData, FillResult } from "./types.js";

export type { FillData, FillField, FillPhoto, FillResult } from "./types.js";

/**
 * Remplissage automatique par site (phase 2). Un site absent d'ici reste en copier-coller.
 * `currency` : devise des prix du site ; un produit dans une autre devise garde son prix à saisir.
 */
export const FILLERS: Partial<Record<string, { fill: (data: FillData) => Promise<FillResult>; currency: string }>> = {
  POSHMARK: { fill: fillPoshmark, currency: "USD" },
};
