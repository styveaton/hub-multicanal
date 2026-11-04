/**
 * Client de l'Open API v3 d'Etsy (https://developers.etsy.com/documentation/reference).
 * OAuth 2.0 avec PKCE ; chaque appel porte x-api-key = « keystring:shared_secret ».
 * `fetch` est injectable : le faux Etsy des tests et du mode local s'y branche.
 */

import { ChannelApiError } from "../listing.js";

/** Droits demandés au vendeur (shops_w : créer un profil de préparation s'il n'en a pas). */
export const ETSY_SCOPES = ["listings_r", "listings_w", "listings_d", "shops_r", "shops_w", "transactions_r"] as const;

/** Propriétés de variation personnalisées d'Etsy (3 au plus). */
export const ETSY_CUSTOM_PROPERTY_IDS = [513, 514, 516] as const;

export interface EtsyTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

export interface EtsyShop {
  shop_id: number;
  shop_name: string;
  currency_code: string;
  url: string;
}

export interface EtsyShippingProfile {
  shipping_profile_id: number;
  title: string;
}

export interface EtsyProcessingProfile {
  readiness_state_id: number;
  readiness_state: string;
  min_processing_days?: number;
  max_processing_days?: number;
}

/** Champs d'une annonce envoyés en formulaire (createDraftListing / updateListing). */
export interface EtsyListingFields {
  title: string;
  description: string;
  who_made: string;
  when_made: string;
  taxonomy_id: number;
  shipping_profile_id: number;
  is_supply: boolean;
  type: "physical";
  tags?: string[];
}

export interface EtsyListing {
  listing_id: number;
  state: "active" | "inactive" | "sold_out" | "draft" | "removed" | "expired";
  url?: string;
}

export interface EtsyInventoryProduct {
  sku: string;
  property_values: Array<{ property_id: number; property_name: string; values: string[]; value_ids: number[] }>;
  offerings: Array<{ price: number; quantity: number; is_enabled: boolean; readiness_state_id: number }>;
}

export interface EtsyInventory {
  products: EtsyInventoryProduct[];
  price_on_property: number[];
  quantity_on_property: number[];
  sku_on_property: number[];
  readiness_state_on_property: number[];
}

export interface EtsyMoney {
  amount: number;
  divisor: number;
  currency_code: string;
}

/** Commande Etsy (« receipt »), champs utilisés par OmniList. */
export interface EtsyReceipt {
  receipt_id: number;
  status: "paid" | "completed" | "open" | "payment processing" | "canceled" | "fully refunded" | "partially refunded";
  is_paid: boolean;
  is_shipped: boolean;
  name?: string;
  buyer_user_id?: number;
  created_timestamp: number;
  updated_timestamp: number;
  grandtotal?: EtsyMoney;
  transactions: Array<{ transaction_id: number; listing_id: number; sku?: string; title: string; quantity: number; price: EtsyMoney }>;
}

export interface EtsyTaxonomyNode {
  id: number;
  name: string;
  level: number;
  children: EtsyTaxonomyNode[];
}

export interface EtsyPhoto {
  data: Uint8Array;
  contentType: string;
  filename: string;
}

export interface EtsyClientOptions {
  keystring: string;
  sharedSecret: string;
  /** https://api.etsy.com (ou le faux Etsy). */
  apiBaseUrl: string;
  /** https://www.etsy.com/oauth/connect : page d'accord, vue par le navigateur du vendeur. */
  authorizeUrl: string;
  fetch?: typeof fetch;
}

const APP = "/v3/application";

export class EtsyClient {
  private readonly fetchImpl: typeof fetch;
  private taxonomy: EtsyTaxonomyNode[] | null = null;

  constructor(private readonly opts: EtsyClientOptions) {
    this.fetchImpl = opts.fetch ?? fetch;
  }

  /** Page d'accord Etsy (PKCE S256 obligatoire). */
  authorizeUrl(params: { state: string; redirectUri: string; codeChallenge: string; scopes?: readonly string[] }): string {
    const q = new URLSearchParams({
      response_type: "code",
      client_id: this.opts.keystring,
      redirect_uri: params.redirectUri,
      scope: (params.scopes ?? ETSY_SCOPES).join(" "),
      state: params.state,
      code_challenge: params.codeChallenge,
      code_challenge_method: "S256",
    });
    return `${this.opts.authorizeUrl}?${q}`;
  }

