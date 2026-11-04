import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Prisma } from "@hub/db";
import {
  CHANNELS,
  CHANNEL_DEFAULT_ENABLED,
  CHANNEL_LABEL,
  CHANNEL_TITLE_MAX,
  DEFAULT_CURRENCY,
  DEPOP_DEPARTMENTS,
  depopIssues,
  type DepopDepartment,
  type DepopDetails,
  type DepopIssue,
  PERCENT_BPS_MAX,
  PERCENT_BPS_MIN,
  applyPriceRule,
  feePreview,
  type Channel,
  type PriceRule,
} from "@hub/shared";
import { HttpError } from "../lib/errors.js";
import { requirePermission } from "../plugins/auth.js";
import { listingNeedsSync } from "@hub/channels";
import { SUPPORTED_CHANNELS } from "./channels.js";
import { photoUrl } from "./photos.js";

// ---------------------------------------------------------------------------
// Validation (US4 : champs obligatoires, 1 à 12 photos, article unique ou variantes)
// ---------------------------------------------------------------------------

export const MAX_PHOTOS = 12;
export const MAX_VARIANTS = 100;

const Money = z.number().int("price_invalid").min(1, "price_invalid").max(100_000_000);
const SkuCode = z
  .string()
  .trim()
  .min(1, "SKU obligatoire")
  .max(50)
  .regex(/^[A-Za-z0-9._-]+$/, "sku_format");

const Attributes = z
  .record(z.string().trim().min(1).max(30), z.string().trim().min(1, "value_required").max(50))
  .refine((a) => Object.keys(a).length >= 1 && Object.keys(a).length <= 3, "1 à 3 options par variante (ex. Taille, Couleur)");

const VariantInput = z.object({
  id: z.string().optional(),
  sku: SkuCode,
  attributes: Attributes,
  priceCents: Money,
  quantity: z.number().int().min(0, "quantity_invalid").max(100_000),
});

const ProductBase = {
  title: z.string().trim().min(1, "title_required").max(200),
  description: z.string().trim().min(1, "description_required").max(5000),
  brand: z.string().trim().max(100).nullish(),
  condition: z.enum(["NEW", "USED_LIKE_NEW", "USED_GOOD", "USED_FAIR"]).default("NEW"),
  photoIds: z
    .array(z.string().min(1))
    .min(1, "photo_required")
    .max(MAX_PHOTOS, `${MAX_PHOTOS} photos maximum`)
    .refine((ids) => new Set(ids).size === ids.length, "photo_duplicate"),
};

export const ProductInput = z
  .discriminatedUnion("mode", [
    z.object({ ...ProductBase, mode: z.literal("SINGLE"), sku: SkuCode, priceCents: Money }),
    z.object({
      ...ProductBase,
      mode: z.literal("VARIANTS"),
      variants: z.array(VariantInput).min(1, "variant_required").max(MAX_VARIANTS),
    }),
  ])
  .superRefine((p, ctx) => {
    // Zod lance ce contrôle même si « au moins 1 variante » a déjà échoué.
    if (p.mode !== "VARIANTS" || p.variants.length === 0) return;
    const optionNames = JSON.stringify(Object.keys(p.variants[0]!.attributes).sort());
    const skus = new Set<string>();
    const combos = new Set<string>();
    p.variants.forEach((v, i) => {
      if (JSON.stringify(Object.keys(v.attributes).sort()) !== optionNames) {
        ctx.addIssue({ code: "custom", path: ["variants", i, "attributes"], message: "variant_options_mismatch" });
      }
      const sku = v.sku.toUpperCase();
      if (skus.has(sku)) ctx.addIssue({ code: "custom", path: ["variants", i, "sku"], message: "sku_duplicate" });
      skus.add(sku);
      const combo = JSON.stringify(Object.entries(v.attributes).map(([k, val]) => [k, val.toLowerCase()]).sort());
      if (combos.has(combo)) ctx.addIssue({ code: "custom", path: ["variants", i, "attributes"], message: "variant_duplicate" });
      combos.add(combo);
    });
  });
type ProductInput = z.infer<typeof ProductInput>;

const ChannelParam = z.enum(CHANNELS);

