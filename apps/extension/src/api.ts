/**
 * Accès à l'API OmniList avec le jeton du navigateur (docs/PLAN-EXTENSION.md).
 * Le jeton et l'adresse du site sont gardés dans chrome.storage.local, jamais ailleurs.
 */

/** Sites OmniList autorisés : la production, et le site local pour le développement. */
export const OMNILIST_ORIGINS = ["https://omnilist.1handbiz.com", "http://localhost:3000"] as const;
export const DEFAULT_ORIGIN = OMNILIST_ORIGINS[0];

/** Site connu ET autorisé par le manifeste (la version publiée n'autorise pas localhost). */
export const isOmnilistOrigin = (origin: string) =>
  (OMNILIST_ORIGINS as readonly string[]).includes(origin) &&
  ((chrome.runtime.getManifest().host_permissions ?? []) as string[]).some((p: string) => p.startsWith(`${origin}/`));

export interface Pairing {
  origin: string;
  token: string;
}

export type TaskType = "LIST" | "UPDATE" | "DELIST";

export interface TaskSummary {
  id: string;
  channel: string;
  type: TaskType;
  sku: string;
  title: string;
  status: "QUEUED" | "CLAIMED";
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

export interface TaskPayload {
  id: string;
  type: TaskType;
  channel: string;
  sku: string;
  openUrl: string | null;
  listingUrl: string | null;
  externalId: string | null;
  product: {
    title: string;
    description: string;
    brand: string | null;
    condition: string;
    priceCents: number;
    currency: string;
    quantity: number;
    attributes: Record<string, string>;
    photos: string[];
  } | null;
}

export interface SiteConfig {
  channel: string;
  hosts: string[];
  enabled: boolean;
  selectorsVersion: number;
  consented: boolean;
  paused: boolean;
  pauseReason: string | null;
  dailyCap: number;
  usedLast24h: number;
}

export interface ExtensionConfig {
  device: { id: string; name: string };
  sites: SiteConfig[];
}

/** Erreur renvoyée par OmniList : code (ex. « daily_cap_reached ») et statut HTTP. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

const KEY = "pairing";

export async function getPairing(): Promise<Pairing | null> {
  const stored = (await chrome.storage.local.get(KEY))[KEY] as Pairing | undefined;
  return stored && isOmnilistOrigin(stored.origin) && stored.token.startsWith("omx_") ? stored : null;
}

export const savePairing = (pairing: Pairing) => chrome.storage.local.set({ [KEY]: pairing });
export const clearPairing = () => chrome.storage.local.remove(KEY);

/** Appel à l'API (via le relais /api du site). Jeton révoqué : la liaison est effacée. */
export async function call<T>(path: string, init: { method?: string; body?: unknown } = {}, pairing?: Pairing | null): Promise<T> {
  const p = pairing ?? (await getPairing());
  if (!p) throw new ApiError(401, "not_paired");
  const res = await fetch(`${p.origin}/api/extension${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${p.token}`,
      "x-extension-version": chrome.runtime.getManifest().version,
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    if (res.status === 401 && !pairing) await clearPairing();
    throw new ApiError(res.status, typeof data.error === "string" ? data.error : "network_error");
  }
  return data as T;
}

export const api = {
  config: () => call<ExtensionConfig>("/config"),
  tasks: () => call<{ items: TaskSummary[] }>("/tasks"),
  claim: (id: string) => call<TaskPayload>(`/tasks/${id}/claim`, { method: "POST" }),
  complete: (id: string, body: { listingUrl?: string | null; externalId?: string | null }) =>
    call<{ status: string }>(`/tasks/${id}/complete`, { method: "POST", body }),
  fail: (id: string, body: { code: string; message?: string | null }) =>
    call<{ paused: boolean; final: boolean }>(`/tasks/${id}/fail`, { method: "POST", body }),
  release: (id: string) => call<{ status: string }>(`/tasks/${id}/release`, { method: "POST" }),
};

/** Vérifie un jeton avant de l'enregistrer. */
export async function pair(pairing: Pairing) {
  const config = await call<ExtensionConfig>("/config", {}, pairing);
  await savePairing(pairing);
  return config;
}

/** Messages entre la page OmniList, le service worker et la fenêtre de l'extension. */
export type ExtensionMessage =
  | { type: "pair"; token: string; origin: string }
  | { type: "refresh" };
