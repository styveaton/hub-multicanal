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
  wooDate,
  photosKey,
  priceRule,
  saveListing,
  sellableItems,
  textToHtml,
  type ChannelDeps,
  type LoadedProduct,
  type SellableItem,
} from "../listing.js";
import type { WooOrder, WooOrderStatus, WooProductBody, WooStore, WooVariationBody } from "./client.js";

/**
 * WooCommerce : article unique = produit « simple » ; fiche à variantes = produit « variable »
 * avec une variation par SKU. Le stock WooCommerce est remis à la valeur du stock central.
 */

const CH = "WOOCOMMERCE" as const;

/** Clés de la boutique (chiffrées ensemble dans accessTokenEnc). */
export function wooStore(deps: ChannelDeps, connection: ChannelConnection): WooStore {
  if (connection.status !== "CONNECTED" || !connection.externalAccountId) throw new NotConnectedError();
  const { key, secret } = JSON.parse(deps.cipher.decrypt(connection.accessTokenEnc)) as { key: string; secret: string };
  return { url: connection.externalAccountId, key, secret };
}

async function handleUnauthorized(deps: ChannelDeps, connection: ChannelConnection, err: unknown) {
  if (err instanceof ChannelApiError && (err.status === 401 || err.status === 403)) {
    await deps.prisma.channelConnection.update({ where: { id: connection.id }, data: { status: "NEEDS_REAUTH" } });
  }
}

const amount = (cents: number) => (cents / 100).toFixed(2);

/** Attributs de variation ; sans attributs, le SKU sert d'attribut. */
function variationAttributes(items: SellableItem[]) {
  const options = optionsOf(items);
  if (options.length > 0) {
    return { options, of: (item: SellableItem) => options.map((o) => ({ name: o.name, option: item.attributes?.[o.name] ?? "-" })) };
  }
  const skuOption = [{ name: "SKU", values: items.map((i) => i.sku) }];
  return { options: skuOption, of: (item: SellableItem) => [{ name: "SKU", option: item.sku }] };
}

/** Fiche OmniList → produit WooCommerce. */
export function buildWooProduct(
  p: Pick<LoadedProduct, "title" | "description" | "mode">,
  opts: { title?: string | null; category?: string | null; items: SellableItem[]; pictureUrls: string[] | null },
): WooProductBody {
  const base = {
    name: opts.title?.trim() || p.title,
    status: "publish" as const,
    description: textToHtml(p.description),
    ...(opts.category ? { tags: [{ name: opts.category }] } : {}),
    ...(opts.pictureUrls ? { images: opts.pictureUrls.map((src) => ({ src })) } : {}),
  };
  if (p.mode === "SINGLE") {
    const item = opts.items[0]!;
    return {
      ...base,
      type: "simple",
      sku: item.sku,
      regular_price: amount(item.priceCents),
      manage_stock: true,
      stock_quantity: Math.max(0, item.quantity),
    };
  }
  const { options } = variationAttributes(opts.items);
  return { ...base, type: "variable", attributes: options.map((o) => ({ name: o.name, options: o.values, visible: true, variation: true })) };
}

