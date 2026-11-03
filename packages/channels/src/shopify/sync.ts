import type { ChannelConnection, OrderStatus } from "@hub/db";
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
  placedBeforeConnection,
  photosKey,
  priceRule,
  saveListing,
  sellableItems,
  textToHtml,
  type ChannelDeps,
  type LoadedProduct,
  type SellableItem,
} from "../listing.js";
import { gidTail, type ShopifyOrder, type ShopifyProductSetInput } from "./client.js";

/**
 * Shopify : une fiche OmniList = un produit Shopify, une variante par SKU.
 * Le stock Shopify est toujours remis à la valeur du stock central (quantité absolue).
 */

const CH = "SHOPIFY" as const;

export interface ShopifySettings {
  shopName?: string;
  locationId?: string;
}

interface ShopifyAccess {
  shop: string;
  token: string;
  locationId: string;
}

/** Jeton hors ligne de la boutique (il n'expire pas ; une désinstallation le révoque). */
export function shopifyAccess(deps: ChannelDeps, connection: ChannelConnection): ShopifyAccess {
  const locationId = (connection.settings as ShopifySettings | null)?.locationId;
  if (connection.status !== "CONNECTED" || !connection.externalAccountId || !locationId) throw new NotConnectedError();
  return { shop: connection.externalAccountId, token: deps.cipher.decrypt(connection.accessTokenEnc), locationId };
}

async function handleUnauthorized(deps: ChannelDeps, connection: ChannelConnection, err: unknown) {
  if (err instanceof ChannelApiError && (err.status === 401 || err.status === 403)) {
    await deps.prisma.channelConnection.update({ where: { id: connection.id }, data: { status: "NEEDS_REAUTH" } });
  }
}

const amount = (cents: number) => (cents / 100).toFixed(2);
const adminUrl = (shop: string, productId: string) => `https://admin.shopify.com/store/${shop.split(".")[0]}/products/${gidTail(productId)}`;

/** Fiche OmniList → entrée productSet. */
export function buildShopifyProduct(
  p: Pick<LoadedProduct, "title" | "description" | "brand">,
  opts: { title?: string | null; productType?: string | null; items: SellableItem[]; locationId: string; pictureUrls: string[] | null },
): ShopifyProductSetInput {
  let options = optionsOf(opts.items);
  let valuesOf = (item: SellableItem) => options.map((o) => ({ optionName: o.name, name: item.attributes?.[o.name] ?? "-" }));
  if (options.length === 0) {
    // Article unique : option par défaut de Shopify. Variantes sans attributs : le SKU sert d'option.
    if (opts.items.length === 1) {
      options = [{ name: "Title", values: ["Default Title"] }];
      valuesOf = () => [{ optionName: "Title", name: "Default Title" }];
    } else {
      options = [{ name: "SKU", values: opts.items.map((i) => i.sku) }];
      valuesOf = (item) => [{ optionName: "SKU", name: item.sku }];
    }
  }
  return {
    title: opts.title?.trim() || p.title,
    descriptionHtml: textToHtml(p.description),
    ...(p.brand ? { vendor: p.brand } : {}),
    ...(opts.productType ? { productType: opts.productType } : {}),
    status: "ACTIVE",
    productOptions: options.map((o, i) => ({ name: o.name, position: i + 1, values: o.values.map((name) => ({ name })) })),
    variants: opts.items.map((item) => ({
      optionValues: valuesOf(item),
      price: amount(item.priceCents),
      inventoryItem: { sku: item.sku, tracked: true },
      inventoryQuantities: [{ locationId: opts.locationId, name: "available", quantity: Math.max(0, item.quantity) }],
    })),
    ...(opts.pictureUrls ? { files: opts.pictureUrls.map((originalSource) => ({ originalSource, contentType: "IMAGE" as const })) } : {}),
  };
}

/** Produit Shopify déjà créé pour cette fiche (même archivé : on le réactive plutôt que d'en créer un autre). */
const parentId = (p: LoadedProduct) => p.listings.find((l) => l.externalParentId)?.externalParentId ?? null;

