import type { Channel, PrismaClient } from "@hub/db";
import { pollDepopOrders } from "./depop/orders.js";
import { publishToDepop, removeFromDepop, type ChannelDeps } from "./publish.js";

/** File BullMQ des synchronisations de canaux. */
export const CHANNEL_QUEUE = "channel-sync";

/** Canaux branchés de bout en bout (publication, stock, commandes). */
export const PUBLISHABLE_CHANNELS: readonly Channel[] = ["DEPOP"];

export type ChannelJob =
  | { name: "publish"; data: { productId: string; channel: Channel } }
  | { name: "remove"; data: { organizationId: string; channel: Channel; skus: string[] } }
  // Relevé de secours des commandes, planifié toutes les 2 minutes.
  | { name: "orders:poll"; data: Record<string, never> };

/** Options d'envoi : priorité haute pour les mises à jour de stock (anti double vente). */
export interface EnqueueOptions {
  priority?: "stock";
}

export type Enqueue = (job: ChannelJob, opts?: EnqueueOptions) => Promise<void>;

/**
 * Annonce à renvoyer quand la fiche ou son stock change : en ligne, en cours d'envoi,
 * ou retirée faute de stock (un réassort la remet en vente).
 */
export const listingNeedsSync = (l: { status: string; errorCode: string | null }) =>
  l.status === "LISTED" || l.status === "PENDING" || (l.status === "REMOVED" && l.errorCode === "out_of_stock");

/** Jobs de mise à jour des canaux pour des fiches dont le stock a bougé. */
export async function syncJobsFor(prisma: PrismaClient, productIds: string[]): Promise<ChannelJob[]> {
  if (productIds.length === 0) return [];
  const listings = await prisma.channelListing.findMany({
    where: { productId: { in: productIds }, channel: { in: [...PUBLISHABLE_CHANNELS] } },
    select: { productId: true, channel: true, status: true, errorCode: true },
  });
  const keys = new Set(listings.filter(listingNeedsSync).map((l) => `${l.channel}:${l.productId}`));
  return [...keys].map((key) => {
    const [channel, productId] = key.split(":") as [Channel, string];
    return { name: "publish", data: { productId, channel } };
  });
}

/** Met à jour les canaux après une variation de stock, en priorité. */
export async function propagateStock(deps: { prisma: PrismaClient; enqueue: Enqueue }, productIds: string[]) {
  for (const job of await syncJobsFor(deps.prisma, productIds)) await deps.enqueue(job, { priority: "stock" });
}

export async function processChannelJob(deps: ChannelDeps & { enqueue: Enqueue }, job: ChannelJob): Promise<void> {
  if (job.name === "orders:poll") {
    const connections = await deps.prisma.channelConnection.findMany({ where: { channel: "DEPOP", status: "CONNECTED" } });
    for (const connection of connections) {
      // Une boutique en erreur ne bloque pas les autres.
      try {
        await propagateStock(deps, await pollDepopOrders(deps, connection));
      } catch (err) {
        console.error(`[orders:poll] boutique ${connection.organizationId} : ${(err as Error).message}`);
      }
    }
    return;
  }
  if (job.data.channel !== "DEPOP") return; // autres canaux : pas encore branchés
  if (job.name === "publish") return publishToDepop(deps, job.data.productId);
  return removeFromDepop(deps, job.data.organizationId, job.data.skus);
}
