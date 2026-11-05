import type { BrowserTask, BrowserTaskType, Channel } from "@hub/db";
import {
  ASSISTED_CLAIM_TIMEOUT_MS,
  ASSISTED_FAILURE_STREAK,
  ASSISTED_SITES,
  CHANNEL_TITLE_MAX,
  isAssistedAlert,
  isAssistedChannel,
  type AssistedChannel,
} from "@hub/shared";
import { isOnChannel, loadProduct, logChannel, markAll, priceRule, saveListing, sellableItems, type ChannelDeps } from "./listing.js";

/**
 * Sites assistés (Poshmark, Mercari, Facebook Marketplace, Grailed) : pas d'API.
 * Le worker ne parle pas au site : il crée des tâches que le vendeur traite dans son navigateur,
 * avec l'extension « OmniList Assistant ». L'annonce reste « en attente » jusqu'à la fin de la tâche.
 */

/** Code d'attente posé sur l'annonce tant que le vendeur n'a pas traité la tâche. */
export const AWAITING_SELLER = "awaiting_seller";

const OPEN = ["QUEUED", "CLAIMED"] as const;

/**
 * Une seule tâche en attente par SKU et par site : la nouvelle remplace l'ancienne.
 * Une tâche déjà ouverte dans le navigateur (CLAIMED) n'est pas touchée.
 */
async function queueTask(
  deps: ChannelDeps,
  data: { organizationId: string; channel: Channel; productId: string | null; skuCode: string; type: BrowserTaskType; title: string },
) {
  const { organizationId, channel, skuCode } = data;
  const queued = await deps.prisma.browserTask.findFirst({ where: { organizationId, channel, skuCode, status: "QUEUED" } });
  if (queued?.type === data.type) {
    await deps.prisma.browserTask.update({ where: { id: queued.id }, data: { title: data.title, productId: data.productId } });
    return;
  }
  if (queued) await deps.prisma.browserTask.update({ where: { id: queued.id }, data: { status: "CANCELLED", errorCode: "replaced" } });
  await deps.prisma.browserTask.create({ data });
}

/** Annule la tâche en attente d'un SKU (l'article n'est plus à publier). */
async function cancelQueued(deps: ChannelDeps, organizationId: string, channel: Channel, skuCode: string, reason: string) {
  await deps.prisma.browserTask.updateMany({
    where: { organizationId, channel, skuCode, status: "QUEUED" },
    data: { status: "CANCELLED", errorCode: reason },
  });
}

export async function publishAssisted(deps: ChannelDeps, productId: string, channel: Channel) {
  const p = await loadProduct(deps, productId, channel);
  if (!p) return;
  const settings = p.channels[0];
  const items = sellableItems(p, priceRule(settings));
  const currentSkus = new Set(items.map((i) => i.sku));
  const stale = p.listings.filter((l) => !currentSkus.has(l.skuCode) && isOnChannel(l));

  const consent = await deps.prisma.channelConsent.findUnique({ where: { organizationId_channel: { organizationId: p.organizationId, channel } } });
  if (!consent) return markAll(deps, channel, p, [...currentSkus], "consent_missing", null);

  const title = (settings?.title || p.title).slice(0, CHANNEL_TITLE_MAX[channel]);
  const base = { organizationId: p.organizationId, channel, productId: p.id, title };

  const delist = async (skuCode: string, onChannel: boolean, removedCode: string | null) => {
    if (onChannel) {
      await queueTask(deps, { ...base, skuCode, type: "DELIST" });
      await saveListing(deps, channel, p.organizationId, skuCode, { productId: p.id, status: "PENDING", errorCode: AWAITING_SELLER, errorMessage: null });
    } else {
      // Jamais publiée sur le site : rien à retirer là-bas.
      await cancelQueued(deps, p.organizationId, channel, skuCode, "not_needed");
      if (p.listings.some((l) => l.skuCode === skuCode)) {
        await saveListing(deps, channel, p.organizationId, skuCode, { productId: p.id, status: "REMOVED", errorCode: removedCode, errorMessage: null });
      }
    }
  };

  // Canal désactivé sur la fiche : on retire ce qui est en ligne.
  if (!settings?.enabled) {
    for (const l of p.listings.filter((x) => x.status !== "REMOVED")) await delist(l.skuCode, isOnChannel(l), null);
    return;
  }

  for (const item of items) {
    const existing = p.listings.find((l) => l.skuCode === item.sku);
    const onChannel = existing != null && isOnChannel(existing);
    if (item.quantity <= 0) {
      // Vendu ailleurs ou rupture : à retirer (un réassort la remet en vente).
      await delist(item.sku, onChannel, "out_of_stock");
      continue;
    }
    await queueTask(deps, { ...base, skuCode: item.sku, type: onChannel ? "UPDATE" : "LIST" });
    await saveListing(deps, channel, p.organizationId, item.sku, { productId: p.id, status: "PENDING", errorCode: AWAITING_SELLER, errorMessage: null });
  }
  for (const l of stale) await delist(l.skuCode, true, null);
}

