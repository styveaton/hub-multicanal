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

  app.all("/api/v1/*", async (request, reply) => {
    const path = request.url.replace(/^.*?(\/api\/v1\/)/, "$1").split("?")[0]!;
    const body = typeof request.body === "string" ? request.body : request.body ? JSON.stringify(request.body) : undefined;
    const res = fake.handle({ method: request.method, path, headers: request.headers as Record<string, string>, body });
    return reply.code(res.status).send(res.body ?? "");
  });
};
