import type { FastifyPluginAsync } from "fastify";

/** Faux WooCommerce servi par l'API, seulement avec WOO_ENV=fake (local et tests). */
export const fakeWooRoutes: FastifyPluginAsync = async (app) => {
  const fake = app.channels.fakeWoo;
  if (!fake) return;

  // Démonstration locale : un client achète sur le site. Le relevé de secours importe la vente.
  app.post<{ Body: { sku?: string; quantity?: number } }>("/simulate-sale", async (request, reply) => {
    const { sku, quantity } = (typeof request.body === "string" ? JSON.parse(request.body) : request.body) ?? {};
    if (!sku || !fake.bySku(sku)) return reply.code(404).send({ error: "unknown_listing" });
    return fake.simulateSale(sku, { quantity: quantity ?? 1 });
  });

  app.all("/wp-json/wc/v3/*", async (request, reply) => {
    const [path, search] = request.url.replace(/^.*?\/wp-json\/wc\/v3/, "").split("?");
    const body = typeof request.body === "string" ? request.body : request.body ? JSON.stringify(request.body) : "";
    const res = fake.handle(request.method, path!, new URLSearchParams(search ?? ""), (request.headers.authorization as string | undefined) ?? null, body);
    const pages = res.headers.get("x-wp-totalpages");
    if (pages) reply.header("x-wp-totalpages", pages);
    return reply.code(res.status).header("content-type", "application/json").send(await res.text());
  });
};
