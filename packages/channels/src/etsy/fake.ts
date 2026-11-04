import { pkceChallenge, randomToken } from "../crypto.js";
import type { EtsyInventory, EtsyReceipt, EtsyTaxonomyNode } from "./client.js";

/**
 * Faux Etsy en mémoire : reproduit OAuth (PKCE), les annonces, photos, inventaire, profils et
 * commandes de l'Open API v3 utilisés par OmniList, pour les tests et le mode local (ETSY_ENV=fake).
 */

export const FAKE_ETSY_KEYSTRING = "fakeetsykeystring";
export const FAKE_ETSY_SECRET = "fakeetsysecret";
export const FAKE_ETSY_USER_ID = 51234567;
export const FAKE_ETSY_SHOP_ID = 31234567;
export const FAKE_ETSY_SHOP_NAME = "OmniListVintage";

export interface FakeEtsyListing {
  listing_id: number;
  shop_id: number;
  state: "draft" | "active" | "inactive" | "sold_out";
  fields: Record<string, string>;
  images: Array<{ listing_image_id: number; size: number; rank: number }>;
  inventory: EtsyInventory | null;
}

/** Petit arbre de catégories, à l'image de celui d'Etsy. */
export const FAKE_ETSY_TAXONOMY: EtsyTaxonomyNode[] = [
  {
    id: 1,
    name: "Clothing",
    level: 1,
    children: [
      { id: 448, name: "Coats & Jackets", level: 2, children: [] },
      { id: 559, name: "T-shirts", level: 2, children: [] },
    ],
  },
  { id: 2, name: "Home & Living", level: 1, children: [] },
];

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fail = (status: number, error: string) => json(status, { error });

export class FakeEtsy {
  readonly listings = new Map<number, FakeEtsyListing>();
  readonly receipts: EtsyReceipt[] = [];
  /** Boutique sans profil d'expédition (tests). */
  noShippingProfile = false;
  /** Compte Etsy sans boutique (tests) : /users/me répond 404 comme le vrai Etsy. */
  noShop = false;
  readonly processingProfiles: Array<{ readiness_state_id: number; readiness_state: string }> = [];
  private readonly codes = new Map<string, { challenge: string; redirectUri: string; expiresAt: number }>();
  private readonly accessTokens = new Map<string, number>();
  private readonly refreshTokens = new Set<string>();
  private nextId = 1_500_000_000;

  constructor(private readonly now: () => number = Date.now) {}

  /** Page d'accord : le faux vendeur accepte toujours. Renvoie l'adresse de retour. */
  authorize(query: URLSearchParams): string {
    const redirectUri = query.get("redirect_uri") ?? "";
    const back = new URL(redirectUri);
    back.searchParams.set("state", query.get("state") ?? "");
    if (query.get("client_id") !== FAKE_ETSY_KEYSTRING || query.get("code_challenge_method") !== "S256") {
      back.searchParams.set("error", "invalid_request");
      return back.toString();
    }
    const code = `fake_etsy_${randomToken(12)}`;
    this.codes.set(code, { challenge: query.get("code_challenge") ?? "", redirectUri, expiresAt: this.now() + 5 * 60_000 });
    back.searchParams.set("code", code);
    return back.toString();
  }

  /** Annonce d'un SKU (tests). */
  bySku(sku: string) {
    for (const l of this.listings.values()) {
      const product = l.inventory?.products.find((p) => p.sku === sku);
      if (product) return { listing: l, product };
    }
    return null;
  }

  /** Vente sur Etsy : décompte la quantité et crée la commande payée. */
  simulateSale(sku: string, opts: { quantity?: number; paid?: boolean } = {}): EtsyReceipt {
    const found = this.bySku(sku);
    if (!found || found.listing.state !== "active") throw new Error(`Annonce inconnue sur le faux Etsy : ${sku}`);
    const quantity = opts.quantity ?? 1;
    const offering = found.product.offerings[0]!;
    offering.quantity = Math.max(0, offering.quantity - quantity);
    const total = found.listing.inventory!.products.reduce((n, p) => n + (p.offerings[0]?.quantity ?? 0), 0);
    if (total === 0) found.listing.state = "sold_out";
    const ts = Math.floor(this.now() / 1000);
    const price = { amount: Math.round(offering.price * 100), divisor: 100, currency_code: "USD" };
    const paid = opts.paid ?? true;
    const receipt: EtsyReceipt = {
      receipt_id: this.nextId++,
      status: paid ? "paid" : "payment processing",
      is_paid: paid,
      is_shipped: false,
      name: "Casey Buyer",
      buyer_user_id: 77001,
      created_timestamp: ts,
      updated_timestamp: ts,
      grandtotal: { ...price, amount: price.amount * quantity },
      transactions: [{ transaction_id: this.nextId++, listing_id: found.listing.listing_id, sku, title: found.listing.fields.title ?? "", quantity, price }],
    };
    this.receipts.push(receipt);
    return receipt;
  }

