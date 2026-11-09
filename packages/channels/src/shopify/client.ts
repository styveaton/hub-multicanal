/**
 * Client de l'Admin API GraphQL de Shopify (https://shopify.dev/docs/api/admin-graphql).
 * Une boutique = un domaine *.myshopify.com et un jeton d'accès « hors ligne » (sans expiration).
 * Chaque requête porte un nom d'opération : le faux Shopify des tests s'en sert pour répondre.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { ChannelApiError } from "../listing.js";

export const SHOPIFY_SCOPES = ["read_products", "write_products", "read_inventory", "write_inventory", "read_orders", "read_locations"] as const;

/** Version de l'API visée (Shopify publie une version par trimestre, maintenue 12 mois). */
export const SHOPIFY_API_VERSION = "2026-10";

/** « ma-boutique », « ma-boutique.myshopify.com » ou l'adresse de l'admin → domaine canonique, ou null. */
export function normalizeShopDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  s = s.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const admin = input.match(/admin\.shopify\.com\/store\/([a-z0-9][a-z0-9-]*)/i);
  if (admin) s = admin[1]!.toLowerCase();
  if (!s.includes(".")) s = `${s}.myshopify.com`;
  return /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s) ? s : null;
}

/** Identifiant numérique d'un identifiant global (gid://shopify/Order/123 → 123). */
export const gidTail = (id: string | number) => String(id).split("/").pop() ?? String(id);

export interface ShopifyShop {
  name: string;
  domain: string;
  currency: string;
  /** Emplacement de stock où OmniList tient les quantités. */
  locationId: string;
}

export interface ShopifyVariantRef {
  id: string;
  sku: string;
  inventoryItemId: string;
}

export interface ShopifyProductRef {
  id: string;
  handle: string;
  onlineStoreUrl: string | null;
  variants: ShopifyVariantRef[];
}

/** Entrée de productSet (champs utilisés par OmniList). */
export interface ShopifyProductSetInput {
  title: string;
  descriptionHtml: string;
  vendor?: string;
  productType?: string;
  status: "ACTIVE" | "DRAFT" | "ARCHIVED";
  productOptions: Array<{ name: string; position: number; values: Array<{ name: string }> }>;
  variants: Array<{
    optionValues: Array<{ optionName: string; name: string }>;
    price: string;
    inventoryItem: { sku: string; tracked: boolean };
    inventoryQuantities?: Array<{ locationId: string; name: "available"; quantity: number }>;
  }>;
  files?: Array<{ originalSource: string; contentType: "IMAGE" }>;
}

/** Commande Shopify ramenée aux champs utiles, qu'elle vienne d'un webhook (REST) ou d'un relevé (GraphQL). */
export interface ShopifyOrder {
  id: string;
  name: string;
  createdAt: string;
  cancelled: boolean;
  /** PAID, PENDING, REFUNDED, PARTIALLY_REFUNDED, VOIDED… */
  financialStatus: string;
  /** FULFILLED, UNFULFILLED, PARTIALLY_FULFILLED… */
  fulfillmentStatus: string | null;
  currency: string;
  buyerName: string | null;
  lines: Array<{ sku: string | null; title: string; quantity: number; unitPriceCents: number; productId: string | null }>;
}

export interface ShopifyOrdersPage {
  orders: ShopifyOrder[];
  hasNextPage: boolean;
  cursor: string | null;
}

const cents = (amount: string | number | null | undefined) => Math.round(Number(amount ?? 0) * 100);

/** Commande reçue par webhook (format REST : orders/create, orders/updated, orders/cancelled). */
export function shopifyOrderFromWebhook(o: {
  id: number | string;
  name?: string;
  created_at: string;
  cancelled_at?: string | null;
  financial_status?: string | null;
  fulfillment_status?: string | null;
  currency: string;
  customer?: { first_name?: string | null; last_name?: string | null } | null;
  line_items: Array<{ sku?: string | null; title: string; quantity: number; price: string; product_id?: number | null }>;
}): ShopifyOrder {
  const buyer = [o.customer?.first_name, o.customer?.last_name].filter(Boolean).join(" ");
  return {
    id: gidTail(o.id),
    name: o.name ?? `#${o.id}`,
    createdAt: o.created_at,
    cancelled: o.cancelled_at != null,
    financialStatus: (o.financial_status ?? "paid").toUpperCase(),
    fulfillmentStatus: o.fulfillment_status ? o.fulfillment_status.toUpperCase() : null,
    currency: o.currency,
    buyerName: buyer || null,
    lines: o.line_items.map((li) => ({
      sku: li.sku || null,
      title: li.title,
      quantity: li.quantity,
      unitPriceCents: cents(li.price),
      productId: li.product_id != null ? String(li.product_id) : null,
    })),
  };
}

