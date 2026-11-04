import type { ChannelConnection, OrderStatus } from "@hub/db";
import { CHANNEL_TITLE_MAX, ETSY_MAX_IMAGES, etsyIssues, type EtsyDetails } from "@hub/shared";
import { recordOrder, type OrderInput, type StockChange } from "../inventory.js";
import {
  ChannelApiError,
  NotConnectedError,
  RetryableChannelError,
  asChannelError,
  findConnection,
  isOnChannel,
  loadProduct,
  logChannel,
  markAll,
  optionsOf,
  photosKey,
  placedBeforeConnection,
  priceRule,
  saveListing,
  sellableItems,
  type ChannelDeps,
  type LoadedProduct,
  type SellableItem,
} from "../listing.js";
import { ETSY_CUSTOM_PROPERTY_IDS, type EtsyInventory, type EtsyListingFields, type EtsyPhoto, type EtsyReceipt } from "./client.js";

/**
 * Etsy : une fiche OmniList = une annonce Etsy ; les variantes sont les produits de son inventaire
 * (jusqu'à 3 options personnalisées). Le stock Etsy est toujours remis au stock central.
 */

const CH = "ETSY" as const;

export interface EtsySettings {
  shopId?: number;
  shopName?: string;
  currency?: string;
  shippingProfileId?: number;
  readinessStateId?: number;
}

interface EtsyMeta {
  taxonomyId?: number;
  photosKey?: string;
  imageIds?: number[];
}

const settingsOf = (c: ChannelConnection) => (c.settings ?? {}) as EtsySettings;
const metaOf = (l: { externalMeta: unknown } | undefined) => (l?.externalMeta ?? {}) as EtsyMeta;
export const etsyListingUrl = (listingId: number | string) => `https://www.etsy.com/listing/${listingId}`;

// ---------------------------------------------------------------------------
// Jetons
// ---------------------------------------------------------------------------

/** Jeton d'accès valide (1 h). Etsy renvoie un nouveau jeton de rafraîchissement à chaque fois. */
export async function etsyAccessToken(deps: ChannelDeps, connection: ChannelConnection): Promise<string> {
  const now = deps.now?.() ?? new Date();
  if (connection.status !== "CONNECTED") throw new NotConnectedError();
  if (connection.accessTokenExpiresAt && connection.accessTokenExpiresAt.getTime() - now.getTime() > 60_000) {
    return deps.cipher.decrypt(connection.accessTokenEnc);
  }
  if (!connection.refreshTokenEnc) throw new NotConnectedError();
  try {
    const tokens = await deps.etsy.refresh(deps.cipher.decrypt(connection.refreshTokenEnc));
    const data = {
      accessTokenEnc: deps.cipher.encrypt(tokens.access_token),
      refreshTokenEnc: deps.cipher.encrypt(tokens.refresh_token),
      accessTokenExpiresAt: new Date(now.getTime() + tokens.expires_in * 1000),
    };
    await deps.prisma.channelConnection.update({ where: { id: connection.id }, data });
    Object.assign(connection, data);
    return tokens.access_token;
  } catch (err) {
    if (err instanceof ChannelApiError && !err.retryable) {
      // Jeton de rafraîchissement expiré (90 jours sans activité) ou accès retiré.
      await deps.prisma.channelConnection.update({ where: { id: connection.id }, data: { status: "NEEDS_REAUTH" } });
      throw new NotConnectedError();
    }
    throw err;
  }
}

async function handleUnauthorized(deps: ChannelDeps, connection: ChannelConnection, err: unknown) {
  if (err instanceof ChannelApiError && err.status === 401) {
    await deps.prisma.channelConnection.update({ where: { id: connection.id }, data: { status: "NEEDS_REAUTH" } });
  }
}

