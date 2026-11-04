import type { ChannelConnection, OrderStatus, ProductCondition } from "@hub/db";
import { CHANNEL_TITLE_MAX } from "@hub/shared";
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
  priceRule,
  saveListing,
  sellableItems,
  textToHtml,
  type ChannelDeps,
  type LoadedProduct,
  type SellableItem,
} from "../listing.js";
import { EBAY_MARKETPLACE, type EbayInventoryItem, type EbayItemGroup, type EbayOfferInput, type EbayOrder } from "./client.js";

/**
 * eBay (Inventory API) : un article eBay par SKU, une offre par SKU. Une fiche à variantes devient
 * un groupe (une seule annonce à variantes). Le stock eBay est toujours remis à la valeur du stock central.
 */

const CH = "EBAY" as const;

/** Clé de l'emplacement de stock créé chez le vendeur. */
export const EBAY_LOCATION_KEY = "omnilist";
const MAX_IMAGES = 24;

export interface EbaySettings {
  username?: string;
  /** Code postal d'où partent les colis (obligatoire pour publier). */
  postalCode?: string;
  /** Code postal déjà envoyé à eBay pour l'emplacement de stock. */
  locationPostalCode?: string;
  policies?: { fulfillmentPolicyId: string; paymentPolicyId: string; returnPolicyId: string; names?: string[] };
}

interface EbayMeta {
  offerId?: string;
  categoryId?: string;
}

const settingsOf = (c: ChannelConnection) => (c.settings ?? {}) as EbaySettings;

// ---------------------------------------------------------------------------
// Jetons
// ---------------------------------------------------------------------------

