import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { buildApp } from "./app.js";
import { loadEnv } from "./env.js";
import { requirePermission } from "./plugins/auth.js";

describe("API", () => {
  it("GET /health répond ok", async () => {
    const app = buildApp(loadEnv({ NODE_ENV: "test" }));
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});

describe("requirePermission", () => {
  const build = (role?: "OWNER" | "EMPLOYEE") => {
    const app = Fastify();
    app.addHook("onRequest", async (req) => {
      if (role) req.auth = { userId: "u1", organizationId: "o1", role };
    });
    app.get("/billing", { preHandler: requirePermission("billing:manage") }, async () => ({ ok: true }));
    return app;
  };

  it("401 sans session", async () => {
    expect((await build().inject("/billing")).statusCode).toBe(401);
  });
  it("403 pour un employé sur l'abonnement", async () => {
    expect((await build("EMPLOYEE").inject("/billing")).statusCode).toBe(403);
  });
  it("200 pour le propriétaire", async () => {
    expect((await build("OWNER").inject("/billing")).statusCode).toBe(200);
  });
});
