import type { FastifyPluginAsync } from "fastify";

/**
 * Faux Shopify servi par l'API, seulement avec SHOPIFY_ENV=fake (local et tests) :
 * - GET /<boutique>/admin/oauth/authorize : installation acceptée d'office, retour signé vers OmniList ;
 * - POST /<boutique>/admin/… : jetons et Admin API GraphQL.
 */
export const fakeShopifyRoutes: FastifyPluginAsync = async (app) => {
  const fake = app.channels.fakeShopify;
  if (!fake) return;

  app.get<{ Params: { shop: string } }>("/:shop/admin/oauth/authorize", async (request, reply) => {
    return reply.redirect(fake.authorize(request.params.shop, new URLSearchParams(request.query as Record<string, string>)));
  });

  // Démonstration locale : un client achète dans la boutique. Le relevé de secours importe la vente.
  app.post<{ Body: { sku?: string; quantity?: number } }>("/simulate-sale", async (request, reply) => {
    const { sku, quantity } = (typeof request.body === "string" ? JSON.parse(request.body) : request.body) ?? {};
    if (!sku || !fake.variantBySku(sku)) return reply.code(404).send({ error: "unknown_listing" });
    return fake.simulateSale(sku, { quantity: quantity ?? 1 });
  });

  app.post<{ Params: { shop: string; "*": string } }>("/:shop/admin/*", async (request, reply) => {
    const body = typeof request.body === "string" ? request.body : JSON.stringify(request.body ?? {});
    const res = fake.handle(
      request.params.shop,
      "POST",
      `/admin/${request.params["*"]}`,
      (request.headers["x-shopify-access-token"] as string | undefined) ?? null,
      body,
    );
    return reply.code(res.status).header("content-type", "application/json").send(await res.text());
  });
};