interface GqlOrderNode {
  id: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  currencyCode: string;
  customer: { displayName: string | null } | null;
  lineItems: {
    nodes: Array<{ sku: string | null; title: string; quantity: number; originalUnitPriceSet: { shopMoney: { amount: string } }; product: { id: string } | null }>;
  };
}

const fromGql = (o: GqlOrderNode): ShopifyOrder => ({
  id: gidTail(o.id),
  name: o.name,
  createdAt: o.createdAt,
  cancelled: o.cancelledAt != null,
  financialStatus: o.displayFinancialStatus ?? "PAID",
  fulfillmentStatus: o.displayFulfillmentStatus,
  currency: o.currencyCode,
  buyerName: o.customer?.displayName ?? null,
  lines: o.lineItems.nodes.map((li) => ({
    sku: li.sku || null,
    title: li.title,
    quantity: li.quantity,
    unitPriceCents: cents(li.originalUnitPriceSet.shopMoney.amount),
    productId: li.product ? gidTail(li.product.id) : null,
  })),
});

// Requêtes nommées : le nom d'opération sert aussi d'aiguillage au faux Shopify.
const Q = {
  shop: `query OmniShop { shop { name myshopifyDomain currencyCode } locations(first: 1) { nodes { id name } } }`,
  productSet: `mutation OmniProductSet($input: ProductSetInput!, $identifier: ProductSetIdentifiers) {
  productSet(input: $input, identifier: $identifier, synchronous: true) {
    product { id handle onlineStoreUrl variants(first: 250) { nodes { id sku inventoryItem { id } } } }
    userErrors { field message code }
  }
}`,
  inventorySet: `mutation OmniInventorySet($input: InventorySetQuantitiesInput!, $idempotencyKey: String!) {
  inventorySetQuantities(input: $input) @idempotent(key: $idempotencyKey) { userErrors { field message code } }
}`,
  productStatus: `mutation OmniProductStatus($product: ProductUpdateInput!) {
  productUpdate(product: $product) { product { id status } userErrors { field message } }
}`,
  productDelete: `mutation OmniProductDelete($input: ProductDeleteInput!) {
  productDelete(input: $input) { deletedProductId userErrors { field message } }
}`,
  orders: `query OmniOrders($query: String!, $after: String) {
  orders(first: 50, after: $after, query: $query, sortKey: UPDATED_AT) {
    nodes {
      id name createdAt cancelledAt displayFinancialStatus displayFulfillmentStatus currencyCode
      customer { displayName }
      lineItems(first: 100) { nodes { sku title quantity originalUnitPriceSet { shopMoney { amount } } product { id } } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`,
  webhookCreate: `mutation OmniWebhookCreate($topic: WebhookSubscriptionTopic!, $sub: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $sub) { webhookSubscription { id } userErrors { field message } }
}`,
} as const;

/** Nom d'opération d'une requête GraphQL (« mutation OmniProductSet(… » → OmniProductSet). */
export const operationName = (query: string) => query.match(/^\s*(?:query|mutation)\s+(\w+)/)?.[1] ?? "";

type UserError = { field?: string[] | null; message: string; code?: string | null };

export interface ShopifyClientOptions {
  clientId: string;
  clientSecret: string;
  apiVersion?: string;
  /** Adresse de l'API d'une boutique (https://<boutique>, ou le faux Shopify en local). */
  baseUrlFor: (shop: string) => string;
  /** Adresse de la page d'accord (le navigateur du vendeur y va). */
  authorizeBaseFor?: (shop: string) => string;
  fetch?: typeof fetch;
}

export class ShopifyClient {
  private readonly fetchImpl: typeof fetch;
  readonly apiVersion: string;

  constructor(private readonly opts: ShopifyClientOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
    this.apiVersion = opts.apiVersion ?? SHOPIFY_API_VERSION;
  }

