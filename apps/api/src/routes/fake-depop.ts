import type { FastifyPluginAsync } from "fastify";

/**
 * Faux Depop servi par l'API, seulement avec DEPOP_ENV=fake (local et tests) :
 * - GET /authorize : page d'accord, acceptée d'office, qui renvoie vers OmniList ;
 * - /api/v1/* : la Selling API, appelée par l'API (connexion) et par le worker (publication).
 */
export const fakeDepopRoutes: FastifyPluginAsync = async (app) => {
  const fake = app.channels.fakeDepop;
  if (!fake) return;

  // Le point d'accès des jetons reçoit un formulaire ; on garde le texte brut.
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => done(null, body));

  app.get("/authorize", async (request, reply) => {
    const query = new URLSearchParams(request.query as Record<string, string>);
    return reply.redirect(fake.authorize(query));
  });

  // Démonstration locale : un acheteur achète sur le faux Depop. Le relevé de secours importe la vente.
  app.post<{ Body: { sku?: string; quantity?: number } }>("/simulate-sale", async (request, reply) => {
    const { sku, quantity } = (typeof request.body === "string" ? JSON.parse(request.body) : request.body) ?? {};
    if (!sku || !fake.products.has(sku)) return reply.code(404).send({ error: "unknown_listing" });
    return fake.simulateSale(sku, { quantity: quantity ?? 1 });
  });

  app.all("/api/v1/*", async (request, reply) => {
    const [rawPath, search] = request.url.replace(/^.*?(\/api\/v1\/)/, "$1").split("?");
    const body = typeof request.body === "string" ? request.body : request.body ? JSON.stringify(request.body) : undefined;
    const res = fake.handle({
      method: request.method,
      path: rawPath!,
      headers: request.headers as Record<string, string>,
      body,
      query: new URLSearchParams(search ?? ""),
    });
    return reply.code(res.status).send(res.body ?? "");
  });
};