// Champs propres à Depop (rayon, type, taille, port). Les valeurs sont contrôlées par depopIssues.
const DepopDetailsInput = z
  .object({
    department: z.enum(DEPOP_DEPARTMENTS.map((d) => d.id) as [DepopDepartment, ...DepopDepartment[]]).optional(),
    productType: z.string().trim().min(1).max(60).optional(),
    sizeId: z.number().int().positive().optional(),
    shippingCents: z.number().int().min(0).max(100_000).optional(),
  })
  .strict();

const ChannelInput = z.object({
  enabled: z.boolean(),
  details: z.record(z.unknown()).nullish(),
  title: z.string().trim().max(255).nullish(),
  category: z.string().trim().max(200).nullish(),
  price: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("BASE") }),
    z.object({ mode: z.literal("FIXED"), priceCents: Money }),
    z.object({ mode: z.literal("PERCENT"), percentBps: z.number().int().min(PERCENT_BPS_MIN).max(PERCENT_BPS_MAX) }),
  ]),
});

const ListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

// ---------------------------------------------------------------------------
// Lecture et mise en forme
// ---------------------------------------------------------------------------

const productInclude = {
  photos: { orderBy: { position: "asc" } },
  variants: { orderBy: { position: "asc" }, include: { sku: true } },
  channels: true,
  skus: { where: { variantId: null } },
  listings: { orderBy: { skuCode: "asc" } },
} satisfies Prisma.ProductInclude;

type ProductWithRelations = Prisma.ProductGetPayload<{ include: typeof productInclude }>;
type ChannelRow = ProductWithRelations["channels"][number];

/** Articles vendables : l'article unique, ou chaque variante. */
function sellableItems(p: ProductWithRelations) {
  if (p.mode === "SINGLE") {
    return [
      { variantId: null as string | null, sku: p.skus[0]?.code ?? "", priceCents: p.priceCents ?? 0, quantity: p.skus[0]?.quantity ?? 0, attributes: undefined },
    ];
  }
  return p.variants.map((v) => ({
    variantId: v.id as string | null,
    sku: v.sku?.code ?? "",
    priceCents: v.priceCents,
    quantity: v.sku?.quantity ?? 0,
    attributes: v.attributes as Record<string, string> | undefined,
  }));
}

function ruleOf(row: ChannelRow | undefined): PriceRule {
  if (row?.priceMode === "FIXED" && row.priceCents != null) return { mode: "FIXED", priceCents: row.priceCents };
  if (row?.priceMode === "PERCENT" && row.percentBps != null) return { mode: "PERCENT", percentBps: row.percentBps };
  return { mode: "BASE" };
}

/** Canaux où la catégorie n'est pas exigée pour publier. */
// eBay : sans catégorie saisie, OmniList prend celle qu'eBay suggère pour le titre.
const CATEGORY_OPTIONAL: ReadonlySet<Channel> = new Set(["EBAY", "SHOPIFY", "WOOCOMMERCE"]);

function serializeChannel(p: ProductWithRelations, channel: Channel) {
  const row = p.channels.find((c) => c.channel === channel);
  const rule = ruleOf(row);
  const effectiveTitle = row?.title || p.title;
  const enabled = row?.enabled ?? CHANNEL_DEFAULT_ENABLED[channel];
  const details = (row?.details ?? {}) as DepopDetails;
  // Codes seulement : le front affiche le texte dans la langue de l'utilisateur.
  const warnings: Array<{ code: "title_too_long"; length: number; max: number } | { code: "category_missing" } | DepopIssue> = [];
  if (channel === "DEPOP") {
    // Depop n'a ni titre ni catégorie libre : ses propres contrôles remplacent les avertissements génériques.
    warnings.push(...depopWarnings(p, details, rule));
  } else {
    if (effectiveTitle.length > CHANNEL_TITLE_MAX[channel]) {
      warnings.push({ code: "title_too_long", length: effectiveTitle.length, max: CHANNEL_TITLE_MAX[channel] });
    }
    // Shopify (type de produit) et WooCommerce (étiquette) : catégorie facultative.
    if (enabled && !row?.category && !CATEGORY_OPTIONAL.has(channel)) warnings.push({ code: "category_missing" });
  }
  return {
    channel,
    label: CHANNEL_LABEL[channel],
    enabled,
    title: row?.title ?? null,
    effectiveTitle,
    titleMax: CHANNEL_TITLE_MAX[channel],
    category: row?.category ?? null,
    price: rule,
    // Aperçu indicatif des frais pour chaque article vendable.
    preview: sellableItems(p).map((item) => ({
      variantId: item.variantId,
      sku: item.sku,
      basePriceCents: item.priceCents,
      ...feePreview(applyPriceRule(item.priceCents, rule), channel),
    })),
    warnings,
    details: row?.details ?? null,
    // Publication réelle possible pour ce canal (Depop pour l'instant).
    publishable: SUPPORTED_CHANNELS.has(channel),
    listings: p.listings
      .filter((l) => l.channel === channel)
      .map((l) => ({
        sku: l.skuCode,
        status: l.status,
        externalUrl: l.externalUrl,
        errorCode: l.errorCode,
        errorMessage: l.errorMessage,
        updatedAt: l.updatedAt,
      })),
  };
}

