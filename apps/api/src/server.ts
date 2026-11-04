import { prisma } from "@hub/db";
import {
  FakeDepop,
  FakeEbay,
  FakeEtsy,
  FakeShopify,
  FakeWoo,
  createDepopClient,
  createEbayClient,
  createEtsyClient,
  createShopifyClient,
  createWooClient,
  loadChannelConfig,
} from "@hub/channels";
import { buildApp } from "./app.js";
import { loadEnv } from "./env.js";
import { createSmtpMailer } from "./lib/mailer.js";
import { BullJobQueue } from "./lib/queue.js";
import { S3Storage } from "./lib/storage.js";

const env = loadEnv();
const storage = new S3Storage(env);
const channelConfig = loadChannelConfig();
// En local sans clés Depop : faux Depop servi par l'API (le worker l'appelle en HTTP).
const fakeDepop = channelConfig.depop.mode === "fake" ? new FakeDepop() : undefined;
const fakeShopify = channelConfig.shopify.mode === "fake" ? new FakeShopify() : undefined;
const fakeWoo = channelConfig.woo.mode === "fake" ? new FakeWoo() : undefined;
const fakeEbay = channelConfig.ebay.mode === "fake" ? new FakeEbay() : undefined;
const fakeEtsy = channelConfig.etsy.mode === "fake" ? new FakeEtsy() : undefined;
const queue = new BullJobQueue(env.REDIS_URL ?? "redis://localhost:6379");
const app = buildApp(env, {
  prisma,
  mailer: createSmtpMailer(env),
  storage,
  channels: {
    config: channelConfig,
    depop: createDepopClient(channelConfig.depop, fakeDepop?.fetch),
    shopify: createShopifyClient(channelConfig.shopify, fakeShopify?.fetch),
    woo: createWooClient(channelConfig.woo, fakeWoo?.fetch),
    ebay: createEbayClient(channelConfig.ebay, fakeEbay?.fetch),
    etsy: createEtsyClient(channelConfig.etsy, fakeEtsy?.fetch),
    queue,
    fakeDepop,
    fakeShopify,
    fakeWoo,
    fakeEbay,
    fakeEtsy,
  },
});
app.addHook("onClose", () => queue.close());

storage
  .ensureBucket()
  .catch((err) => app.log.warn(err, `bucket S3 « ${env.S3_BUCKET} » inaccessible : les photos ne fonctionneront pas`))
  .finally(() =>
    app.listen({ port: env.API_PORT, host: "0.0.0.0" }).catch((err) => {
      app.log.error(err);
      process.exit(1);
    }),
  );
