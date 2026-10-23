import { sql } from "./db/client.ts";
import { pruneReleasedHandles } from "./domain/agents.ts";
import { pruneUnsentFiles } from "./domain/files.ts";
import { pruneOAuth } from "./domain/oauth.ts";
import { pruneExpiredCredentials } from "./domain/owners.ts";
import { pruneExpiredRegistrations } from "./domain/registrations.ts";
import { pruneFinishedJobs } from "./jobs/queue.ts";
import { runJobs } from "./jobs/runner.ts";
import { logger } from "./lib/logger.ts";
import { closeRedis } from "./lib/redis.ts";

const MAINTENANCE_INTERVAL_MS = 60 * 60_000;

const controller = new AbortController();

async function maintenance() {
  try {
    await pruneExpiredCredentials();
    await pruneOAuth();
    await pruneUnsentFiles();
    await pruneExpiredRegistrations();
    await pruneReleasedHandles();
    await pruneFinishedJobs(7);
  } catch (err) {
    logger.error({ err }, "maintenance failed");
  }
}

const timer = setInterval(() => void maintenance(), MAINTENANCE_INTERVAL_MS);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    logger.info({ signal }, "worker shutting down");
    controller.abort();
  });
}

logger.info("worker started");
await maintenance();
await runJobs(controller.signal);
clearInterval(timer);
await Promise.all([sql.end({ timeout: 5 }), closeRedis()]);
logger.info("worker stopped");
