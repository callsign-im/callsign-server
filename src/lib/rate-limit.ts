import { AppError } from "../domain/errors.ts";
import { bestEffort, redis } from "./redis.ts";

export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<void> {
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
