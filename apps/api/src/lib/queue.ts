import { Queue } from "bullmq";
import { CHANNEL_QUEUE, processChannelJob, type ChannelDeps, type ChannelJob, type EnqueueOptions } from "@hub/channels";

/** File des jobs de synchronisation des canaux. BullMQ en vrai, mémoire dans les tests. */
export interface JobQueue {
  add(job: ChannelJob, opts?: EnqueueOptions): Promise<void>;
  close(): Promise<void>;
}

export class BullJobQueue implements JobQueue {
  private readonly queue: Queue;

  constructor(redisUrl: string) {
    const url = new URL(redisUrl);
    this.queue = new Queue(CHANNEL_QUEUE, { connection: { host: url.hostname, port: Number(url.port || 6379) } });
  }

  async add(job: ChannelJob, opts: EnqueueOptions = {}) {
    await this.queue.add(job.name, job.data, {
      // 1 = le plus prioritaire : un changement de stock passe avant les publications ordinaires.
      priority: opts.priority === "stock" ? 1 : 10,
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

  /** Exécute les jobs en attente, comme le ferait le worker (y compris ceux qu'ils ajoutent). */
  async drain(deps: ChannelDeps) {
    const enqueue = (job: ChannelJob) => this.add(job);
    while (this.jobs.length > 0) await processChannelJob({ ...deps, enqueue }, this.jobs.shift()!);
  }

  async close() {}
}
