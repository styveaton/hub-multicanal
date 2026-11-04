import type { FastifyPluginAsync } from "fastify";

/**
 * Faux eBay servi par l'API, seulement avec EBAY_ENV=fake (local et tests) :
 * - GET /oauth2/authorize : page d'accord, acceptée d'office, qui renvoie vers OmniList ;
 * - /identity, /commerce, /sell : les API REST appelées par l'API (connexion) et le worker ;
 * - GET /itm/:listingId : « page » de l'annonce (son contenu en JSON) ;
 * - POST /simulate-sale : un acheteur achète (démonstration locale).
 */
export const fakeEbayRoutes: FastifyPluginAsync = async (app) => {
  const fake = app.channels.fakeEbay;
  if (!fake) return;

  // Le point d'accès des jetons reçoit un formulaire ; on garde le texte brut.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => done(null, body));

  app.get("/oauth2/authorize", async (request, reply) => {
    return reply.redirect(fake.authorize(new URLSearchParams(request.query as Record<string, string>)));
  });

  app.get<{ Params: { listingId: string } }>("/itm/:listingId", async (request, reply) => {
    const offers = [...fake.offers.values()].filter((o) => o.listingId === request.params.listingId);
    if (offers.length === 0) return reply.code(404).send({ error: "listing_not_found" });
    return { listingId: request.params.listingId, offers, items: offers.map((o) => fake.items.get(o.sku)) };
  });

  app.post<{ Body: { sku?: string; quantity?: number } }>("/simulate-sale", async (request, reply) => {
    const { sku, quantity } = (typeof request.body === "string" ? JSON.parse(request.body) : request.body) ?? {};
    if (!sku || fake.offerBySku(sku)?.status !== "PUBLISHED") return reply.code(404).send({ error: "unknown_listing" });
    return fake.simulateSale(sku, { quantity: quantity ?? 1 });
  });

  for (const prefix of ["/identity/*", "/commerce/*", "/sell/*"]) {
    app.all(prefix, async (request, reply) => {
      const [rawPath, search] = request.url.replace(/^.*?\/(identity|commerce|sell)\//, "/$1/").split("?");
      const body = typeof request.body === "string" ? request.body : request.body ? JSON.stringify(request.body) : "";
      const res = fake.handle(request.method, rawPath!, request.headers as Record<string, string>, body, new URLSearchParams(search ?? ""));
      const text = await res.text();
      return reply.code(res.status).header("content-type", "application/json").send(text || undefined);
    });
  }
};
