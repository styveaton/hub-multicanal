/**
 * Client de l'API REST WooCommerce v3 (https://woocommerce.github.io/woocommerce-rest-api-docs/).
 * Authentification par clés consommateur (ck_… / cs_…) en HTTPS (Basic).
 * `baseUrlFor` permet d'aiguiller vers le faux WooCommerce en local et dans les tests.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { ChannelApiError } from "../listing.js";

export interface WooStore {
  /** Adresse du site WordPress, ex. https://boutique.example.com */
  url: string;
  key: string;
  secret: string;
}

/** Adresse saisie → adresse canonique (https, sans / final), ou null. `allowHttp` : faux WooCommerce local. */
export function normalizeStoreUrl(input: string, allowHttp = false): string | null {
  let s = input.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && !allowHttp) return null;
    if (!u.hostname.includes(".") && u.hostname !== "localhost") return null;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

export interface WooImage {
  src: string;
}

export interface WooProductBody {
  name: string;
  type: "simple" | "variable";
  status: "publish" | "draft" | "private";
  description: string;
  sku?: string;
  regular_price?: string;
  manage_stock?: boolean;
  stock_quantity?: number;
  images?: WooImage[];
  tags?: Array<{ name: string }>;
  attributes?: Array<{ name: string; options: string[]; visible: boolean; variation: boolean }>;
}

export interface WooVariationBody {
  id?: number;
  sku: string;
  regular_price: string;
  manage_stock: boolean;
  stock_quantity: number;
  attributes: Array<{ name: string; option: string }>;
}

export interface WooProduct {
  id: number;
  sku: string;
  permalink: string;
  status: string;
  type: string;
}

export interface WooBatchResult {
  create?: Array<{ id: number; sku?: string; error?: { code: string; message: string } }>;
  update?: Array<{ id: number; sku?: string; error?: { code: string; message: string } }>;
  delete?: Array<{ id: number; error?: { code: string; message: string } }>;
}

export type WooOrderStatus = "pending" | "processing" | "on-hold" | "completed" | "cancelled" | "refunded" | "failed" | "trash" | "checkout-draft";

/** Commande WooCommerce (champs utilisés par OmniList), identique en webhook et en relevé. */
export interface WooOrder {
  id: number;
  number?: string;
  status: WooOrderStatus;
  currency: string;
  date_created_gmt: string;
  date_modified_gmt?: string;
  billing?: { first_name?: string; last_name?: string } | null;
  line_items: Array<{ sku?: string | null; name: string; quantity: number; price: number | string; product_id: number; variation_id?: number }>;
}

export interface WooClientOptions {
  /** Adresse réelle de l'API pour une boutique (par défaut l'adresse du site). */
  baseUrlFor?: (storeUrl: string) => string;
  fetch?: typeof fetch;
}

