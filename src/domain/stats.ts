import { and, count, eq, gt, ne, notInArray, notLike } from "drizzle-orm";
import { db } from "../db/client.ts";
import { agents, conversationMembers, conversations, messages, owners } from "../db/schema.ts";
import { bestEffort, redis } from "../lib/redis.ts";
import { PRODUCTS } from "./agents.ts";
import { HELLO_HANDLE } from "./handles.ts";
import { bridgeOwnerEmail } from "./email-bridge.ts";
import { helloOwnerEmail } from "./hello.ts";

const CACHE_KEY = "network-stats";
const CACHE_SECONDS = 300;
const ACTIVE_WINDOW_MS = 7 * 86_400_000;

export type NetworkStats = {
  agents: number;
  activeAgents: number;
  people: number;
  messages: number;
  conversations: number;
  groups: number;
  products: Record<string, number>;
  updatedAt: string;
};

async function total(query: Promise<{ value: number }[]>): Promise<number> {
  const [row] = await query;
  return row?.value ?? 0;
}

// @hello, the email bridge and their owners are ours, so they don't count as network activity.
async function computeStats(): Promise<NetworkStats> {
  const realAgents = and(ne(agents.handle, HELLO_HANDLE), notLike(agents.handle, "%@%"));
  const withHello = db
    .select({ id: conversationMembers.conversationId })
    .from(conversationMembers)
    .innerJoin(agents, eq(agents.id, conversationMembers.agentId))
    .where(eq(agents.handle, HELLO_HANDLE));
  const [agentCount, activeAgents, people, messageCount, conversationCount, groups, byProduct] =
    await Promise.all([
      total(db.select({ value: count() }).from(agents).where(realAgents)),
      total(
        db
          .select({ value: count() })
          .from(agents)
          .where(and(realAgents, gt(agents.lastSeenAt, new Date(Date.now() - ACTIVE_WINDOW_MS)))),
      ),
      total(
        db
          .select({ value: count() })
          .from(owners)
          .where(notInArray(owners.email, [helloOwnerEmail(), bridgeOwnerEmail()])),
      ),
      total(
        db
          .select({ value: count() })
          .from(messages)
          .where(notInArray(messages.conversationId, withHello)),
      ),
      total(
        db
          .select({ value: count() })
          .from(conversations)
          .where(notInArray(conversations.id, withHello)),
      ),
      total(
        db.select({ value: count() }).from(conversations).where(eq(conversations.kind, "group")),
      ),
      db
        .select({ product: agents.product, value: count() })
        .from(agents)
        .where(realAgents)
        .groupBy(agents.product),
    ]);
  const products = Object.fromEntries(PRODUCTS.map((product) => [product, 0]));
  for (const row of byProduct) products[row.product] = row.value;
  return {
    agents: agentCount,
    activeAgents,
    people,
    messages: messageCount,
    conversations: conversationCount,
    groups,
    products,
    updatedAt: new Date().toISOString(),
  };
}

// Aggregate counts only, cached so the public endpoint stays cheap.
export async function networkStats(): Promise<NetworkStats> {
  const cached = await bestEffort(() => redis.get(CACHE_KEY), null);
  if (cached) return JSON.parse(cached) as NetworkStats;
  const stats = await computeStats();
  await bestEffort(() => redis.set(CACHE_KEY, JSON.stringify(stats), "EX", CACHE_SECONDS), null);
  return stats;
}
