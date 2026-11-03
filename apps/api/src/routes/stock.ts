import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Prisma } from "@hub/db";
import { CHANNELS } from "@hub/shared";
import { InsufficientStockError, UnknownSkuError, adjustStock, propagateStock } from "@hub/channels";
import { HttpError } from "../lib/errors.js";
import { requirePermission } from "../plugins/auth.js";
import { photoUrl } from "./photos.js";

const ListQuery = z.object({
  q: z.string().trim().max(100).optional(),
  filter: z.enum(["all", "low", "out"]).default("all"),
});

const AdjustInput = z
  .object({
    delta: z.number().int().min(-100_000).max(100_000).optional(),
    set: z.number().int().min(0, "quantity_invalid").max(100_000).optional(),
    note: z.string().trim().max(200).optional(),
  })
  .refine((v) => (v.delta === undefined) !== (v.set === undefined), "delta_or_set");

const LogQuery = z.object({
  sku: z.string().trim().max(50).optional(),
  type: z.enum(["SALE", "RESTOCK", "ADJUSTMENT", "OVERSOLD", "UNKNOWN_SKU", "CHANNEL_UPDATE", "CHANNEL_ERROR"]).optional(),
  channel: z.enum(CHANNELS).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

/** Seuil « stock faible ». */
export const LOW_STOCK = 2;

/** US8 : stock central par SKU, corrections et journal de synchronisation. */
export const stockRoutes: FastifyPluginAsync = async (app) => {
  const canManage = { preHandler: requirePermission("stock:manage") };
  const enqueue = { prisma: app.prisma, enqueue: app.channels.queue.add.bind(app.channels.queue) };

  app.get("/", canManage, async (request) => {
    const { q, filter } = ListQuery.parse(request.query);
    const where: Prisma.SkuWhereInput = {
      organizationId: request.auth!.organizationId,
      ...(filter === "out" ? { quantity: 0 } : filter === "low" ? { quantity: { gt: 0, lte: LOW_STOCK } } : {}),
      ...(q
        ? { OR: [{ code: { contains: q, mode: "insensitive" } }, { product: { title: { contains: q, mode: "insensitive" } } }] }
        : {}),
    };
    const skus = await app.prisma.sku.findMany({
      where,
      include: {
        variant: true,
        product: {
          select: {
            id: true,
            title: true,
            photos: { orderBy: { position: "asc" }, take: 1, select: { id: true } },
            listings: { where: { status: "LISTED" }, select: { channel: true, skuCode: true } },
          },
        },
      },
      orderBy: [{ quantity: "asc" }, { code: "asc" }],
      take: 500,
    });
    return {
      lowStock: LOW_STOCK,
      items: skus.map((s) => ({
        sku: s.code,
        productId: s.productId,
        title: s.product.title,
        attributes: (s.variant?.attributes as Record<string, string> | undefined) ?? null,
        quantity: s.quantity,
        photoUrl: s.product.photos[0] ? photoUrl(s.product.photos[0].id) : null,
        // Canaux où ce SKU est en ligne.
        channels: s.product.listings.filter((l) => l.skuCode === s.code).map((l) => l.channel),
      })),
    };
  });

  // Correction du stock : +/- ou nouvelle valeur. Les canaux sont mis à jour aussitôt.
  app.post<{ Params: { sku: string } }>("/:sku/adjust", canManage, async (request) => {
    const input = AdjustInput.parse(request.body);
    try {
      const res = await adjustStock(app.prisma, {
        organizationId: request.auth!.organizationId,
        sku: request.params.sku,
        delta: input.delta,
        set: input.set,
        note: input.note,
      });
      if (res.delta !== 0) await propagateStock(enqueue, [res.productId]);
      return { sku: request.params.sku, quantity: res.quantity };
    } catch (err) {
      if (err instanceof UnknownSkuError) throw new HttpError(404, "not_found");
      if (err instanceof InsufficientStockError) throw new HttpError(409, "stock_negative", { available: err.available });
      throw err;
    }
  });

  // Journal de synchronisation : ventes, corrections, envois aux canaux, doubles ventes.
  app.get("/log", canManage, async (request) => {
    const { sku, type, channel, page, pageSize } = LogQuery.parse(request.query);
    const where: Prisma.SyncLogWhereInput = {
      organizationId: request.auth!.organizationId,
      ...(sku ? { skuCode: sku } : {}),
      ...(type ? { type } : {}),
      ...(channel ? { channel } : {}),
    };
    const [total, entries] = await app.prisma.$transaction([
      app.prisma.syncLog.count({ where }),
      app.prisma.syncLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (page - 1) * pageSize, take: pageSize }),
    ]);
    return {
      total,
      page,
      pageSize,
      items: entries.map((e) => ({
        id: e.id,
        type: e.type,
        channel: e.channel,
        sku: e.skuCode,
        productId: e.productId,
        orderId: e.orderId,
        delta: e.delta,
        quantityAfter: e.quantityAfter,
        message: e.message,
        createdAt: e.createdAt,
      })),
    };
  });
};
