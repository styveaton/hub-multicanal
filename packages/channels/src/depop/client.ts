/**
 * Client de la Selling API Depop (https://partnerapi.depop.com/api-docs/).
 * `fetch` est injectable : le faux Depop des tests et du mode local s'y branche.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export const DEPOP_SCOPES = ["products_read", "products_write", "shop_read", "orders_read"] as const;

export interface DepopTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

export interface DepopShop {
  id: number;
  username: string;
  country_code: string;
}

export interface DepopPicture {
  url: string;
}

/** Corps de PUT /api/v1/products/by-sku/{sku}/ (champs utilisés par OmniList). */
export interface DepopProductBody {
  address: { country_code: string; state?: string };
  description: string;
  price_currency: string;
  price_amount: string;
  quantity: number;
  pictures: DepopPicture[];
  department: string;
  product_type: string;
  size_set_id?: number;
  size_id?: number;
  condition: string;
  brand_name: string;
  attributes: Record<string, string[]>;
  national_shipping_cost: string;
}

export interface DepopProductResult {
  product_id: number;
  slug: string;
  sku?: string;
}

export type DepopOrderStatus = "SHIPPING_PENDING" | "SHIPPED" | "REFUNDED" | "CANCELLED" | "COMPLETED";

/** Commande Depop (champs utilisés par OmniList). Une ligne par unité vendue. */
export interface DepopOrder {
  purchase_id: string;
  status: DepopOrderStatus;
  currency: string;
  buyer_pays_amount?: string;
  buyer_address?: { name?: string } | null;
  line_items: Array<{ sku?: string | null; product_id: number; description: string; sold_price: string }>;
  created_at: string;
}

export interface DepopOrdersPage {
  meta: { cursor?: string | null; has_more: boolean };
  data: DepopOrder[];
}

export interface DepopWebhookConfig {
  id: string;
  secret?: string;
}

/** Erreur renvoyée par Depop. `retryable` : relancer plus tard peut réussir (429, 5xx, réseau). */
export class DepopApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "DepopApiError";
  }
}

export const depopProductUrl = (slug: string) => `https://www.depop.com/products/${slug}/`;

export interface DepopClientOptions {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
}

export class DepopClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: DepopClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /** Échange le code reçu après l'accord du vendeur contre des jetons (PKCE obligatoire). */
  exchangeCode(code: string, redirectUri: string, codeVerifier: string): Promise<DepopTokens> {
    return this.token({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: codeVerifier });
  }

  /** Nouveau couple de jetons ; l'ancien jeton de rafraîchissement ne sert plus. */
  refresh(refreshToken: string): Promise<DepopTokens> {
    return this.token({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  getShop(accessToken: string): Promise<DepopShop> {
    return this.call("GET", "/api/v1/shop/", accessToken);
  }

  putProduct(accessToken: string, sku: string, body: DepopProductBody): Promise<DepopProductResult> {
    return this.call("PUT", `/api/v1/products/by-sku/${encodeURIComponent(sku)}/`, accessToken, body);
  }

  /** Idempotent : réussit même si l'annonce n'existe plus. */
  async deleteProduct(accessToken: string, sku: string): Promise<void> {
    await this.call("DELETE", `/api/v1/products/by-sku/${encodeURIComponent(sku)}/`, accessToken);
  }

  /** À appeler dès que l'article se vend sur un autre canal. */
  async markSold(accessToken: string, sku: string): Promise<void> {
    await this.call("POST", `/api/v1/products/by-sku/${encodeURIComponent(sku)}/mark-as-sold/`, accessToken);
  }

  /** Commandes reçues, de la plus récente à la plus ancienne (200 au plus par page). */
  listOrders(accessToken: string, params: { from?: Date; cursor?: string; limit?: number } = {}): Promise<DepopOrdersPage> {
    const q = new URLSearchParams({ limit: String(params.limit ?? 200) });
    if (params.from) q.set("from", params.from.toISOString());
    if (params.cursor) q.set("cursor", params.cursor);
    return this.call("GET", `/api/v1/orders/?${q}`, accessToken);
  }

  /** Abonnement aux événements du vendeur ; le secret n'est renvoyé qu'à la création. */
  createWebhook(accessToken: string, url: string, eventTypes: string[]): Promise<DepopWebhookConfig> {
    return this.call("POST", "/api/v1/webhooks/", accessToken, { url, event_types: eventTypes, enabled: true });
  }

  private async token(params: Record<string, string>): Promise<DepopTokens> {
    const body = new URLSearchParams({ ...params, client_id: this.opts.clientId, client_secret: this.opts.clientSecret });
    const res = await this.send(`${this.baseUrl}/api/v1/oauth2/access-token/`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
    });
    return (await this.parse(res)) as DepopTokens;
  }

  private async call<T>(method: string, path: string, accessToken: string, body?: unknown): Promise<T> {
    const res = await this.send(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return (await this.parse(res)) as T;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
    } catch (err) {
      throw new DepopApiError(0, "network_error", (err as Error).message, true);
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
    if (res.ok) return json;

    // Formats d'erreur Depop : { errors: [{ code, message }] } ou OAuth { error, error_description }.
    const j = (json ?? {}) as {
      errors?: Array<{ code?: string; message?: string }>;
      error?: string;
      error_description?: string;
      error_message?: string;
    };
    const first = j.errors?.[0];
    const code = first?.code ?? j.error ?? (res.status === 401 ? "unauthorized" : `http_${res.status}`);
    const message = first?.message ?? j.error_description ?? j.error_message ?? (text.slice(0, 300) || res.statusText);
    const retryable = res.status === 429 || res.status >= 500;
    throw new DepopApiError(res.status, code, message, retryable);
  }
}

/**
 * Vérifie un webhook Depop : X-Depop-Signature = HMAC-SHA256 hexadécimal de « <timestamp>.<corps brut> »,
 * clé = secret du webhook. Les messages de plus de 5 minutes sont refusés (rejeu).
 */
export function verifyDepopWebhook(
  secret: string,
  rawBody: string,
  timestamp: string | undefined,
  signature: string | undefined,
  now = Date.now(),
): boolean {
  const ts = Number(timestamp);
  if (!signature || !Number.isFinite(ts) || Math.abs(now / 1000 - ts) > 300) return false;
  const expected = Buffer.from(signDepopWebhook(secret, rawBody, String(timestamp)));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export const signDepopWebhook = (secret: string, rawBody: string, timestamp: string) =>
  createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
