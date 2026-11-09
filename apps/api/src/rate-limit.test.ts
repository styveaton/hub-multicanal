import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestApp, prisma, resetDatabase } from "./test/helpers.js";

/** Limite de requêtes : 10 essais de connexion par IP toutes les 15 minutes. */

const { app } = createTestApp({ RATE_LIMIT: "on", TRUST_PROXY_HOPS: "1" });

// Comme en production : nginx ajoute l'IP du visiteur à X-Forwarded-For, Next.js le transmet.
const login = (ip: string, forwarded = ip) =>
  app.inject({
    method: "POST",
    url: "/auth/login",
    remoteAddress: "10.0.0.2", // le conteneur Next.js
    headers: { "x-forwarded-for": forwarded },
    payload: { email: "personne@exemple.fr", password: "mauvais-motdepasse" },
  });

beforeEach(resetDatabase);

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

describe("limite de requêtes", () => {
  it("bloque la 11e connexion d'une même IP, sans gêner les autres", async () => {
    for (let i = 0; i < 10; i++) expect((await login("203.0.113.7")).statusCode).toBe(401);
    const blocked = await login("203.0.113.7");
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error).toBe("too_many_requests");
    expect((await login("198.51.100.9")).statusCode).toBe(401);
  });

  it("une fausse IP ajoutée en tête de X-Forwarded-For ne contourne pas la limite", async () => {
    for (let i = 0; i < 10; i++) await login("203.0.113.8", `1.2.3.${i}, 203.0.113.8`);
    expect((await login("203.0.113.8", "9.9.9.9, 203.0.113.8")).statusCode).toBe(429);
  });

  it("n'applique pas la limite stricte aux webhooks signés", async () => {
    for (let i = 0; i < 15; i++) {
      const res = await app.inject({ method: "POST", url: "/webhooks/shopify/compliance", remoteAddress: "10.0.0.2", payload: {} });
      expect(res.statusCode).toBe(401);
    }
  });
});
