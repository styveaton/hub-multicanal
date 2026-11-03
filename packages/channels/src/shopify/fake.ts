import { randomToken } from "../crypto.js";
import { gidTail, signShopifyQuery, type ShopifyProductSetInput } from "./client.js";

/**
 * Faux Shopify en mémoire : reproduit l'installation OAuth et les opérations GraphQL utilisées par
 * OmniList (aiguillage sur le nom d'opération), pour les tests et le mode local (SHOPIFY_ENV=fake).
 */

export const FAKE_SHOPIFY_CLIENT_ID = "fake-shopify-client";
export const FAKE_SHOPIFY_CLIENT_SECRET = "fake-shopify-secret";

interface FakeVariant {
  id: string;
  sku: string;
  price: string;
  inventoryItemId: string;
  quantity: number;
  options: Array<{ optionName: string; name: string }>;
}

export interface FakeShopifyProduct {
  id: string;
  shop: string;
  handle: string;
  title: string;
  descriptionHtml: string;
  status: string;
  productType?: string;
  variants: FakeVariant[];
  files: string[];
}

/** Commande au format webhook REST (c'est aussi ce que renvoie simulateSale). */
export interface FakeShopifyOrder {
  id: number;
  admin_graphql_api_id: string;
  name: string;
  created_at: string;
  updated_at: string;
  cancelled_at: string | null;
  financial_status: string;
  fulfillment_status: string | null;
  currency: string;
  customer: { first_name: string; last_name: string };
  line_items: Array<{ sku: string; title: string; quantity: number; price: string; product_id: number }>;
  shop: string;
}

interface GqlRequest {
  query?: string;
  operationName?: string;
  variables?: Record<string, unknown>;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export class FakeShopify {
  readonly products = new Map<string, FakeShopifyProduct>();
  readonly orders: FakeShopifyOrder[] = [];
  readonly webhooks: Array<{ id: string; shop: string; topic: string; uri: string }> = [];
  readonly locationId = "gid://shopify/Location/7001";
  /** Erreur utilisateur forcée sur le prochain productSet (tests). */
  failNextSet: string | null = null;
  private readonly codes = new Map<string, string>(); // code → boutique
  private readonly tokens = new Map<string, string>(); // jeton → boutique
  private nextId = 9_100_000;

  constructor(private readonly now: () => number = Date.now) {}

  /** Page d'installation : le faux marchand accepte toujours. Renvoie l'adresse de retour signée. */
  authorize(shop: string, query: URLSearchParams): string {
    const back = new URL(query.get("redirect_uri") ?? "");
    const params = new URLSearchParams();
    if (query.get("client_id") !== FAKE_SHOPIFY_CLIENT_ID) {
      back.searchParams.set("error", "invalid_request");
      back.searchParams.set("state", query.get("state") ?? "");
      return back.toString();
    }
    const code = `fake_shopify_code_${randomToken(12)}`;
    this.codes.set(code, shop);
    params.set("code", code);
    params.set("host", Buffer.from(`admin.shopify.com/store/${shop.split(".")[0]}`).toString("base64url"));
    params.set("shop", shop);
    params.set("state", query.get("state") ?? "");
    params.set("timestamp", String(Math.floor(this.now() / 1000)));
    params.set("hmac", signShopifyQuery(FAKE_SHOPIFY_CLIENT_SECRET, params));
    params.forEach((v, k) => back.searchParams.set(k, v));
    return back.toString();
  }

  /** Vente dans la boutique (tests et démonstration) : décompte le stock Shopify et crée la commande. */
  simulateSale(sku: string, opts: { quantity?: number } = {}): FakeShopifyOrder {
    const product = [...this.products.values()].find((p) => p.variants.some((v) => v.sku === sku));
    const variant = product?.variants.find((v) => v.sku === sku);
    if (!product || !variant) throw new Error(`Variante inconnue sur le faux Shopify : ${sku}`);
    const quantity = opts.quantity ?? 1;
    variant.quantity = Math.max(0, variant.quantity - quantity);
    const id = this.nextId++;
    const at = new Date(this.now()).toISOString();
    const order: FakeShopifyOrder = {
      id,
      admin_graphql_api_id: `gid://shopify/Order/${id}`,
      name: `#${1000 + this.orders.length + 1}`,
      created_at: at,
      updated_at: at,
      cancelled_at: null,
      financial_status: "paid",
      fulfillment_status: null,
      currency: "USD",
      customer: { first_name: "Riley", last_name: "Shopper" },
      line_items: [{ sku, title: product.title, quantity, price: variant.price, product_id: Number(gidTail(product.id)) }],
      shop: product.shop,
    };
    this.orders.unshift(order);
    return order;
  }

  cancelOrder(id: number) {
    const order = this.orders.find((o) => o.id === id);
    if (order) {
      order.cancelled_at = new Date(this.now()).toISOString();
      order.updated_at = order.cancelled_at;
    }
    return order;
  }

  /** Le marchand désinstalle l'application : ses jetons ne marchent plus. */
  revokeAll() {
    this.tokens.clear();
  }

  variantBySku(sku: string) {
    for (const p of this.products.values()) {
      const v = p.variants.find((x) => x.sku === sku);
      if (v) return { product: p, variant: v };
    }
    return null;
  }

  /** Adaptateur `fetch` : https://<boutique>/admin/… ou …/fake-shopify/<boutique>/admin/… */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const m = url.pathname.match(/\/([a-z0-9][a-z0-9-]*\.myshopify\.com)(\/admin\/.*)$/);
    const shop = m ? m[1]! : url.hostname;
    const path = m ? m[2]! : url.pathname;
    const headers = new Headers(init?.headers);
    return this.handle(shop, init?.method ?? "GET", path, headers.get("x-shopify-access-token"), (init?.body as string | undefined) ?? "");
  };

