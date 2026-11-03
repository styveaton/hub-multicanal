import { Queue, Worker } from "bullmq";
import { prisma } from "@hub/db";
import {
  CHANNEL_QUEUE,
  createDepopClient,
  loadChannelConfig,
  processChannelJob,
  type ChannelJob,
  type EnqueueOptions,
} from "@hub/channels";

/**
 * Worker de synchronisation des canaux : publication et mise à jour des annonces,
 * propagation du stock après chaque vente, relevé de secours des commandes.
 * Depop est branché ; eBay, Amazon et TikTok Shop suivront le même chemin.
 */
const redisUrl = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
const connection = { host: redisUrl.hostname, port: Number(redisUrl.port || 6379) };

const config = loadChannelConfig();
const queue = new Queue(CHANNEL_QUEUE, { connection });
const enqueue = async (job: ChannelJob, opts: EnqueueOptions = {}) => {
  await queue.add(job.name, job.data, {
    priority: opts.priority === "stock" ? 1 : 10,
    attempts: 5,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: true,
    removeOnFail: 1000,
  });
};
// En mode fake, le faux Depop est servi par l'API (DEPOP_ENV=fake) : on l'appelle en HTTP.
const deps = { prisma, cipher: config.cipher, media: config.media, depop: createDepopClient(config.depop), enqueue };

// Relevé de secours des commandes : les webhooks des canaux peuvent se perdre.
await queue.upsertJobScheduler(
  "orders:poll",
  { every: config.orderPollSeconds * 1000 },
  { name: "orders:poll", data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } },
);

const worker = new Worker(
  CHANNEL_QUEUE,
  async (job) => {
    await processChannelJob(deps, { name: job.name, data: job.data } as ChannelJob);
  },
  { connection, concurrency: 4 },
);

worker.on("ready", () =>
  console.log(`Worker ${CHANNEL_QUEUE} prêt (Depop : ${config.depop.mode}, relevé des commandes toutes les ${config.orderPollSeconds} s)`),
);
worker.on("failed", (job, err) => console.error(`[${CHANNEL_QUEUE}] job ${job?.id} (${job?.name}) échoué : ${err.message}`));

const shutdown = async () => {
  await worker.close();
  await queue.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
