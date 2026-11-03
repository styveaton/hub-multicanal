import type { ChannelConnection, OrderStatus } from "@hub/db";
import { recordOrder, type OrderInput, type StockChange } from "../inventory.js";
import { NotConnectedError, type ChannelDeps } from "../listing.js";
import { depopAccessToken } from "../publish.js";
import type { DepopOrder, DepopOrderStatus } from "./client.js";

/** Statuts Depop → statuts OmniList. */
const STATUS: Record<DepopOrderStatus, OrderStatus> = {
  SHIPPING_PENDING: "PAID",
  SHIPPED: "SHIPPED",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
  REFUNDED: "REFUNDED",
};

const cents = (amount: string) => Math.round(Number(amount) * 100);

/** Commande Depop → commande OmniList (une ligne Depop = une unité). */
export function depopOrderToInput(organizationId: string, order: DepopOrder): OrderInput {
  return {
    organizationId,
    channel: "DEPOP",
    source: "CHANNEL",
    externalOrderId: order.purchase_id,
    status: STATUS[order.status] ?? "PAID",
    buyerName: order.buyer_address?.name ?? null,
    currency: order.currency,
    placedAt: new Date(order.created_at),
    lines: order.line_items.map((li) => ({
      // Annonce créée hors OmniList : pas de SKU, on garde l'identifiant Depop pour le journal.
      sku: li.sku || `depop-${li.product_id}`,
      quantity: 1,
      unitPriceCents: cents(li.sold_price),
      title: li.description.split("\n")[0]?.slice(0, 200),
    })),
  };
}

/** Commande reçue par webhook ou relevé : enregistrée une seule fois, stock décompté sous verrou. */
export function importDepopOrder(deps: ChannelDeps, organizationId: string, order: DepopOrder): Promise<StockChange> {
  return recordOrder(deps.prisma, depopOrderToInput(organizationId, order));
}

/** Recouvrement entre deux relevés : une commande en retard n'est pas perdue (l'import est idempotent). */
const OVERLAP_MS = 15 * 60 * 1000;
const MAX_PAGES = 10;

/**
 * Relevé de secours : les webhooks Depop sont « au mieux », on relit les commandes récentes.
 * Renvoie les fiches dont le stock a bougé.
 */
export async function pollDepopOrders(deps: ChannelDeps, connection: ChannelConnection): Promise<string[]> {
  const now = deps.now?.() ?? new Date();
  let token: string;
  try {
    token = await depopAccessToken(deps, connection);
  } catch (err) {
    if (err instanceof NotConnectedError) return [];
    throw err;
  }
  // Première fois : seulement les ventes faites depuis la connexion (le stock d'avant est déjà juste).
  const since = connection.ordersSyncedAt ? new Date(connection.ordersSyncedAt.getTime() - OVERLAP_MS) : connection.createdAt;

  const productIds = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await deps.depop.listOrders(token, { from: since, cursor });
    for (const order of res.data) {
      const change = await importDepopOrder(deps, connection.organizationId, order);
      change.productIds.forEach((id) => productIds.add(id));
    }
    if (!res.meta.has_more || !res.meta.cursor) break;
    cursor = res.meta.cursor;
  }
  await deps.prisma.channelConnection.update({ where: { id: connection.id }, data: { ordersSyncedAt: now } });
  return [...productIds];
}