/** Photo d'une fiche : Etsy veut le fichier lui-même. Par défaut, lue par son lien signé. */
async function loadPhoto(deps: ChannelDeps, photoId: string): Promise<EtsyPhoto> {
  if (deps.loadPhoto) return deps.loadPhoto(photoId);
  const res = await fetch(deps.media.url(photoId));
  if (!res.ok) throw new ChannelApiError(res.status, "photo_unavailable", `Photo ${photoId} illisible (${res.status})`, true);
  const contentType = res.headers.get("content-type") ?? "image/jpeg";
  return { data: new Uint8Array(await res.arrayBuffer()), contentType, filename: `${photoId}.${contentType.split("/")[1] ?? "jpg"}` };
}

// ---------------------------------------------------------------------------
// Annonces
// ---------------------------------------------------------------------------

const price = (cents: number) => Math.round(cents) / 100;

/** Inventaire Etsy : un produit par SKU ; les options de la fiche deviennent des variations personnalisées. */
export function buildEtsyInventory(items: SellableItem[], readinessStateId: number): EtsyInventory {
  const options = optionsOf(items).slice(0, ETSY_CUSTOM_PROPERTY_IDS.length);
  const propertyIds = options.map((_, i) => ETSY_CUSTOM_PROPERTY_IDS[i]!);
  return {
    products: items.map((item) => ({
      sku: item.sku,
      property_values: options.map((o, i) => ({
        property_id: propertyIds[i]!,
        property_name: o.name,
        values: [item.attributes?.[o.name] ?? "-"],
        value_ids: [],
      })),
      // Variante épuisée : masquée aux acheteurs ; l'annonce reste en ligne pour les autres.
      offerings: [{ price: price(item.priceCents), quantity: Math.max(0, item.quantity), is_enabled: item.quantity > 0, readiness_state_id: readinessStateId }],
    })),
    price_on_property: propertyIds,
    quantity_on_property: propertyIds,
    sku_on_property: propertyIds,
    readiness_state_on_property: [],
  };
}

/** Profil d'expédition et profil de préparation de la boutique, choisis une fois puis gardés. */
async function prepareShop(deps: ChannelDeps, connection: ChannelConnection, token: string): Promise<Required<Pick<EtsySettings, "shopId" | "shippingProfileId" | "readinessStateId">> | string> {
  const s = settingsOf(connection);
  if (!s.shopId) return "needs_reauth";
  const next = { ...s };
  if (!next.shippingProfileId) {
    const profiles = await deps.etsy.getShippingProfiles(token, s.shopId);
    if (!profiles[0]) return "etsy_shipping_profile_missing";
    next.shippingProfileId = profiles[0].shipping_profile_id;
  }
  if (!next.readinessStateId) {
    const existing = await deps.etsy.getProcessingProfiles(token, s.shopId);
    next.readinessStateId = (existing.find((r) => r.readiness_state === "ready_to_ship") ?? existing[0] ?? (await deps.etsy.createProcessingProfile(token, s.shopId))).readiness_state_id;
  }
  if (next.shippingProfileId !== s.shippingProfileId || next.readinessStateId !== s.readinessStateId) {
    await deps.prisma.channelConnection.update({ where: { id: connection.id }, data: { settings: { ...next } } });
    connection.settings = { ...next };
  }
  return { shopId: next.shopId!, shippingProfileId: next.shippingProfileId!, readinessStateId: next.readinessStateId! };
}

