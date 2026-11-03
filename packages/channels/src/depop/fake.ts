import { pkceChallenge, randomToken } from "../crypto.js";
import type { DepopOrder, DepopOrderStatus, DepopProductBody } from "./client.js";

/**
 * Faux Depop en mémoire : reproduit les réponses de la Selling API pour les tests,
 * et pour essayer tout le parcours en local avant d'avoir les clés (DEPOP_ENV=fake).
 * Ne valide que ce dont OmniList a besoin.
 */

export interface FakeRequest {
  method: string;
  /** Chemin après la base, ex. /api/v1/shop/ */
  path: string;
  headers: Record<string, string | undefined>;
  /** Corps brut (formulaire ou JSON). */
  body?: string;
  query?: URLSearchParams;
}

export interface FakeResponse {
  status: number;
  body?: unknown;
}

interface FakeProduct {
  productId: number;
  slug: string;
  status: "selling" | "sold";
  body: DepopProductBody;
}

export const FAKE_DEPOP_CLIENT_ID = "fake-depop-client";
export const FAKE_DEPOP_CLIENT_SECRET = "fake-depop-secret";
export const FAKE_DEPOP_USERNAME = "omnilist_demo";

const error = (status: number, code: string, message: string): FakeResponse => ({
  status,
  body: { id: randomToken(8), errors: [{ code, message }] },
});
const oauthError = (status: number, err: string, description: string): FakeResponse => ({
  status,
  body: { code: status, error: err, error_description: description },
});

export class FakeDepop {
  readonly products = new Map<string, FakeProduct>();
  /** Commandes reçues sur le faux Depop, la plus récente en premier. */
  readonly orders: DepopOrder[] = [];
  readonly webhooks: Array<{ id: string; url: string; secret: string; eventTypes: string[] }> = [];
  /** Erreur forcée sur le prochain PUT (tests). */
  failNextPut: FakeResponse | null = null;
  private readonly codes = new Map<string, { challenge: string; redirectUri: string; expiresAt: number }>();
  private readonly accessTokens = new Map<string, number>(); // jeton → expiration (ms)
  private readonly refreshTokens = new Set<string>();
  private nextId = 7_000_000;

  constructor(private readonly now: () => number = Date.now) {}

  /** Page d'accord Depop : le faux vendeur accepte toujours. Renvoie l'URL de retour. */
  authorize(query: URLSearchParams): string {
    const redirectUri = query.get("redirect_uri") ?? "";
    const back = new URL(redirectUri);
    const state = query.get("state") ?? "";
    if (query.get("client_id") !== FAKE_DEPOP_CLIENT_ID || query.get("code_challenge_method") !== "S256") {
      back.searchParams.set("error", "invalid_request");
    } else {
      const code = `fake_code_${randomToken(12)}`;
      this.codes.set(code, { challenge: query.get("code_challenge") ?? "", redirectUri, expiresAt: this.now() + 10 * 60_000 });
      back.searchParams.set("code", code);
    }
    back.searchParams.set("state", state);
    return back.toString();
  }

  /**
   * Vente sur Depop (tests et démonstration) : décompte la quantité de l'annonce, la marque vendue
   * à 0 et crée la commande, comme le ferait un acheteur.
   */
  simulateSale(sku: string, opts: { quantity?: number; status?: DepopOrderStatus; purchaseId?: string } = {}): DepopOrder {
    const product = this.products.get(sku);
    if (!product) throw new Error(`Annonce inconnue sur le faux Depop : ${sku}`);
    const quantity = opts.quantity ?? 1;
    product.body = { ...product.body, quantity: Math.max(0, product.body.quantity - quantity) };
    if (product.body.quantity === 0) product.status = "sold";
    const order: DepopOrder = {
      purchase_id: opts.purchaseId ?? String(this.nextId++),
      status: opts.status ?? "SHIPPING_PENDING",
      currency: product.body.price_currency,
      buyer_pays_amount: (Number(product.body.price_amount) * quantity).toFixed(2),
      buyer_address: { name: "Jordan Buyer" },
      line_items: Array.from({ length: quantity }, () => ({
        sku,
        product_id: product.productId,
        description: product.body.description,
        sold_price: product.body.price_amount,
      })),
      created_at: new Date(this.now()).toISOString(),
    };
    this.orders.unshift(order);
    return order;
  }

  /** Change le statut d'une commande (annulation, remboursement…). */
  setOrderStatus(purchaseId: string, status: DepopOrderStatus) {
    const order = this.orders.find((o) => o.purchase_id === purchaseId);
    if (order) order.status = status;
    return order;
  }

  /** Expire tous les jetons d'accès (tests du rafraîchissement). */
  expireAccessTokens() {
    for (const token of this.accessTokens.keys()) this.accessTokens.set(token, 0);
  }

  /** Révoque tout (tests : le vendeur a retiré l'accès). */
  revokeAll() {
    this.accessTokens.clear();
    this.refreshTokens.clear();
  }

  /** Adaptateur `fetch` pour DepopClient : URL de base quelconque, seul le chemin compte. */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const path = url.pathname.replace(/^.*?(\/api\/v1\/)/, "$1");
    const res = this.handle({ method: init?.method ?? "GET", path, headers, body: init?.body as string | undefined, query: url.searchParams });
    return new Response(res.body === undefined ? null : JSON.stringify(res.body), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  };