  exchangeCode(code: string, redirectUri: string, codeVerifier: string): Promise<EtsyTokens> {
    return this.token({ grant_type: "authorization_code", client_id: this.opts.keystring, redirect_uri: redirectUri, code, code_verifier: codeVerifier });
  }

  /** Nouveau couple de jetons (accès : 1 h ; rafraîchissement : 90 jours). */
  refresh(refreshToken: string): Promise<EtsyTokens> {
    return this.token({ grant_type: "refresh_token", client_id: this.opts.keystring, refresh_token: refreshToken });
  }

  /** Le jeton commence par l'identifiant du vendeur ; /users/me donne aussi sa boutique. */
  getMe(token: string): Promise<{ user_id: number; shop_id: number }> {
    return this.call("GET", `${APP}/users/me`, token);
  }

  getShop(token: string, shopId: number): Promise<EtsyShop> {
    return this.call("GET", `${APP}/shops/${shopId}`, token);
  }

  async getShippingProfiles(token: string, shopId: number): Promise<EtsyShippingProfile[]> {
    const res = await this.call<{ results?: EtsyShippingProfile[] }>("GET", `${APP}/shops/${shopId}/shipping-profiles`, token);
    return res.results ?? [];
  }

  async getProcessingProfiles(token: string, shopId: number): Promise<EtsyProcessingProfile[]> {
    const res = await this.call<{ results?: EtsyProcessingProfile[] }>("GET", `${APP}/shops/${shopId}/readiness-state-definitions`, token);
    return res.results ?? [];
  }

  /** Profil de préparation « prêt à expédier sous 1 à 3 jours », pour une boutique qui n'en a pas. */
  createProcessingProfile(token: string, shopId: number): Promise<EtsyProcessingProfile> {
    return this.call("POST", `${APP}/shops/${shopId}/readiness-state-definitions`, token, {
      form: toForm({ readiness_state: "ready_to_ship", min_processing_time: 1, max_processing_time: 3, processing_time_unit: "days" }),
    });
  }

  /** Brouillon d'annonce ; il devient visible une fois activé (avec au moins une photo). */
  createDraftListing(token: string, shopId: number, fields: EtsyListingFields & { quantity: number; price: number; readiness_state_id: number }) {
    return this.call<EtsyListing>("POST", `${APP}/shops/${shopId}/listings`, token, { form: toForm(fields) });
  }

  updateListing(token: string, shopId: number, listingId: number, fields: Partial<EtsyListingFields> & { state?: "active" | "inactive" }) {
    return this.call<EtsyListing>("PATCH", `${APP}/shops/${shopId}/listings/${listingId}`, token, { form: toForm(fields) });
  }

  /** Supprime l'annonce. Réussit si elle n'existe plus. */
  async deleteListing(token: string, listingId: number): Promise<void> {
    try {
      await this.call("DELETE", `${APP}/listings/${listingId}`, token);
    } catch (err) {
      if (!(err instanceof ChannelApiError && err.status === 404)) throw err;
    }
  }

  /** Remplace tout l'inventaire (variantes, prix, quantités, SKU) de l'annonce. */
  updateInventory(token: string, listingId: number, inventory: EtsyInventory) {
    return this.call<unknown>("PUT", `${APP}/listings/${listingId}/inventory`, token, { json: inventory });
  }

  async uploadImage(token: string, shopId: number, listingId: number, photo: EtsyPhoto, rank: number): Promise<number> {
    const form = new FormData();
    form.set("image", new Blob([new Uint8Array(photo.data)], { type: photo.contentType }), photo.filename);
    form.set("rank", String(rank));
    const res = await this.call<{ listing_image_id: number }>("POST", `${APP}/shops/${shopId}/listings/${listingId}/images`, token, { multipart: form });
    return res.listing_image_id;
  }