export async function publishToEtsy(deps: ChannelDeps, productId: string) {
  const p = await loadProduct(deps, productId, CH);
  if (!p) return;
  const settings = p.channels[0];
  const items = sellableItems(p, priceRule(settings));
  const skus = items.map((i) => i.sku);

  const connection = await findConnection(deps, p.organizationId, CH);
  if (!connection) return markAll(deps, CH, p, skus, "not_connected", null);
  let token: string;
  try {
    token = await etsyAccessToken(deps, connection);
  } catch (err) {
    if (err instanceof NotConnectedError) return markAll(deps, CH, p, skus, "needs_reauth", null);
    throw new RetryableChannelError((err as Error).message);
  }
  const shopId = settingsOf(connection).shopId;
  const live = p.listings.filter(isOnChannel);
  const listingId = Number(live[0]?.externalId ?? p.listings.find((l) => l.externalId)?.externalId ?? 0) || null;

  try {
    // Canal désactivé : l'annonce passe « inactive » (cachée, historique gardé).
    if (!settings?.enabled) {
      if (listingId && shopId && live.length > 0) await deps.etsy.updateListing(token, shopId, listingId, { state: "inactive" });
      for (const l of p.listings.filter((x) => x.status !== "REMOVED")) {
        await saveListing(deps, CH, p.organizationId, l.skuCode, { productId: p.id, status: "REMOVED", errorCode: null, errorMessage: null });
        if (isOnChannel(l)) await logChannel(deps, CH, { organizationId: p.organizationId, productId: p.id, skuCode: l.skuCode, ok: true, message: "removed" });
      }
      return;
    }

    const title = settings.title?.trim() || p.title;
    const details = (settings.details ?? {}) as EtsyDetails;
    if (items.some((i) => !i.sku)) return markAll(deps, CH, p, skus, "listing_incomplete", "sku_missing");
    if (title.length > CHANNEL_TITLE_MAX.ETSY) return markAll(deps, CH, p, skus, "listing_incomplete", "title_too_long");
    if (p.photos.length === 0) return markAll(deps, CH, p, skus, "listing_incomplete", "photos_missing");
    const issue = etsyIssues({ details, items })[0];
    if (issue) return markAll(deps, CH, p, skus, "listing_incomplete", issue.code);

    // Plus rien en stock : l'annonce passe « inactive » ; un réassort la remet en ligne.
    if (items.every((i) => i.quantity <= 0)) {
      if (listingId && shopId && live.length > 0) await deps.etsy.updateListing(token, shopId, listingId, { state: "inactive" });
      for (const sku of skus) {
        const was = p.listings.find((l) => l.skuCode === sku);
        await saveListing(deps, CH, p.organizationId, sku, { productId: p.id, status: "REMOVED", errorCode: "out_of_stock", errorMessage: null });
        if (was && isOnChannel(was)) await logChannel(deps, CH, { organizationId: p.organizationId, productId: p.id, skuCode: sku, ok: true, message: "out_of_stock" });
      }
      return;
    }

    const shop = await prepareShop(deps, connection, token);
    if (typeof shop === "string") return markAll(deps, CH, p, skus, shop, null);

    // Catégorie : numéro saisi, ou recherche dans l'arbre Etsy (texte saisi, sinon titre).
    const typed = settings.category?.trim() || null;
    const used = typed ? null : (p.listings.map((l) => metaOf(l).taxonomyId).find(Boolean) ?? null);
    const taxonomyId = used ?? (await deps.etsy.findTaxonomyId(typed ?? title));
    if (!taxonomyId) return markAll(deps, CH, p, skus, "listing_incomplete", "category_missing");

    const fields: EtsyListingFields = {
      title,
      description: p.description.trim(),
      who_made: details.whoMade!,
      when_made: details.whenMade!,
      taxonomy_id: taxonomyId,
      shipping_profile_id: shop.shippingProfileId,
      is_supply: false,
      type: "physical",
    };

    let id = listingId;
    if (id) {
      try {
        await deps.etsy.updateListing(token, shop.shopId, id, fields);
      } catch (err) {
        // Annonce supprimée à la main sur Etsy : on en crée une nouvelle.
        if (!(err instanceof ChannelApiError && err.status === 404)) throw err;
        id = null;
      }
    }
    const created = !id;
    if (!id) {
      const first = items.find((i) => i.quantity > 0)!;
      id = (
        await deps.etsy.createDraftListing(token, shop.shopId, {
          ...fields,
          quantity: first.quantity,
          price: price(first.priceCents),
          readiness_state_id: shop.readinessStateId,
        })
      ).listing_id;
    }

    // Photos : renvoyées seulement si elles ont changé (Etsy veut les fichiers eux-mêmes).
    const key = photosKey(p);
    const meta = metaOf(p.listings.find((l) => l.externalId === String(id)));
    let imageIds = meta.imageIds ?? [];
    if (created || meta.photosKey !== key) {
      for (const old of created ? [] : imageIds) await deps.etsy.deleteImage(token, shop.shopId, id, old);
      imageIds = [];
      for (const [i, ph] of p.photos.slice(0, ETSY_MAX_IMAGES).entries()) {
        imageIds.push(await deps.etsy.uploadImage(token, shop.shopId, id, await loadPhoto(deps, ph.id), i + 1));
      }
    }

    await deps.etsy.updateInventory(token, id, buildEtsyInventory(items, shop.readinessStateId));
    if (created || live.length === 0) await deps.etsy.updateListing(token, shop.shopId, id, { state: "active" });

    // Variantes retirées de la fiche : elles ont disparu de l'inventaire Etsy.
    for (const l of p.listings.filter((x) => !skus.includes(x.skuCode) && isOnChannel(x))) {
      await saveListing(deps, CH, p.organizationId, l.skuCode, { productId: p.id, status: "REMOVED", errorCode: null, errorMessage: null });
      await logChannel(deps, CH, { organizationId: p.organizationId, productId: p.id, skuCode: l.skuCode, ok: true, message: "removed" });
    }

    const now = deps.now?.() ?? new Date();
    for (const item of items) {
      const existing = p.listings.find((l) => l.skuCode === item.sku);
      await saveListing(deps, CH, p.organizationId, item.sku, {
        productId: p.id,
        status: "LISTED",
        externalId: String(id),
        externalParentId: null,
        externalMeta: { taxonomyId, photosKey: key, imageIds },
        externalUrl: etsyListingUrl(id),
        errorCode: null,
        errorMessage: null,
        publishedAt: existing?.publishedAt ?? now,
      });
      await logChannel(deps, CH, {
        organizationId: p.organizationId,
        productId: p.id,
        skuCode: item.sku,
        ok: true,
        message: existing && isOnChannel(existing) ? `updated:${item.quantity}` : `listed:${item.quantity}`,
      });
    }
  } catch (err) {
    await handleUnauthorized(deps, connection, err);
    const e = asChannelError(err);
    await markAll(deps, CH, p, skus, e.code, e.message);
    await logChannel(deps, CH, { organizationId: p.organizationId, productId: p.id, skuCode: skus[0] ?? "", ok: false, message: `${e.code}: ${e.message}` });
    if (e.retryable) throw new RetryableChannelError(e.message);
  }
}

