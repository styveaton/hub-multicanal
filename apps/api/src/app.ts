import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { ZodError } from "zod";
import { Prisma, type PrismaClient } from "@hub/db";
import type { Env } from "./env.js";
import type { Mailer } from "./lib/mailer.js";
import { registerSessionAuth } from "./plugins/auth.js";
import { authRoutes } from "./routes/auth.js";
import { healthRoutes } from "./routes/health.js";
import { invitationRoutes } from "./routes/invitations.js";

declare module "fastify" {
  interface FastifyInstance {
    env: Env;
    prisma: PrismaClient;
    mailer: Mailer;
  }
}

export interface AppDeps {
  prisma: PrismaClient;
  mailer: Mailer;
}

export function buildApp(env: Env, deps: AppDeps) {
  const app = Fastify({ logger: env.NODE_ENV !== "test" });
  app.decorate("env", env);
  app.decorate("prisma", deps.prisma);
  app.decorate("mailer", deps.mailer);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "validation_error", issues: error.issues });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return reply.code(409).send({ error: "conflict" });
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (error as Error).message });
    request.log.error(error);
    return reply.code(500).send({ error: "internal_error" });
  });

  app.register(cookie);
  app.register(healthRoutes);

  // Routes qui ont besoin de la session.
  app.register(async (scope) => {
    registerSessionAuth(scope);
    scope.register(authRoutes, { prefix: "/auth" });
    scope.register(invitationRoutes, { prefix: "/invitations" });
  });

  return app;
}