export async function publishToWoo(deps: ChannelDeps, productId: string) {
  const p = await loadProduct(deps, productId, CH);
  if (!p) return;
  const settings = p.channels[0];
  const items = sellableItems(p, priceRule(settings));
  const skus = items.map((i) => i.sku);

  const connection = await findConnection(deps, p.organizationId, CH);
  if (!connection) return markAll(deps, CH, p, skus, "not_connected", null);
  let store: WooStore;
  try {
    store = wooStore(deps, connection);
  } catch {
    return markAll(deps, CH, p, skus, "needs_reauth", null);
  }
  const parentRaw = p.listings.find((l) => l.externalParentId)?.externalParentId;
  let parentId = parentRaw ? Number(parentRaw) : null;

  try {
    // Canal désactivé : le produit repasse en brouillon (invisible pour les clients).
    if (!settings?.enabled) {
      if (parentId && p.listings.some(isOnChannel)) await deps.woo.updateProduct(store, parentId, { status: "draft" });
      for (const l of p.listings.filter((x) => x.status !== "REMOVED")) {
        await saveListing(deps, CH, p.organizationId, l.skuCode, { productId: p.id, status: "REMOVED", errorCode: null, errorMessage: null });
        if (isOnChannel(l)) await logChannel(deps, CH, { organizationId: p.organizationId, productId: p.id, skuCode: l.skuCode, ok: true, message: "removed" });
      }
      return;
    }
    if (items.some((i) => !i.sku)) return markAll(deps, CH, p, skus, "listing_incomplete", "sku_missing");

    const key = photosKey(p);
    const sentKey = (p.listings.find((l) => l.externalParentId)?.externalMeta as { photosKey?: string } | null)?.photosKey;
    const pictureUrls = !parentId || sentKey !== key ? p.photos.map((ph) => deps.media.url(ph.id)) : null;
    const body = buildWooProduct(p, { title: settings.title, category: settings.category, items, pictureUrls });

    // Article unique déjà présent dans la boutique (créé à la main avec le même SKU) : on le reprend.
    if (!parentId && p.mode === "SINGLE") parentId = (await deps.woo.findProductBySku(store, items[0]!.sku))?.id ?? null;

    let product;
    try {
      product = parentId ? await deps.woo.updateProduct(store, parentId, body) : await deps.woo.createProduct(store, body);
    } catch (err) {
      // Produit supprimé à la main dans WordPress : on le recrée.
      if (!(parentId && err instanceof ChannelApiError && err.status === 404)) throw err;
      product = await deps.woo.createProduct(store, { ...body, images: p.photos.map((ph) => ({ src: deps.media.url(ph.id) })) });
    }

    // Identifiant WooCommerce de chaque SKU.
    const idBySku = new Map<string, number>();
    if (p.mode === "SINGLE") {
      idBySku.set(items[0]!.sku, product.id);
    } else {
      const existing = await deps.woo.listVariations(store, product.id);
      const known = new Map(existing.map((v) => [v.sku, v.id]));
      const { of } = variationAttributes(items);
      const toBody = (item: SellableItem): WooVariationBody => ({
        sku: item.sku,
        regular_price: amount(item.priceCents),
        manage_stock: true,
        stock_quantity: Math.max(0, item.quantity),
        attributes: of(item),
      });
      const res = await deps.woo.batchVariations(store, product.id, {
        update: items.filter((i) => known.has(i.sku)).map((i) => ({ ...toBody(i), id: known.get(i.sku)! })),
        create: items.filter((i) => !known.has(i.sku)).map(toBody),
        delete: existing.filter((v) => !skus.includes(v.sku)).map((v) => v.id),
      });
      for (const [sku, id] of known) idBySku.set(sku, id);
      for (const created of res.create ?? []) if (created.sku) idBySku.set(created.sku, created.id);
    }

    const now = deps.now?.() ?? new Date();
    for (const item of items) {
      const id = idBySku.get(item.sku);
      const existing = p.listings.find((l) => l.skuCode === item.sku);
      if (!id) {
        await saveListing(deps, CH, p.organizationId, item.sku, { productId: p.id, status: "ERROR", errorCode: "variant_missing", errorMessage: null });
        continue;
      }
      await saveListing(deps, CH, p.organizationId, item.sku, {
        productId: p.id,
        status: "LISTED",
        externalId: String(id),
        externalParentId: String(product.id),
        externalMeta: { photosKey: key },
        externalUrl: product.permalink,
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

/** Fiche supprimée dans OmniList : le produit WooCommerce part à la corbeille. */
export async function removeFromWoo(deps: ChannelDeps, organizationId: string, skus: string[]) {
  if (skus.length === 0) return;
  const connection = await findConnection(deps, organizationId, CH);
  if (!connection) return;
  let store: WooStore;
  try {
    store = wooStore(deps, connection);
  } catch {
    return;
  }
  const listings = await deps.prisma.channelListing.findMany({ where: { organizationId, channel: CH, skuCode: { in: skus } } });
  let retry: Error | null = null;
  for (const parent of new Set(listings.map((l) => l.externalParentId).filter((x): x is string => !!x))) {
    const own = listings.filter((l) => l.externalParentId === parent);
    try {
      await deps.woo.deleteProduct(store, Number(parent));
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

/** Statuts qui ne sont pas (ou plus) une vente : paiement en attente ou échoué. */
const NOT_A_SALE: ReadonlySet<WooOrderStatus> = new Set(["pending", "failed", "checkout-draft"]);

const STATUS: Partial<Record<WooOrderStatus, OrderStatus>> = {
  processing: "PAID",
  "on-hold": "PAID",
  completed: "COMPLETED",
  cancelled: "CANCELLED",
  refunded: "REFUNDED",
  trash: "CANCELLED",
};

export function wooOrderToInput(organizationId: string, o: WooOrder, status: OrderStatus): OrderInput {
  const buyer = [o.billing?.first_name, o.billing?.last_name].filter(Boolean).join(" ");
  return {
    organizationId,
    channel: CH,
    source: "CHANNEL",
    externalOrderId: String(o.id),
    status,
    buyerName: buyer || null,
    currency: o.currency,
    placedAt: wooDate(o.date_created_gmt),
    lines: o.line_items.map((li) => ({
      sku: li.sku || `woo-${li.variation_id || li.product_id}`,
      quantity: li.quantity,
      unitPriceCents: Math.round(Number(li.price) * 100),
      title: li.name.slice(0, 200),
    })),
  };
}

const NONE: StockChange = { created: false, productIds: [], oversoldQty: 0 };

/** Commande reçue par webhook ou relevé. Une commande non payée n'est pas une vente : ignorée. */
export async function importWooOrder(deps: ChannelDeps, organizationId: string, order: WooOrder): Promise<StockChange> {
  let status = STATUS[order.status];
  if (NOT_A_SALE.has(order.status)) {
    // Déjà comptée (payée puis échouée) : on la traite comme annulée, sinon on attend le paiement.
    const known = await deps.prisma.order.findFirst({ where: { organizationId, channel: CH, externalOrderId: String(order.id) } });
    if (!known) return NONE;
    status = "CANCELLED";
  }
  if (!status) return NONE;
  return recordOrder(deps.prisma, wooOrderToInput(organizationId, order, status));
}

const OVERLAP_MS = 15 * 60 * 1000;
const MAX_PAGES = 10;

export async function pollWooOrders(deps: ChannelDeps, connection: ChannelConnection): Promise<string[]> {
  const now = deps.now?.() ?? new Date();
  let store: WooStore;
  try {
    store = wooStore(deps, connection);
  } catch {
    return [];
  }
  // Dates à la seconde : on démarre une seconde avant la connexion pour ne rien manquer.
  const since = new Date((connection.ordersSyncedAt ?? connection.createdAt).getTime() - (connection.ordersSyncedAt ? OVERLAP_MS : 1000));
  const productIds = new Set<string>();
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await deps.woo.listOrders(store, { modifiedAfter: since, page });
      for (const order of res.orders) {
        if (placedBeforeConnection(wooDate(order.date_created_gmt), connection.createdAt)) continue;
        (await importWooOrder(deps, connection.organizationId, order)).productIds.forEach((id) => productIds.add(id));
      }
      if (page >= res.totalPages) break;
    }
  } catch (err) {
    await handleUnauthorized(deps, connection, err);
    throw err;
  }
  await deps.prisma.channelConnection.update({ where: { id: connection.id }, data: { ordersSyncedAt: now } });
  return [...productIds];
}
