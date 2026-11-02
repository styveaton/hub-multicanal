import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { requirePermission } from "./plugins/auth.js";
import { createTestApp } from "./test/helpers.js";

describe("API", () => {
  it("GET /health répond ok", async () => {
    const { app } = createTestApp();
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
    app.get("/channels", { preHandler: requirePermission("channels:manage") }, async () => ({ ok: true }));
    return app;
  };

  it("401 sans session", async () => {
    expect((await build().inject("/billing")).statusCode).toBe(401);
  });
  it("403 pour un employé sur l'abonnement et les canaux", async () => {
    expect((await build("EMPLOYEE").inject("/billing")).statusCode).toBe(403);
    expect((await build("EMPLOYEE").inject("/channels")).statusCode).toBe(403);
  });
  it("200 pour le propriétaire", async () => {
    expect((await build("OWNER").inject("/billing")).statusCode).toBe(200);
    expect((await build("OWNER").inject("/channels")).statusCode).toBe(200);
  });
});
