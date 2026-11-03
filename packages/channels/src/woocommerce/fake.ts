import type { WooOrder, WooOrderStatus, WooProductBody, WooVariationBody } from "./client.js";

/**
 * Faux WooCommerce en mémoire (tests et mode local, WOO_ENV=fake). Toute clé « ck_… » / « cs_… »
 * est acceptée, sauf celles qui contiennent « bad » (pour essayer le refus de connexion).
 */

interface FakeVariation extends WooVariationBody {
  id: number;
}

export interface FakeWooProduct extends WooProductBody {
  id: number;
  permalink: string;
  variations: FakeVariation[];
}

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const wooError = (status: number, code: string, message: string) => reply(status, { code, message, data: { status } });

export class FakeWoo {
  readonly products = new Map<number, FakeWooProduct>();
  readonly orders: WooOrder[] = [];
  readonly webhooks: Array<{ id: number; topic: string; delivery_url: string; secret: string }> = [];
  failNextWrite: { code: string; message: string } | null = null;
  private nextId = 4200;

  constructor(private readonly now: () => number = Date.now) {}

  /** Article (simple ou variation) portant ce SKU. */
  bySku(sku: string): { product: FakeWooProduct; variation?: FakeVariation } | null {
    for (const product of this.products.values()) {
      if (product.type === "simple" && product.sku === sku) return { product };
      const variation = product.variations.find((v) => v.sku === sku);
      if (variation) return { product, variation };
    }
    return null;
  }

  /** Vente sur la boutique : WooCommerce baisse son stock et crée la commande « processing ». */
  simulateSale(sku: string, opts: { quantity?: number } = {}): WooOrder {
    const found = this.bySku(sku);
    if (!found) throw new Error(`Article inconnu sur le faux WooCommerce : ${sku}`);
    const quantity = opts.quantity ?? 1;
    const target = found.variation ?? found.product;
    target.stock_quantity = Math.max(0, (target.stock_quantity ?? 0) - quantity);
    const at = new Date(this.now()).toISOString().replace(/\.\d{3}Z$/, "");
    const id = this.nextId++;
    const order: WooOrder = {
      id,
      number: String(id),
      status: "processing",
      currency: "USD",
      date_created_gmt: at,
      date_modified_gmt: at,
      billing: { first_name: "Casey", last_name: "Customer" },
      line_items: [
        {
          sku,
          name: found.product.name,
          quantity,
          price: Number(target.regular_price ?? 0),
          product_id: found.product.id,
          variation_id: found.variation?.id ?? 0,
        },
      ],
    };
    this.orders.unshift(order);
    return order;
  }

  setOrderStatus(id: number, status: WooOrderStatus) {
    const order = this.orders.find((o) => o.id === id);
    if (order) {
      order.status = status;
      order.date_modified_gmt = new Date(this.now()).toISOString().replace(/\.\d{3}Z$/, "");
    }
    return order;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const path = url.pathname.replace(/^.*\/wp-json\/wc\/v3/, "");
    return this.handle(init?.method ?? "GET", path, url.searchParams, new Headers(init?.headers).get("authorization"), (init?.body as string | undefined) ?? "");
  };

  handle(method: string, path: string, query: URLSearchParams, authorization: string | null, raw: string): Response {
    const [key, secret] = Buffer.from((authorization ?? "").replace(/^Basic\s+/i, ""), "base64").toString().split(":");
    if (!key?.startsWith("ck_") || !secret?.startsWith("cs_") || key.includes("bad")) {
      return wooError(401, "woocommerce_rest_cannot_view", "Sorry, you cannot list resources.");
    }
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};

    if (method === "GET" && path === "/data/currencies/current") return reply(200, { code: "USD", name: "United States (US) dollar", symbol: "$" });

    if (path === "/products" && method === "GET") {
      const sku = query.get("sku");
      return reply(200, [...this.products.values()].filter((p) => !sku || p.sku === sku).map((p) => this.view(p)));
    }
    if (path === "/products" && method === "POST") return this.write(null, body as unknown as WooProductBody);

    let m = path.match(/^\/products\/(\d+)$/);
    if (m) {
      const product = this.products.get(Number(m[1]));
      if (!product) return wooError(404, "woocommerce_rest_product_invalid_id", "Invalid ID.");
      if (method === "PUT") return this.write(product, body as unknown as WooProductBody);
      if (method === "DELETE") {
        this.products.delete(product.id);
        return reply(200, this.view(product));
      }
    }

