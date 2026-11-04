import { generateKeyPairSync, sign } from "node:crypto";
import { randomToken } from "../crypto.js";
import type { EbayInventoryItem, EbayItemGroup, EbayOfferInput, EbayOrder } from "./client.js";

/**
 * Faux eBay en mémoire : reproduit OAuth et les appels Inventory / Account / Fulfillment / Taxonomy /
 * Notification utilisés par OmniList, pour les tests et le mode local (EBAY_ENV=fake).
 * Ne valide que ce dont OmniList a besoin, avec les mêmes formats d'erreur qu'eBay.
 */

export const FAKE_EBAY_CLIENT_ID = "fake-ebay-client";
export const FAKE_EBAY_CLIENT_SECRET = "fake-ebay-secret";
export const FAKE_EBAY_USERNAME = "omnilist_seller";
export const FAKE_EBAY_KID = "fake-ebay-key-1";

interface FakeOffer extends EbayOfferInput {
  offerId: string;
  status: "PUBLISHED" | "UNPUBLISHED";
  listingId?: string;
}

const res = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const err = (status: number, errorId: number, message: string) =>
  res(status, { errors: [{ errorId, domain: "API_INVENTORY", category: "REQUEST", message, longMessage: message }] });
const oauthErr = (status: number, error: string, description: string) => res(status, { error, error_description: description });

export class FakeEbay {
  readonly items = new Map<string, EbayInventoryItem>();
  readonly groups = new Map<string, EbayItemGroup>();
  readonly offers = new Map<string, FakeOffer>();
  readonly locations = new Map<string, { postalCode: string }>();
  readonly orders: EbayOrder[] = [];
  /** Le vendeur n'a pas encore créé ses règles de vente (tests). */
  noPolicies = false;
  optedIn = false;
  private readonly codes = new Map<string, number>(); // code → expiration
  private readonly accessTokens = new Map<string, number>();
  private readonly refreshTokens = new Set<string>();
  private readonly keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  private nextId = 110_000_000_000;

  constructor(private readonly now: () => number = Date.now) {}

  /** Page d'accord eBay : le faux vendeur accepte toujours. Renvoie l'adresse de retour (le RuName). */
  authorize(query: URLSearchParams): string {
    const back = new URL(query.get("redirect_uri") ?? "");
    back.searchParams.set("state", query.get("state") ?? "");
    if (query.get("client_id") !== FAKE_EBAY_CLIENT_ID || query.get("response_type") !== "code") {
      back.searchParams.set("error", "invalid_request");
      return back.toString();
    }
    const code = `v^1.1#fake_${randomToken(12)}`;
    this.codes.set(code, this.now() + 5 * 60_000);
    back.searchParams.set("code", code);
    back.searchParams.set("expires_in", "299");
    return back.toString();
  }

  /** Vente sur eBay (tests et démonstration) : décompte le stock de l'offre et crée la commande payée. */
  simulateSale(sku: string, opts: { quantity?: number; orderId?: string; paymentStatus?: EbayOrder["orderPaymentStatus"] } = {}): EbayOrder {
    const offer = [...this.offers.values()].find((o) => o.sku === sku && o.status === "PUBLISHED");
    const item = this.items.get(sku);
    if (!offer || !item) throw new Error(`Annonce inconnue sur le faux eBay : ${sku}`);
    const quantity = opts.quantity ?? 1;
    offer.availableQuantity = Math.max(0, offer.availableQuantity - quantity);
    item.availability.shipToLocationAvailability.quantity = offer.availableQuantity;
    const date = new Date(this.now()).toISOString();
    const price = offer.pricingSummary.price;
    const order: EbayOrder = {
      orderId: opts.orderId ?? `27-${String(this.nextId).slice(-10, -5)}-${String(this.nextId++).slice(-5)}`,
      creationDate: date,
      lastModifiedDate: date,
      orderPaymentStatus: opts.paymentStatus ?? "PAID",
      orderFulfillmentStatus: "NOT_STARTED",
      cancelStatus: { cancelState: "NONE_REQUESTED" },
      buyer: { username: "jordan_buys" },
      fulfillmentStartInstructions: [{ shippingStep: { shipTo: { fullName: "Jordan Buyer" } } }],
      pricingSummary: { total: { value: (Number(price.value) * quantity).toFixed(2), currency: price.currency } },
      lineItems: [
        {
          lineItemId: String(this.nextId++),
          sku,
          title: item.product.title,
          quantity,
          lineItemCost: { value: (Number(price.value) * quantity).toFixed(2), currency: price.currency },
          legacyItemId: offer.listingId,
        },
      ],
    };
    this.orders.unshift(order);
    return order;
  }

