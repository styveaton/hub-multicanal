import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { CHANNELS, CHANNEL_INTEGRATION, CHANNEL_LABEL, can, isUsState, type Channel } from "@hub/shared";
import {
  ChannelApiError,
  DEPOP_SCOPES,
  EBAY_SCOPES,
  ETSY_SCOPES,
  PUBLISHABLE_CHANNELS,
  SHOPIFY_SCOPES,
  normalizeShopDomain,
  normalizeStoreUrl,
  pkceChallenge,
  randomToken,
  sha256Hex,
  wooStore,
} from "@hub/channels";
import { HttpError } from "../lib/errors.js";
import { requireAuth, requirePermission } from "../plugins/auth.js";

/** Canaux branchés de bout en bout : eBay, Etsy, Depop, Shopify, WooCommerce. */
export const SUPPORTED_CHANNELS: ReadonlySet<Channel> = new Set(PUBLISHABLE_CHANNELS);

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

const ChannelParam = z
  .string()
  .transform((s) => s.toUpperCase())
  .pipe(z.enum(CHANNELS));

const DepopSettingsInput = z.object({
  shipFromState: z.string().refine(isUsState, "us_state_invalid"),
});

// Code postal américain d'où partent les colis (emplacement de stock eBay).
const EbaySettingsInput = z.object({
  postalCode: z.string().trim().regex(/^\d{5}(-\d{4})?$/, "postal_code_invalid"),
});

const ShopifyConnectInput = z.object({ shop: z.string().min(1).max(255) });

const WooConnectInput = z.object({
  storeUrl: z.string().min(1).max(500),
  consumerKey: z.string().trim().regex(/^ck_[A-Za-z0-9_]+$/, "woo_key_invalid"),
  consumerSecret: z.string().trim().regex(/^cs_[A-Za-z0-9_]+$/, "woo_secret_invalid"),
});

/** Sujets Shopify suivis : commandes (US9) et désinstallation de l'application. */
const SHOPIFY_TOPICS = ["ORDERS_CREATE", "ORDERS_UPDATED", "ORDERS_CANCELLED", "APP_UNINSTALLED"] as const;
const WOO_TOPICS = ["order.created", "order.updated"] as const;

function supported(channel: Channel) {
  if (!SUPPORTED_CHANNELS.has(channel)) throw new HttpError(400, "channel_not_supported");
}

