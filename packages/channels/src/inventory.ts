import { Prisma, type Channel, type OrderStatus, type PrismaClient } from "@hub/db";

/**
 * Stock central (US8) : toutes les variations de stock passent par ici, sous verrou de ligne
 * (SELECT … FOR UPDATE) pour que deux ventes simultanées du même SKU ne se marchent pas dessus.
 * Une commande déjà reçue (webhook + relevé de secours) n'est jamais comptée deux fois :
 * index unique (boutique, canal, numéro de commande du canal).
 */

type Tx = Prisma.TransactionClient;

export interface SaleLineInput {
  sku: string;
  quantity: number;
  unitPriceCents: number;
  title?: string;
}

export interface OrderInput {
  organizationId: string;
  /** null : vente saisie hors canal (en direct, salon…). */
  channel: Channel | null;
  source: "CHANNEL" | "MANUAL";
  externalOrderId: string;
  status: OrderStatus;
  buyerName?: string | null;
  currency: string;
  placedAt: Date;
  lines: SaleLineInput[];
  createdById?: string | null;
}

export interface StockChange {
  orderId?: string;
  /** false : commande déjà connue (rien de décompté une deuxième fois). */
  created: boolean;
  /** Fiches dont le stock a bougé : leurs annonces doivent être mises à jour sur les canaux. */
  productIds: string[];
  /** Quantité vendue alors que le stock était déjà à 0. */
  oversoldQty: number;
}

/** Vente refusée : stock insuffisant (ventes saisies dans OmniList uniquement). */
export class InsufficientStockError extends Error {
  constructor(
    readonly sku: string,
    readonly available: number,
  ) {
    super("insufficient_stock");
  }
}

export class UnknownSkuError extends Error {
  constructor(readonly sku: string) {
    super("unknown_sku");
  }
}

const CANCELLED: ReadonlySet<OrderStatus> = new Set(["CANCELLED", "REFUNDED"]);

interface LockedSku {
  id: string;
  code: string;
  quantity: number;
  productId: string;
}

/** Verrouille les SKU (toujours dans le même ordre, pour éviter les interblocages). */
async function lockSkus(tx: Tx, organizationId: string, codes: string[]): Promise<Map<string, LockedSku>> {
  if (codes.length === 0) return new Map();
  const rows = await tx.$queryRaw<LockedSku[]>`
    SELECT "id", "code", "quantity", "productId" FROM "Sku"
    WHERE "organizationId" = ${organizationId} AND "code" = ANY(${codes})
    ORDER BY "id"
    FOR UPDATE`;
  return new Map(rows.map((r) => [r.code, r]));
}

/** Additionne les lignes d'un même SKU (Depop envoie une ligne par unité vendue). */
function groupLines(lines: SaleLineInput[]) {
  const map = new Map<string, SaleLineInput>();
  for (const l of lines) {
    const prev = map.get(l.sku);
    map.set(l.sku, prev ? { ...prev, quantity: prev.quantity + l.quantity } : { ...l });
  }
  return [...map.values()];
}

async function setQuantity(tx: Tx, skuId: string, quantity: number) {
  await tx.sku.update({ where: { id: skuId }, data: { quantity } });
}

async function productTitles(tx: Tx, productIds: string[]) {
  const products = await tx.product.findMany({ where: { id: { in: productIds } }, select: { id: true, title: true } });
  return new Map(products.map((p) => [p.id, p.title]));
}

/** Remet en stock ce qu'une commande avait réellement décompté. */
async function restockLines(tx: Tx, order: { id: string; organizationId: string; channel: Channel | null }) {
  const lines = await tx.orderLine.findMany({ where: { orderId: order.id, matched: true } });
  const locked = await lockSkus(tx, order.organizationId, [...new Set(lines.map((l) => l.skuCode))]);
  const productIds = new Set<string>();
  for (const line of lines) {
    const sku = locked.get(line.skuCode);
    const back = line.quantity - line.oversoldQty;
    if (!sku || back <= 0) continue;
    sku.quantity += back;
    await setQuantity(tx, sku.id, sku.quantity);
    productIds.add(sku.productId);
    await tx.syncLog.create({
      data: {
        organizationId: order.organizationId,
        type: "RESTOCK",
        channel: order.channel,
        skuCode: sku.code,
        productId: sku.productId,
        orderId: order.id,
        delta: back,
        quantityAfter: sku.quantity,
      },
    });
  }
  await tx.order.update({ where: { id: order.id }, data: { restockedAt: new Date() } });
  return [...productIds];
}