  /** Modifie une commande (annulation, remboursement, expédition…) et sa date de modification. */
  updateOrder(orderId: string, patch: Partial<Pick<EbayOrder, "orderPaymentStatus" | "orderFulfillmentStatus" | "cancelStatus">>) {
    const order = this.orders.find((o) => o.orderId === orderId);
    if (order) Object.assign(order, patch, { lastModifiedDate: new Date(this.now()).toISOString() });
    return order;
  }

  /** Offre publiée d'un SKU (tests). */
  offerBySku(sku: string) {
    return [...this.offers.values()].find((o) => o.sku === sku);
  }

  expireAccessTokens() {
    for (const t of this.accessTokens.keys()) this.accessTokens.set(t, 0);
  }

  revokeAll() {
    this.accessTokens.clear();
    this.refreshTokens.clear();
  }

  /** Avis eBay signé comme le vrai : en-tête X-EBAY-SIGNATURE pour ce corps. */
  signNotification(rawBody: string): string {
    const signature = sign("sha1", Buffer.from(rawBody), this.keys.privateKey).toString("base64");
    return Buffer.from(JSON.stringify({ alg: "ECDSA", kid: FAKE_EBAY_KID, signature, digest: "SHA1" })).toString("base64");
  }

  /** Adaptateur `fetch` pour EbayClient : seule la fin du chemin compte. */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const path = url.pathname.replace(/^.*?\/(identity|commerce|sell)\//, "/$1/");
    return this.handle(init?.method ?? "GET", path, headers, (init?.body as string | undefined) ?? "", url.searchParams);
  };