  /** Change une commande (paiement reçu, annulation, remboursement, expédition). */
  updateReceipt(receiptId: number, patch: Partial<Pick<EtsyReceipt, "status" | "is_paid" | "is_shipped">>) {
    const r = this.receipts.find((x) => x.receipt_id === receiptId);
    if (r) Object.assign(r, patch, { updated_timestamp: Math.floor(this.now() / 1000) });
    return r;
  }

  expireAccessTokens() {
    for (const t of this.accessTokens.keys()) this.accessTokens.set(t, 0);
  }

  revokeAll() {
    this.accessTokens.clear();
    this.refreshTokens.clear();
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const path = url.pathname.replace(/^.*?\/v3\//, "/v3/");
    return this.handle(init?.method ?? "GET", path, headers, init?.body ?? null, url.searchParams);
  };

  async handle(method: string, path: string, headers: Record<string, string | undefined>, body: BodyInit | null, query: URLSearchParams): Promise<Response> {
    if (method === "POST" && path === "/v3/public/oauth/token") return this.token(String(body ?? ""));
    if (headers["x-api-key"] !== `${FAKE_ETSY_KEYSTRING}:${FAKE_ETSY_SECRET}`) return fail(403, "Invalid API key: must be keystring:shared_secret");
    if (method === "GET" && path === "/v3/application/seller-taxonomy/nodes") return json(200, { count: FAKE_ETSY_TAXONOMY.length, results: FAKE_ETSY_TAXONOMY });

    const token = headers.authorization?.replace(/^Bearer\s+/i, "");
    const exp = token ? this.accessTokens.get(token) : undefined;
    if (!token || exp === undefined || exp <= this.now()) return fail(401, "invalid_token");
    const form = () => new URLSearchParams(typeof body === "string" ? body : "");

    if (method === "GET" && path === "/v3/application/users/me" && this.noShop) {
      return fail(404, `Could not find a shop for User with user_id = ${FAKE_ETSY_USER_ID}`);
    }
    if (method === "GET" && path === "/v3/application/users/me") return json(200, { user_id: FAKE_ETSY_USER_ID, shop_id: FAKE_ETSY_SHOP_ID });
    const shop = `/v3/application/shops/${FAKE_ETSY_SHOP_ID}`;
    if (method === "GET" && path === shop) {
      return json(200, { shop_id: FAKE_ETSY_SHOP_ID, shop_name: FAKE_ETSY_SHOP_NAME, currency_code: "USD", url: `https://www.etsy.com/shop/${FAKE_ETSY_SHOP_NAME}` });
    }
    if (!path.startsWith(shop) && !path.startsWith("/v3/application/listings/")) return fail(404, `No route for ${method} ${path}`);

    if (method === "GET" && path === `${shop}/receipts`) return this.receiptsPage(query);
    if (method === "GET" && path === `${shop}/shipping-profiles`) {
      const results = this.noShippingProfile ? [] : [{ shipping_profile_id: 900001, title: "USA standard" }];
      return json(200, { count: results.length, results });
    }
    if (path === `${shop}/readiness-state-definitions`) {
      if (method === "GET") return json(200, { count: this.processingProfiles.length, results: this.processingProfiles });
      if (method === "POST") {
        const f = form();
        if (!f.get("readiness_state") || !f.get("min_processing_time") || !f.get("max_processing_time")) return fail(400, "Missing processing time");
        const profile = { readiness_state_id: this.nextId++, readiness_state: f.get("readiness_state")! };
        this.processingProfiles.push(profile);
        return json(201, { shop_id: FAKE_ETSY_SHOP_ID, ...profile });
      }
    }

    if (method === "POST" && path === `${shop}/listings`) {
      const f = Object.fromEntries(form());
      const missing = ["quantity", "title", "description", "price", "who_made", "when_made", "taxonomy_id", "shipping_profile_id", "readiness_state_id"].find((k) => !f[k]);
      if (missing) return fail(400, `${missing} is required`);
      if (f.title!.length > 140) return fail(400, "Title must be 140 characters or less");
      const listing: FakeEtsyListing = { listing_id: this.nextId++, shop_id: FAKE_ETSY_SHOP_ID, state: "draft", fields: f, images: [], inventory: null };
      this.listings.set(listing.listing_id, listing);
      return json(201, this.view(listing));
    }

    const m = path.match(/^\/v3\/application\/(?:shops\/\d+\/)?listings\/(\d+)(\/images(?:\/(\d+))?|\/inventory)?$/);
    const listing = m ? this.listings.get(Number(m[1])) : undefined;
    if (!m || !listing) return fail(404, "Listing not found");

    if (!m[2]) {
      if (method === "DELETE") {
        this.listings.delete(listing.listing_id);
        return json(204);
      }
      if (method === "PATCH") {
        const f = Object.fromEntries(form());
        if (f.state === "active") {
          if (listing.images.length === 0) return fail(400, "An active listing must have at least one image");
          const qty = listing.inventory?.products.reduce((n, p) => n + p.offerings.filter((o) => o.is_enabled).reduce((a, o) => a + o.quantity, 0), 0) ?? 0;
          if (qty <= 0) return fail(400, "Cannot activate a listing with no quantity");
        }
        const { state, ...rest } = f;
        Object.assign(listing.fields, rest);
        if (state) listing.state = state as FakeEtsyListing["state"];
        return json(200, this.view(listing));
      }
    }
    if (m[2] === "/inventory" && method === "PUT") {
      const inv = JSON.parse(String(body ?? "{}")) as EtsyInventory;
      if (!inv.products?.length) return fail(400, "products is required");
      for (const p of inv.products) {
        const o = p.offerings?.[0];
        if (!o || o.price < 0.2) return fail(400, "Price must be at least 0.20");
        if (o.is_enabled && o.quantity < 1) return fail(400, "Enabled offerings need a quantity of at least 1");
        if (!o.readiness_state_id) return fail(400, "readiness_state_id is required on offerings of physical listings");
      }
      if (inv.products.every((p) => !p.offerings[0]!.is_enabled)) return fail(400, "At least one offering must be enabled");
      listing.inventory = inv;
      if (listing.state === "sold_out") listing.state = "active";
      return json(200, inv);
    }
    if (m[2]?.startsWith("/images")) {
      if (method === "POST" && !m[3]) {
        const f = body instanceof FormData ? body : null;
        const image = f?.get("image");
        if (!(image instanceof Blob) || image.size === 0) return fail(400, "image is required");
        if (listing.images.length >= 10) return fail(400, "A listing can have at most 10 images");
        const img = { listing_image_id: this.nextId++, size: image.size, rank: Number(f!.get("rank") ?? 1) };
        listing.images.push(img);
        return json(201, { listing_id: listing.listing_id, ...img });
      }
      if (method === "DELETE" && m[3]) {
        listing.images = listing.images.filter((i) => i.listing_image_id !== Number(m[3]));
        return json(204);
      }
    }

    return fail(404, `No route for ${method} ${path}`);
  }

  private receiptsPage(query: URLSearchParams): Response {
    const since = Number(query.get("min_last_modified") ?? 0);
    const limit = Number(query.get("limit") ?? 25);
    const offset = Number(query.get("offset") ?? 0);
    const list = this.receipts.filter((r) => r.updated_timestamp >= since);
    return json(200, { count: list.length, results: list.slice(offset, offset + limit) });
  }

  private view(l: FakeEtsyListing) {
    return { listing_id: l.listing_id, state: l.state, url: `https://www.etsy.com/listing/${l.listing_id}` };
  }

  private token(raw: string): Response {
    const p = new URLSearchParams(raw);
    if (p.get("client_id") !== FAKE_ETSY_KEYSTRING) return json(401, { error: "invalid_client", error_description: "Unknown client" });
    if (p.get("grant_type") === "authorization_code") {
      const code = this.codes.get(p.get("code") ?? "");
      this.codes.delete(p.get("code") ?? "");
      if (!code || code.expiresAt <= this.now() || code.redirectUri !== p.get("redirect_uri")) {
        return json(400, { error: "invalid_grant", error_description: "code is invalid or expired" });
      }
      if (pkceChallenge(p.get("code_verifier") ?? "") !== code.challenge) {
        return json(400, { error: "invalid_grant", error_description: "code_verifier is invalid" });
      }
      return this.issue();
    }
    if (p.get("grant_type") === "refresh_token") {
      if (!this.refreshTokens.delete(p.get("refresh_token") ?? "")) return json(400, { error: "invalid_grant", error_description: "refresh_token is invalid" });
      return this.issue();
    }
    return json(400, { error: "unsupported_grant_type" });
  }

  private issue(): Response {
    const access = `${FAKE_ETSY_USER_ID}.fake_${randomToken(16)}`;
    const refresh = `${FAKE_ETSY_USER_ID}.fakerefresh_${randomToken(16)}`;
    this.accessTokens.set(access, this.now() + 3600_000);
    this.refreshTokens.add(refresh);
    return json(200, { access_token: access, refresh_token: refresh, expires_in: 3600, token_type: "Bearer" });
  }
}
