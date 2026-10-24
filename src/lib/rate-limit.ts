import { AppError } from "../domain/errors.ts";
import { bestEffort, redis } from "./redis.ts";

// Agents the deployment runs itself, like @hello, act for whoever wrote to them; that sender's
// own limits apply instead.
const exempt = new Set<string>();

export function exemptFromRateLimits(agentId: string): void {
  exempt.add(agentId);
}

export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<void> {
  if (exempt.has(key.slice(key.lastIndexOf(":") + 1))) return;
  const window = Math.floor(Date.now() / 1000 / windowSeconds);
  const redisKey = `rate:${key}:${window}`;
  const count = await bestEffort(async () => {
    const results = await redis.multi().incr(redisKey).expire(redisKey, windowSeconds).exec();
    return Number(results?.[0]?.[1] ?? 0);
  }, 0);

  if (count > limit) {
    const retryAfter = (window + 1) * windowSeconds - Math.floor(Date.now() / 1000);
    throw new AppError("rate_limited", `Rate limit exceeded. Retry in ${retryAfter}s.`, {
      retryAfter,
    });
  }
}