/** Fiche supprimée dans OmniList : les annonces en ligne deviennent des tâches « à retirer ». */
export async function removeAssisted(deps: ChannelDeps, organizationId: string, channel: Channel, skus: string[]) {
  const listings = await deps.prisma.channelListing.findMany({ where: { organizationId, channel, skuCode: { in: skus } } });
  for (const l of listings) {
    if (isOnChannel(l)) {
      await queueTask(deps, { organizationId, channel, productId: null, skuCode: l.skuCode, type: "DELIST", title: l.skuCode });
      await saveListing(deps, channel, organizationId, l.skuCode, { productId: null, status: "PENDING", errorCode: AWAITING_SELLER, errorMessage: null });
    } else {
      await cancelQueued(deps, organizationId, channel, l.skuCode, "not_needed");
      await saveListing(deps, channel, organizationId, l.skuCode, { productId: null, status: "REMOVED", errorCode: null, errorMessage: null });
    }
  }
}

/** Ce que l'extension reçoit pour une tâche : de quoi remplir le formulaire du site. */
export interface BrowserTaskPayload {
  id: string;
  type: BrowserTaskType;
  channel: AssistedChannel;
  sku: string;
  /** Page à ouvrir : création d'annonce, ou annonce existante (modifier, retirer). */
  openUrl: string | null;
  listingUrl: string | null;
  externalId: string | null;
  product: {
    title: string;
    description: string;
    brand: string | null;
    condition: string;
    priceCents: number;
    currency: string;
    quantity: number;
    attributes: Record<string, string>;
    photos: string[];
  } | null;
}

/** Contenu d'une tâche, calculé au moment où le vendeur l'ouvre (fiche à jour, liens de photos frais). */
export async function buildTaskPayload(deps: ChannelDeps, task: BrowserTask): Promise<BrowserTaskPayload> {
  if (!isAssistedChannel(task.channel)) throw new Error(`canal non assisté : ${task.channel}`);
  const listing = await deps.prisma.channelListing.findUnique({
    where: { organizationId_channel_skuCode: { organizationId: task.organizationId, channel: task.channel, skuCode: task.skuCode } },
  });
  const site = ASSISTED_SITES[task.channel];
  const listingUrl = listing?.externalUrl ?? null;
  const openUrl = task.type === "LIST" ? site.newListingUrl : listingUrl;

  let product: BrowserTaskPayload["product"] = null;
  const p = task.productId ? await loadProduct(deps, task.productId, task.channel) : null;
  if (p && task.type !== "DELIST") {
    const settings = p.channels[0];
    const item = sellableItems(p, priceRule(settings)).find((i) => i.sku === task.skuCode);
    if (item) {
      product = {
        title: (settings?.title || p.title).slice(0, CHANNEL_TITLE_MAX[task.channel]),
        description: p.description,
        brand: p.brand,
        condition: p.condition,
        priceCents: item.priceCents,
        currency: p.currency,
        quantity: item.quantity,
        attributes: item.attributes ?? {},
        photos: p.photos.map((ph) => deps.media.url(ph.id)),
      };
    }
  }
  return { id: task.id, type: task.type, channel: task.channel, sku: task.skuCode, openUrl, listingUrl, externalId: listing?.externalId ?? null, product };
}

