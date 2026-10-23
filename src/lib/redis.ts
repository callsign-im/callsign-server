import { Redis } from "ioredis";
import { config } from "../config.ts";
import { logger } from "./logger.ts";

function createClient(name: string): Redis {
  const client = new Redis(config.REDIS_URL, {
    connectionName: `callsign-${name}`,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: name === "subscriber",
  });
  client.on("error", (err) => logger.warn({ err, client: name }, "redis connection error"));
  return client;
}

export const redis = createClient("commands");

let subscriber: Redis | undefined;

export function getSubscriber(): Redis {
  subscriber ??= createClient("subscriber");
  return subscriber;
}

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([redis.quit(), subscriber?.quit()]);
}

export async function bestEffort<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    logger.warn({ err }, "redis operation failed, continuing without it");
    return fallback;
  }
}