  async deleteImage(token: string, shopId: number, listingId: number, imageId: number): Promise<void> {
    try {
      await this.call("DELETE", `${APP}/shops/${shopId}/listings/${listingId}/images/${imageId}`, token);
    } catch (err) {
      if (!(err instanceof ChannelApiError && err.status === 404)) throw err;
    }
  }

  /** Commandes modifiées depuis une date (100 au plus par page). */
  listReceipts(token: string, shopId: number, params: { modifiedSince: Date; offset?: number; limit?: number }) {
    const q = new URLSearchParams({
      min_last_modified: String(Math.floor(params.modifiedSince.getTime() / 1000)),
      limit: String(params.limit ?? 100),
      offset: String(params.offset ?? 0),
      sort_on: "updated",
      sort_order: "asc",
    });
    return this.call<{ count: number; results: EtsyReceipt[] }>("GET", `${APP}/shops/${shopId}/receipts?${q}`, token);
  }

  /**
   * Catégorie Etsy pour un texte : numéro direct, sinon la catégorie la plus précise dont le nom
   * apparaît dans le texte (« Veste en jean » → … › Coats & Jackets si le texte est en anglais).
   */
  async findTaxonomyId(text: string): Promise<number | null> {
    if (/^\d+$/.test(text.trim())) return Number(text.trim());
    if (!this.taxonomy) {
      const res = await this.call<{ results: EtsyTaxonomyNode[] }>("GET", `${APP}/seller-taxonomy/nodes`, null);
      this.taxonomy = res.results;
    }
    const words = text.toLowerCase();
    let best: { id: number; score: number } | null = null;
    const visit = (nodes: EtsyTaxonomyNode[]) => {
      for (const n of nodes) {
        const name = n.name.toLowerCase();
        // Nom entier, ou chaque mot du nom (« Coats & Jackets » : « jacket »), au singulier.
        const parts = name.split(/[^a-z0-9]+/).filter((w) => w.length > 2).map((w) => w.replace(/s$/, ""));
        const hit = words.includes(name) || (parts.length > 0 && parts.some((w) => new RegExp(`\\b${w}s?\\b`).test(words)));
        if (hit) {
          const score = n.level * 10 + (words.includes(name) ? 5 : 0);
          if (!best || score > best.score) best = { id: n.id, score };
        }
        visit(n.children ?? []);
      }
    };
    visit(this.taxonomy);
    return (best as { id: number } | null)?.id ?? null;
  }

  private async token(params: Record<string, string>): Promise<EtsyTokens> {
    const res = await this.send(`${this.opts.apiBaseUrl.replace(/\/$/, "")}/v3/public/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams(params).toString(),
    });
    return (await this.parse(res)) as EtsyTokens;
  }

  private async call<T>(
    method: string,
    path: string,
    token: string | null,
    body?: { form?: URLSearchParams; json?: unknown; multipart?: FormData },
  ): Promise<T> {
    const headers: Record<string, string> = {
      "x-api-key": `${this.opts.keystring}:${this.opts.sharedSecret}`,
      accept: "application/json",
    };
    if (token) headers.authorization = `Bearer ${token}`;
    let payload: BodyInit | undefined;
    if (body?.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      payload = body.form.toString();
    } else if (body?.json !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body.json);
    } else if (body?.multipart) {
      payload = body.multipart;
    }
    const res = await this.send(`${this.opts.apiBaseUrl.replace(/\/$/, "")}${path}`, { method, headers, body: payload });
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
    // Formats d'erreur Etsy : { error } ou OAuth { error, error_description }.
    const j = (json ?? {}) as { error?: string; error_description?: string };
    const code = res.status === 401 ? "unauthorized" : res.status === 404 ? "not_found" : `etsy_${res.status}`;
    const message = j.error_description ?? j.error ?? (text.slice(0, 300) || res.statusText);
    throw new ChannelApiError(res.status, j.error === "invalid_grant" ? "invalid_grant" : code, message, res.status === 429 || res.status >= 500);
  }
}

/** Champs → formulaire ; les tableaux sont envoyés séparés par des virgules (format Etsy). */
function toForm(fields: object): URLSearchParams {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    form.set(k, Array.isArray(v) ? v.join(",") : String(v));
  }
  return form;
}
