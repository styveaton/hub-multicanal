import type { FastifyPluginAsync } from "fastify";

/**
 * Faux Etsy servi par l'API, seulement avec ETSY_ENV=fake (local et tests) :
 * - GET /oauth/connect : page d'accord, acceptée d'office, qui renvoie vers OmniList ;
 * - /v3/* : l'Open API v3 appelée par l'API (connexion) et par le worker (annonces, photos, commandes) ;
 * - POST /simulate-sale : un acheteur achète (démonstration locale).
 */
export const fakeEtsyRoutes: FastifyPluginAsync = async (app) => {
  const fake = app.channels.fakeEtsy;
  if (!fake) return;

  // Corps bruts : formulaires (jetons, annonces) et envois de photos (multipart).
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => done(null, body));
  app.addContentTypeParser("multipart/form-data", { parseAs: "buffer", bodyLimit: 25 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.get("/oauth/connect", async (request, reply) => {
    return reply.redirect(fake.authorize(new URLSearchParams(request.query as Record<string, string>)));
  });

  app.post<{ Body: { sku?: string; quantity?: number } }>("/simulate-sale", async (request, reply) => {
    const { sku, quantity } = (typeof request.body === "string" ? JSON.parse(request.body) : request.body) ?? {};
    if (!sku || fake.bySku(sku)?.listing.state !== "active") return reply.code(404).send({ error: "unknown_listing" });
    return fake.simulateSale(sku, { quantity: quantity ?? 1 });
  });

  app.all("/v3/*", async (request, reply) => {
    const [rawPath, search] = request.url.replace(/^.*?\/v3\//, "/v3/").split("?");
    const type = request.headers["content-type"] ?? "";
    let body: BodyInit | null = null;
    if (Buffer.isBuffer(request.body) && type.startsWith("multipart/form-data")) {
      body = await new Response(new Uint8Array(request.body), { headers: { "content-type": type } }).formData();
    } else if (typeof request.body === "string") {
      body = request.body;
    } else if (request.body) {
      body = JSON.stringify(request.body);
    }
    const res = await fake.handle(request.method, rawPath!, request.headers as Record<string, string>, body, new URLSearchParams(search ?? ""));
    const text = await res.text();
    return reply.code(res.status).header("content-type", "application/json").send(text || undefined);
  });
};
