import type { FastifyPluginAsync } from "fastify";
import {
  ebayChallengeResponse,
  importDepopOrder,
  importShopifyOrder,
  importWooOrder,
  placedBeforeConnection,
  propagateStock,
  parseEbaySignature,
  shopifyOrderFromWebhook,
  verifyDepopWebhook,
  verifyEbayNotification,
  verifyShopifyWebhook,
  verifyWooWebhook,
  wooDate,
  type ChannelDeps,
  type DepopOrder,
  type StockChange,
  type WooOrder,
} from "@hub/channels";

interface DepopEvent {
  id: string;
  event_type: string;
  created_at: string;
  data: unknown;
}

/**
 * Webhooks des canaux (sans session), tous signés en HMAC-SHA256 sur le corps brut :
 * - Depop : hex de « <X-Depop-Timestamp>.<corps> », secret du webhook de la boutique ;
 * - Shopify : base64 du corps (X-Shopify-Hmac-Sha256), secret de l'application ;
 * - WooCommerce : base64 du corps (X-WC-Webhook-Signature), secret choisi à la création ;
 * - eBay : avis « suppression de compte », signés en ECDSA (X-EBAY-SIGNATURE, clé publique d'eBay).
 * On répond vite ; le relevé de secours rattrape tout envoi perdu.
 */
