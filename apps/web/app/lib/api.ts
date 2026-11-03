import type { Channel, ChannelIntegration, DepopDetails, DepopIssue, PriceRule } from "@hub/shared";
import fr from "../i18n/fr";
import type { Messages } from "../i18n";

export interface Me {
  user: { id: string; email: string; name: string | null };
  organization: { id: string; name: string };
  role: "OWNER" | "EMPLOYEE";
  permissions: string[];
}

export interface Invitation {
  id: string;
  email: string;
  role: "OWNER" | "EMPLOYEE";
  status: string;
  expiresAt: string;
}

export type Condition = "NEW" | "USED_LIKE_NEW" | "USED_GOOD" | "USED_FAIR";

export interface Photo {
  id: string;
  url: string;
}

export interface Variant {
  id?: string;
  sku: string;
  attributes: Record<string, string>;
  priceCents: number;
  quantity: number;
}

export interface ChannelSettings {
  channel: Channel;
  label: string;
  enabled: boolean;
  title: string | null;
  effectiveTitle: string;
  titleMax: number;
  category: string | null;
  price: PriceRule;
  preview: Array<{ variantId: string | null; sku: string; basePriceCents: number; priceCents: number; feeCents: number; netCents: number }>;
  warnings: ChannelWarning[];
  /** Champs propres au canal (Depop : rayon, type, taille, port). */
  details: DepopDetails | null;
  /** Publication réelle possible (Depop pour l'instant). */
  publishable: boolean;
  listings: Listing[];
}

export type ChannelWarning = { code: "title_too_long"; length: number; max: number } | { code: "category_missing" } | DepopIssue;

export type ListingStatus = "PENDING" | "LISTED" | "ERROR" | "REMOVED";

export interface Listing {
  sku: string;
  status: ListingStatus;
  externalUrl: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  updatedAt: string;
}

/** Ligne de la page Canaux. */
export interface ChannelOverview {
  channel: Channel;
  label: string;
  integration: ChannelIntegration;
  supported: boolean;
  available: boolean;
  testMode: boolean;
  listedCount: number;
  connection: {
    status: "CONNECTED" | "NEEDS_REAUTH";
    username: string | null;
    connectedAt: string;
    settings: { shipFromState?: string };
  } | null;
}

export interface ProductDetail {
  id: string;
  title: string;
  description: string;
  brand: string | null;
  condition: Condition;
  mode: "SINGLE" | "VARIANTS";
  currency: string;
  sku: string | null;
  priceCents: number | null;
  quantity: number;
  priceRange: { minCents: number; maxCents: number };
  photos: Photo[];
  variants: Variant[];
  channels: ChannelSettings[];
  updatedAt: string;
}

export interface ProductListItem {
  id: string;
  title: string;
  mode: "SINGLE" | "VARIANTS";
  currency: string;
  sku: string | null;
  variantCount: number;
  quantity: number;
  priceRange: { minCents: number; maxCents: number };
  photoUrl: string | null;
  channels: Channel[];
  warningCount: number;
  updatedAt: string;
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; code: string; message: string; details: Record<string, unknown> };

// Textes de la langue courante, fournis par I18nProvider (français par défaut avant le premier rendu).
let messages: Messages = fr;
export function setApiMessages(next: Messages) {
  messages = next;
}

function messageFor(code: string, data: Record<string, unknown>): string {
  const { errors, validation } = messages;
  // Erreur de validation : on traduit le premier code précis renvoyé par l'API, sinon message générique.
  if (code === "validation_error") {
    const first = (data.issues as Array<{ message?: string }> | undefined)?.[0]?.message;
    if (first && first in validation) return validation[first as keyof typeof validation];
  }
  if (code === "sku_taken") return errors.sku_taken(String(data.sku));
  if (code === "title_too_long") return errors.title_too_long(Number(data.max));
  const m = errors[code as keyof typeof errors];
  return typeof m === "string" ? m : errors.generic;
}

/** Appelle l'API via le proxy /api (cookie de session inclus). */
export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<ApiResult<T>> {
  const isForm = typeof FormData !== "undefined" && init?.body instanceof FormData;
  const res = await fetch(`/api${path}`, {
    method: init?.method ?? "GET",
    headers: init?.body !== undefined && !isForm ? { "content-type": "application/json" } : undefined,
    body: init?.body === undefined ? undefined : isForm ? (init.body as FormData) : JSON.stringify(init.body),
    credentials: "same-origin",
  });
  if (res.status === 204) return { ok: true, data: undefined as T };
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) return { ok: true, data: data as T };
  const code = typeof data.error === "string" ? data.error : "";
  return { ok: false, status: res.status, code, message: messageFor(code, data), details: data };
}

/** « 19,99 » ou « 19.99 » → 1999 centimes ; null si invalide. */
export function parseMoney(value: string): number | null {
  const normalized = value.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  const cents = Math.round(Number(normalized) * 100);
  return cents > 0 ? cents : null;
}

/** 1999 → « 19.99 » pour pré-remplir un champ. */
export const centsToInput = (cents: number | null | undefined) => (cents == null ? "" : (cents / 100).toFixed(2));
