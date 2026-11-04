/**
 * Client des API REST eBay utilisées par OmniList :
 * - OAuth (jeton du vendeur + jeton d'application) ;
 * - Sell Inventory (articles, groupes de variantes, offres, emplacement) et Sell Account (règles de vente) ;
 * - Sell Fulfillment (commandes), Commerce Identity (compte), Taxonomy (catégorie suggérée) ;
 * - Notification (clé publique des avis « suppression de compte »).
 * `fetch` est injectable : le faux eBay des tests et du mode local s'y branche.
 */

import { createHash, verify as verifySignature } from "node:crypto";
import { ChannelApiError } from "../listing.js";

/** Droits demandés au vendeur. */
export const EBAY_SCOPES = [
  "https://api.ebay.com/oauth/api_scope",
  "https://api.ebay.com/oauth/api_scope/sell.inventory",
  "https://api.ebay.com/oauth/api_scope/sell.account",
  "https://api.ebay.com/oauth/api_scope/sell.fulfillment",
  "https://api.ebay.com/oauth/api_scope/commerce.identity.readonly",
] as const;

/** Jeton d'application (catégories, clés publiques des notifications). */
const APP_SCOPE = "https://api.ebay.com/oauth/api_scope";

export const EBAY_MARKETPLACE = "EBAY_US";

export interface EbayTokens {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  refresh_token_expires_in: number;
}

export interface EbayUser {
  userId: string;
  username: string;
}

export interface EbayPolicy {
  id: string;
  name: string;
}

export interface EbayPolicies {
  fulfillment: EbayPolicy[];
  payment: EbayPolicy[];
  return: EbayPolicy[];
}

/** État ou code postal d'où partent les colis (emplacement de stock eBay). */
export interface EbayLocationInput {
  postalCode: string;
  name: string;
}

/** Corps de createOrReplaceInventoryItem (champs utilisés par OmniList). */
export interface EbayInventoryItem {
  product: {
    title: string;
    description: string;
    aspects: Record<string, string[]>;
    imageUrls: string[];
    brand?: string;
  };
  condition: string;
  availability: { shipToLocationAvailability: { quantity: number } };
}

/** Corps de createOrReplaceInventoryItemGroup (fiche à variantes). */
export interface EbayItemGroup {
  title: string;
  description: string;
  imageUrls: string[];
  aspects: Record<string, string[]>;
  variantSKUs: string[];
  variesBy: { aspectsImageVariesBy: string[]; specifications: Array<{ name: string; values: string[] }> };
}

/** Corps de createOffer / updateOffer. */
export interface EbayOfferInput {
  sku: string;
  marketplaceId: string;
  format: "FIXED_PRICE";
  availableQuantity: number;
  categoryId: string;
  listingDescription: string;
  merchantLocationKey: string;
  listingPolicies: { fulfillmentPolicyId: string; paymentPolicyId: string; returnPolicyId: string };
  pricingSummary: { price: { value: string; currency: string } };
}

export interface EbayOffer {
  offerId: string;
  sku: string;
  status: "PUBLISHED" | "UNPUBLISHED";
  listing?: { listingId?: string; listingStatus?: string };
}

export interface EbayMoney {
  value: string;
  currency: string;
}

/** Commande eBay (champs utilisés par OmniList). */
export interface EbayOrder {
  orderId: string;
  creationDate: string;
  lastModifiedDate: string;
  orderPaymentStatus: "PAID" | "PENDING" | "FAILED" | "FULLY_REFUNDED" | "PARTIALLY_REFUNDED";
  orderFulfillmentStatus: "NOT_STARTED" | "IN_PROGRESS" | "FULFILLED";
  cancelStatus?: { cancelState: "NONE_REQUESTED" | "IN_PROGRESS" | "CANCELED" };
  buyer?: { username?: string };
  fulfillmentStartInstructions?: Array<{ shippingStep?: { shipTo?: { fullName?: string } } }>;
  pricingSummary?: { total?: EbayMoney };
  lineItems: Array<{ lineItemId: string; sku?: string; title: string; quantity: number; lineItemCost: EbayMoney; legacyItemId?: string }>;
}

export interface EbayOrdersPage {
  orders: EbayOrder[];
  total: number;
  next?: string;
}

export interface EbayPublicKey {
  key: string;
  algorithm: string;
  digest: string;
}