function depopWarnings(p: ProductWithRelations, details: DepopDetails, rule: PriceRule) {
  return depopIssues({
    mode: p.mode,
    title: p.title,
    description: p.description,
    brand: p.brand,
    details,
    items: sellableItems(p).map((i) => ({ sku: i.sku, priceCents: applyPriceRule(i.priceCents, rule), attributes: i.attributes })),
  });
}

/** Annonces en ligne ou en cours d'envoi : toute modification de la fiche doit être renvoyée. */
const hasActiveListings = (p: ProductWithRelations, channel: Channel) =>
  p.listings.some((l) => l.channel === channel && listingNeedsSync(l));

function serializeProduct(p: ProductWithRelations) {
  const items = sellableItems(p);
  const prices = items.map((i) => i.priceCents);
  return {
    id: p.id,
    title: p.title,
    description: p.description,
    brand: p.brand,
    condition: p.condition,
    mode: p.mode,
    currency: p.currency,
    sku: p.mode === "SINGLE" ? (p.skus[0]?.code ?? null) : null,
    priceCents: p.mode === "SINGLE" ? p.priceCents : null,
    quantity: items.reduce((sum, i) => sum + i.quantity, 0),
    priceRange: { minCents: Math.min(...prices), maxCents: Math.max(...prices) },
    photos: p.photos.map((ph) => ({ id: ph.id, url: photoUrl(ph.id), position: ph.position })),
    variants: p.variants.map((v) => ({
      id: v.id,
      sku: v.sku?.code ?? "",
      attributes: v.attributes as Record<string, string>,
      priceCents: v.priceCents,
      quantity: v.sku?.quantity ?? 0,
    })),
    channels: CHANNELS.map((c) => serializeChannel(p, c)),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

async function loadProduct(app: FastifyInstance, organizationId: string, id: string) {
  const product = await app.prisma.product.findFirst({ where: { id, organizationId }, include: productInclude });
  if (!product) throw new HttpError(404, "not_found");
  return product;
}

// ---------------------------------------------------------------------------
// Écriture
// ---------------------------------------------------------------------------

const skuCodes = (input: ProductInput) => (input.mode === "SINGLE" ? [input.sku] : input.variants.map((v) => v.sku));

/** Vérifie qu'aucun SKU n'est déjà utilisé par un autre produit de la boutique (comparaison sans casse). */
async function assertSkusFree(tx: Prisma.TransactionClient, organizationId: string, codes: string[], productId?: string) {
  const taken = await tx.sku.findFirst({
    where: {
      organizationId,
      OR: codes.map((code) => ({ code: { equals: code, mode: "insensitive" as const } })),
      ...(productId ? { NOT: { productId } } : {}),
    },
  });
  if (taken) throw new HttpError(409, "sku_taken", { sku: taken.code });
}

/** Les photos doivent appartenir à la boutique, et être libres ou déjà sur ce produit. */
async function assertPhotosUsable(tx: Prisma.TransactionClient, organizationId: string, photoIds: string[], productId?: string) {
  const count = await tx.productPhoto.count({
    where: {
      id: { in: photoIds },
      organizationId,
      OR: [{ productId: null }, ...(productId ? [{ productId }] : [])],
    },
  });
  if (count !== photoIds.length) throw new HttpError(400, "invalid_photos");
}

async function attachPhotos(tx: Prisma.TransactionClient, productId: string, photoIds: string[]) {
  for (const [position, id] of photoIds.entries()) {
    await tx.productPhoto.update({ where: { id }, data: { productId, position } });
  }
}

/**
 * Écrit variantes et SKU sans toucher au stock existant : le stock central (Sku.quantity) ne change
 * que par une vente, une annulation ou un ajustement (page Stock). La quantité saisie ne sert
 * qu'au stock de départ d'un nouvel article ou d'une nouvelle variante.
 */
async function writeVariantsAndSkus(
  tx: Prisma.TransactionClient,
  organizationId: string,
  productId: string,
  input: ProductInput,
  existingVariantIds: string[],
) {
  if (input.mode === "SINGLE") {
    // Les SKU des variantes partent avec elles (suppression en cascade).
    await tx.productVariant.deleteMany({ where: { productId } });
    const single = await tx.sku.findFirst({ where: { productId, variantId: null } });
    if (single) await tx.sku.update({ where: { id: single.id }, data: { code: input.sku } });
    else await tx.sku.create({ data: { organizationId, productId, code: input.sku, quantity: 1 } });
    return;
  }

  await tx.sku.deleteMany({ where: { productId, variantId: null } });
  const keep = input.variants.map((v) => v.id).filter((id): id is string => !!id && existingVariantIds.includes(id));
  await tx.productVariant.deleteMany({ where: { productId, id: { notIn: keep } } });

  for (const [position, v] of input.variants.entries()) {
    const data = { attributes: v.attributes, priceCents: v.priceCents, position };
    if (v.id && keep.includes(v.id)) {
      await tx.productVariant.update({ where: { id: v.id }, data });
      await tx.sku.update({ where: { variantId: v.id }, data: { code: v.sku } });
    } else {
      const variant = await tx.productVariant.create({ data: { ...data, productId } });
      await tx.sku.create({ data: { organizationId, productId, variantId: variant.id, code: v.sku, quantity: v.quantity } });
    }
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const productRoutes: FastifyPluginAsync = async (app) => {
  const canManage = { preHandler: requirePermission("products:manage") };

  app.get("/", canManage, async (request) => {
    const { q, page, pageSize } = ListQuery.parse(request.query);
    const where: Prisma.ProductWhereInput = {
      organizationId: request.auth!.organizationId,
      ...(q
        ? {
            OR: [
              { title: { contains: q, mode: "insensitive" } },
              { skus: { some: { code: { contains: q, mode: "insensitive" } } } },
            ],
          }
        : {}),
    };
    const [total, products] = await app.prisma.$transaction([
      app.prisma.product.count({ where }),
      app.prisma.product.findMany({
        where,
        include: productInclude,
        orderBy: { updatedAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      total,
      page,
      pageSize,
      items: products.map((p) => {
        const full = serializeProduct(p);
        return {
          id: full.id,
          title: full.title,
          mode: full.mode,
          currency: full.currency,
          sku: full.sku,
          variantCount: full.variants.length,
          quantity: full.quantity,
          priceRange: full.priceRange,
          photoUrl: full.photos[0]?.url ?? null,
          channels: full.channels.filter((c) => c.enabled).map((c) => c.channel),
          warningCount: full.channels.reduce((n, c) => n + (c.enabled ? c.warnings.length : 0), 0),
          updatedAt: full.updatedAt,
        };
      }),
    };
  });

  app.get<{ Params: { id: string } }>("/:id", canManage, async (request) => {
    return serializeProduct(await loadProduct(app, request.auth!.organizationId, request.params.id));
  });

  // US4 : création de la fiche maître.
  app.post("/", canManage, async (request, reply) => {
    const input = ProductInput.parse(request.body);
    const { organizationId } = request.auth!;

    const productId = await app.prisma.$transaction(async (tx) => {
      await assertPhotosUsable(tx, organizationId, input.photoIds);
      await assertSkusFree(tx, organizationId, skuCodes(input));
      const product = await tx.product.create({
        data: {
          organizationId,
          title: input.title,
          description: input.description,
          brand: input.brand || null,
          condition: input.condition,
          mode: input.mode,
          currency: DEFAULT_CURRENCY,
          priceCents: input.mode === "SINGLE" ? input.priceCents : null,
          channels: { create: CHANNELS.map((channel) => ({ channel, enabled: CHANNEL_DEFAULT_ENABLED[channel] })) },
        },
      });
      await writeVariantsAndSkus(tx, organizationId, product.id, input, []);
      await attachPhotos(tx, product.id, input.photoIds);
      return product.id;
    });

    return reply.code(201).send(serializeProduct(await loadProduct(app, organizationId, productId)));
  });

  // Modification complète de la fiche maître (photos dans l'ordre voulu, variantes).
  app.put<{ Params: { id: string } }>("/:id", canManage, async (request) => {
    const input = ProductInput.parse(request.body);
    const { organizationId } = request.auth!;
    const existing = await loadProduct(app, organizationId, request.params.id);

    const removedPhotos = existing.photos.filter((ph) => !input.photoIds.includes(ph.id));
    await app.prisma.$transaction(async (tx) => {
      await assertPhotosUsable(tx, organizationId, input.photoIds, existing.id);
      await assertSkusFree(tx, organizationId, skuCodes(input), existing.id);
      await tx.product.update({
        where: { id: existing.id },
        data: {
          title: input.title,
          description: input.description,
          brand: input.brand || null,
          condition: input.condition,
          mode: input.mode,
          priceCents: input.mode === "SINGLE" ? input.priceCents : null,
        },
      });
      // Un prix fixe par canal n'a pas de sens pour plusieurs variantes : on revient au prix maître.
      if (input.mode === "VARIANTS") {
        await tx.productChannel.updateMany({
          where: { productId: existing.id, priceMode: "FIXED" },
          data: { priceMode: "BASE", priceCents: null },
        });
      }
      await writeVariantsAndSkus(tx, organizationId, existing.id, input, existing.variants.map((v) => v.id));
      await tx.productPhoto.deleteMany({ where: { id: { in: removedPhotos.map((ph) => ph.id) } } });
      await attachPhotos(tx, existing.id, input.photoIds);
    });

    for (const ph of removedPhotos) {
      await app.storage.delete(ph.storageKey).catch((err) => request.log.warn(err, "suppression photo S3"));
    }
    const updated = await loadProduct(app, organizationId, existing.id);
    await syncListedChannels(updated);
    return serializeProduct(updated);
  });

  app.delete<{ Params: { id: string } }>("/:id", canManage, async (request, reply) => {
    const { organizationId } = request.auth!;
    const existing = await loadProduct(app, organizationId, request.params.id);
    await app.prisma.$transaction([
      app.prisma.productPhoto.deleteMany({ where: { productId: existing.id } }),
      app.prisma.product.delete({ where: { id: existing.id } }),
    ]);
    // Les annonces en ligne sont retirées des canaux par le worker.
    for (const channel of SUPPORTED_CHANNELS) {
      // eBay : une annonce retirée garde son article et son offre dans l'inventaire du vendeur ; on les efface aussi.
      const skus = existing.listings.filter((l) => l.channel === channel && (l.status !== "REMOVED" || channel === "EBAY")).map((l) => l.skuCode);
      if (skus.length > 0) await app.channels.queue.add({ name: "remove", data: { organizationId, channel, skus } });
    }
    for (const ph of existing.photos) {
      await app.storage.delete(ph.storageKey).catch((err) => request.log.warn(err, "suppression photo S3"));
    }
    return reply.code(204).send();
  });

  // US5 : titre, catégorie et prix pour un canal.
  app.put<{ Params: { id: string; channel: string } }>("/:id/channels/:channel", canManage, async (request) => {
    const channel = ChannelParam.parse(request.params.channel);
    const input = ChannelInput.parse(request.body);
    const { organizationId } = request.auth!;
    const product = await loadProduct(app, organizationId, request.params.id);

    if (input.price.mode === "FIXED" && product.mode === "VARIANTS") {
      throw new HttpError(400, "fixed_price_single_only");
    }
    const title = input.title || null;
    if (title && title.length > CHANNEL_TITLE_MAX[channel]) {
      throw new HttpError(400, "title_too_long", { max: CHANNEL_TITLE_MAX[channel] });
    }

    const details = channel === "DEPOP" ? DepopDetailsInput.parse(input.details ?? {}) : undefined;

    const data = {
      enabled: input.enabled,
      title,
      category: input.category || null,
      ...(details ? { details } : {}),
      priceMode: input.price.mode,
      priceCents: input.price.mode === "FIXED" ? input.price.priceCents : null,
      percentBps: input.price.mode === "PERCENT" ? input.price.percentBps : null,
    };
    await app.prisma.productChannel.upsert({
      where: { productId_channel: { productId: product.id, channel } },
      create: { productId: product.id, channel, ...data },
      update: data,
    });
    // Toucher le produit pour remonter dans la liste « récemment modifiés ».
    await app.prisma.product.update({ where: { id: product.id }, data: { updatedAt: new Date() } });

    const updated = await loadProduct(app, organizationId, product.id);
    // Déjà en ligne : on renvoie les nouveaux réglages (ou on retire l'annonce si le canal est désactivé).
    if (SUPPORTED_CHANNELS.has(channel) && hasActiveListings(updated, channel)) {
      await markPending(updated, channel);
      await app.channels.queue.add({ name: "publish", data: { productId: updated.id, channel } });
    }
    return serializeChannel(await loadProduct(app, organizationId, product.id), channel);
  });

  // Publication (ou mise à jour) de la fiche sur un canal branché : le worker fait l'envoi.
  app.post<{ Params: { id: string; channel: string } }>("/:id/channels/:channel/publish", canManage, async (request) => {
    const channel = ChannelParam.parse(request.params.channel);
    if (!SUPPORTED_CHANNELS.has(channel)) throw new HttpError(400, "channel_not_supported");
    const { organizationId } = request.auth!;
    const product = await loadProduct(app, organizationId, request.params.id);

    const connection = await app.prisma.channelConnection.findUnique({
      where: { organizationId_channel: { organizationId, channel } },
    });
    if (!connection) throw new HttpError(409, "channel_not_connected");
    if (connection.status !== "CONNECTED") throw new HttpError(409, "channel_needs_reauth");
    if (channel === "DEPOP" && !(connection.settings as { shipFromState?: string } | null)?.shipFromState) {
      throw new HttpError(409, "ship_from_missing");
    }
    if (channel === "EBAY" && !(connection.settings as { postalCode?: string } | null)?.postalCode) {
      throw new HttpError(409, "ebay_location_missing");
    }

    const settings = serializeChannel(product, channel);
    if (settings.warnings.length > 0) throw new HttpError(400, "listing_incomplete", { warnings: settings.warnings });

    // Publier active le canal sur la fiche.
    await app.prisma.productChannel.upsert({
      where: { productId_channel: { productId: product.id, channel } },
      create: { productId: product.id, channel, enabled: true },
      update: { enabled: true },
    });
    await markPending(product, channel);
    await app.channels.queue.add({ name: "publish", data: { productId: product.id, channel } });
    return serializeChannel(await loadProduct(app, organizationId, product.id), channel);
  });

  /** Chaque SKU de la fiche passe « en attente » jusqu'au passage du worker. */
  async function markPending(p: ProductWithRelations, channel: Channel) {
    for (const item of sellableItems(p)) {
      await app.prisma.channelListing.upsert({
        where: { organizationId_channel_skuCode: { organizationId: p.organizationId, channel, skuCode: item.sku } },
        create: { organizationId: p.organizationId, productId: p.id, channel, skuCode: item.sku },
        update: { productId: p.id, status: "PENDING", errorCode: null, errorMessage: null },
      });
    }
  }

  /** Fiche maître modifiée : on renvoie la mise à jour aux canaux où elle est en ligne. */
  async function syncListedChannels(p: ProductWithRelations) {
    for (const channel of SUPPORTED_CHANNELS) {
      if (!hasActiveListings(p, channel)) continue;
      await markPending(p, channel);
      await app.channels.queue.add({ name: "publish", data: { productId: p.id, channel } });
    }
  }
};