  get clientSecret() {
    return this.opts.clientSecret;
  }

  /** Page où le marchand accepte d'installer l'application (jeton hors ligne). */
  authorizeUrl(shop: string, params: { state: string; redirectUri: string; scopes: readonly string[] }): string {
    const base = (this.opts.authorizeBaseFor ?? this.opts.baseUrlFor)(shop).replace(/\/$/, "");
    const q = new URLSearchParams({
      client_id: this.opts.clientId,
      scope: params.scopes.join(","),
      redirect_uri: params.redirectUri,
      state: params.state,
    });
    return `${base}/admin/oauth/authorize?${q}`;
  }

  /** Retour de la page d'accord : la signature `hmac` prouve qu'il vient de Shopify. */
  verifyCallback(query: URLSearchParams): boolean {
    return verifyShopifyQuery(this.opts.clientSecret, query);
  }

  async exchangeCode(shop: string, code: string): Promise<{ access_token: string; scope: string }> {
    const res = await this.send(`${this.base(shop)}/admin/oauth/access_token`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_id: this.opts.clientId, client_secret: this.opts.clientSecret, code }),
    });
    return (await this.parse(res)) as { access_token: string; scope: string };
  }

  async getShop(shop: string, token: string): Promise<ShopifyShop> {
    const data = await this.gql<{
      shop: { name: string; myshopifyDomain: string; currencyCode: string };
      locations: { nodes: Array<{ id: string }> };
    }>(shop, token, Q.shop);
    const locationId = data.locations.nodes[0]?.id;
    if (!locationId) throw new ChannelApiError(422, "no_location", "La boutique Shopify n'a aucun emplacement de stock", false);
    return { name: data.shop.name, domain: data.shop.myshopifyDomain, currency: data.shop.currencyCode, locationId };
  }

  /** Crée ou met à jour le produit ; les variantes absentes de la liste sont supprimées par Shopify. */
  async setProduct(shop: string, token: string, input: ShopifyProductSetInput, productId?: string | null): Promise<ShopifyProductRef> {
    const data = await this.gql<{
      productSet: {
        product: {
          id: string;
          handle: string;
          onlineStoreUrl: string | null;
          variants: { nodes: Array<{ id: string; sku: string | null; inventoryItem: { id: string } }> };
        } | null;
        userErrors: UserError[];
      };
    }>(shop, token, Q.productSet, { input, identifier: productId ? { id: productId } : null });
    this.userErrors(data.productSet.userErrors);
    const p = data.productSet.product;
    if (!p) throw new ChannelApiError(502, "empty_response", "Shopify n'a pas renvoyé le produit", true);
    return {
      id: p.id,
      handle: p.handle,
      onlineStoreUrl: p.onlineStoreUrl,
      variants: p.variants.nodes.map((v) => ({ id: v.id, sku: v.sku ?? "", inventoryItemId: v.inventoryItem.id })),
    };
  }

  /** Quantités absolues (stock central), sans contrôle de la valeur précédente. */
  async setQuantities(shop: string, token: string, locationId: string, items: Array<{ inventoryItemId: string; quantity: number }>) {
    if (items.length === 0) return;
    const data = await this.gql<{ inventorySetQuantities: { userErrors: UserError[] } }>(shop, token, Q.inventorySet, {
      input: {
        name: "available",
        reason: "correction",
        referenceDocumentUri: "omnilist://stock/central",
        quantities: items.map((i) => ({ inventoryItemId: i.inventoryItemId, locationId, quantity: i.quantity, changeFromQuantity: null })),
      },
      idempotencyKey: randomUUID(),
    });
    this.userErrors(data.inventorySetQuantities.userErrors);
  }

  /** Archivé : invisible dans la boutique, mais l'historique des ventes est conservé. */
  async setStatus(shop: string, token: string, productId: string, status: "ACTIVE" | "ARCHIVED") {
    const data = await this.gql<{ productUpdate: { userErrors: UserError[] } }>(shop, token, Q.productStatus, { product: { id: productId, status } });
    this.userErrors(data.productUpdate.userErrors);
  }

  /** Idempotent : un produit déjà supprimé n'est pas une erreur. */
  async deleteProduct(shop: string, token: string, productId: string) {
    const data = await this.gql<{ productDelete: { userErrors: UserError[] } }>(shop, token, Q.productDelete, { input: { id: productId } });
    const errors = data.productDelete.userErrors.filter((e) => !/not exist|not found/i.test(e.message));
    this.userErrors(errors);
  }

  async listOrders(shop: string, token: string, params: { updatedSince: Date; after?: string | null }): Promise<ShopifyOrdersPage> {
    const data = await this.gql<{ orders: { nodes: GqlOrderNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }>(
      shop,
      token,
      Q.orders,
      { query: `updated_at:>='${params.updatedSince.toISOString()}'`, after: params.after ?? null },
    );
    return { orders: data.orders.nodes.map(fromGql), hasNextPage: data.orders.pageInfo.hasNextPage, cursor: data.orders.pageInfo.endCursor };
  }

  /** Abonnement à un sujet (ORDERS_CREATE…). Les envois sont signés avec le secret de l'application. */
  async createWebhook(shop: string, token: string, topic: string, uri: string): Promise<string> {
    const data = await this.gql<{ webhookSubscriptionCreate: { webhookSubscription: { id: string } | null; userErrors: UserError[] } }>(
      shop,
      token,
      Q.webhookCreate,
      { topic, sub: { uri, format: "JSON" } },
    );
    this.userErrors(data.webhookSubscriptionCreate.userErrors);
    return data.webhookSubscriptionCreate.webhookSubscription?.id ?? "";
  }

  private base(shop: string) {
    return this.opts.baseUrlFor(shop).replace(/\/$/, "");
  }

  private async gql<T>(shop: string, token: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await this.send(`${this.base(shop)}/admin/api/${this.apiVersion}/graphql.json`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "x-shopify-access-token": token },
      body: JSON.stringify({ query, variables, operationName: operationName(query) }),
    });
    const json = (await this.parse(res)) as { data?: T; errors?: Array<{ message: string; extensions?: { code?: string } }> };
    if (json.errors?.length) {
      const first = json.errors[0]!;
      const code = first.extensions?.code ?? "graphql_error";
      const throttled = code === "THROTTLED";
      throw new ChannelApiError(throttled ? 429 : code === "ACCESS_DENIED" ? 403 : 400, code.toLowerCase(), first.message, throttled);
    }
    if (!json.data) throw new ChannelApiError(502, "empty_response", "Réponse Shopify vide", true);
    return json.data;
  }

  private userErrors(errors: UserError[]) {
    if (errors.length === 0) return;
    const message = errors.map((e) => (e.field?.length ? `${e.field.join(".")}: ${e.message}` : e.message)).join(" ; ");
    throw new ChannelApiError(422, (errors[0]!.code ?? "user_error").toLowerCase(), message, false);
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchImpl(url, init);
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
    if (res.ok) return json;
    const j = (json ?? {}) as { errors?: unknown; error?: string; error_description?: string };
    const message = typeof j.errors === "string" ? j.errors : (j.error_description ?? j.error ?? (text.slice(0, 300) || res.statusText));
    const code = res.status === 401 ? "unauthorized" : res.status === 402 ? "shop_frozen" : res.status === 404 ? "shop_not_found" : `http_${res.status}`;
    throw new ChannelApiError(res.status, code, message, res.status === 429 || res.status >= 500);
  }
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Signature d'une adresse de retour Shopify : HMAC-SHA256 hexadécimal des paramètres triés (sans `hmac`). */
export function signShopifyQuery(secret: string, query: URLSearchParams): string {
  const message = [...query.entries()]
    .filter(([k]) => k !== "hmac" && k !== "signature")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return createHmac("sha256", secret).update(message).digest("hex");
}

export function verifyShopifyQuery(secret: string, query: URLSearchParams): boolean {
  const given = query.get("hmac");
  return !!given && safeEqual(signShopifyQuery(secret, query), given);
}

/** Webhook Shopify : X-Shopify-Hmac-Sha256 = HMAC-SHA256 base64 du corps brut, clé = secret de l'application. */
export const signShopifyWebhook = (secret: string, rawBody: string) => createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");

export function verifyShopifyWebhook(secret: string, rawBody: string, header: string | undefined): boolean {
  // Secret absent (Shopify pas encore configuré) : une signature faite avec une clé vide serait acceptée.
  if (!secret) return false;
  return !!header && safeEqual(signShopifyWebhook(secret, rawBody), header);
}
