import { Worker } from "bullmq";
import { prisma } from "@hub/db";
import { CHANNEL_QUEUE, createDepopClient, loadChannelConfig, processChannelJob, type ChannelJob } from "@hub/channels";

/**
 * Worker de synchronisation des canaux : publication, mise à jour et retrait des annonces.
 * Depop est branché ; eBay, Amazon et TikTok Shop suivront le même chemin.
 */
const redisUrl = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
const connection = { host: redisUrl.hostname, port: Number(redisUrl.port || 6379) };

const config = loadChannelConfig();
// En mode fake, le faux Depop est servi par l'API (DEPOP_ENV=fake) : on l'appelle en HTTP.
const deps = { prisma, cipher: config.cipher, media: config.media, depop: createDepopClient(config.depop) };

const worker = new Worker(
  CHANNEL_QUEUE,
  async (job) => {
    await processChannelJob(deps, { name: job.name, data: job.data } as ChannelJob);
  },
  { connection, concurrency: 4 },
);

worker.on("ready", () => console.log(`Worker ${CHANNEL_QUEUE} prêt (Depop : ${config.depop.mode})`));
worker.on("failed", (job, err) => console.error(`[${CHANNEL_QUEUE}] job ${job?.id} (${job?.name}) échoué : ${err.message}`));

const shutdown = async () => {
  await worker.close();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