/** Fiche supprimée dans OmniList : l'annonce Etsy est supprimée. */
export async function removeFromEtsy(deps: ChannelDeps, organizationId: string, skus: string[]) {
  if (skus.length === 0) return;
  const connection = await findConnection(deps, organizationId, CH);
  if (!connection) return;
  let token: string;
  try {
    token = await etsyAccessToken(deps, connection);
  } catch (err) {
    if (err instanceof NotConnectedError) return;
    throw new RetryableChannelError((err as Error).message);
  }
  const listings = await deps.prisma.channelListing.findMany({ where: { organizationId, channel: CH, skuCode: { in: skus } } });
  let retry: Error | null = null;
  for (const id of new Set(listings.map((l) => l.externalId).filter((x): x is string => !!x))) {
    const own = listings.filter((l) => l.externalId === id);
    try {
      await deps.etsy.deleteListing(token, Number(id));
      for (const l of own) {
        await saveListing(deps, CH, organizationId, l.skuCode, { productId: null, status: "REMOVED", errorCode: null, errorMessage: null });
        if (isOnChannel(l)) await logChannel(deps, CH, { organizationId, productId: null, skuCode: l.skuCode, ok: true, message: "removed" });
      }
    } catch (err) {
      await handleUnauthorized(deps, connection, err);
      const e = asChannelError(err);
      for (const l of own) await saveListing(deps, CH, organizationId, l.skuCode, { productId: null, status: "ERROR", errorCode: e.code, errorMessage: e.message });
      if (e.retryable) retry = e;
    }
  }
  if (retry) throw new RetryableChannelError(retry.message);
}

