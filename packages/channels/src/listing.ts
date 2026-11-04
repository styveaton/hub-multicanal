import type { Channel, Prisma, PrismaClient } from "@hub/db";
import { applyPriceRule, type PriceRule } from "@hub/shared";
import type { MediaSigner, TokenCipher } from "./crypto.js";
import type { DepopClient } from "./depop/client.js";
import type { EbayClient } from "./ebay/client.js";
import type { EtsyClient, EtsyPhoto } from "./etsy/client.js";
import type { ShopifyClient } from "./shopify/client.js";
import type { WooClient } from "./woocommerce/client.js";

/**
 * Outils communs à la publication sur tous les canaux branchés (Depop, Shopify, WooCommerce) :
 * chargement de la fiche, articles vendables, annonces par SKU et journal de synchronisation.
 */

export interface ChannelDeps {
  prisma: PrismaClient;
  cipher: TokenCipher;
  media: MediaSigner;
  depop: DepopClient;
  shopify: ShopifyClient;
  woo: WooClient;
  ebay: EbayClient;
  etsy: EtsyClient;
  /** Fichier d'une photo (Etsy veut l'image elle-même) ; par défaut, lu par son lien signé. */
  loadPhoto?: (photoId: string) => Promise<EtsyPhoto>;
  now?: () => Date;
}

/** Erreur temporaire : le job est relancé par BullMQ. */
export class RetryableChannelError extends Error {}

/** Compte non connecté ou accès retiré : le propriétaire doit (re)connecter le canal. */
export class NotConnectedError extends Error {}

/** Erreur renvoyée par un canal. `retryable` : relancer plus tard peut réussir (429, 5xx, réseau). */
export class ChannelApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ChannelApiError";
  }
}

/** Fiche avec ce dont la publication sur `channel` a besoin. */
export const includeFor = (channel: Channel) =>
  ({
    photos: { orderBy: { position: "asc" as const } },
    variants: { orderBy: { position: "asc" as const }, include: { sku: true } },
    skus: { where: { variantId: null } },
    channels: { where: { channel } },
    listings: { where: { channel } },
  }) satisfies Prisma.ProductInclude;

export type LoadedProduct = Prisma.ProductGetPayload<{ include: ReturnType<typeof includeFor> }>;
export type LoadedListing = LoadedProduct["listings"][number];

export const loadProduct = (deps: ChannelDeps, productId: string, channel: Channel) =>
  deps.prisma.product.findUnique({ where: { id: productId }, include: includeFor(channel) });

export function priceRule(row: LoadedProduct["channels"][number] | undefined): PriceRule {
  if (row?.priceMode === "FIXED" && row.priceCents != null) return { mode: "FIXED", priceCents: row.priceCents };
  if (row?.priceMode === "PERCENT" && row.percentBps != null) return { mode: "PERCENT", percentBps: row.percentBps };
  return { mode: "BASE" };
}

export interface SellableItem {
  sku: string;
  /** Prix sur le canal, après la règle de prix du canal. */
  priceCents: number;
  quantity: number;
  attributes?: Record<string, string>;
}

/** L'article unique, ou chaque variante, au prix du canal et avec le stock central. */
export function sellableItems(p: LoadedProduct, rule: PriceRule): SellableItem[] {
  if (p.mode === "SINGLE") {
    return [{ sku: p.skus[0]?.code ?? "", priceCents: applyPriceRule(p.priceCents ?? 0, rule), quantity: p.skus[0]?.quantity ?? 0 }];
  }
  return p.variants.map((v) => ({
    sku: v.sku?.code ?? "",
    priceCents: applyPriceRule(v.priceCents, rule),
    quantity: v.sku?.quantity ?? 0,
    attributes: v.attributes as Record<string, string>,
  }));
}

export type ListingUpdate = Omit<Prisma.ChannelListingUncheckedCreateInput, "organizationId" | "channel" | "skuCode">;

export async function saveListing(deps: ChannelDeps, channel: Channel, organizationId: string, skuCode: string, data: ListingUpdate) {
  await deps.prisma.channelListing.upsert({
    where: { organizationId_channel_skuCode: { organizationId, channel, skuCode } },
    create: { organizationId, channel, skuCode, ...data },
    update: data,
  });
}

/**
 * Annonce présente sur le canal : déjà publiée (identifiant connu) et pas retirée.
 * Le statut seul ne suffit pas : une modification de la fiche repasse l'annonce « en attente ».
 */
export const isOnChannel = (l: { externalId: string | null; status: string }) => l.externalId != null && l.status !== "REMOVED";

/** Trace une action sur un canal dans le journal de synchronisation. */
export async function logChannel(
  deps: ChannelDeps,
  channel: Channel,
  data: { organizationId: string; productId: string | null; skuCode: string; ok: boolean; message: string },
) {
  await deps.prisma.syncLog.create({
    data: {
      organizationId: data.organizationId,
      type: data.ok ? "CHANNEL_UPDATE" : "CHANNEL_ERROR",
      channel,
      skuCode: data.skuCode,
      productId: data.productId,
      message: data.message,
    },
  });
}

/** Toutes les annonces de la fiche passent en erreur (compte non connecté, fiche incomplète…). */
export async function markAll(deps: ChannelDeps, channel: Channel, p: LoadedProduct, skus: string[], errorCode: string, errorMessage: string | null) {
  for (const sku of skus) {
    await saveListing(deps, channel, p.organizationId, sku, { productId: p.id, status: "ERROR", errorCode, errorMessage });
  }
}

/** Connexion du canal pour la boutique, ou null. */
export const findConnection = (deps: ChannelDeps, organizationId: string, channel: Channel) =>
  deps.prisma.channelConnection.findUnique({ where: { organizationId_channel: { organizationId, channel } } });

/** Erreur quelconque → erreur de canal (une erreur inattendue est retentée). */
export const asChannelError = (err: unknown) =>
  err instanceof ChannelApiError ? err : new ChannelApiError(0, "internal_error", (err as Error).message, true);

/** Texte de la fiche → HTML simple (paragraphes et retours à la ligne), échappé. */
export function textToHtml(text: string): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  return text
    .trim()
    .split(/\n{2,}/)
    .map((para) => `<p>${esc(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/** Empreinte des photos envoyées : on ne renvoie les images que si elles ont changé. */
export const photosKey = (p: LoadedProduct) => p.photos.map((ph) => ph.id).join(",");

/** Noms des options (« Taille », « Couleur »…) et leurs valeurs, dans l'ordre d'apparition. */
export function optionsOf(items: SellableItem[]): Array<{ name: string; values: string[] }> {
  const options = new Map<string, string[]>();
  for (const item of items) {
    for (const [name, value] of Object.entries(item.attributes ?? {})) {
      const values = options.get(name) ?? [];
      if (!values.includes(value)) values.push(value);
      options.set(name, values);
    }
  }
  return [...options].map(([name, values]) => ({ name, values }));
}

/**
 * Commande passée avant la connexion du canal : le stock central en tenait déjà compte, on l'ignore.
 * Les canaux datent à la seconde près : on compare à la seconde de la connexion.
 */
export const placedBeforeConnection = (placedAt: Date, connectedAt: Date) => placedAt.getTime() < Math.floor(connectedAt.getTime() / 1000) * 1000;

/** Date WooCommerce « 2026-11-03T10:00:00 » (UTC, sans fuseau) → Date. */
export const wooDate = (value: string) => new Date(`${value.replace(/Z$/, "")}Z`);