export const channelRoutes: FastifyPluginAsync = async (app) => {
  const canManage = { preHandler: requirePermission("channels:manage") };
  const { config } = app.channels;
  const web = config.env.WEB_URL.replace(/\/$/, "");
  const publicApi = config.publicApiUrl.replace(/\/$/, "");

  const availability = (channel: Channel) => {
    if (channel === "EBAY") return { available: config.ebay.available, testMode: config.ebay.mode !== "production" };
    if (channel === "ETSY") return { available: config.etsy.available, testMode: config.etsy.mode === "fake" };
    if (channel === "DEPOP") return { available: config.depop.available, testMode: config.depop.mode !== "production" };
    if (channel === "SHOPIFY") return { available: config.shopify.available, testMode: config.shopify.mode === "fake" };
    if (channel === "WOOCOMMERCE") return { available: config.woo.available, testMode: config.woo.mode === "fake" };
    return { available: false, testMode: false };
  };

  // Liste des canaux et état de leur connexion pour la boutique.
  app.get("/", { preHandler: requireAuth }, async (request) => {
    const { organizationId } = request.auth!;
    const [connections, listed] = await Promise.all([
      app.prisma.channelConnection.findMany({ where: { organizationId } }),
      app.prisma.channelListing.groupBy({ by: ["channel"], where: { organizationId, status: "LISTED" }, _count: true }),
    ]);
    return {
      canManage: can(request.auth!.role, "channels:manage"),
      items: CHANNELS.map((channel) => {
        const c = connections.find((x) => x.channel === channel);
        return {
          channel,
          label: CHANNEL_LABEL[channel],
          integration: CHANNEL_INTEGRATION[channel],
          supported: SUPPORTED_CHANNELS.has(channel),
          // Clés présentes (ou faux canal en local) : on peut proposer la connexion.
          ...availability(channel),
          listedCount: listed.find((l) => l.channel === channel)?._count ?? 0,
          connection: c
            ? {
                status: c.status,
                username: c.externalUsername,
                // Boutique reliée (Shopify : *.myshopify.com ; WooCommerce : adresse du site).
                account: channel === "SHOPIFY" || channel === "WOOCOMMERCE" ? c.externalAccountId : null,
                connectedAt: c.createdAt,
                settings: c.settings as { shipFromState?: string; postalCode?: string; policies?: { names?: string[] } },
              }
            : null,
        };
      }),
    };
  });

  /** Demande OAuth en cours (anti-CSRF), valable 10 minutes. */
  async function saveState(request: FastifyRequest, channel: Channel, extra: { verifier?: string; shop?: string }) {
    const { organizationId, userId } = request.auth!;
    const state = randomToken();
    await app.prisma.oAuthState.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    await app.prisma.oAuthState.create({
      data: {
        stateHash: sha256Hex(state),
        organizationId,
        userId,
        channel,
        codeVerifierEnc: config.cipher.encrypt(extra.verifier ?? "-"),
        extra: extra.shop ? { shop: extra.shop } : undefined,
        expiresAt: new Date(Date.now() + OAUTH_STATE_TTL_MS),
      },
    });
    return state;
  }

  // Connexion : adresse de la page d'accord du canal (Depop, Shopify), ou connexion directe par clés (WooCommerce).
  app.post<{ Params: { channel: string } }>("/:channel/connect", canManage, async (request) => {
    const channel = ChannelParam.parse(request.params.channel);
    supported(channel);
    if (!availability(channel).available) throw new HttpError(503, "channel_unavailable");

    if (channel === "SHOPIFY") {
      const shop = normalizeShopDomain(ShopifyConnectInput.parse(request.body ?? {}).shop);
      if (!shop) throw new HttpError(400, "shop_invalid");
      const state = await saveState(request, channel, { shop });
      return { url: app.channels.shopify.authorizeUrl(shop, { state, redirectUri: config.shopify.redirectUri, scopes: SHOPIFY_SCOPES }) };
    }

    if (channel === "WOOCOMMERCE") return connectWoo(request);

    if (channel === "EBAY") {
      const state = await saveState(request, channel, {});
      return { url: app.channels.ebay.authorizeUrl(state, EBAY_SCOPES) };
    }

    if (channel === "ETSY") {
      const verifier = randomToken(48);
      const state = await saveState(request, channel, { verifier });
      return {
        url: app.channels.etsy.authorizeUrl({ state, redirectUri: config.etsy.redirectUri, codeChallenge: pkceChallenge(verifier), scopes: ETSY_SCOPES }),
      };
    }

    const verifier = randomToken(48); // 64 caractères, dans les bornes PKCE (43 à 128)
    const state = await saveState(request, channel, { verifier });
    const url = new URL(config.depop.authorizeUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", config.depop.clientId);
    url.searchParams.set("redirect_uri", config.depop.redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", pkceChallenge(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    // Depop sépare les scopes par « + » (encodé %2B).
    return { url: `${url.toString()}&scope=${DEPOP_SCOPES.join("%2B")}` };
  });

  /** WooCommerce : clés REST créées par le marchand (WooCommerce › Réglages › Avancé › API REST). */
  async function connectWoo(request: FastifyRequest) {
    const input = WooConnectInput.parse(request.body ?? {});
    const storeUrl = normalizeStoreUrl(input.storeUrl, config.woo.mode === "fake");
    if (!storeUrl) throw new HttpError(400, "store_url_invalid");
    const store = { url: storeUrl, key: input.consumerKey, secret: input.consumerSecret };
    let currency: string;
    try {
      currency = await app.channels.woo.getCurrency(store);
    } catch (err) {
      request.log.warn(err, "connexion WooCommerce refusée");
      const status = err instanceof ChannelApiError ? err.status : 0;
      throw new HttpError(400, status === 401 || status === 403 ? "woo_keys_invalid" : "woo_unreachable");
    }

    const { organizationId, userId } = request.auth!;
    const where = { organizationId_channel: { organizationId, channel: "WOOCOMMERCE" as const } };
    const previous = await app.prisma.channelConnection.findUnique({ where });
    // Nouvelles clés : les anciens webhooks (autre site ou clés révoquées) ne servent plus.
    if (previous?.webhookId && previous.status === "CONNECTED") {
      const old = wooStore(channelDepsLite(), previous);
      for (const id of previous.webhookId.split(",")) await app.channels.woo.deleteWebhook(old, Number(id)).catch(() => undefined);
    }
    const data = {
      status: "CONNECTED" as const,
      externalAccountId: storeUrl,
      externalUsername: new URL(storeUrl).host,
      accessTokenEnc: config.cipher.encrypt(JSON.stringify({ key: store.key, secret: store.secret })),
      refreshTokenEnc: null,
      accessTokenExpiresAt: null,
      scopes: "read_write",
      settings: { currency },
      webhookId: null,
      webhookSecretEnc: null,
      connectedById: userId,
    };
    const connection = await app.prisma.channelConnection.upsert({ where, create: { organizationId, channel: "WOOCOMMERCE", ...data }, update: data });

    // Webhooks de commandes : ventes reçues en quelques secondes ; sinon le relevé de secours suffit.
    if (config.webhooksEnabled) {
      try {
        const secret = randomToken(24);
        const ids: number[] = [];
        for (const topic of WOO_TOPICS) {
          ids.push(
            await app.channels.woo.createWebhook(store, {
              name: `OmniList ${topic}`,
              topic,
              deliveryUrl: `${publicApi}/webhooks/woocommerce/${connection.id}`,
              secret,
            }),
          );
        }
        await app.prisma.channelConnection.update({
          where: { id: connection.id },
          data: { webhookId: ids.join(","), webhookSecretEnc: config.cipher.encrypt(secret) },
        });
      } catch (err) {
        request.log.warn(err, "webhooks WooCommerce non enregistrés : le relevé de secours prend le relais");
      }
    }
    return { connected: true };
  }

  /** Dépendances minimales pour lire des clés chiffrées. */
  const channelDepsLite = () => ({
    prisma: app.prisma,
    cipher: config.cipher,
    media: config.media,
    depop: app.channels.depop,
    shopify: app.channels.shopify,
    woo: app.channels.woo,
    ebay: app.channels.ebay,
    etsy: app.channels.etsy,
  });

  // Retour du canal après l'accord (ou le refus) du vendeur.
  app.get<{ Params: { channel: string }; Querystring: Record<string, string | undefined> }>("/:channel/callback", async (request, reply) => {
    const back = (params: Record<string, string>) => reply.redirect(`${web}/channels?${new URLSearchParams(params)}`);
    const channel = ChannelParam.safeParse(request.params.channel);
    if (!channel.success || !SUPPORTED_CHANNELS.has(channel.data) || channel.data === "WOOCOMMERCE") return back({ error: "channel_not_supported" });
    const key = channel.data.toLowerCase();
    if (!request.auth) return reply.redirect(`${web}/login`);
    if (!can(request.auth.role, "channels:manage")) return back({ error: "forbidden", channel: key });

    const { code, state, error } = request.query;
    // Refus sur la page eBay : l'adresse « refusée » déclarée chez eBay ne transmet pas toujours le state.
    if (channel.data === "EBAY" && error && !state) return back({ error: "access_denied", channel: key });
    const saved = state ? await app.prisma.oAuthState.findUnique({ where: { stateHash: sha256Hex(state) } }) : null;
    if (saved) await app.prisma.oAuthState.delete({ where: { id: saved.id } });
    const valid =
      saved &&
      saved.channel === channel.data &&
      saved.organizationId === request.auth.organizationId &&
      saved.userId === request.auth.userId &&
      saved.expiresAt > new Date();
    if (!valid) return back({ error: "invalid_state", channel: key });
    if (error || !code) return back({ error: error === "access_denied" ? "access_denied" : "connect_failed", channel: key });

    const { organizationId, userId } = request.auth;
    const where = { organizationId_channel: { organizationId, channel: channel.data } };
    try {
      if (channel.data === "SHOPIFY") {
        // Retour signé par Shopify, pour la boutique demandée au départ.
        const query = new URLSearchParams(request.query as Record<string, string>);
        const shop = request.query.shop;
        if (!app.channels.shopify.verifyCallback(query) || !shop || (saved.extra as { shop?: string } | null)?.shop !== shop) {
          return back({ error: "invalid_state", channel: key });
        }
        const { shopify } = app.channels;
        const tokens = await shopify.exchangeCode(shop, code);
        const info = await shopify.getShop(shop, tokens.access_token);
        const data = {
          status: "CONNECTED" as const,
          externalAccountId: shop,
          externalUsername: info.name,
          accessTokenEnc: config.cipher.encrypt(tokens.access_token),
          refreshTokenEnc: null,
          accessTokenExpiresAt: null,
          scopes: tokens.scope,
          settings: { shopName: info.name, locationId: info.locationId, currency: info.currency },
          webhookId: null,
          connectedById: userId,
        };
        const connection = await app.prisma.channelConnection.upsert({ where, create: { organizationId, channel: "SHOPIFY", ...data }, update: data });
        if (config.webhooksEnabled) {
          try {
            const ids: string[] = [];
            for (const topic of SHOPIFY_TOPICS) {
              ids.push(await shopify.createWebhook(shop, tokens.access_token, topic, `${publicApi}/webhooks/shopify/${connection.id}`));
            }
            await app.prisma.channelConnection.update({ where: { id: connection.id }, data: { webhookId: ids.join(",") } });
          } catch (err) {
            request.log.warn(err, "webhooks Shopify non enregistrés : le relevé de secours prend le relais");
          }
        }
        return back({ connected: key });
      }

      if (channel.data === "EBAY") {
        const { ebay } = app.channels;
        const tokens = await ebay.exchangeCode(code);
        const user = await ebay.getUser(tokens.access_token);
        const previous = await app.prisma.channelConnection.findUnique({ where });
        // Même compte eBay : on garde le code postal et les règles de vente déjà choisis.
        const kept = previous && previous.externalAccountId === user.userId ? (previous.settings as object) : {};
        const data = {
          status: "CONNECTED" as const,
          externalAccountId: user.userId,
          externalUsername: user.username,
          accessTokenEnc: config.cipher.encrypt(tokens.access_token),
          refreshTokenEnc: config.cipher.encrypt(tokens.refresh_token),
          accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
          scopes: EBAY_SCOPES.join(" "),
          settings: { ...kept, username: user.username },
          connectedById: userId,
        };
        await app.prisma.channelConnection.upsert({ where, create: { organizationId, channel: "EBAY", ...data }, update: data });
        return back({ connected: key });
      }

      if (channel.data === "ETSY") {
        const { etsy } = app.channels;
        const tokens = await etsy.exchangeCode(code, config.etsy.redirectUri, config.cipher.decrypt(saved.codeVerifierEnc));
        const me = await etsy.getMe(tokens.access_token);
        if (!me.shop_id) return back({ error: "etsy_no_shop", channel: key });
        const shop = await etsy.getShop(tokens.access_token, me.shop_id);
        const previous = await app.prisma.channelConnection.findUnique({ where });
        // Même boutique : on garde les profils d'expédition et de préparation déjà choisis.
        const kept = previous && previous.externalAccountId === String(shop.shop_id) ? (previous.settings as object) : {};
        const data = {
          status: "CONNECTED" as const,
          externalAccountId: String(shop.shop_id),
          externalUsername: shop.shop_name,
          accessTokenEnc: config.cipher.encrypt(tokens.access_token),
          refreshTokenEnc: config.cipher.encrypt(tokens.refresh_token),
          accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
          scopes: ETSY_SCOPES.join(" "),
          settings: { ...kept, shopId: shop.shop_id, shopName: shop.shop_name, currency: shop.currency_code },
          connectedById: userId,
        };
        await app.prisma.channelConnection.upsert({ where, create: { organizationId, channel: "ETSY", ...data }, update: data });
        return back({ connected: key });
      }

      const { depop } = app.channels;
      const tokens = await depop.exchangeCode(code, config.depop.redirectUri, config.cipher.decrypt(saved.codeVerifierEnc));
      const shop = await depop.getShop(tokens.access_token);
      const data = {
        status: "CONNECTED" as const,
        externalAccountId: String(shop.id),
        externalUsername: shop.username,
        accessTokenEnc: config.cipher.encrypt(tokens.access_token),
        refreshTokenEnc: config.cipher.encrypt(tokens.refresh_token),
        accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        scopes: DEPOP_SCOPES.join(" "),
        connectedById: userId,
      };
      const connection = await app.prisma.channelConnection.upsert({ where, create: { organizationId, channel: channel.data, ...data }, update: data });
      // Webhook des commandes (US9) : ventes reçues en quelques secondes. Sans lui, le relevé de
      // secours prend le relais, donc un échec ici ne bloque pas la connexion.
      if (config.webhooksEnabled && !connection.webhookId) {
        try {
          const hook = await depop.createWebhook(tokens.access_token, `${publicApi}/webhooks/depop/${connection.id}`, ["v1:order.*"]);
          await app.prisma.channelConnection.update({
            where: { id: connection.id },
            data: { webhookId: hook.id, webhookSecretEnc: hook.secret ? config.cipher.encrypt(hook.secret) : null },
          });
        } catch (err) {
          request.log.warn(err, "webhook Depop non enregistré : le relevé de secours prend le relais");
        }
      }
    } catch (err) {
      request.log.warn(err, `connexion ${channel.data} échouée`);
      return back({ error: "connect_failed", channel: key });
    }
    return back({ connected: key });
  });

  // Réglages du compte connecté (Depop : État d'où partent les colis ; eBay : code postal d'expédition).
  app.put<{ Params: { channel: string } }>("/:channel/settings", canManage, async (request) => {
    const channel = ChannelParam.parse(request.params.channel);
    if (channel !== "DEPOP" && channel !== "EBAY") throw new HttpError(400, "channel_not_supported");
    const input = channel === "DEPOP" ? DepopSettingsInput.parse(request.body) : EbaySettingsInput.parse(request.body);
    const where = { organizationId_channel: { organizationId: request.auth!.organizationId, channel } };
    const existing = await app.prisma.channelConnection.findUnique({ where });
    if (!existing) throw new HttpError(404, "not_connected");
    const settings = { ...(existing.settings as object), ...input };
    await app.prisma.channelConnection.update({ where, data: { settings } });
    return { settings };
  });

  // Déconnexion : les jetons sont effacés ; les annonces déjà en ligne restent sur le canal.
  app.delete<{ Params: { channel: string } }>("/:channel", canManage, async (request, reply) => {
    const channel = ChannelParam.parse(request.params.channel);
    const where = { organizationId_channel: { organizationId: request.auth!.organizationId, channel } };
    const existing = await app.prisma.channelConnection.findUnique({ where });
    // WooCommerce : on retire nos webhooks du site (au mieux).
    if (existing?.channel === "WOOCOMMERCE" && existing.webhookId && existing.status === "CONNECTED") {
      const store = wooStore(channelDepsLite(), existing);
      for (const id of existing.webhookId.split(",")) await app.channels.woo.deleteWebhook(store, Number(id)).catch(() => undefined);
    }
    await app.prisma.channelConnection.deleteMany({ where: { organizationId: request.auth!.organizationId, channel } });
    return reply.code(204).send();
  });
};