// ---------------------------------------------------------------------------
// Commandes
// ---------------------------------------------------------------------------

/** null : pas (encore) payée, ce n'est pas une vente. */
function statusOf(r: EtsyReceipt): OrderStatus | null {
  if (r.status === "canceled") return "CANCELLED";
  if (r.status === "fully refunded") return "REFUNDED";
  if (!r.is_paid) return null;
  if (r.status === "completed") return "COMPLETED";
  if (r.is_shipped) return "SHIPPED";
  return "PAID";
}

const cents = (m: { amount: number; divisor: number }) => Math.round((m.amount / (m.divisor || 100)) * 100);

export function etsyReceiptToInput(organizationId: string, r: EtsyReceipt, status: OrderStatus): OrderInput {
  return {
    organizationId,
    channel: CH,
    source: "CHANNEL",
    externalOrderId: String(r.receipt_id),
    status,
    buyerName: r.name ?? null,
    buyerRef: r.buyer_user_id ? String(r.buyer_user_id) : null,
    currency: r.grandtotal?.currency_code ?? r.transactions[0]?.price.currency_code ?? "USD",
    placedAt: new Date(r.created_timestamp * 1000),
    lines: r.transactions.map((t) => ({
      // Annonce créée hors OmniList : pas de SKU, on garde le numéro d'annonce Etsy pour le journal.
      sku: t.sku || `etsy-${t.listing_id}`,
      quantity: t.quantity,
      unitPriceCents: cents(t.price),
      title: t.title.slice(0, 200),
    })),
  };
}

const NONE: StockChange = { created: false, productIds: [], oversoldQty: 0 };

export async function importEtsyReceipt(deps: ChannelDeps, organizationId: string, receipt: EtsyReceipt): Promise<StockChange> {
  const status = statusOf(receipt);
  if (!status) return NONE;
  return recordOrder(deps.prisma, etsyReceiptToInput(organizationId, receipt, status));
}

const OVERLAP_MS = 15 * 60 * 1000;
const MAX_PAGES = 10;
const PAGE = 100;

/** Relevé des commandes Etsy modifiées depuis le dernier passage (Etsy n'envoie pas de webhook de commande). */
export async function pollEtsyOrders(deps: ChannelDeps, connection: ChannelConnection): Promise<string[]> {
  const now = deps.now?.() ?? new Date();
  let token: string;
  try {
    token = await etsyAccessToken(deps, connection);
  } catch (err) {
    if (err instanceof NotConnectedError) return [];
    throw err;
  }
  const shopId = settingsOf(connection).shopId;
  if (!shopId) return [];
  const since = new Date((connection.ordersSyncedAt ?? connection.createdAt).getTime() - (connection.ordersSyncedAt ? OVERLAP_MS : 1000));
  const productIds = new Set<string>();
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await deps.etsy.listReceipts(token, shopId, { modifiedSince: since, offset: page * PAGE, limit: PAGE });
      for (const receipt of res.results) {
        if (placedBeforeConnection(new Date(receipt.created_timestamp * 1000), connection.createdAt)) continue;
        (await importEtsyReceipt(deps, connection.organizationId, receipt)).productIds.forEach((id) => productIds.add(id));
      }
      if ((page + 1) * PAGE >= res.count) break;
    }
  } catch (err) {
    await handleUnauthorized(deps, connection, err);
    throw err;
  }
  await deps.prisma.channelConnection.update({ where: { id: connection.id }, data: { ordersSyncedAt: now } });
  return [...productIds];
}
