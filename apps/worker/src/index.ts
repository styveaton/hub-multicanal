import { Worker } from "bullmq";

/**
 * Worker des jobs de synchronisation des canaux (publication, stock, commandes).
 * Les processeurs eBay, Amazon et TikTok Shop arrivent aux Sprints 3 à 5.
 */
const redisUrl = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
const connection = { host: redisUrl.hostname, port: Number(redisUrl.port || 6379) };

const worker = new Worker(
  "channel-sync",
  async (job) => {
    console.log(`[channel-sync] job ${job.id} (${job.name}) reçu, aucun processeur encore`);
  },
  { connection },
);

worker.on("ready", () => console.log("Worker channel-sync prêt"));
worker.on("failed", (job, err) => console.error(`[channel-sync] job ${job?.id} échoué`, err));

const shutdown = async () => {
  await worker.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