async function recordOrderOnce(prisma: PrismaClient, input: OrderInput, strict: boolean): Promise<StockChange> {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.order.findFirst({
      where: { organizationId: input.organizationId, channel: input.channel, externalOrderId: input.externalOrderId },
    });

    if (existing) {
      // Commande déjà importée : seul un changement de statut venant du canal compte
      // (annulation → remise en stock). Une vente saisie en double ne change rien.
      let productIds: string[] = [];
      if (input.source === "CHANNEL" && existing.status !== input.status) {
        await tx.order.update({ where: { id: existing.id }, data: { status: input.status } });
        if (CANCELLED.has(input.status) && !CANCELLED.has(existing.status) && !existing.restockedAt) {
          productIds = await restockLines(tx, existing);
        }
      }
      return { orderId: existing.id, created: false, productIds, oversoldQty: 0 };
    }

    const lines = groupLines(input.lines);
    const locked = await lockSkus(tx, input.organizationId, lines.map((l) => l.sku));
    const titles = await productTitles(tx, [...new Set([...locked.values()].map((s) => s.productId))]);
    const countsAgainstStock = !CANCELLED.has(input.status);

    const order = await tx.order.create({
      data: {
        organizationId: input.organizationId,
        channel: input.channel,
        source: input.source,
        externalOrderId: input.externalOrderId,
        status: input.status,
        buyerName: input.buyerName ?? null,
        currency: input.currency,
        totalCents: lines.reduce((sum, l) => sum + l.unitPriceCents * l.quantity, 0),
        placedAt: input.placedAt,
        restockedAt: countsAgainstStock ? null : new Date(),
        createdById: input.createdById ?? null,
      },
    });

    const productIds = new Set<string>();
    let oversoldTotal = 0;
    for (const line of lines) {
      const sku = locked.get(line.sku);
      if (!sku) {
        if (strict) throw new UnknownSkuError(line.sku);
        await tx.orderLine.create({
          data: { orderId: order.id, skuCode: line.sku, title: line.title ?? line.sku, quantity: line.quantity, unitPriceCents: line.unitPriceCents, matched: false },
        });
        await tx.syncLog.create({
          data: { organizationId: input.organizationId, type: "UNKNOWN_SKU", channel: input.channel, skuCode: line.sku, orderId: order.id, delta: -line.quantity },
        });
        continue;
      }

      const taken = countsAgainstStock ? Math.min(line.quantity, sku.quantity) : 0;
      const oversold = countsAgainstStock ? line.quantity - taken : 0;
      if (strict && oversold > 0) throw new InsufficientStockError(sku.code, sku.quantity);
      sku.quantity -= taken;
      oversoldTotal += oversold;

      await tx.orderLine.create({
        data: {
          orderId: order.id,
          skuCode: sku.code,
          productId: sku.productId,
          title: titles.get(sku.productId) ?? line.title ?? sku.code,
          quantity: line.quantity,
          unitPriceCents: line.unitPriceCents,
          oversoldQty: oversold,
        },
      });
      if (!countsAgainstStock) continue;

      await setQuantity(tx, sku.id, sku.quantity);
      productIds.add(sku.productId);
      const base = { organizationId: input.organizationId, channel: input.channel, skuCode: sku.code, productId: sku.productId, orderId: order.id };
      if (taken > 0) await tx.syncLog.create({ data: { ...base, type: "SALE", delta: -taken, quantityAfter: sku.quantity } });
      if (oversold > 0) await tx.syncLog.create({ data: { ...base, type: "OVERSOLD", delta: -oversold, quantityAfter: sku.quantity } });
    }

    return { orderId: order.id, created: true, productIds: [...productIds], oversoldQty: oversoldTotal };
  });
}

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

/**
 * Enregistre une commande et décompte le stock.
 * `strict` (ventes saisies dans OmniList) : refuse un SKU inconnu ou un stock insuffisant.
 * Sans `strict` (commandes des canaux) : la vente a déjà eu lieu, une double vente est tracée.
 */
export async function recordOrder(prisma: PrismaClient, input: OrderInput, opts: { strict?: boolean } = {}): Promise<StockChange> {
  try {
    return await recordOrderOnce(prisma, input, opts.strict ?? false);
  } catch (err) {
    // La même commande arrive au même instant (webhook + relevé) : l'autre a gagné, on relit.
    if (isUniqueViolation(err)) return recordOrderOnce(prisma, input, opts.strict ?? false);
    throw err;
  }
}

/** Annulation d'une vente saisie dans OmniList : le stock revient. */
export async function cancelOrder(prisma: PrismaClient, organizationId: string, orderId: string): Promise<StockChange | null> {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({ where: { id: orderId, organizationId } });
    if (!order) return null;
    if (CANCELLED.has(order.status)) return { orderId, created: false, productIds: [], oversoldQty: 0 };
    await tx.order.update({ where: { id: order.id }, data: { status: "CANCELLED" } });
    const productIds = order.restockedAt ? [] : await restockLines(tx, order);
    return { orderId, created: false, productIds, oversoldQty: 0 };
  });
}

/** Correction manuelle du stock d'un SKU (inventaire, retour, casse…). */
export async function adjustStock(
  prisma: PrismaClient,
  input: { organizationId: string; sku: string; delta?: number; set?: number; note?: string | null },
): Promise<{ quantity: number; productId: string; delta: number }> {
  return prisma.$transaction(async (tx) => {
    const locked = await lockSkus(tx, input.organizationId, [input.sku]);
    const sku = locked.get(input.sku);
    if (!sku) throw new UnknownSkuError(input.sku);
    const next = input.set ?? sku.quantity + (input.delta ?? 0);
    if (next < 0) throw new InsufficientStockError(sku.code, sku.quantity);
    const delta = next - sku.quantity;
    if (delta !== 0) {
      await setQuantity(tx, sku.id, next);
      await tx.syncLog.create({
        data: {
          organizationId: input.organizationId,
          type: "ADJUSTMENT",
          skuCode: sku.code,
          productId: sku.productId,
          delta,
          quantityAfter: next,
          message: input.note ?? null,
        },
      });
    }
    return { quantity: next, productId: sku.productId, delta };
  });
}