/** Tâche terminée par le vendeur : l'annonce prend son état réel. */
export async function completeTask(deps: ChannelDeps, task: BrowserTask, result: { listingUrl?: string | null; externalId?: string | null }) {
  const now = deps.now?.() ?? new Date();
  const key = { organizationId_channel_skuCode: { organizationId: task.organizationId, channel: task.channel, skuCode: task.skuCode } };
  const listing = await deps.prisma.channelListing.findUnique({ where: key });
  await deps.prisma.browserTask.update({ where: { id: task.id }, data: { status: "DONE", completedAt: now, errorCode: null, errorMessage: null } });
  if (task.type === "DELIST") {
    // Retirée faute de stock : un réassort la republiera.
    const outOfStock = task.productId ? await stockIsEmpty(deps, task.organizationId, task.skuCode) : false;
    await saveListing(deps, task.channel, task.organizationId, task.skuCode, {
      productId: task.productId,
      status: "REMOVED",
      errorCode: outOfStock ? "out_of_stock" : null,
      errorMessage: null,
    });
  } else {
    // Une modification plus récente attend encore le vendeur : l'annonce reste « en attente ».
    const pending = await deps.prisma.browserTask.count({
      where: { organizationId: task.organizationId, channel: task.channel, skuCode: task.skuCode, status: "QUEUED" },
    });
    await saveListing(deps, task.channel, task.organizationId, task.skuCode, {
      productId: task.productId,
      status: pending > 0 ? "PENDING" : "LISTED",
      ...(pending > 0 ? { errorCode: AWAITING_SELLER } : {}),
      externalId: result.externalId ?? listing?.externalId ?? result.listingUrl ?? listing?.externalUrl ?? task.id,
      externalUrl: result.listingUrl ?? listing?.externalUrl ?? null,
      ...(pending > 0 ? {} : { errorCode: null }),
      errorMessage: null,
      publishedAt: listing?.publishedAt ?? now,
    });
  }
  await deps.prisma.syncLog.create({
    data: {
      organizationId: task.organizationId,
      type: "CHANNEL_UPDATE",
      channel: task.channel,
      skuCode: task.skuCode,
      productId: task.productId,
      message: task.type === "LIST" ? "listed:assisted" : task.type === "UPDATE" ? "updated:assisted" : "removed:assisted",
    },
  });
}

async function stockIsEmpty(deps: ChannelDeps, organizationId: string, code: string) {
  const sku = await deps.prisma.sku.findUnique({ where: { organizationId_code: { organizationId, code } } });
  return sku != null && sku.quantity <= 0;
}

export const OPEN_TASK_STATUSES = OPEN;

// ---------------------------------------------------------------------------
// Garde-fous : interrupteur du site, accord du vendeur, plafond du jour, arrêt sur alerte.
// ---------------------------------------------------------------------------

/** Essais d'une même tâche avant de la passer en échec (l'annonce passe alors en erreur). */
export const ASSISTED_MAX_ATTEMPTS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

const nowOf = (deps: ChannelDeps) => deps.now?.() ?? new Date();

/** Interrupteur du site pour tous les vendeurs. Pas de ligne : site actif, repères version 1. */
export async function siteSwitch(deps: Pick<ChannelDeps, "prisma">, channel: Channel) {
  const row = await deps.prisma.siteSwitch.findUnique({ where: { channel } });
  return { enabled: row?.enabled ?? true, selectorsVersion: row?.selectorsVersion ?? 1, reason: row?.reason ?? null };
}

/** Publications ouvertes ou faites sur les dernières 24 h : elles comptent dans le plafond du jour. */
export async function listingsLast24h(deps: ChannelDeps, organizationId: string, channel: Channel) {
  return deps.prisma.browserTask.count({
    where: { organizationId, channel, type: "LIST", status: { in: ["CLAIMED", "DONE"] }, claimedAt: { gte: new Date(nowOf(deps).getTime() - DAY_MS) } },
  });
}

/** Une tâche ouverte depuis trop longtemps sans résultat est de nouveau disponible. */
export const claimExpired = (task: Pick<BrowserTask, "status" | "claimedAt">, now: Date) =>
  task.status === "CLAIMED" && task.claimedAt != null && now.getTime() - task.claimedAt.getTime() > ASSISTED_CLAIM_TIMEOUT_MS;

export type ClaimRefusal = "site_disabled" | "consent_missing" | "channel_paused" | "daily_cap_reached" | "task_not_open";

/**
 * Le vendeur ouvre une tâche dans son navigateur. Refusée si le site est coupé, si l'accord
 * manque ou est en pause, ou si le plafond du jour est atteint (publications seulement).
 */
