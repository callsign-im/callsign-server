import { serve } from "@hono/node-server";
import { config } from "./config.ts";
import { sql } from "./db/client.ts";
import { createApp } from "./http/app.ts";
import { closeMcp } from "./http/routes/mcp.ts";
import { logger } from "./lib/logger.ts";
import { closeRedis } from "./lib/redis.ts";

const server = serve({ fetch: createApp().fetch, port: config.PORT }, (info) => {
  logger.info({ port: info.port }, "api listening");
});

async function shutdown(signal: NodeJS.Signals) {
  logger.info({ signal }, "api shutting down");
  server.close();
  await closeMcp();
  await Promise.all([sql.end({ timeout: 5 }), closeRedis()]);
  process.exit(0);
}

process.once("SIGINT", (signal) => void shutdown(signal));
process.once("SIGTERM", (signal) => void shutdown(signal));
