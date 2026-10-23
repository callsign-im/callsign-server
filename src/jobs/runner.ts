import { setTimeout as sleep } from "node:timers/promises";
import { exitOnRejectedCredentials } from "../db/client.ts";
import type { Job } from "../db/schema.ts";
import { logger } from "../lib/logger.ts";
import { handlers } from "./handlers.ts";
import { claimJobs, completeJob, failJob, type JobKind, type JobPayloads } from "./queue.ts";

const BATCH_SIZE = 10;

function isKnownKind(kind: string): kind is JobKind {
  return Object.hasOwn(handlers, kind);
}

export async function processJob(job: Job): Promise<void> {
  try {
    if (!isKnownKind(job.kind)) throw new Error(`unknown job kind ${job.kind}`);
    const handler = handlers[job.kind] as (
      payload: JobPayloads[JobKind],
      id: string,
    ) => Promise<void>;
    await handler(job.payload as JobPayloads[JobKind], job.id);
    await completeJob(job);
  } catch (err) {
    logger.warn({ err, jobId: job.id, kind: job.kind, attempt: job.attempts }, "job failed");
    await failJob(job, err);
  }
}

export async function processDueJobs(): Promise<number> {
  const batch = await claimJobs(BATCH_SIZE);
  await Promise.all(batch.map(processJob));
  return batch.length;
}

export async function runJobs(signal: AbortSignal, pollIntervalMs = 1000): Promise<void> {
  while (!signal.aborted) {
    try {
      if ((await processDueJobs()) > 0) continue;
    } catch (err) {
      logger.error({ err }, "job loop error");
      exitOnRejectedCredentials(err);
    }
    await sleep(pollIntervalMs, undefined, { signal }).catch(() => undefined);
  }
}