export interface EbayClientOptions {
  clientId: string;
  clientSecret: string;
  /** « RuName » : nom eBay de l'adresse de retour déclarée dans le portail développeur. */
  ruName: string;
  /** api.ebay.com (ou sandbox, ou faux eBay). */
  apiBaseUrl: string;
  /** apiz.ebay.com : API Identity. */
  apizBaseUrl: string;
  /** auth.ebay.com : page d'accord du vendeur (vue par son navigateur). */
  authBaseUrl: string;
  /** Site des annonces : https://www.ebay.com ou https://sandbox.ebay.com. */
  siteUrl: string;
  fetch?: typeof fetch;
}

const INVENTORY = "/sell/inventory/v1";

export class EbayClient {
  private readonly fetchImpl: typeof fetch;
  private appToken: { value: string; expiresAt: number } | null = null;
  private readonly keys = new Map<string, EbayPublicKey>();

  constructor(private readonly opts: EbayClientOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /** Page publique d'une annonce. */
  listingUrl(listingId: string): string {
    return `${this.opts.siteUrl.replace(/\/$/, "")}/itm/${listingId}`;
  }

  /** Page d'accord eBay : le vendeur se connecte et autorise OmniList. */
  authorizeUrl(state: string, scopes: readonly string[] = EBAY_SCOPES): string {
    const q = new URLSearchParams({
      client_id: this.opts.clientId,
      response_type: "code",
      redirect_uri: this.opts.ruName,
      scope: scopes.join(" "),
      state,
    });
    return `${this.opts.authBaseUrl.replace(/\/$/, "")}/oauth2/authorize?${q}`;
  }

  /** Code reçu après l'accord → jeton d'accès (2 h) et jeton de rafraîchissement (18 mois). */
  exchangeCode(code: string): Promise<EbayTokens> {
    return this.token({ grant_type: "authorization_code", code, redirect_uri: this.opts.ruName }) as Promise<EbayTokens>;
  }

  /** Nouveau jeton d'accès ; le jeton de rafraîchissement reste le même. */
  refresh(refreshToken: string, scopes: readonly string[] = EBAY_SCOPES): Promise<{ access_token: string; expires_in: number }> {
    return this.token({ grant_type: "refresh_token", refresh_token: refreshToken, scope: scopes.join(" ") });
  }

  /** Jeton d'application (client credentials), gardé jusqu'à 5 minutes avant son expiration. */
  async applicationToken(): Promise<string> {
    if (this.appToken && this.appToken.expiresAt - Date.now() > 300_000) return this.appToken.value;
    const t = await this.token({ grant_type: "client_credentials", scope: APP_SCOPE });
    this.appToken = { value: t.access_token, expiresAt: Date.now() + t.expires_in * 1000 };
    return t.access_token;
  }

  getUser(token: string): Promise<EbayUser> {
    return this.call("GET", `${this.opts.apizBaseUrl}/commerce/identity/v1/user/`, token);
  }

  /** Règles de vente (expédition, paiement, retours) : le vendeur doit y avoir souscrit. */
  async optInPolicies(token: string): Promise<void> {
    try {
      await this.call("POST", `${this.api}/sell/account/v1/program/opt_in`, token, { programType: "SELLING_POLICY_MANAGEMENT" });
    } catch (err) {
      // Déjà inscrit : eBay répond 409.
      if (!(err instanceof ChannelApiError && err.status === 409)) throw err;
    }
  }

  async getPolicies(token: string): Promise<EbayPolicies> {
    const list = async (kind: "fulfillment" | "payment" | "return") => {
      const res = await this.call<Record<string, Array<Record<string, string>> | undefined>>(
        "GET",
        `${this.api}/sell/account/v1/${kind}_policy?marketplace_id=${EBAY_MARKETPLACE}`,
        token,
      );
      return (res[`${kind}Policies`] ?? []).map((p) => ({ id: p[`${kind}PolicyId`]!, name: p.name ?? "" }));
    };
    return { fulfillment: await list("fulfillment"), payment: await list("payment"), return: await list("return") };
  }

  /** Crée ou met à jour l'emplacement de stock (adresse d'expédition). */
  async upsertLocation(token: string, key: string, input: EbayLocationInput): Promise<void> {
    const path = `${this.api}${INVENTORY}/location/${encodeURIComponent(key)}`;
    const address = { postalCode: input.postalCode, country: "US" };
    try {
      await this.call("POST", path, token, { location: { address }, locationTypes: ["WAREHOUSE"], name: input.name, merchantLocationStatus: "ENABLED" });
    } catch (err) {
      // Déjà créé : on met l'adresse à jour.
      if (!(err instanceof ChannelApiError && err.status === 409)) throw err;
      await this.call("POST", `${path}/update_location_details`, token, { location: { address }, name: input.name });
    }
  }

  async putInventoryItem(token: string, sku: string, item: EbayInventoryItem): Promise<void> {
    await this.call("PUT", `${this.api}${INVENTORY}/inventory_item/${encodeURIComponent(sku)}`, token, item);
  }

  /** Supprime l'article, ses offres et met fin à l'annonce. Réussit s'il n'existe plus. */
  async deleteInventoryItem(token: string, sku: string): Promise<void> {
    await this.ignore404(() => this.call("DELETE", `${this.api}${INVENTORY}/inventory_item/${encodeURIComponent(sku)}`, token));
  }

  async putItemGroup(token: string, key: string, group: EbayItemGroup): Promise<void> {
    await this.call("PUT", `${this.api}${INVENTORY}/inventory_item_group/${encodeURIComponent(key)}`, token, group);
  }

  async deleteItemGroup(token: string, key: string): Promise<void> {
    await this.ignore404(() => this.call("DELETE", `${this.api}${INVENTORY}/inventory_item_group/${encodeURIComponent(key)}`, token));
  }

  /** Offre existante pour ce SKU sur eBay US, ou null. */
  async findOffer(token: string, sku: string): Promise<EbayOffer | null> {
    try {
      const res = await this.call<{ offers?: EbayOffer[] }>(
        "GET",
        `${this.api}${INVENTORY}/offer?sku=${encodeURIComponent(sku)}&marketplace_id=${EBAY_MARKETPLACE}`,
        token,
      );
      return res.offers?.[0] ?? null;
    } catch (err) {
      if (err instanceof ChannelApiError && err.status === 404) return null;
      throw err;
    }
  }

  async createOffer(token: string, offer: EbayOfferInput): Promise<string> {
    const res = await this.call<{ offerId: string }>("POST", `${this.api}${INVENTORY}/offer`, token, offer);
    return res.offerId;
  }

  async updateOffer(token: string, offerId: string, offer: EbayOfferInput): Promise<void> {
    await this.call("PUT", `${this.api}${INVENTORY}/offer/${encodeURIComponent(offerId)}`, token, offer);
  }

  async publishOffer(token: string, offerId: string): Promise<string> {
    const res = await this.call<{ listingId: string }>("POST", `${this.api}${INVENTORY}/offer/${encodeURIComponent(offerId)}/publish`, token);
    return res.listingId;
  }

  async publishGroup(token: string, groupKey: string): Promise<string> {
    const res = await this.call<{ listingId: string }>("POST", `${this.api}${INVENTORY}/offer/publish_by_inventory_item_group`, token, {
      inventoryItemGroupKey: groupKey,
      marketplaceId: EBAY_MARKETPLACE,
    });
    return res.listingId;
  }

  /** Met fin à l'annonce ; l'offre reste, prête à être republiée. */
  async withdrawOffer(token: string, offerId: string): Promise<void> {
    await this.ignore404(() => this.call("POST", `${this.api}${INVENTORY}/offer/${encodeURIComponent(offerId)}/withdraw`, token));
  }

  async withdrawGroup(token: string, groupKey: string): Promise<void> {
    await this.ignore404(() =>
      this.call("POST", `${this.api}${INVENTORY}/offer/withdraw_by_inventory_item_group`, token, {
        inventoryItemGroupKey: groupKey,
        marketplaceId: EBAY_MARKETPLACE,
      }),
    );
  }

  /** Catégorie la plus probable pour un titre (arbre eBay US), ou null. */
  async suggestCategory(query: string): Promise<string | null> {
    const res = await this.withAppToken((token) =>
      this.call<{ categorySuggestions?: Array<{ category: { categoryId: string } }> }>(
        "GET",
        `${this.api}/commerce/taxonomy/v1/category_tree/0/get_category_suggestions?q=${encodeURIComponent(query.slice(0, 100))}`,
        token,
      ),
    );
    return res.categorySuggestions?.[0]?.category.categoryId ?? null;
  }

  /** Appel avec le jeton d'application ; s'il est refusé (révoqué, expiré plus tôt que prévu), un nouveau est demandé. */
  private async withAppToken<T>(fn: (token: string) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.applicationToken());
    } catch (err) {
      if (!(err instanceof ChannelApiError && err.status === 401)) throw err;
      this.appToken = null;
      return fn(await this.applicationToken());
    }
  }

  /** Commandes modifiées depuis une date (200 au plus par page). */
  listOrders(token: string, params: { modifiedSince: Date; offset?: number; limit?: number }): Promise<EbayOrdersPage> {
    const q = new URLSearchParams({
      filter: `lastmodifieddate:[${params.modifiedSince.toISOString()}..]`,
      limit: String(params.limit ?? 200),
      offset: String(params.offset ?? 0),
    });
    return this.call("GET", `${this.api}/sell/fulfillment/v1/order?${q}`, token);
  }

  /** Clé publique d'un avis eBay (gardée en mémoire : elle ne change pas). */
  async publicKey(kid: string): Promise<EbayPublicKey> {
    const cached = this.keys.get(kid);
    if (cached) return cached;
    const key = await this.withAppToken((token) =>
      this.call<EbayPublicKey>("GET", `${this.api}/commerce/notification/v1/public_key/${encodeURIComponent(kid)}`, token),
    );
    this.keys.set(kid, key);
    return key;
  }

  private get api() {
    return this.opts.apiBaseUrl.replace(/\/$/, "");
  }

  private async ignore404(fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (err) {
      if (!(err instanceof ChannelApiError && err.status === 404)) throw err;
    }
  }

  private async token(params: Record<string, string>): Promise<{ access_token: string; expires_in: number } & Partial<EbayTokens>> {
    const basic = Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString("base64");
    const res = await this.send(`${this.api}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(params).toString(),
    });
    return (await this.parse(res)) as { access_token: string; expires_in: number };
  }

  private async call<T>(method: string, url: string, token: string, body?: unknown): Promise<T> {
    const res = await this.send(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "accept-language": "en-US",
        "x-ebay-c-marketplace-id": EBAY_MARKETPLACE,
        ...(body !== undefined ? { "content-type": "application/json", "content-language": "en-US" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return (await this.parse(res)) as T;
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
    // Formats d'erreur eBay : { errors: [{ errorId, message, longMessage }] } ou OAuth { error, error_description }.
    const j = (json ?? {}) as { errors?: Array<{ errorId?: number; message?: string; longMessage?: string }>; error?: string; error_description?: string };
    const first = j.errors?.[0];
    const code = first?.errorId ? `ebay_${first.errorId}` : (j.error ?? (res.status === 401 ? "unauthorized" : `http_${res.status}`));
    const message = first?.longMessage ?? first?.message ?? j.error_description ?? (text.slice(0, 300) || res.statusText);
    throw new ChannelApiError(res.status, code, message, res.status === 429 || res.status >= 500);
  }
}

// ---------------------------------------------------------------------------
// Avis « suppression de compte » (Marketplace Account Deletion)
// ---------------------------------------------------------------------------

/** Réponse au défi d'eBay : SHA-256 hexadécimal de challengeCode + jeton de vérification + adresse. */
export const ebayChallengeResponse = (challengeCode: string, verificationToken: string, endpoint: string) =>
  createHash("sha256").update(challengeCode).update(verificationToken).update(endpoint).digest("hex");

/** En-tête X-EBAY-SIGNATURE : JSON en base64 { alg, kid, signature, digest }. */
export function parseEbaySignature(header: string | undefined): { kid: string; signature: string; digest: string } | null {
  if (!header) return null;
  try {
    const j = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { kid?: string; signature?: string; digest?: string };
    return j.kid && j.signature ? { kid: j.kid, signature: j.signature, digest: j.digest ?? "SHA1" } : null;
  } catch {
    return null;
  }
}

/** eBay renvoie la clé sur une seule ligne : on la remet au format PEM. */
function toPem(key: string): string {
  const body = key
    .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");
  return `-----BEGIN PUBLIC KEY-----\n${body.match(/.{1,64}/g)?.join("\n")}\n-----END PUBLIC KEY-----\n`;
}

/** Vérifie la signature ECDSA d'un avis eBay sur le corps brut. */
export function verifyEbayNotification(rawBody: string, sig: { signature: string; digest: string }, key: EbayPublicKey): boolean {
  try {
    return verifySignature(sig.digest.replace("-", "").toLowerCase(), Buffer.from(rawBody), toPem(key.key), Buffer.from(sig.signature, "base64"));
  } catch {
    return false;
  }
}