    m = path.match(/^\/products\/(\d+)\/variations(\/batch)?$/);
    if (m) {
      const product = this.products.get(Number(m[1]));
      if (!product) return wooError(404, "woocommerce_rest_product_invalid_id", "Invalid ID.");
      if (method === "GET" && !m[2]) return reply(200, product.variations.map((v) => ({ id: v.id, sku: v.sku })));
      if (method === "POST" && m[2]) return this.batch(product, body as { create?: WooVariationBody[]; update?: WooVariationBody[]; delete?: number[] });
    }

    if (method === "GET" && path === "/orders") {
      const after = Date.parse(`${query.get("modified_after")}Z`);
      const list = this.orders.filter((o) => Date.parse(`${o.date_modified_gmt ?? o.date_created_gmt}Z`) > after);
      const perPage = Number(query.get("per_page") ?? 10);
      const page = Number(query.get("page") ?? 1);
      return reply(200, list.slice((page - 1) * perPage, page * perPage), { "x-wp-totalpages": String(Math.max(1, Math.ceil(list.length / perPage))) });
    }

    if (method === "POST" && path === "/webhooks") {
      const deliveryUrl = String(body.delivery_url ?? "");
      if (!deliveryUrl.startsWith("https://")) return wooError(400, "rest_invalid_param", "Invalid parameter(s): delivery_url");
      const hook = { id: this.nextId++, topic: String(body.topic), delivery_url: deliveryUrl, secret: String(body.secret ?? "") };
      this.webhooks.push(hook);
      return reply(201, { id: hook.id, topic: hook.topic, delivery_url: hook.delivery_url, status: "active" });
    }
    m = path.match(/^\/webhooks\/(\d+)$/);
    if (m && method === "DELETE") {
      const i = this.webhooks.findIndex((w) => w.id === Number(m![1]));
      if (i >= 0) this.webhooks.splice(i, 1);
      return reply(200, { id: Number(m[1]) });
    }
    return wooError(404, "rest_no_route", "No route was found matching the URL and request method.");
  }

  private view(p: FakeWooProduct) {
    return { id: p.id, sku: p.sku ?? "", permalink: p.permalink, status: p.status, type: p.type };
  }

  private write(existing: FakeWooProduct | null, body: WooProductBody): Response {
    if (this.failNextWrite) {
      const e = this.failNextWrite;
      this.failNextWrite = null;
      return wooError(400, e.code, e.message);
    }
    if (!existing && !body.name?.trim()) return wooError(400, "woocommerce_rest_product_invalid_name", "Name is required.");
    if (body.sku) {
      const clash = this.bySku(body.sku);
      if (clash && clash.product.id !== existing?.id) return wooError(400, "product_invalid_sku", "Invalid or duplicated SKU.");
    }
    const id = existing?.id ?? this.nextId++;
    const merged: FakeWooProduct = {
      ...(existing ?? { variations: [], permalink: `https://shop.example.test/product/${id}/` }),
      ...body,
      id,
      variations: existing?.variations ?? [],
      images: body.images ?? existing?.images ?? [],
    } as FakeWooProduct;
    this.products.set(id, merged);
    return reply(existing ? 200 : 201, this.view(merged));
  }

  private batch(product: FakeWooProduct, body: { create?: WooVariationBody[]; update?: WooVariationBody[]; delete?: number[] }): Response {
    const result: { create: unknown[]; update: unknown[]; delete: unknown[] } = { create: [], update: [], delete: [] };
    for (const id of body.delete ?? []) {
      product.variations = product.variations.filter((v) => v.id !== id);
      result.delete.push({ id });
    }
    for (const v of body.update ?? []) {
      const target = product.variations.find((x) => x.id === v.id);
      if (!target) {
        result.update.push({ id: v.id ?? 0, error: { code: "woocommerce_rest_product_variation_invalid_id", message: "Invalid ID." } });
        continue;
      }
      Object.assign(target, v);
      result.update.push({ id: target.id, sku: target.sku });
    }
    for (const v of body.create ?? []) {
      if (this.bySku(v.sku)) {
        result.create.push({ id: 0, error: { code: "product_invalid_sku", message: "Invalid or duplicated SKU." } });
        continue;
      }
      const created = { ...v, id: this.nextId++ };
      product.variations.push(created);
      result.create.push({ id: created.id, sku: created.sku });
    }
    return reply(200, result);
  }
}