  handle(method: string, path: string, headers: Record<string, string | undefined>, body: string, query: URLSearchParams): Response {
    if (method === "POST" && path === "/identity/v1/oauth2/token") return this.token(headers.authorization, body);

    const token = headers.authorization?.replace(/^Bearer\s+/i, "");
    const exp = token ? this.accessTokens.get(token) : undefined;
    if (!token || exp === undefined || exp <= this.now()) return err(401, 1001, "Invalid access token");
    const json = () => JSON.parse(body || "{}");

    if (method === "GET" && path === "/commerce/identity/v1/user/") return res(200, { userId: "fakeUser123", username: FAKE_EBAY_USERNAME, accountType: "INDIVIDUAL" });
    if (method === "GET" && path.startsWith("/commerce/taxonomy/v1/category_tree/0/get_category_suggestions")) {
      return res(200, { categorySuggestions: [{ category: { categoryId: "57988", categoryName: "Coats, Jackets & Vests" } }] });
    }
    const kid = path.match(/^\/commerce\/notification\/v1\/public_key\/(.+)$/)?.[1];
    if (method === "GET" && kid) {
      if (decodeURIComponent(kid) !== FAKE_EBAY_KID) return err(404, 195000, "Key not found");
      const pem = this.keys.publicKey.export({ type: "spki", format: "pem" }).toString().replace(/\n/g, "");
      return res(200, { algorithm: "ECDSA", digest: "SHA1", key: pem });
    }

    // Règles de vente
    if (method === "POST" && path === "/sell/account/v1/program/opt_in") {
      if (this.optedIn) return err(409, 20409, "Already opted in");
      this.optedIn = true;
      return res(200, {});
    }
    const policy = path.match(/^\/sell\/account\/v1\/(fulfillment|payment|return)_policy$/)?.[1];
    if (method === "GET" && policy) {
      const list = this.noPolicies || !this.optedIn ? [] : [{ [`${policy}PolicyId`]: `${policy}-6200`, name: `Default ${policy}` }];
      return res(200, { total: list.length, [`${policy}Policies`]: list });
    }

    // Emplacement de stock
    const loc = path.match(/^\/sell\/inventory\/v1\/location\/([^/]+)(\/update_location_details)?$/);
    if (method === "POST" && loc) {
      const key = decodeURIComponent(loc[1]!);
      const address = (json() as { location?: { address?: { postalCode?: string } } }).location?.address;
      if (!address?.postalCode) return err(400, 25802, "Input error. The postal code is required.");
      if (!loc[2] && this.locations.has(key)) return err(409, 25803, `Location ${key} already exists`);
      if (loc[2] && !this.locations.has(key)) return err(404, 25804, `Location ${key} not found`);
      this.locations.set(key, { postalCode: address.postalCode });
      return res(204);
    }

    // Articles et groupes
    const item = path.match(/^\/sell\/inventory\/v1\/inventory_item\/([^/]+)$/);
    if (item) {
      const sku = decodeURIComponent(item[1]!);
      if (method === "PUT") {
        const it = json() as EbayInventoryItem;
        if (!it.product?.title || it.product.title.length > 80) return err(400, 25718, "The title is missing or longer than 80 characters.");
        if (!it.product.imageUrls?.length) return err(400, 25711, "At least one image is required.");
        this.items.set(sku, it);
        return res(204);
      }
      if (method === "DELETE") {
        if (!this.items.delete(sku)) return err(404, 25702, `SKU ${sku} not found`);
        for (const [id, o] of this.offers) if (o.sku === sku) this.offers.delete(id);
        for (const g of this.groups.values()) g.variantSKUs = g.variantSKUs.filter((s) => s !== sku);
        return res(204);
      }
    }
    const group = path.match(/^\/sell\/inventory\/v1\/inventory_item_group\/([^/]+)$/);
    if (group) {
      const key = decodeURIComponent(group[1]!);
      if (method === "PUT") {
        const g = json() as EbayItemGroup;
        const missing = g.variantSKUs.find((s) => !this.items.has(s));
        if (missing) return err(400, 25705, `SKU ${missing} not found`);
        this.groups.set(key, g);
        return res(204);
      }
      if (method === "DELETE") return this.groups.delete(key) ? res(204) : err(404, 25705, "Group not found");
    }

    // Offres
    if (method === "GET" && path === "/sell/inventory/v1/offer") {
      const list = [...this.offers.values()].filter((o) => o.sku === query.get("sku"));
      if (list.length === 0) return err(404, 25713, "This Offer is not available.");
      return res(200, { offers: list.map((o) => ({ ...o, listing: o.listingId ? { listingId: o.listingId } : undefined })) });
    }
    if (method === "POST" && path === "/sell/inventory/v1/offer") {
      const o = json() as EbayOfferInput;
      if (!this.items.has(o.sku)) return err(400, 25702, `SKU ${o.sku} not found`);
      if ([...this.offers.values()].some((x) => x.sku === o.sku)) return err(400, 25002, "Offer entity already exists.");
      const offerId = String(this.nextId++);
      this.offers.set(offerId, { ...o, offerId, status: "UNPUBLISHED" });
      return res(201, { offerId });
    }
    if (method === "POST" && path === "/sell/inventory/v1/offer/publish_by_inventory_item_group") {
      const { inventoryItemGroupKey } = json() as { inventoryItemGroupKey: string };
      const g = this.groups.get(inventoryItemGroupKey);
      if (!g) return err(404, 25705, "Group not found");
      const offers = g.variantSKUs.map((s) => this.offerBySku(s));
      if (offers.some((o) => !o)) return err(400, 25016, "Every variant needs an offer.");
      const problem = offers.map((o) => this.publishable(o!)).find(Boolean);
      if (problem) return problem;
      if (offers.every((o) => o!.availableQuantity <= 0)) return err(400, 25017, "The quantity must be greater than 0.");
      const listingId = offers.find((o) => o!.listingId && o!.status === "PUBLISHED")?.listingId ?? String(this.nextId++);
      for (const o of offers) Object.assign(o!, { status: "PUBLISHED", listingId });
      return res(200, { listingId });
    }
    if (method === "POST" && path === "/sell/inventory/v1/offer/withdraw_by_inventory_item_group") {
      const { inventoryItemGroupKey } = json() as { inventoryItemGroupKey: string };
      const g = this.groups.get(inventoryItemGroupKey);
      if (!g) return err(404, 25705, "Group not found");
      for (const s of g.variantSKUs) {
        const o = this.offerBySku(s);
        if (o) Object.assign(o, { status: "UNPUBLISHED", listingId: undefined });
      }
      return res(200, {});
    }
    const offer = path.match(/^\/sell\/inventory\/v1\/offer\/([^/]+)(\/publish|\/withdraw)?$/);
    if (offer) {
      const o = this.offers.get(decodeURIComponent(offer[1]!));
      if (!o) return err(404, 25713, "This Offer is not available.");
      if (method === "PUT" && !offer[2]) {
        Object.assign(o, json() as EbayOfferInput);
        const it = this.items.get(o.sku);
        if (it) it.availability.shipToLocationAvailability.quantity = o.availableQuantity;
        return res(204);
      }
      if (method === "POST" && offer[2] === "/publish") {
        const problem = this.publishable(o);
        if (problem) return problem;
        if (o.availableQuantity <= 0) return err(400, 25017, "The quantity must be greater than 0.");
        o.status = "PUBLISHED";
        o.listingId ??= String(this.nextId++);
        return res(200, { listingId: o.listingId });
      }
      if (method === "POST" && offer[2] === "/withdraw") {
        Object.assign(o, { status: "UNPUBLISHED", listingId: undefined });
        return res(200, {});
      }
    }

    // Commandes
    if (method === "GET" && path === "/sell/fulfillment/v1/order") {
      const since = Date.parse(query.get("filter")?.match(/lastmodifieddate:\[(.+?)\.\.\]/)?.[1] ?? "") || 0;
      const offset = Number(query.get("offset") ?? 0);
      const limit = Number(query.get("limit") ?? 50);
      const list = this.orders.filter((o) => Date.parse(o.lastModifiedDate) >= since);
      const page = list.slice(offset, offset + limit);
      return res(200, { total: list.length, orders: page, ...(offset + limit < list.length ? { next: "more" } : {}) });
    }

    return err(404, 2002, `No route for ${method} ${path}`);
  }

