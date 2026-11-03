import type { ChannelConnection } from "@hub/db";
import { depopIssues, isUsState, type DepopDetails, type ProductConditionCode } from "@hub/shared";
import { DepopApiError, depopProductUrl } from "./depop/client.js";
import { buildDepopBody } from "./depop/mapping.js";
import {
  NotConnectedError,
  RetryableChannelError,
  findConnection,
  isOnChannel,
  loadProduct,
  logChannel as logAny,
  markAll as markAny,
  priceRule,
  saveListing as saveAny,
  sellableItems,
  type ChannelDeps,
  type LoadedProduct,
} from "./listing.js";

/**
 * Publication sur Depop, exécutée par le worker (file BullMQ « channel-sync »).
 * Depop : une annonce par SKU, mise à jour par SKU.
 */

const logChannel = (deps: ChannelDeps, data: Parameters<typeof logAny>[2]) => logAny(deps, "DEPOP", data);
const saveListing = (deps: ChannelDeps, organizationId: string, skuCode: string, data: Parameters<typeof saveAny>[4]) =>
  saveAny(deps, "DEPOP", organizationId, skuCode, data);
const markAll = (deps: ChannelDeps, p: LoadedProduct, skus: string[], code: string, message: string | null) =>
  markAny(deps, "DEPOP", p, skus, code, message);
const isOnDepop = isOnChannel;

// ---------------------------------------------------------------------------
// Jetons
// ---------------------------------------------------------------------------

/** Jeton d'accès valide, rafraîchi s'il expire dans moins d'une minute. */
export async function depopAccessToken(deps: ChannelDeps, connection: ChannelConnection): Promise<string> {
  const now = deps.now?.() ?? new Date();
  if (connection.status !== "CONNECTED") throw new NotConnectedError();
  if (connection.accessTokenExpiresAt && connection.accessTokenExpiresAt.getTime() - now.getTime() > 60_000) {
    return deps.cipher.decrypt(connection.accessTokenEnc);
  }
  if (!connection.refreshTokenEnc) throw new NotConnectedError();
  try {
    const tokens = await deps.depop.refresh(deps.cipher.decrypt(connection.refreshTokenEnc));
    await deps.prisma.channelConnection.update({
      where: { id: connection.id },
      data: {
        accessTokenEnc: deps.cipher.encrypt(tokens.access_token),
        refreshTokenEnc: deps.cipher.encrypt(tokens.refresh_token),
        accessTokenExpiresAt: new Date(now.getTime() + tokens.expires_in * 1000),
      },
    });
    return tokens.access_token;
  } catch (err) {
    if (err instanceof DepopApiError && !err.retryable) {
      // Accès retiré ou jeton expiré : le propriétaire doit reconnecter Depop.
      await deps.prisma.channelConnection.update({ where: { id: connection.id }, data: { status: "NEEDS_REAUTH" } });
      throw new NotConnectedError();
    }
    throw err;
  }
}

/** Sur un 401, la connexion est marquée à reconnecter. */
async function handleUnauthorized(deps: ChannelDeps, connection: ChannelConnection, err: unknown) {
  if (err instanceof DepopApiError && err.status === 401) {
    await deps.prisma.channelConnection.update({ where: { id: connection.id }, data: { status: "NEEDS_REAUTH" } });
  }
}

// ---------------------------------------------------------------------------
// Annonces
// ---------------------------------------------------------------------------