/** Jeton d'accès valide (2 h), rafraîchi s'il expire dans moins d'une minute. */
export async function ebayAccessToken(deps: ChannelDeps, connection: ChannelConnection): Promise<string> {
  const now = deps.now?.() ?? new Date();
  if (connection.status !== "CONNECTED") throw new NotConnectedError();
  if (connection.accessTokenExpiresAt && connection.accessTokenExpiresAt.getTime() - now.getTime() > 60_000) {
    return deps.cipher.decrypt(connection.accessTokenEnc);
  }
  if (!connection.refreshTokenEnc) throw new NotConnectedError();
  try {
    const tokens = await deps.ebay.refresh(deps.cipher.decrypt(connection.refreshTokenEnc));
    const expiresAt = new Date(now.getTime() + tokens.expires_in * 1000);
    await deps.prisma.channelConnection.update({
      where: { id: connection.id },
      data: { accessTokenEnc: deps.cipher.encrypt(tokens.access_token), accessTokenExpiresAt: expiresAt },
    });
    // La connexion en mémoire suit : un second appel ne rafraîchit pas encore une fois.
    connection.accessTokenEnc = deps.cipher.encrypt(tokens.access_token);
    connection.accessTokenExpiresAt = expiresAt;
    return tokens.access_token;
  } catch (err) {
    if (err instanceof ChannelApiError && !err.retryable) {
      // Jeton de rafraîchissement expiré (18 mois) ou accès retiré : reconnexion nécessaire.
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

// ---------------------------------------------------------------------------
// Annonces
// ---------------------------------------------------------------------------

/** États OmniList → états d'objet eBay (les plus largement acceptés). */
export const EBAY_CONDITION: Record<ProductCondition, string> = {
  NEW: "NEW",
  USED_LIKE_NEW: "USED_EXCELLENT",
  USED_GOOD: "USED_GOOD",
  USED_FAIR: "USED_ACCEPTABLE",
};

const amount = (cents: number) => (cents / 100).toFixed(2);

/** Caractéristiques (« item specifics ») : la marque, puis les attributs de la variante. */
function aspectsOf(p: Pick<LoadedProduct, "brand">, item?: SellableItem): Record<string, string[]> {
  const aspects: Record<string, string[]> = {};
  if (p.brand) aspects.Brand = [p.brand];
  for (const [name, value] of Object.entries(item?.attributes ?? {})) aspects[name] = [value];
  return aspects;
}

export function buildEbayItem(
  p: Pick<LoadedProduct, "title" | "description" | "brand" | "condition">,
  opts: { title: string; item: SellableItem; imageUrls: string[] },
): EbayInventoryItem {
  return {
    product: {
      title: opts.title,
      description: textToHtml(p.description),
      aspects: aspectsOf(p, opts.item),
      imageUrls: opts.imageUrls,
      ...(p.brand ? { brand: p.brand } : {}),
    },
    condition: EBAY_CONDITION[p.condition],
    availability: { shipToLocationAvailability: { quantity: Math.max(0, opts.item.quantity) } },
  };
}

export function buildEbayGroup(
  p: Pick<LoadedProduct, "description" | "brand">,
  opts: { title: string; items: SellableItem[]; imageUrls: string[] },
): EbayItemGroup {
  return {
    title: opts.title,
    description: textToHtml(p.description),
    imageUrls: opts.imageUrls,
    aspects: aspectsOf(p),
    variantSKUs: opts.items.map((i) => i.sku),
    variesBy: { aspectsImageVariesBy: [], specifications: optionsOf(opts.items) },
  };
}

/** Règles de vente et emplacement de stock du vendeur, préparés une fois puis gardés. */
async function prepareAccount(deps: ChannelDeps, connection: ChannelConnection, token: string): Promise<EbaySettings | string> {
  const s = settingsOf(connection);
  if (!s.postalCode) return "ebay_location_missing";
  const next: EbaySettings = { ...s };
  if (s.locationPostalCode !== s.postalCode) {
    await deps.ebay.upsertLocation(token, EBAY_LOCATION_KEY, { postalCode: s.postalCode, name: "OmniList" });
    next.locationPostalCode = s.postalCode;
  }
  if (!s.policies) {
    await deps.ebay.optInPolicies(token);
    const all = await deps.ebay.getPolicies(token);
    const [f, pay, ret] = [all.fulfillment[0], all.payment[0], all.return[0]];
    if (!f || !pay || !ret) return "ebay_policies_missing";
    next.policies = { fulfillmentPolicyId: f.id, paymentPolicyId: pay.id, returnPolicyId: ret.id, names: [f.name, pay.name, ret.name] };
  }
  if (next.locationPostalCode !== s.locationPostalCode || next.policies !== s.policies) {
    await deps.prisma.channelConnection.update({ where: { id: connection.id }, data: { settings: { ...next } } });
  }
  return next;
}

const metaOf = (l: { externalMeta: unknown } | undefined) => (l?.externalMeta ?? {}) as EbayMeta;

export async function publishToEbay(deps: ChannelDeps, productId: string) {
  const p = await loadProduct(deps, productId, CH);
  if (!p) return;
  const settings = p.channels[0];
  const items = sellableItems(p, priceRule(settings));
  const skus = items.map((i) => i.sku);
  const variants = p.mode !== "SINGLE";
  const groupKey = p.id;

  const connection = await findConnection(deps, p.organizationId, CH);
  if (!connection) return markAll(deps, CH, p, skus, "not_connected", null);
  let token: string;
  try {
    token = await ebayAccessToken(deps, connection);
  } catch (err) {
    if (err instanceof NotConnectedError) return markAll(deps, CH, p, skus, "needs_reauth", null);
    throw new RetryableChannelError((err as Error).message);
  }

  const live = p.listings.filter(isOnChannel);
  /** Met fin à l'annonce (ou à l'annonce à variantes) en gardant les offres. */
  const withdraw = async () => {
    if (live.length === 0) return;
    if (variants || live.some((l) => l.externalParentId)) await deps.ebay.withdrawGroup(token, live.find((l) => l.externalParentId)?.externalParentId ?? groupKey);
    for (const l of live) {
      const offerId = metaOf(l).offerId;
      if (!l.externalParentId && offerId) await deps.ebay.withdrawOffer(token, offerId);
    }
  };

  try {
    // Canal désactivé : l'annonce prend fin sur eBay.
    if (!settings?.enabled) {
      await withdraw();
      for (const l of p.listings.filter((x) => x.status !== "REMOVED")) {
        await saveListing(deps, CH, p.organizationId, l.skuCode, { productId: p.id, status: "REMOVED", errorCode: null, errorMessage: null });
        if (isOnChannel(l)) await logChannel(deps, CH, { organizationId: p.organizationId, productId: p.id, skuCode: l.skuCode, ok: true, message: "removed" });
      }
      return;
    }

    const title = settings.title?.trim() || p.title;
    if (items.some((i) => !i.sku)) return markAll(deps, CH, p, skus, "listing_incomplete", "sku_missing");
    if (title.length > CHANNEL_TITLE_MAX.EBAY) return markAll(deps, CH, p, skus, "listing_incomplete", "title_too_long");
    if (p.photos.length === 0) return markAll(deps, CH, p, skus, "listing_incomplete", "photos_missing");

    // Plus rien en stock : l'annonce prend fin ; un réassort la republie.
    if (items.every((i) => i.quantity <= 0)) {
      await withdraw();
      for (const sku of skus) {
        const was = p.listings.find((l) => l.skuCode === sku);
        await saveListing(deps, CH, p.organizationId, sku, { productId: p.id, status: "REMOVED", errorCode: "out_of_stock", errorMessage: null });
        if (was && isOnChannel(was)) await logChannel(deps, CH, { organizationId: p.organizationId, productId: p.id, skuCode: sku, ok: true, message: "out_of_stock" });
      }
      return;
    }

    const account = await prepareAccount(deps, connection, token);
    if (typeof account === "string") return markAll(deps, CH, p, skus, account, null);

    // Catégorie : celle saisie (numéro eBay), sinon celle déjà utilisée, sinon la suggestion d'eBay.
    // Un texte saisi (« veste en jean ») sert de recherche de catégorie.
    const typed = settings.category?.trim() || null;
    const numeric = typed && /^\d+$/.test(typed) ? typed : null;
    const used = typed ? null : (p.listings.map((l) => metaOf(l).categoryId).find(Boolean) ?? null);
    const categoryId =
      numeric ??
      used ??
      (await deps.ebay.suggestCategory(typed ?? title).catch((err: unknown) => {
        // Jeton d'application refusé : problème des clés OmniList, pas du compte du vendeur.
        throw err instanceof ChannelApiError && err.status === 401 ? new ChannelApiError(502, "ebay_app_token", err.message, true) : err;
      }));
    if (!categoryId) return markAll(deps, CH, p, skus, "listing_incomplete", "category_missing");

    const imageUrls = p.photos.slice(0, MAX_IMAGES).map((ph) => deps.media.url(ph.id));
    for (const item of items) await deps.ebay.putInventoryItem(token, item.sku, buildEbayItem(p, { title, item, imageUrls }));
    if (variants) await deps.ebay.putItemGroup(token, groupKey, buildEbayGroup(p, { title, items, imageUrls }));

    const offers = new Map<string, string>();
    for (const item of items) {
      const offer: EbayOfferInput = {
        sku: item.sku,
        marketplaceId: EBAY_MARKETPLACE,
        format: "FIXED_PRICE",
        availableQuantity: Math.max(0, item.quantity),
        categoryId,
        listingDescription: textToHtml(p.description),
        merchantLocationKey: EBAY_LOCATION_KEY,
        listingPolicies: {
          fulfillmentPolicyId: account.policies!.fulfillmentPolicyId,
          paymentPolicyId: account.policies!.paymentPolicyId,
          returnPolicyId: account.policies!.returnPolicyId,
        },
        pricingSummary: { price: { value: amount(item.priceCents), currency: "USD" } },
      };
      let offerId = metaOf(p.listings.find((l) => l.skuCode === item.sku)).offerId ?? (await deps.ebay.findOffer(token, item.sku))?.offerId;
      if (offerId) {
        try {
          await deps.ebay.updateOffer(token, offerId, offer);
        } catch (err) {
          // Offre supprimée côté eBay : on en crée une nouvelle.
          if (!(err instanceof ChannelApiError && err.status === 404)) throw err;
          offerId = undefined;
        }
      }
      offers.set(item.sku, offerId ?? (await deps.ebay.createOffer(token, offer)));
    }

    // Variantes retirées de la fiche : l'article eBay est supprimé (il quitte le groupe).
    for (const l of p.listings.filter((x) => !skus.includes(x.skuCode) && x.status !== "REMOVED")) {
      await deps.ebay.deleteInventoryItem(token, l.skuCode);
      await saveListing(deps, CH, p.organizationId, l.skuCode, { productId: p.id, status: "REMOVED", errorCode: null, errorMessage: null });
      if (isOnChannel(l)) await logChannel(deps, CH, { organizationId: p.organizationId, productId: p.id, skuCode: l.skuCode, ok: true, message: "removed" });
    }

    // Publication : une annonce déjà en ligne est révisée par les envois ci-dessus ; une nouvelle variante
    // d'un groupe, ou une annonce retirée, doit être (re)publiée.
    const allLive = items.every((i) => {
      const l = p.listings.find((x) => x.skuCode === i.sku);
      return l != null && isOnChannel(l);
    });
    let listingId = live[0]?.externalId ?? null;
    if (!allLive || !listingId) {
      listingId = variants ? await deps.ebay.publishGroup(token, groupKey) : await deps.ebay.publishOffer(token, offers.get(items[0]!.sku)!);
    }

    const now = deps.now?.() ?? new Date();
    for (const item of items) {
      const existing = p.listings.find((l) => l.skuCode === item.sku);
      await saveListing(deps, CH, p.organizationId, item.sku, {
        productId: p.id,
        status: "LISTED",
        externalId: listingId,
        externalParentId: variants ? groupKey : null,
        externalMeta: { offerId: offers.get(item.sku), categoryId },
        externalUrl: deps.ebay.listingUrl(listingId),
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

/** Fiche supprimée dans OmniList : articles, offres et annonce eBay supprimés. */
export async function removeFromEbay(deps: ChannelDeps, organizationId: string, skus: string[]) {
  if (skus.length === 0) return;
  const connection = await findConnection(deps, organizationId, CH);
  if (!connection) return;
  let token: string;
  try {
    token = await ebayAccessToken(deps, connection);
  } catch (err) {
    if (err instanceof NotConnectedError) return;
    throw new RetryableChannelError((err as Error).message);
  }
  const listings = await deps.prisma.channelListing.findMany({ where: { organizationId, channel: CH, skuCode: { in: skus } } });
  try {
    for (const group of new Set(listings.map((l) => l.externalParentId).filter((x): x is string => !!x))) {
      await deps.ebay.withdrawGroup(token, group);
    }
    for (const l of listings) {
      await deps.ebay.deleteInventoryItem(token, l.skuCode);
      await saveListing(deps, CH, organizationId, l.skuCode, { productId: null, status: "REMOVED", errorCode: null, errorMessage: null });
      if (isOnChannel(l)) await logChannel(deps, CH, { organizationId, productId: null, skuCode: l.skuCode, ok: true, message: "removed" });
    }
    for (const group of new Set(listings.map((l) => l.externalParentId).filter((x): x is string => !!x))) {
      await deps.ebay.deleteItemGroup(token, group);
    }
  } catch (err) {
    await handleUnauthorized(deps, connection, err);
    const e = asChannelError(err);
    for (const l of listings) await saveListing(deps, CH, organizationId, l.skuCode, { productId: null, status: "ERROR", errorCode: e.code, errorMessage: e.message });
    if (e.retryable) throw new RetryableChannelError(e.message);
  }
}

// ---------------------------------------------------------------------------
// Commandes
// ---------------------------------------------------------------------------

/** null : paiement pas (encore) reçu, ce n'est pas une vente. */
function statusOf(o: EbayOrder): OrderStatus | null {
  if (o.cancelStatus?.cancelState === "CANCELED") return "CANCELLED";
  if (o.orderPaymentStatus === "FULLY_REFUNDED") return "REFUNDED";
  if (o.orderPaymentStatus === "PENDING" || o.orderPaymentStatus === "FAILED") return null;
  if (o.orderFulfillmentStatus === "FULFILLED") return "SHIPPED";
  return "PAID";
}

const cents = (m: { value: string } | undefined) => Math.round(Number(m?.value ?? 0) * 100);

export function ebayOrderToInput(organizationId: string, o: EbayOrder, status: OrderStatus): OrderInput {
  return {
    organizationId,
    channel: CH,
    source: "CHANNEL",
    externalOrderId: o.orderId,
    status,
    buyerName: o.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo?.fullName ?? o.buyer?.username ?? null,
    buyerRef: o.buyer?.username ?? null,
    currency: o.pricingSummary?.total?.currency ?? o.lineItems[0]?.lineItemCost.currency ?? "USD",
    placedAt: new Date(o.creationDate),
    lines: o.lineItems.map((li) => ({
      // Annonce créée hors OmniList : pas de SKU, on garde le numéro d'objet eBay pour le journal.
      sku: li.sku || `ebay-${li.legacyItemId ?? li.lineItemId}`,
      quantity: li.quantity,
      // lineItemCost : prix de la ligne entière.
      unitPriceCents: Math.round(cents(li.lineItemCost) / Math.max(1, li.quantity)),
      title: li.title.slice(0, 200),
    })),
  };
}

const NONE: StockChange = { created: false, productIds: [], oversoldQty: 0 };

/** Commande eBay : enregistrée une seule fois ; un paiement en attente n'est pas encore une vente. */
export async function importEbayOrder(deps: ChannelDeps, organizationId: string, order: EbayOrder): Promise<StockChange> {
  let status = statusOf(order);
  if (!status) {
    // Déjà comptée puis paiement échoué : traitée comme annulée.
    const known = await deps.prisma.order.findFirst({ where: { organizationId, channel: CH, externalOrderId: order.orderId } });
    if (!known || order.orderPaymentStatus !== "FAILED") return NONE;
    status = "CANCELLED";
  }
  return recordOrder(deps.prisma, ebayOrderToInput(organizationId, order, status));
}

const OVERLAP_MS = 15 * 60 * 1000;
const MAX_PAGES = 10;
const PAGE = 200;

/** Relevé des commandes eBay modifiées depuis le dernier passage (eBay n'envoie pas de webhook de commande REST). */
export async function pollEbayOrders(deps: ChannelDeps, connection: ChannelConnection): Promise<string[]> {
  const now = deps.now?.() ?? new Date();
  let token: string;
  try {
    token = await ebayAccessToken(deps, connection);
  } catch (err) {
    if (err instanceof NotConnectedError) return [];
    throw err;
  }
  const since = new Date((connection.ordersSyncedAt ?? connection.createdAt).getTime() - (connection.ordersSyncedAt ? OVERLAP_MS : 1000));
  const productIds = new Set<string>();
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await deps.ebay.listOrders(token, { modifiedSince: since, offset: page * PAGE, limit: PAGE });
      for (const order of res.orders) {
        if (placedBeforeConnection(new Date(order.creationDate), connection.createdAt)) continue;
        (await importEbayOrder(deps, connection.organizationId, order)).productIds.forEach((id) => productIds.add(id));
      }
      if (!res.next || (page + 1) * PAGE >= res.total) break;
    }
  } catch (err) {
    await handleUnauthorized(deps, connection, err);
    throw err;
  }
  await deps.prisma.channelConnection.update({ where: { id: connection.id }, data: { ordersSyncedAt: now } });
  return [...productIds];
}