export async function publishToShopify(deps: ChannelDeps, productId: string) {
  const p = await loadProduct(deps, productId, CH);
  if (!p) return;
  const settings = p.channels[0];
  const items = sellableItems(p, priceRule(settings));
  const skus = items.map((i) => i.sku);

  const connection = await findConnection(deps, p.organizationId, CH);
  if (!connection) return markAll(deps, CH, p, skus, "not_connected", null);
  let access: ShopifyAccess;
  try {
    access = shopifyAccess(deps, connection);
  } catch {
    return markAll(deps, CH, p, skus, "needs_reauth", null);
  }
  const { shop, token, locationId } = access;
  const existingId = parentId(p);

  try {
    // Canal désactivé : le produit est archivé (invisible, historique conservé).
    if (!settings?.enabled) {
      const live = p.listings.filter(isOnChannel);
      if (existingId && live.length > 0) await deps.shopify.setStatus(shop, token, existingId, "ARCHIVED");
      for (const l of p.listings.filter((x) => x.status !== "REMOVED")) {
        await saveListing(deps, CH, p.organizationId, l.skuCode, { productId: p.id, status: "REMOVED", errorCode: null, errorMessage: null });
        if (isOnChannel(l)) await logChannel(deps, CH, { organizationId: p.organizationId, productId: p.id, skuCode: l.skuCode, ok: true, message: "removed" });
      }
      return;
    }

    if (items.some((i) => !i.sku)) return markAll(deps, CH, p, skus, "listing_incomplete", "sku_missing");

    // Les photos ne sont renvoyées que si elles ont changé (Shopify les retélécharge à chaque envoi).
    const key = photosKey(p);
    const sentKey = (p.listings.find((l) => l.externalParentId)?.externalMeta as { photosKey?: string } | null)?.photosKey;
    const pictureUrls = !existingId || sentKey !== key ? p.photos.map((ph) => deps.media.url(ph.id)) : null;
    const input = buildShopifyProduct(p, { title: settings.title, productType: settings.category, items, locationId, pictureUrls });

    let ref;
    try {
      ref = await deps.shopify.setProduct(shop, token, input, existingId);
    } catch (err) {
      // Produit supprimé à la main dans Shopify : on le recrée.
      if (!(existingId && err instanceof ChannelApiError && /does not exist/i.test(err.message))) throw err;
      ref = await deps.shopify.setProduct(shop, token, { ...input, files: p.photos.map((ph) => ({ originalSource: deps.media.url(ph.id), contentType: "IMAGE" as const })) }, null);
    }

    const bySku = new Map(ref.variants.map((v) => [v.sku, v]));
    // productSet ne fixe le stock qu'à la création d'une variante : on impose ensuite le stock central.
    await deps.shopify.setQuantities(
      shop,
      token,
      locationId,
      items.flatMap((i) => {
        const v = bySku.get(i.sku);
        return v ? [{ inventoryItemId: v.inventoryItemId, quantity: Math.max(0, i.quantity) }] : [];
      }),
    );

    const now = deps.now?.() ?? new Date();
    for (const item of items) {
      const v = bySku.get(item.sku);
      const existing = p.listings.find((l) => l.skuCode === item.sku);
      if (!v) {
        await saveListing(deps, CH, p.organizationId, item.sku, { productId: p.id, status: "ERROR", errorCode: "variant_missing", errorMessage: null });
        continue;
      }
      await saveListing(deps, CH, p.organizationId, item.sku, {
        productId: p.id,
        status: "LISTED",
        externalId: v.id,
        externalParentId: ref.id,
        externalMeta: { inventoryItemId: v.inventoryItemId, photosKey: key },
        externalUrl: ref.onlineStoreUrl ?? adminUrl(shop, ref.id),
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
    // Variantes supprimées de la fiche : Shopify les a retirées avec productSet.
    for (const l of p.listings.filter((x) => !skus.includes(x.skuCode) && isOnChannel(x))) {
      await saveListing(deps, CH, p.organizationId, l.skuCode, { productId: p.id, status: "REMOVED", errorCode: null, errorMessage: null });
      await logChannel(deps, CH, { organizationId: p.organizationId, productId: p.id, skuCode: l.skuCode, ok: true, message: "removed" });
    }
  } catch (err) {
    await handleUnauthorized(deps, connection, err);
    const e = asChannelError(err);
    await markAll(deps, CH, p, skus, e.code, e.message);
    await logChannel(deps, CH, { organizationId: p.organizationId, productId: p.id, skuCode: skus[0] ?? "", ok: false, message: `${e.code}: ${e.message}` });
    if (e.retryable) throw new RetryableChannelError(e.message);
  }
}

/** Fiche supprimée dans OmniList : le produit Shopify est supprimé. */
export async function removeFromShopify(deps: ChannelDeps, organizationId: string, skus: string[]) {
  if (skus.length === 0) return;
  const connection = await findConnection(deps, organizationId, CH);
  if (!connection) return;
  let access: ShopifyAccess;
  try {
    access = shopifyAccess(deps, connection);
  } catch {
    return;
  }
  const listings = await deps.prisma.channelListing.findMany({ where: { organizationId, channel: CH, skuCode: { in: skus } } });
  let retry: Error | null = null;
  for (const parent of new Set(listings.map((l) => l.externalParentId).filter((x): x is string => !!x))) {
    const own = listings.filter((l) => l.externalParentId === parent);
    try {
      await deps.shopify.deleteProduct(access.shop, access.token, parent);
      for (const l of own) {
        await saveListing(deps, CH, organizationId, l.skuCode, { productId: null, status: "REMOVED", errorCode: null, errorMessage: null });
        await logChannel(deps, CH, { organizationId, productId: null, skuCode: l.skuCode, ok: true, message: "removed" });
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

function statusOf(o: ShopifyOrder): OrderStatus {
  if (o.cancelled || o.financialStatus === "VOIDED") return "CANCELLED";
  if (o.financialStatus === "REFUNDED") return "REFUNDED";
  if (o.fulfillmentStatus === "FULFILLED") return "SHIPPED";
  return "PAID";
}

export function shopifyOrderToInput(organizationId: string, o: ShopifyOrder): OrderInput {
  return {
    organizationId,
    channel: CH,
    source: "CHANNEL",
    // Identifiant numérique : le même que l'on vienne d'un webhook ou d'un relevé (idempotence).
    externalOrderId: o.id,
    status: statusOf(o),
    buyerName: o.buyerName,
    currency: o.currency,
    placedAt: new Date(o.createdAt),
    lines: o.lines.map((li) => ({
      // Produit créé hors OmniList : pas de SKU, on garde l'identifiant Shopify pour le journal.
      sku: li.sku || `shopify-${li.productId ?? "unknown"}`,
      quantity: li.quantity,
      unitPriceCents: li.unitPriceCents,
      title: li.title.slice(0, 200),
    })),
  };
}

export const importShopifyOrder = (deps: ChannelDeps, organizationId: string, order: ShopifyOrder): Promise<StockChange> =>
  recordOrder(deps.prisma, shopifyOrderToInput(organizationId, order));

const OVERLAP_MS = 15 * 60 * 1000;
const MAX_PAGES = 10;

/** Relevé de secours des commandes Shopify modifiées depuis le dernier passage. */
export async function pollShopifyOrders(deps: ChannelDeps, connection: ChannelConnection): Promise<string[]> {
  const now = deps.now?.() ?? new Date();
  let access: ShopifyAccess;
  try {
    access = shopifyAccess(deps, connection);
  } catch {
    return [];
  }
  const since = new Date((connection.ordersSyncedAt ?? connection.createdAt).getTime() - (connection.ordersSyncedAt ? OVERLAP_MS : 1000));
  const productIds = new Set<string>();
  let cursor: string | null = null;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await deps.shopify.listOrders(access.shop, access.token, { updatedSince: since, after: cursor });
      for (const order of res.orders) {
        // Commande passée avant la connexion : le stock central en tenait déjà compte.
        if (placedBeforeConnection(new Date(order.createdAt), connection.createdAt)) continue;
        (await importShopifyOrder(deps, connection.organizationId, order)).productIds.forEach((id) => productIds.add(id));
      }
      if (!res.hasNextPage || !res.cursor) break;
      cursor = res.cursor;
    }
  } catch (err) {
    await handleUnauthorized(deps, connection, err);
    throw err;
  }
  await deps.prisma.channelConnection.update({ where: { id: connection.id }, data: { ordersSyncedAt: now } });
  return [...productIds];
}
