import { Queue } from "bullmq";
import { CHANNEL_QUEUE, processChannelJob, type ChannelDeps, type ChannelJob } from "@hub/channels";

/** File des jobs de synchronisation des canaux. BullMQ en vrai, mémoire dans les tests. */
export interface JobQueue {
  add(job: ChannelJob): Promise<void>;
  close(): Promise<void>;
}

export class BullJobQueue implements JobQueue {
  private readonly queue: Queue;

  constructor(redisUrl: string) {
    const url = new URL(redisUrl);
    this.queue = new Queue(CHANNEL_QUEUE, { connection: { host: url.hostname, port: Number(url.port || 6379) } });
  }

  async add(job: ChannelJob) {
    await this.queue.add(job.name, job.data, {
      attempts: 5,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: true,
      removeOnFail: 1000,
    });
  }

  close() {
    return this.queue.close();
  }
}

/** File en mémoire : les tests lancent les jobs eux-mêmes avec `drain`. */
export class MemoryJobQueue implements JobQueue {
  readonly jobs: ChannelJob[] = [];

  async add(job: ChannelJob) {
    this.jobs.push(job);
  }

  /** Exécute les jobs en attente, comme le ferait le worker. */
  async drain(deps: ChannelDeps) {
    while (this.jobs.length > 0) await processChannelJob(deps, this.jobs.shift()!);
  }

  async close() {}
}
