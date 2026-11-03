import type { FastifyPluginAsync } from "fastify";
import { importDepopOrder, propagateStock, verifyDepopWebhook, type DepopOrder } from "@hub/channels";

interface DepopEvent {
  id: string;
  event_type: string;
  created_at: string;
  data: unknown;
}

/**
 * Webhooks des canaux (sans session). Depop signe chaque envoi : HMAC-SHA256 de
 * « <X-Depop-Timestamp>.<corps brut> » avec le secret du webhook de la boutique.
 * On répond vite ; le relevé de secours rattrape tout envoi perdu.
 */
export const webhookRoutes: FastifyPluginAsync = async (app) => {
  // Corps brut indispensable pour vérifier la signature.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));

  app.post<{ Params: { connectionId: string } }>("/depop/:connectionId", async (request, reply) => {
    const connection = await app.prisma.channelConnection.findUnique({ where: { id: request.params.connectionId } });
    if (!connection || connection.channel !== "DEPOP" || !connection.webhookSecretEnc) return reply.code(404).send({ error: "not_found" });

    const raw = typeof request.body === "string" ? request.body : "";
    const secret = app.channels.config.cipher.decrypt(connection.webhookSecretEnc);
    const valid = verifyDepopWebhook(
      secret,
      raw,
      request.headers["x-depop-timestamp"] as string | undefined,
      request.headers["x-depop-signature"] as string | undefined,
    );
    if (!valid) return reply.code(401).send({ error: "invalid_signature" });

    let event: DepopEvent;
    try {
      event = JSON.parse(raw) as DepopEvent;
    } catch {
      return reply.code(400).send({ error: "invalid_json" });
    }

    // Nouvelle commande, annulation, remboursement : même traitement, idempotent.
    if (event.event_type.startsWith("v1:order.")) {
      const change = await importDepopOrder(
        { prisma: app.prisma, cipher: app.channels.config.cipher, media: app.channels.config.media, depop: app.channels.depop },
        connection.organizationId,
        event.data as DepopOrder,
      );
      await propagateStock({ prisma: app.prisma, enqueue: app.channels.queue.add.bind(app.channels.queue) }, change.productIds);
    }
    return { received: true };
  });
};