  handle(shop: string, method: string, path: string, token: string | null, body: string): Response {
    if (method === "POST" && path === "/admin/oauth/access_token") {
      const b = JSON.parse(body || "{}") as { client_id?: string; client_secret?: string; code?: string };
      const codeShop = this.codes.get(b.code ?? "");
      this.codes.delete(b.code ?? "");
      if (b.client_id !== FAKE_SHOPIFY_CLIENT_ID || b.client_secret !== FAKE_SHOPIFY_CLIENT_SECRET || codeShop !== shop) {
        return json(400, { error: "invalid_request", error_description: "The authorization code was not found or was already used" });
      }
      const access = `shpat_${randomToken(16)}`;
      this.tokens.set(access, shop);
      return json(200, { access_token: access, scope: "read_products,write_products,read_inventory,write_inventory,read_orders,read_locations" });
    }
    if (!/^\/admin\/api\/[\d-]+\/graphql\.json$/.test(path) || method !== "POST") return json(404, { errors: "Not Found" });
    if (!token || this.tokens.get(token) !== shop) {
      return json(401, { errors: "[API] Invalid API key or access token (unrecognized login or wrong password)" });
    }
    const req = JSON.parse(body || "{}") as GqlRequest;
    const v = req.variables ?? {};
    switch (req.operationName) {
      case "OmniShop":
        return json(200, {
          data: {
            shop: { name: "OmniList Demo", myshopifyDomain: shop, currencyCode: "USD" },
            locations: { nodes: [{ id: this.locationId, name: "Shop location" }] },
          },
        });
      case "OmniProductSet":
        return this.productSet(shop, v.input as ShopifyProductSetInput, (v.identifier as { id?: string } | null)?.id);
      case "OmniInventorySet": {
        const input = v.input as { quantities: Array<{ inventoryItemId: string; locationId: string; quantity: number; changeFromQuantity?: number | null }> };
        if (!v.idempotencyKey) return json(200, { errors: [{ message: "The @idempotent directive is required", extensions: { code: "BAD_REQUEST" } }] });
        for (const q of input.quantities) {
          if (!("changeFromQuantity" in q)) {
            return json(200, { data: { inventorySetQuantities: { userErrors: [{ field: ["changeFromQuantity"], message: "is required", code: "INVALID" }] } } });
          }
          const variant = [...this.products.values()].flatMap((p) => p.variants).find((x) => x.inventoryItemId === q.inventoryItemId);
          if (!variant) return json(200, { data: { inventorySetQuantities: { userErrors: [{ field: ["inventoryItemId"], message: "not found", code: "INVALID_INVENTORY_ITEM" }] } } });
          variant.quantity = q.quantity;
        }
        return json(200, { data: { inventorySetQuantities: { userErrors: [] } } });
      }
      case "OmniProductStatus": {
        const p = v.product as { id: string; status: string };
        const product = this.products.get(p.id);
        if (!product) return json(200, { data: { productUpdate: { product: null, userErrors: [{ field: ["id"], message: "Product does not exist" }] } } });
        product.status = p.status;
        return json(200, { data: { productUpdate: { product: { id: product.id, status: product.status }, userErrors: [] } } });
      }
      case "OmniProductDelete": {
        const id = (v.input as { id: string }).id;
        if (!this.products.delete(id)) return json(200, { data: { productDelete: { deletedProductId: null, userErrors: [{ field: ["id"], message: "Product does not exist" }] } } });
        return json(200, { data: { productDelete: { deletedProductId: id, userErrors: [] } } });
      }
      case "OmniOrders":
        return this.listOrders(shop, String(v.query ?? ""), v.after as string | null);
      case "OmniWebhookCreate": {
        const sub = v.sub as { uri: string };
        if (!sub.uri.startsWith("https://")) {
          return json(200, { data: { webhookSubscriptionCreate: { webhookSubscription: null, userErrors: [{ field: ["uri"], message: "Address must be HTTPS" }] } } });
        }
        const hook = { id: `gid://shopify/WebhookSubscription/${this.nextId++}`, shop, topic: String(v.topic), uri: sub.uri };
        this.webhooks.push(hook);
        return json(200, { data: { webhookSubscriptionCreate: { webhookSubscription: { id: hook.id }, userErrors: [] } } });
      }
      default:
        return json(200, { errors: [{ message: `Unknown operation ${req.operationName}`, extensions: { code: "BAD_REQUEST" } }] });
    }
  }

