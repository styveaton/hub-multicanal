import Fastify from "fastify";
import type { Env } from "./env.js";
import { healthRoutes } from "./routes/health.js";

declare module "fastify" {
  interface FastifyInstance {
    env: Env;
  }
}

export function buildApp(env: Env) {
  const app = Fastify({ logger: env.NODE_ENV !== "test" });
  app.decorate("env", env);
  app.register(healthRoutes);
  return app;
}