export const webhookRoutes: FastifyPluginAsync = async (app) => {
  // Corps brut indispensable pour vérifier les signatures.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
  // WooCommerce envoie un « ping » en formulaire à la création du webhook.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => done(null, body));

  const { config } = app.channels;
  const deps = (): ChannelDeps => ({
    prisma: app.prisma,
    cipher: config.cipher,
    media: config.media,
    depop: app.channels.depop,
    shopify: app.channels.shopify,
    woo: app.channels.woo,
    ebay: app.channels.ebay,
    etsy: app.channels.etsy,
  });
  const propagate = (change: StockChange) =>
    propagateStock({ prisma: app.prisma, enqueue: app.channels.queue.add.bind(app.channels.queue) }, change.productIds);
  const rawOf = (body: unknown) => (typeof body === "string" ? body : "");
  const header = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

  app.post<{ Params: { connectionId: string } }>("/depop/:connectionId", async (request, reply) => {
    const connection = await app.prisma.channelConnection.findUnique({ where: { id: request.params.connectionId } });
    if (!connection || connection.channel !== "DEPOP" || !connection.webhookSecretEnc) return reply.code(404).send({ error: "not_found" });

    const raw = rawOf(request.body);
    const secret = config.cipher.decrypt(connection.webhookSecretEnc);
    const valid = verifyDepopWebhook(secret, raw, header(request.headers["x-depop-timestamp"]), header(request.headers["x-depop-signature"]));
    if (!valid) return reply.code(401).send({ error: "invalid_signature" });

    let event: DepopEvent;
    try {
      event = JSON.parse(raw) as DepopEvent;
    } catch {
      return reply.code(400).send({ error: "invalid_json" });
    }
    // Nouvelle commande, annulation, remboursement : même traitement, idempotent.
    if (event.event_type.startsWith("v1:order.")) {
      await propagate(await importDepopOrder(deps(), connection.organizationId, event.data as DepopOrder));
    }
    return { received: true };
  });

  // Webhooks RGPD obligatoires des applications Shopify publiques (déclarés dans la configuration de l'app).
  app.post("/shopify/compliance", async (request, reply) => {
    const raw = rawOf(request.body);
    if (!verifyShopifyWebhook(config.shopify.clientSecret, raw, header(request.headers["x-shopify-hmac-sha256"]))) {
      return reply.code(401).send({ error: "invalid_signature" });
    }
    const topic = header(request.headers["x-shopify-topic"]);
    const body = JSON.parse(raw || "{}") as { shop_domain?: string; orders_to_redact?: number[] };
    const connections = body.shop_domain
      ? await app.prisma.channelConnection.findMany({ where: { channel: "SHOPIFY", externalAccountId: body.shop_domain } })
      : [];
    if (topic === "customers/redact" && body.orders_to_redact?.length) {
      // Seule donnée client gardée : le nom de l'acheteur sur la commande.
      await app.prisma.order.updateMany({
        where: {
          channel: "SHOPIFY",
          organizationId: { in: connections.map((c) => c.organizationId) },
          externalOrderId: { in: body.orders_to_redact.map(String) },
        },
        data: { buyerName: null },
      });
    }
    if (topic === "shop/redact") {
      await app.prisma.channelConnection.deleteMany({ where: { id: { in: connections.map((c) => c.id) } } });
    }
    // customers/data_request : rien à transmettre de plus que ce que Shopify détient déjà.
    return { received: true };
  });

  app.post<{ Params: { connectionId: string } }>("/shopify/:connectionId", async (request, reply) => {
    const connection = await app.prisma.channelConnection.findUnique({ where: { id: request.params.connectionId } });
    if (!connection || connection.channel !== "SHOPIFY") return reply.code(404).send({ error: "not_found" });
    const raw = rawOf(request.body);
    if (!verifyShopifyWebhook(config.shopify.clientSecret, raw, header(request.headers["x-shopify-hmac-sha256"]))) {
      return reply.code(401).send({ error: "invalid_signature" });
    }
    // Un webhook d'une autre boutique ne doit pas toucher cette connexion.
    const shop = header(request.headers["x-shopify-shop-domain"]);
    if (shop && shop !== connection.externalAccountId) return reply.code(404).send({ error: "not_found" });

    const topic = header(request.headers["x-shopify-topic"]) ?? "";
    if (topic === "app/uninstalled") {
      await app.prisma.channelConnection.update({ where: { id: connection.id }, data: { status: "NEEDS_REAUTH", webhookId: null } });
      return { received: true };
    }
    if (topic.startsWith("orders/")) {
      let order;
      try {
        order = shopifyOrderFromWebhook(JSON.parse(raw));
      } catch {
        return reply.code(400).send({ error: "invalid_json" });
      }
      // Commande passée avant la connexion : le stock central en tenait déjà compte.
      if (!placedBeforeConnection(new Date(order.createdAt), connection.createdAt)) {
        await propagate(await importShopifyOrder(deps(), connection.organizationId, order));
      }
    }
    return { received: true };
  });

  app.post<{ Params: { connectionId: string } }>("/woocommerce/:connectionId", async (request, reply) => {
    const connection = await app.prisma.channelConnection.findUnique({ where: { id: request.params.connectionId } });
    if (!connection || connection.channel !== "WOOCOMMERCE") return reply.code(404).send({ error: "not_found" });
    const raw = rawOf(request.body);
    // Ping de création (formulaire « webhook_id=… », non signé) : il suffit de répondre 200.
    if (!header(request.headers["x-wc-webhook-signature"]) && /^webhook_id=\d+$/.test(raw.trim())) return { received: true };
    if (!connection.webhookSecretEnc) return reply.code(404).send({ error: "not_found" });
    const secret = config.cipher.decrypt(connection.webhookSecretEnc);
    if (!verifyWooWebhook(secret, raw, header(request.headers["x-wc-webhook-signature"]))) {
      return reply.code(401).send({ error: "invalid_signature" });
    }
    const topic = header(request.headers["x-wc-webhook-topic"]) ?? "";
    if (topic.startsWith("order.")) {
      let order: WooOrder;
      try {
        order = JSON.parse(raw) as WooOrder;
      } catch {
        return reply.code(400).send({ error: "invalid_json" });
      }
      if (!placedBeforeConnection(wooDate(order.date_created_gmt), connection.createdAt)) {
        await propagate(await importWooOrder(deps(), connection.organizationId, order));
      }
    }
    return { received: true };
  });

  // Avis « suppression / fermeture de compte » d'eBay, obligatoire pour garder les clés Production.
  // GET : défi de validation de l'adresse ; POST : un membre eBay (vendeur ou acheteur) a fermé son compte.
  app.get<{ Querystring: { challenge_code?: string } }>("/ebay/account-deletion", async (request, reply) => {
    const code = request.query.challenge_code;
    if (!code) return reply.code(400).send({ error: "challenge_code_missing" });
    const challengeResponse = ebayChallengeResponse(code, config.ebay.verificationToken, config.ebay.deletionEndpoint);
    return reply.header("content-type", "application/json").send({ challengeResponse });
  });

  app.post("/ebay/account-deletion", async (request, reply) => {
    const raw = rawOf(request.body);
    const sig = parseEbaySignature(header(request.headers["x-ebay-signature"]));
    // eBay attend 412 quand la signature ne correspond pas.
    if (!sig) return reply.code(412).send({ error: "invalid_signature" });
    let key;
    try {
      key = await app.channels.ebay.publicKey(sig.kid);
    } catch (err) {
      request.log.warn(err, "clé publique eBay introuvable : eBay renverra l'avis");
      return reply.code(500).send({ error: "key_unavailable" });
    }
    if (!verifyEbayNotification(raw, sig, key)) return reply.code(412).send({ error: "invalid_signature" });

    let body: { metadata?: { topic?: string }; notification?: { data?: { username?: string; userId?: string } } };
    try {
      body = JSON.parse(raw);
    } catch {
      return reply.code(400).send({ error: "invalid_json" });
    }
    const data = body.notification?.data;
    if (body.metadata?.topic === "MARKETPLACE_ACCOUNT_DELETION" && data) {
      // Vendeur : sa connexion (jetons compris) est effacée.
      if (data.userId) await app.prisma.channelConnection.deleteMany({ where: { channel: "EBAY", externalAccountId: data.userId } });
      // Acheteur : son nom et son pseudo disparaissent des commandes (le reste sert à la comptabilité).
      if (data.username) {
        await app.prisma.order.updateMany({ where: { channel: "EBAY", buyerRef: data.username }, data: { buyerName: null, buyerRef: null } });
      }
    }
    return reply.code(204).send();
  });
};
