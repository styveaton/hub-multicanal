import { randomUUID } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Prisma } from "@hub/db";
import { CHANNELS, DEFAULT_CURRENCY } from "@hub/shared";
import { InsufficientStockError, UnknownSkuError, cancelOrder, propagateStock, recordOrder } from "@hub/channels";
import { HttpError } from "../lib/errors.js";
import { requirePermission } from "../plugins/auth.js";

const ORDER_STATUSES = ["PAID", "SHIPPED", "COMPLETED", "CANCELLED", "REFUNDED"] as const;

const ListQuery = z.object({
  // « manual » : ventes saisies sans canal (en direct…).
  channel: z.union([z.enum(CHANNELS), z.literal("manual")]).optional(),
  status: z.enum(ORDER_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

const ManualSaleInput = z.object({
  // Canal où la vente a eu lieu (ex. Mercari, pas encore branché), ou null pour une vente en direct.
  channel: z.enum(CHANNELS).nullable().default(null),
  reference: z.string().trim().max(100).optional(),
  buyerName: z.string().trim().max(100).optional(),
  lines: z
    .array(
      z.object({
        sku: z.string().trim().min(1).max(50),
        quantity: z.number().int().min(1, "quantity_invalid").max(10_000),
        unitPriceCents: z.number().int().min(0).max(100_000_000),
      }),
    )
    .min(1)
    .max(50),
});

/** US9 : commandes importées des canaux et ventes saisies ; US8 : chaque vente décompte le stock central. */
export const orderRoutes: FastifyPluginAsync = async (app) => {
  const canView = { preHandler: requirePermission("orders:view") };
  const canSell = { preHandler: requirePermission("stock:manage") };
  const deps = { prisma: app.prisma, enqueue: app.channels.queue.add.bind(app.channels.queue) };

  app.get("/", canView, async (request) => {
    const { channel, status, page, pageSize } = ListQuery.parse(request.query);
    const where: Prisma.OrderWhereInput = {
      organizationId: request.auth!.organizationId,
      ...(channel === "manual" ? { channel: null } : channel ? { channel } : {}),
      ...(status ? { status } : {}),
    };
    const [total, orders] = await app.prisma.$transaction([
      app.prisma.order.count({ where }),
      app.prisma.order.findMany({
        where,
        include: { lines: true },
        orderBy: { placedAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      total,
      page,
      pageSize,
      items: orders.map((o) => ({
        id: o.id,
        channel: o.channel,
        source: o.source,
        externalOrderId: o.externalOrderId,
        status: o.status,
        buyerName: o.buyerName,
        currency: o.currency,
        totalCents: o.totalCents,
        placedAt: o.placedAt,
        oversold: o.lines.some((l) => l.oversoldQty > 0),
        lines: o.lines.map((l) => ({
          sku: l.skuCode,
          productId: l.productId,
          title: l.title,
          quantity: l.quantity,
          unitPriceCents: l.unitPriceCents,
          oversoldQty: l.oversoldQty,
          matched: l.matched,
        })),
      })),
    };
  });

  // Vente saisie : refusée si le stock ne suffit pas (pas de double vente possible depuis OmniList).
  app.post("/", canSell, async (request, reply) => {
    const input = ManualSaleInput.parse(request.body);
    const { organizationId, userId } = request.auth!;
    try {
      const res = await recordOrder(
        app.prisma,
        {
          organizationId,
          channel: input.channel,
          source: "MANUAL",
          externalOrderId: input.reference ? `manual:${input.reference}` : `manual:${randomUUID()}`,
          status: "PAID",
          buyerName: input.buyerName || null,
          currency: DEFAULT_CURRENCY,
          placedAt: new Date(),
          lines: input.lines,
          createdById: userId,
        },
        { strict: true },
      );
      if (!res.created) throw new HttpError(409, "order_exists");
      await propagateStock(deps, res.productIds);
      return reply.code(201).send({ id: res.orderId });
    } catch (err) {
      if (err instanceof UnknownSkuError) throw new HttpError(404, "unknown_sku", { sku: err.sku });
      if (err instanceof InsufficientStockError) throw new HttpError(409, "insufficient_stock", { sku: err.sku, available: err.available });
      throw err;
    }
  });

  // Annulation d'une vente saisie : le stock revient et les canaux sont mis à jour.
  app.post<{ Params: { id: string } }>("/:id/cancel", canSell, async (request) => {
    const { organizationId } = request.auth!;
    const order = await app.prisma.order.findFirst({ where: { id: request.params.id, organizationId } });
    if (!order) throw new HttpError(404, "not_found");
    // Les commandes des canaux s'annulent sur le canal ; l'annulation arrive ensuite par import.
    if (order.source !== "MANUAL") throw new HttpError(409, "cancel_on_channel");
    const res = await cancelOrder(app.prisma, organizationId, order.id);
    await propagateStock(deps, res?.productIds ?? []);
    return { id: order.id, status: "CANCELLED" };
  });
};