export async function claimTask(
  deps: ChannelDeps,
  task: BrowserTask,
  deviceId: string,
): Promise<{ ok: true; payload: BrowserTaskPayload } | { ok: false; reason: ClaimRefusal }> {
  const now = nowOf(deps);
  const open = task.status === "QUEUED" || (task.status === "CLAIMED" && (task.deviceId === deviceId || claimExpired(task, now)));
  if (!open) return { ok: false, reason: "task_not_open" };
  if (!(await siteSwitch(deps, task.channel)).enabled) return { ok: false, reason: "site_disabled" };
  const consent = await deps.prisma.channelConsent.findUnique({
    where: { organizationId_channel: { organizationId: task.organizationId, channel: task.channel } },
  });
  if (!consent) return { ok: false, reason: "consent_missing" };
  if (consent.pausedAt) return { ok: false, reason: "channel_paused" };
  // Réouverture par le même navigateur : déjà comptée.
  const alreadyMine = task.status === "CLAIMED" && task.deviceId === deviceId;
  if (task.type === "LIST" && !alreadyMine && (await listingsLast24h(deps, task.organizationId, task.channel)) >= consent.dailyCap) {
    return { ok: false, reason: "daily_cap_reached" };
  }
  // Prise atomique : deux navigateurs ne peuvent pas ouvrir la même tâche.
  const taken = await deps.prisma.browserTask.updateMany({
    where: { id: task.id, status: task.status, updatedAt: task.updatedAt },
    data: { status: "CLAIMED", deviceId, claimedAt: now, ...(alreadyMine ? {} : { attempts: { increment: 1 } }) },
  });
  if (taken.count === 0) return { ok: false, reason: "task_not_open" };
  const claimed = await deps.prisma.browserTask.findUniqueOrThrow({ where: { id: task.id } });
  return { ok: true, payload: await buildTaskPayload(deps, claimed) };
}

/** Le vendeur a fermé la tâche sans la finir : elle revient dans la file, sans compter comme un échec. */
export async function releaseTask(deps: ChannelDeps, task: BrowserTask) {
  await deps.prisma.browserTask.update({ where: { id: task.id }, data: { status: "QUEUED", deviceId: null, claimedAt: null } });
}

/** Met le site en pause pour le vendeur : plus aucune tâche ne s'ouvre jusqu'à sa reprise. */
export async function pauseConsent(deps: ChannelDeps, organizationId: string, channel: Channel, reason: string) {
  await deps.prisma.channelConsent.updateMany({
    where: { organizationId, channel, pausedAt: null },
    data: { pausedAt: nowOf(deps), pauseReason: reason },
  });
}

/**
 * Échec d'une tâche dans le navigateur.
 * - Alerte du site (CAPTCHA, vérification, avertissement, restriction) : arrêt immédiat, site en pause
 *   pour le vendeur, la tâche attend la reprise.
 * - Autre échec : la tâche revient dans la file ; au bout de 3 essais, l'annonce passe en erreur.
 * - Plusieurs échecs de suite sur le site : pause automatique.
 */
export async function failTask(deps: ChannelDeps, task: BrowserTask, error: { code: string; message?: string | null }) {
  const { organizationId, channel, skuCode } = task;
  const message = error.message?.slice(0, 500) ?? null;
  const alert = isAssistedAlert(error.code);
  const final = !alert && task.attempts >= ASSISTED_MAX_ATTEMPTS;

  await deps.prisma.browserTask.update({
    where: { id: task.id },
    data: final
      ? { status: "FAILED", completedAt: nowOf(deps), errorCode: error.code, errorMessage: message }
      : { status: "QUEUED", deviceId: null, claimedAt: null, errorCode: error.code, errorMessage: message },
  });
  if (final) {
    await saveListing(deps, channel, organizationId, skuCode, { productId: task.productId, status: "ERROR", errorCode: error.code, errorMessage: message });
  }
  await logChannel(deps, channel, { organizationId, productId: task.productId, skuCode, ok: false, message: `failed:assisted:${error.code}` });

  if (alert) {
    await pauseConsent(deps, organizationId, channel, error.code);
    return { paused: true, final };
  }
  // Les derniers résultats du site pour ce vendeur sont tous des échecs : pause.
  const recent = await deps.prisma.syncLog.findMany({
    where: { organizationId, channel, message: { contains: ":assisted" } },
    orderBy: { createdAt: "desc" },
    take: ASSISTED_FAILURE_STREAK,
    select: { type: true },
  });
  if (recent.length >= ASSISTED_FAILURE_STREAK && recent.every((r) => r.type === "CHANNEL_ERROR")) {
    await pauseConsent(deps, organizationId, channel, "too_many_failures");
    return { paused: true, final };
  }
  return { paused: false, final };
}

/** Accord retiré : les tâches en attente sont annulées, les annonces restent telles quelles sur le site. */
export async function cancelOpenTasks(deps: ChannelDeps, organizationId: string, channel: Channel, reason: string) {
  await deps.prisma.browserTask.updateMany({
    where: { organizationId, channel, status: { in: [...OPEN] } },
    data: { status: "CANCELLED", errorCode: reason, deviceId: null },
  });
}
