import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { ZodError } from "zod";
import { Prisma, type PrismaClient } from "@hub/db";
import type { ChannelConfig, DepopClient, FakeDepop, FakeShopify, FakeWoo, ShopifyClient, WooClient } from "@hub/channels";
import type { Env } from "./env.js";
import { HttpError } from "./lib/errors.js";
import type { Mailer } from "./lib/mailer.js";
import type { JobQueue } from "./lib/queue.js";
import type { Storage } from "./lib/storage.js";
import { registerSessionAuth } from "./plugins/auth.js";
import { authRoutes } from "./routes/auth.js";
import { channelRoutes } from "./routes/channels.js";
import { fakeDepopRoutes } from "./routes/fake-depop.js";
import { fakeShopifyRoutes } from "./routes/fake-shopify.js";
import { fakeWooRoutes } from "./routes/fake-woo.js";
import { healthRoutes } from "./routes/health.js";
import { invitationRoutes } from "./routes/invitations.js";
import { orderRoutes } from "./routes/orders.js";
import { photoRoutes, publicPhotoRoutes } from "./routes/photos.js";
import { productRoutes } from "./routes/products.js";
import { stockRoutes } from "./routes/stock.js";
import { webhookRoutes } from "./routes/webhooks.js";

declare module "fastify" {
  interface FastifyInstance {
    env: Env;
    prisma: PrismaClient;
    mailer: Mailer;
    storage: Storage;
    channels: ChannelRuntime;
  }
}

/** Ce dont les routes ont besoin pour parler aux canaux. */
export interface ChannelRuntime {
  config: ChannelConfig;
  depop: DepopClient;
  shopify: ShopifyClient;
  woo: WooClient;
  queue: JobQueue;
  /** Faux canaux servis par l'API (mode fake, en local et dans les tests). */
  fakeDepop?: FakeDepop;
  fakeShopify?: FakeShopify;
  fakeWoo?: FakeWoo;
}

export interface AppDeps {
  prisma: PrismaClient;
  mailer: Mailer;
  storage: Storage;
  channels: ChannelRuntime;
}

export function buildApp(env: Env, deps: AppDeps) {
  const app = Fastify({ logger: env.NODE_ENV !== "test" });
  app.decorate("env", env);
  app.decorate("prisma", deps.prisma);
  app.decorate("mailer", deps.mailer);
  app.decorate("storage", deps.storage);
  app.decorate("channels", deps.channels);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "validation_error", issues: error.issues });
    }
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ error: error.message, ...error.details });
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
  // Sans session : les canaux téléchargent les photos par lien signé.
  app.register(publicPhotoRoutes, { prefix: "/public/photos" });
  app.register(webhookRoutes, { prefix: "/webhooks" });
  if (deps.channels.fakeDepop) app.register(fakeDepopRoutes, { prefix: "/dev/fake-depop" });
  if (deps.channels.fakeShopify) app.register(fakeShopifyRoutes, { prefix: "/dev/fake-shopify" });
  if (deps.channels.fakeWoo) app.register(fakeWooRoutes, { prefix: "/dev/fake-woo" });

  // Routes qui ont besoin de la session.
  app.register(async (scope) => {
    registerSessionAuth(scope);
    scope.register(authRoutes, { prefix: "/auth" });
    scope.register(invitationRoutes, { prefix: "/invitations" });
    scope.register(photoRoutes, { prefix: "/photos" });
    scope.register(productRoutes, { prefix: "/products" });
    scope.register(channelRoutes, { prefix: "/channels" });
    scope.register(stockRoutes, { prefix: "/stock" });
    scope.register(orderRoutes, { prefix: "/orders" });
  });

  return app;
}