  handle(req: FakeRequest): FakeResponse {
    if (req.method === "POST" && req.path === "/api/v1/oauth2/access-token/") return this.token(req.body ?? "");

    const auth = req.headers.authorization ?? req.headers.Authorization;
    const token = auth?.replace(/^Bearer\s+/i, "");
    const exp = token ? this.accessTokens.get(token) : undefined;
    if (!token || exp === undefined || exp <= this.now()) return error(401, "unauthorized", "Invalid or expired access token");

    if (req.method === "GET" && req.path === "/api/v1/shop/") {
      return { status: 200, body: { id: 97082934, username: FAKE_DEPOP_USERNAME, country_code: "US" } };
    }

    if (req.method === "GET" && req.path === "/api/v1/orders/") return this.listOrders(req.query ?? new URLSearchParams());
    if (req.method === "POST" && req.path === "/api/v1/webhooks/") return this.createWebhook(req.body ?? "");

    const m = req.path.match(/^\/api\/v1\/products\/by-sku\/([^/]+)\/(mark-as-sold\/)?$/);
    if (!m) return error(404, "not_found", `No route for ${req.method} ${req.path}`);
    const sku = decodeURIComponent(m[1]!);

    if (m[2]) {
      if (req.method !== "POST") return error(405, "method_not_allowed", "Use POST");
      const p = this.products.get(sku);
      if (!p) return error(404, "product_not_found", `Product (sku: ${sku}) not found`);
      p.status = "sold";
      return { status: 200 };
    }
    if (req.method === "DELETE") {
      this.products.delete(sku);
      return { status: 200 };
    }
    if (req.method === "PUT") return this.put(sku, req.body ?? "");
    return error(405, "method_not_allowed", `Method ${req.method} not allowed`);
  }

  private listOrders(query: URLSearchParams): FakeResponse {
    const from = query.get("from") ? Date.parse(query.get("from")!) : 0;
    const limit = Math.min(Number(query.get("limit") ?? 20), 200);
    const cursor = query.get("cursor");
    let list = this.orders.filter((o) => Date.parse(o.created_at) >= from);
    if (cursor) list = list.slice(list.findIndex((o) => o.purchase_id === cursor) + 1);
    const page = list.slice(0, limit);
    return { status: 200, body: { meta: { cursor: page.at(-1)?.purchase_id ?? null, has_more: list.length > limit }, data: page } };
  }

  private createWebhook(raw: string): FakeResponse {
    const body = JSON.parse(raw || "{}") as { url?: string; event_types?: string[] };
    if (!body.url?.startsWith("https://")) return error(400, "invalid_url", "The URL must be a public HTTPS endpoint");
    if (this.webhooks.some((w) => w.url === body.url)) return error(409, "webhook_exists", "This URL is already registered");
    const hook = { id: randomToken(8), url: body.url, secret: randomToken(24), eventTypes: body.event_types ?? [] };
    this.webhooks.push(hook);
    return { status: 200, body: { id: hook.id, url: hook.url, enabled: true, event_types: hook.eventTypes, secret: hook.secret } };
  }

  private token(raw: string): FakeResponse {
    const p = new URLSearchParams(raw);
    if (p.get("client_id") !== FAKE_DEPOP_CLIENT_ID || p.get("client_secret") !== FAKE_DEPOP_CLIENT_SECRET) {
      return oauthError(401, "client secret does not match", "Depop OAuth2 error");
    }
    if (p.get("grant_type") === "authorization_code") {
      const code = this.codes.get(p.get("code") ?? "");
      this.codes.delete(p.get("code") ?? "");
      if (!code || code.expiresAt <= this.now() || code.redirectUri !== p.get("redirect_uri")) {
        return oauthError(400, "invalid_grant", "The provided authorization grant is invalid or expired");
      }
      if (pkceChallenge(p.get("code_verifier") ?? "") !== code.challenge) {
        return oauthError(400, "invalid_request", "PKCE verification failed");
      }
      return this.issue();
    }
    if (p.get("grant_type") === "refresh_token") {
      const rt = p.get("refresh_token") ?? "";
      if (!this.refreshTokens.delete(rt)) return oauthError(400, "invalid_grant", "The refresh token is invalid, expired or revoked");
      return this.issue();
    }
    return oauthError(400, "unsupported_grant_type", "Unsupported grant type");
  }

  private issue(): FakeResponse {
    const access = `pat_${randomToken(16)}`;
    const refresh = `prt_${randomToken(16)}`;
    this.accessTokens.set(access, this.now() + 3600_000);
    this.refreshTokens.add(refresh);
    return { status: 200, body: { access_token: access, refresh_token: refresh, expires_in: 3600, token_type: "Bearer" } };
  }

  private put(sku: string, raw: string): FakeResponse {
    if (this.failNextPut) {
      const res = this.failNextPut;
      this.failNextPut = null;
      return res;
    }
    let body: DepopProductBody;
    try {
      body = JSON.parse(raw) as DepopProductBody;
    } catch {
      return error(400, "invalid_json", "Body must be JSON");
    }
    const missing = (["address", "description", "price_amount", "quantity", "pictures", "department", "product_type", "condition", "brand_name"] as const).find(
      (k) => body[k] === undefined || body[k] === "",
    );
    if (missing) return error(422, "missing_attribute", `Missing mandatory field: ${missing}`);
    if (body.pictures.length < 1 || body.pictures.length > 8) {
      return error(422, "too_many_pictures", "Between 1 and 8 pictures are required");
    }
    if (Number(body.price_amount) < 1) return error(422, "invalid_price", "Price must be at least $1.00");
    if (body.description.length > 1000) return error(422, "invalid_description", "Description is limited to 1000 characters");

    const existing = this.products.get(sku);
    const productId = existing?.productId ?? this.nextId++;
    const slug = existing?.slug ?? `${FAKE_DEPOP_USERNAME}-${productId}`;
    this.products.set(sku, { productId, slug, status: "selling", body });
    return { status: 200, body: { product_id: productId, slug, sku } };
  }
}