export async function publishToDepop(deps: ChannelDeps, productId: string) {
  const p = await loadProduct(deps, productId, "DEPOP");
  if (!p) return;
  const settings = p.channels[0];
  const rule = priceRule(settings);
  const items = sellableItems(p, rule);
  const currentSkus = new Set(items.map((i) => i.sku));
  // Annonces encore sur Depop pour des SKU qui n'existent plus (variante supprimée, SKU renommé).
  const stale = p.listings.filter((l) => !currentSkus.has(l.skuCode) && isOnDepop(l)).map((l) => l.skuCode);

  const connection = await findConnection(deps, p.organizationId, "DEPOP");
  if (!connection) return markAll(deps, p, [...currentSkus], "not_connected", null);

  let token: string;
  try {
    token = await depopAccessToken(deps, connection);
  } catch (err) {
    if (err instanceof NotConnectedError) return markAll(deps, p, [...currentSkus], "needs_reauth", null);
    throw new RetryableChannelError((err as Error).message);
  }

  // Canal désactivé : on retire ce qui est en ligne.
  if (!settings?.enabled) {
    // Jamais arrivées sur Depop : rien à supprimer là-bas, on les marque simplement retirées.
    for (const l of p.listings.filter((x) => !isOnDepop(x) && x.status !== "REMOVED")) {
      await saveListing(deps, p.organizationId, l.skuCode, { productId: p.id, status: "REMOVED", errorCode: null, errorMessage: null });
    }
    const listed = p.listings.filter(isOnDepop).map((l) => l.skuCode);
    return removeSkus(deps, connection, token, p.organizationId, listed, p.id);
  }

  const details = (settings.details ?? {}) as DepopDetails;
  const shipFromState = (connection.settings as { shipFromState?: string } | null)?.shipFromState ?? "";
  const issues = depopIssues({
    mode: p.mode,
    title: p.title,
    description: p.description,
    brand: p.brand,
    details,
    items,
  });
  if (!isUsState(shipFromState)) issues.push({ code: "ship_from_missing" });
  if (issues.length > 0) {
    // La fiche a changé depuis la demande : on signale sans appeler Depop.
    return markAll(deps, p, [...currentSkus], "listing_incomplete", issues.map((i) => i.code).join(","));
  }

  const pictureUrls = p.photos.map((ph) => deps.media.url(ph.id));
  let retry: Error | null = null;
  const now = deps.now?.() ?? new Date();

  for (const item of items) {
    const existing = p.listings.find((l) => l.skuCode === item.sku);
    try {
      if (item.quantity <= 0) {
        // Rupture de stock : l'annonce passe en « vendue » ; un nouvel envoi la remet en vente.
        const wasOnDepop = existing != null && isOnDepop(existing);
        if (wasOnDepop) await deps.depop.markSold(token, item.sku);
        await saveListing(deps, p.organizationId, item.sku, { productId: p.id, status: "REMOVED", errorCode: "out_of_stock", errorMessage: null });
        if (wasOnDepop) await logChannel(deps, { organizationId: p.organizationId, productId: p.id, skuCode: item.sku, ok: true, message: "marked_sold" });
        continue;
      }
      const body = buildDepopBody({
        product: { title: p.title, description: p.description, brand: p.brand, condition: p.condition as ProductConditionCode, currency: p.currency },
        details,
        item,
        pictureUrls,
        shipFromState,
      });
      const res = await deps.depop.putProduct(token, item.sku, body);
      await saveListing(deps, p.organizationId, item.sku, {
        productId: p.id,
        status: "LISTED",
        externalId: String(res.product_id),
        externalUrl: depopProductUrl(res.slug),
        errorCode: null,
        errorMessage: null,
        publishedAt: existing?.publishedAt ?? now,
      });
      await logChannel(deps, {
        organizationId: p.organizationId,
        productId: p.id,
        skuCode: item.sku,
        ok: true,
        message: existing?.externalId ? `updated:${item.quantity}` : `listed:${item.quantity}`,
      });
    } catch (err) {
      await handleUnauthorized(deps, connection, err);
      const e = err instanceof DepopApiError ? err : new DepopApiError(0, "internal_error", (err as Error).message, true);
      await saveListing(deps, p.organizationId, item.sku, { productId: p.id, status: "ERROR", errorCode: e.code, errorMessage: e.message });
      await logChannel(deps, { organizationId: p.organizationId, productId: p.id, skuCode: item.sku, ok: false, message: `${e.code}: ${e.message}` });
      if (e.retryable) retry = e;
    }
  }

  if (stale.length > 0) await removeSkus(deps, connection, token, p.organizationId, stale, p.id);
  if (retry) throw new RetryableChannelError(retry.message);
}

async function removeSkus(
  deps: ChannelDeps,
  connection: ChannelConnection,
  token: string,
  organizationId: string,
  skus: string[],
  productId: string | null,
) {
  let retry: Error | null = null;
  for (const sku of skus) {
    try {
      await deps.depop.deleteProduct(token, sku);
      await saveListing(deps, organizationId, sku, { productId, status: "REMOVED", errorCode: null, errorMessage: null });
      await logChannel(deps, { organizationId, productId, skuCode: sku, ok: true, message: "removed" });
    } catch (err) {
      await handleUnauthorized(deps, connection, err);
      const e = err instanceof DepopApiError ? err : new DepopApiError(0, "internal_error", (err as Error).message, true);
      await saveListing(deps, organizationId, sku, { productId, status: "ERROR", errorCode: e.code, errorMessage: e.message });
      await logChannel(deps, { organizationId, productId, skuCode: sku, ok: false, message: `${e.code}: ${e.message}` });
      if (e.retryable) retry = e;
    }
  }
  if (retry) throw new RetryableChannelError(retry.message);
}

/** Fiche supprimée dans OmniList : on retire ses annonces Depop. */
export async function removeFromDepop(deps: ChannelDeps, organizationId: string, skus: string[]) {
  if (skus.length === 0) return;
  const connection = await findConnection(deps, organizationId, "DEPOP");
  if (!connection) return;
  let token: string;
  try {
    token = await depopAccessToken(deps, connection);
  } catch (err) {
    if (err instanceof NotConnectedError) return;
    throw new RetryableChannelError((err as Error).message);
  }
  await removeSkus(deps, connection, token, organizationId, skus, null);
}