export class WooClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: WooClientOptions = {}) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /** Vérifie les clés et renvoie la devise de la boutique. */
  async getCurrency(store: WooStore): Promise<string> {
    const res = await this.call<{ code: string }>(store, "GET", "/data/currencies/current");
    return res.code;
  }

  async findProductBySku(store: WooStore, sku: string): Promise<WooProduct | null> {
    const list = await this.call<WooProduct[]>(store, "GET", `/products?sku=${encodeURIComponent(sku)}`);
    return list[0] ?? null;
  }

  createProduct(store: WooStore, body: WooProductBody): Promise<WooProduct> {
    return this.call(store, "POST", "/products", body);
  }

  updateProduct(store: WooStore, id: number, body: Partial<WooProductBody>): Promise<WooProduct> {
    return this.call(store, "PUT", `/products/${id}`, body);
  }

  /** Corbeille (récupérable dans WordPress). Idempotent : un produit introuvable n'est pas une erreur. */
  async deleteProduct(store: WooStore, id: number): Promise<void> {
    try {
      await this.call(store, "DELETE", `/products/${id}`);
    } catch (err) {
      if (!(err instanceof ChannelApiError && (err.status === 404 || err.status === 410))) throw err;
    }
  }

  async batchVariations(
    store: WooStore,
    productId: number,
    batch: { create?: WooVariationBody[]; update?: WooVariationBody[]; delete?: number[] },
  ): Promise<WooBatchResult> {
    const res = await this.call<WooBatchResult>(store, "POST", `/products/${productId}/variations/batch`, batch);
    const failed = [...(res.create ?? []), ...(res.update ?? [])].find((r) => r.error);
    if (failed?.error) throw new ChannelApiError(400, failed.error.code, failed.error.message, false);
    return res;
  }

  async listVariations(store: WooStore, productId: number): Promise<Array<{ id: number; sku: string }>> {
    return this.call(store, "GET", `/products/${productId}/variations?per_page=100`);
  }

  /** Commandes modifiées depuis `modifiedAfter` (heure UTC), par pages de 50. */
  async listOrders(store: WooStore, params: { modifiedAfter: Date; page?: number }): Promise<{ orders: WooOrder[]; totalPages: number }> {
    const q = new URLSearchParams({
      modified_after: params.modifiedAfter.toISOString().replace(/\.\d{3}Z$/, ""),
      dates_are_gmt: "true",
      per_page: "50",
      page: String(params.page ?? 1),
      orderby: "modified",
      order: "asc",
    });
    const res = await this.send(store, "GET", `/orders?${q}`);
    const orders = (await this.parse(res)) as WooOrder[];
    return { orders, totalPages: Number(res.headers.get("x-wp-totalpages") ?? 1) };
  }

  async createWebhook(store: WooStore, params: { name: string; topic: string; deliveryUrl: string; secret: string }): Promise<number> {
    const res = await this.call<{ id: number }>(store, "POST", "/webhooks", {
      name: params.name,
      topic: params.topic,
      delivery_url: params.deliveryUrl,
      secret: params.secret,
      status: "active",
    });
    return res.id;
  }

  async deleteWebhook(store: WooStore, id: number): Promise<void> {
    await this.call(store, "DELETE", `/webhooks/${id}?force=true`).catch(() => undefined);
  }

  private async call<T>(store: WooStore, method: string, path: string, body?: unknown): Promise<T> {
    return (await this.parse(await this.send(store, method, path, body))) as T;
  }

  private async send(store: WooStore, method: string, path: string, body?: unknown): Promise<Response> {
    const base = (this.opts.baseUrlFor?.(store.url) ?? store.url).replace(/\/$/, "");
    const auth = Buffer.from(`${store.key}:${store.secret}`).toString("base64");
    try {
      return await this.fetchImpl(`${base}/wp-json/wc/v3${path}`, {
        method,
        headers: {
          authorization: `Basic ${auth}`,
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new ChannelApiError(0, "network_error", (err as Error).message, true);
    }
  }

  private async parse(res: Response): Promise<unknown> {
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (res.ok && json !== null) return json;
    if (res.ok) throw new ChannelApiError(502, "invalid_response", "Réponse WooCommerce illisible (l'adresse pointe-t-elle vers WordPress ?)", false);
    const j = (json ?? {}) as { code?: string; message?: string };
    const code = j.code ?? (res.status === 401 ? "unauthorized" : `http_${res.status}`);
    const message = j.message ?? (text.slice(0, 300) || res.statusText);
    throw new ChannelApiError(res.status, code, message, res.status === 429 || res.status >= 500);
  }
}

/** Webhook WooCommerce : X-WC-Webhook-Signature = HMAC-SHA256 base64 du corps brut, clé = secret du webhook. */
export const signWooWebhook = (secret: string, rawBody: string) => createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");

export function verifyWooWebhook(secret: string, rawBody: string, header: string | undefined): boolean {
  if (!header) return false;
  const a = Buffer.from(signWooWebhook(secret, rawBody));
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}