  private productSet(shop: string, input: ShopifyProductSetInput, id?: string): Response {
    const fail = (message: string, field = ["input"]) => json(200, { data: { productSet: { product: null, userErrors: [{ field, message, code: "INVALID" }] } } });
    if (this.failNextSet) {
      const message = this.failNextSet;
      this.failNextSet = null;
      return fail(message);
    }
    if (!input.title?.trim()) return fail("Title can't be blank", ["input", "title"]);
    if (input.variants.length === 0 || input.variants.length > 2048) return fail("Variants are required");
    if (input.variants.some((x) => Number(x.price) < 0)) return fail("Price must be positive");
    const existing = id ? this.products.get(id) : undefined;
    if (id && !existing) return fail("Product does not exist", ["identifier", "id"]);
    const productId = existing?.id ?? `gid://shopify/Product/${this.nextId++}`;
    const variants: FakeVariant[] = input.variants.map((iv) => {
      const prev = existing?.variants.find((x) => x.sku === iv.inventoryItem.sku);
      return {
        id: prev?.id ?? `gid://shopify/ProductVariant/${this.nextId++}`,
        inventoryItemId: prev?.inventoryItemId ?? `gid://shopify/InventoryItem/${this.nextId++}`,
        sku: iv.inventoryItem.sku,
        price: iv.price,
        quantity: prev?.quantity ?? iv.inventoryQuantities?.[0]?.quantity ?? 0,
        options: iv.optionValues,
      };
    });
    const product: FakeShopifyProduct = {
      id: productId,
      shop,
      handle: existing?.handle ?? input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
      title: input.title,
      descriptionHtml: input.descriptionHtml,
      status: input.status,
      productType: input.productType,
      variants,
      files: input.files ? input.files.map((f) => f.originalSource) : (existing?.files ?? []),
    };
    this.products.set(productId, product);
    return json(200, {
      data: {
        productSet: {
          product: {
            id: product.id,
            handle: product.handle,
            onlineStoreUrl: product.status === "ACTIVE" ? `https://${shop}/products/${product.handle}` : null,
            variants: { nodes: variants.map((x) => ({ id: x.id, sku: x.sku, inventoryItem: { id: x.inventoryItemId } })) },
          },
          userErrors: [],
        },
      },
    });
  }

  private listOrders(shop: string, query: string, after: string | null): Response {
    const since = Date.parse(query.match(/updated_at:>='([^']+)'/)?.[1] ?? "1970-01-01");
    let list = this.orders.filter((o) => o.shop === shop && Date.parse(o.updated_at) >= since);
    if (after) list = list.slice(list.findIndex((o) => String(o.id) === after) + 1);
    const page = list.slice(0, 50);
    return json(200, {
      data: {
        orders: {
          nodes: page.map((o) => ({
            id: o.admin_graphql_api_id,
            name: o.name,
            createdAt: o.created_at,
            cancelledAt: o.cancelled_at,
            displayFinancialStatus: o.financial_status.toUpperCase(),
            displayFulfillmentStatus: o.fulfillment_status ? o.fulfillment_status.toUpperCase() : "UNFULFILLED",
            currencyCode: o.currency,
            customer: { displayName: `${o.customer.first_name} ${o.customer.last_name}` },
            lineItems: {
              nodes: o.line_items.map((li) => ({
                sku: li.sku,
                title: li.title,
                quantity: li.quantity,
                originalUnitPriceSet: { shopMoney: { amount: li.price } },
                product: { id: `gid://shopify/Product/${li.product_id}` },
              })),
            },
          })),
          pageInfo: { hasNextPage: list.length > 50, endCursor: page.at(-1) ? String(page.at(-1)!.id) : null },
        },
      },
    });
  }
}