  /** Ce qu'eBay vérifie à la publication : emplacement, règles de vente, catégorie. */
  private publishable(o: FakeOffer): Response | null {
    if (!this.locations.has(o.merchantLocationKey)) return err(400, 25802, "Valid merchantLocationKey is required.");
    if (!o.listingPolicies?.fulfillmentPolicyId || !o.listingPolicies.paymentPolicyId || !o.listingPolicies.returnPolicyId) {
      return err(400, 25007, "Valid listing policies are required.");
    }
    if (!o.categoryId) return err(400, 25005, "Valid category is required.");
    return null;
  }

  private token(authorization: string | undefined, raw: string): Response {
    const basic = Buffer.from(`${FAKE_EBAY_CLIENT_ID}:${FAKE_EBAY_CLIENT_SECRET}`).toString("base64");
    if (authorization !== `Basic ${basic}`) return oauthErr(401, "invalid_client", "client authentication failed");
    const p = new URLSearchParams(raw);
    const grant = p.get("grant_type");
    if (grant === "client_credentials") return this.issue(false);
    if (grant === "authorization_code") {
      const exp = this.codes.get(p.get("code") ?? "");
      this.codes.delete(p.get("code") ?? "");
      if (!exp || exp <= this.now()) return oauthErr(400, "invalid_grant", "the provided authorization grant code is invalid or was issued to another client");
      return this.issue(true);
    }
    if (grant === "refresh_token") {
      if (!this.refreshTokens.has(p.get("refresh_token") ?? "")) return oauthErr(400, "invalid_grant", "the provided authorization refresh token is invalid or was issued to another client");
      return this.issue(false);
    }
    return oauthErr(400, "unsupported_grant_type", "grant type in request is not supported by the authorization server");
  }

  private issue(withRefresh: boolean): Response {
    const access = `v^1.1#i^1#fake_${randomToken(16)}`;
    this.accessTokens.set(access, this.now() + 7200_000);
    const body: Record<string, unknown> = { access_token: access, expires_in: 7200, token_type: "User Access Token" };
    if (withRefresh) {
      const refresh = `v^1.1#r^1#fake_${randomToken(16)}`;
      this.refreshTokens.add(refresh);
      Object.assign(body, { refresh_token: refresh, refresh_token_expires_in: 47304000 });
    }
    return res(200, body);
  }
}
