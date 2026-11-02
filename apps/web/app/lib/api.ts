import type { Channel, PriceRule } from "@hub/shared";

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

export const CONDITION_LABEL: Record<Condition, string> = {
  NEW: "Neuf",
  USED_LIKE_NEW: "Comme neuf",
  USED_GOOD: "Très bon état",
  USED_FAIR: "Bon état",
};

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
  feeNote: string;
  preview: Array<{ variantId: string | null; sku: string; basePriceCents: number; priceCents: number; feeCents: number; netCents: number }>;
  warnings: Array<{ code: string; message: string }>;
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

const MESSAGES: Record<string, string | ((d: Record<string, unknown>) => string)> = {
  email_taken: "Un compte existe déjà avec cet email.",
  invalid_credentials: "Email ou mot de passe incorrect.",
  validation_error: "Vérifiez les champs du formulaire.",
  already_member: "Cette personne fait déjà partie de l'équipe.",
  invalid_invitation: "Ce lien d'invitation n'est plus valable.",
  invitation_expired: "Ce lien d'invitation a expiré. Demandez une nouvelle invitation.",
  name_required: "Indiquez votre nom.",
  weak_password: "Le mot de passe doit faire au moins 8 caractères.",
  email_failed: "L'email n'a pas pu être envoyé. Réessayez.",
  forbidden: "Vous n'avez pas les droits pour cette action.",
  unauthenticated: "Vous devez être connecté.",
  not_found: "Élément introuvable.",
  sku_taken: (d) => `Le SKU « ${String(d.sku)} » est déjà utilisé par un autre produit.`,
  invalid_photos: "Une des photos n'est plus disponible. Retirez-la et envoyez-la à nouveau.",
  photo_too_large: "Photo trop lourde (10 Mo maximum).",
  unsupported_photo_type: "Format non pris en charge : utilisez JPEG, PNG ou WebP.",
  fixed_price_single_only: "Le prix fixe n'est possible que pour un article unique. Utilisez un pourcentage.",
  title_too_long: (d) => `Titre trop long pour ce canal (${String(d.max)} caractères maximum).`,
};

function messageFor(code: string, data: Record<string, unknown>): string {
  // Pour une erreur de validation, on affiche le premier message précis renvoyé par l'API.
  if (code === "validation_error") {
    const first = (data.issues as Array<{ message?: string }> | undefined)?.[0]?.message;
    if (first && !first.startsWith("Expected") && !first.startsWith("Required")) return first;
  }
  const m = MESSAGES[code];
  if (typeof m === "function") return m(data);
  return m ?? "Une erreur est survenue.";
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
