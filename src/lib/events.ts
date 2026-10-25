import { EventEmitter } from "node:events";
import { logger } from "./logger.ts";
import { bestEffort, getSubscriber, redis } from "./redis.ts";

const CHANNEL_PREFIX = "owner-events:";

export type OwnerEvent =
  | { type: "ledger"; agent: string; event: Record<string, unknown> }
  | { type: "session"; session: string; change: "started" | "updated" | "ended" | "taken_over" };

const local = new EventEmitter().setMaxListeners(0);
let subscribed = false;

export async function publishToOwner(ownerId: string, event: OwnerEvent): Promise<void> {
  await bestEffort(() => redis.publish(CHANNEL_PREFIX + ownerId, JSON.stringify(event)), 0);
}

export function subscribeToOwner(
  ownerId: string,
  listener: (event: OwnerEvent) => void,
): () => void {
  ensureSubscribed();
  local.on(ownerId, listener);
  return () => local.off(ownerId, listener);
}

function ensureSubscribed() {
  if (subscribed) return;
  subscribed = true;
  const subscriber = getSubscriber();
  subscriber.on("pmessage", (_pattern, channel, payload) => {
    try {
      local.emit(channel.slice(CHANNEL_PREFIX.length), JSON.parse(payload) as OwnerEvent);
    } catch (err) {
      logger.warn({ err }, "discarding malformed owner event");
    }
  });
  subscriber.psubscribe(`${CHANNEL_PREFIX}*`).catch((err: unknown) => {
    subscribed = false;
    logger.error({ err }, "failed to subscribe to owner events");
  });
}
