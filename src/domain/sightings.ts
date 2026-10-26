import { and, count, desc, eq, inArray, lt } from "drizzle-orm";
import { db } from "../db/client.ts";
import {
  agentNetworks,
  agents,
  agentTokens,
  tokenSightings,
  type Agent,
  type TokenSighting,
} from "../db/schema.ts";
import { enqueue } from "../jobs/queue.ts";
import type { DataKey } from "../lib/encryption.ts";
import { uuidv7 } from "../lib/ids.ts";
import { logger } from "../lib/logger.ts";
import { networkOf, normalizeIp } from "../lib/network.ts";
import { bestEffort, redis } from "../lib/redis.ts";
import { raiseAlert } from "./alerts.ts";
import { ownerKey } from "./keys.ts";

/** Where an agent request came from. */
export type Seen = { ip: string; userAgent: string | null };

// A token seen again from the same address within this window doesn't touch the database.
const DEDUPE_SECONDS = 900;
const SIGHTINGS_SHOWN = 50;
const SIGHTING_RETENTION_MS = 180 * 86_400_000;

const sightingContext = (column: string, tokenId: string, ipDigest: string) =>
  `token_sightings.${column}:${tokenId}:${ipDigest}`;
const labelContext = (agentId: string, networkDigest: string) =>
  `agent_networks.label:${agentId}:${networkDigest}`;

/** Records where a token was used from. Runs on every authenticated call, so it never throws. */
export async function noteSighting(agent: Agent, tokenId: string, seen: Seen): Promise<void> {
  const ip = normalizeIp(seen.ip);
  if (!ip) return;
  try {
    const key = await ownerKey(agent.ownerId);
    const ipDigest = key.digest(`ip:${ip}`);
    const fresh = await bestEffort(
      () => redis.set(`sighting:${tokenId}:${ipDigest}`, "1", "EX", DEDUPE_SECONDS, "NX"),
      null,
    );
    if (fresh !== "OK") return;
    const userAgent = seen.userAgent
      ? key.seal(seen.userAgent, sightingContext("user_agent", tokenId, ipDigest))
      : null;
    const [row] = await db
      .insert(tokenSightings)
      .values({
        id: uuidv7(),
        tokenId,
        agentId: agent.id,
        ipDigest,
        ip: key.seal(ip, sightingContext("ip", tokenId, ipDigest)),
        userAgent,
      })
      .onConflictDoUpdate({
        target: [tokenSightings.tokenId, tokenSightings.ipDigest],
        set: { lastSeenAt: new Date(), userAgent },
      })
      .returning({ id: tokenSightings.id, networkDigest: tokenSightings.networkDigest });
    if (row && !row.networkDigest) await enqueue(db, "sighting.check", { sightingId: row.id });
  } catch (err) {
    logger.warn({ err, tokenId }, "couldn't record a token sighting");
  }
}

/**
 * Works out the network of a new address. The agent's first network becomes its baseline; any
 * later one it hasn't used before raises an alert until the owner says it was them.
 */
export async function checkSighting({ sightingId }: { sightingId: string }): Promise<void> {
  const [found] = await db
    .select({ sighting: tokenSightings, agent: agents, token: agentTokens })
    .from(tokenSightings)
    .innerJoin(agents, eq(agents.id, tokenSightings.agentId))
    .innerJoin(agentTokens, eq(agentTokens.id, tokenSightings.tokenId))
    .where(eq(tokenSightings.id, sightingId));
  if (!found || found.sighting.networkDigest) return;
  const { sighting, agent, token } = found;
  const key = await ownerKey(agent.ownerId);
  const ip = key.open(sighting.ip, sightingContext("ip", sighting.tokenId, sighting.ipDigest));
  const network = await networkOf(ip);
  const networkDigest = key.digest(`network:${network.id}`);

  const unfamiliar = await db.transaction(async (tx) => {
    await tx
      .update(tokenSightings)
      .set({
        network: key.seal(
          network.label,
          sightingContext("network", sighting.tokenId, sighting.ipDigest),
        ),
        networkDigest,
      })
      .where(eq(tokenSightings.id, sighting.id));
    // Serializes an agent's first sightings, so exactly one network becomes the baseline.
    await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agent.id)).for("update");
    const known = await tx
      .select({ digest: agentNetworks.networkDigest })
      .from(agentNetworks)
      .where(eq(agentNetworks.agentId, agent.id));
    if (known.some((row) => row.digest === networkDigest)) {
      await tx
        .update(agentNetworks)
        .set({ lastSeenAt: new Date() })
        .where(
          and(eq(agentNetworks.agentId, agent.id), eq(agentNetworks.networkDigest, networkDigest)),
        );
      return false;
    }
    await tx.insert(agentNetworks).values({
      agentId: agent.id,
      networkDigest,
      label: key.seal(network.label, labelContext(agent.id, networkDigest)),
      status: known.length === 0 ? "known" : "pending",
    });
    return known.length > 0;
  });
  if (!unfamiliar) return;

  await raiseAlert({
    agent,
    kind: "new_network",
    tokenId: token.id,
    networkDigest,
    details: {
      network: network.label,
      ip,
      userAgent: key.open(
        sighting.userAgent,
        sightingContext("user_agent", sighting.tokenId, sighting.ipDigest),
      ),
      client: token.name,
      tokenPrefix: token.prefix,
    },
  });
}

export type SightingView = {
  ip: string;
  network: string | null;
  userAgent: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
};

function sightingView(key: DataKey, row: TokenSighting): SightingView {
  const context = (column: string) => sightingContext(column, row.tokenId, row.ipDigest);
  return {
    ip: key.open(row.ip, context("ip")),
    network: key.open(row.network, context("network")),
    userAgent: key.open(row.userAgent, context("user_agent")),
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

export async function listTokenSightings(agent: Agent, tokenId: string): Promise<SightingView[]> {
  const key = await ownerKey(agent.ownerId);
  const rows = await db
    .select()
    .from(tokenSightings)
    .where(and(eq(tokenSightings.agentId, agent.id), eq(tokenSightings.tokenId, tokenId)))
    .orderBy(desc(tokenSightings.lastSeenAt))
    .limit(SIGHTINGS_SHOWN);
  return rows.map((row) => sightingView(key, row));
}

export type TokenUsage = { last: SightingView; addresses: number };

/** The latest address each token was used from, and how many it has been used from. */
export async function tokenUsage(
  agent: Agent,
  tokenIds: string[],
): Promise<Map<string, TokenUsage>> {
  if (tokenIds.length === 0) return new Map();
  const [key, latest, totals] = await Promise.all([
    ownerKey(agent.ownerId),
    db
      .selectDistinctOn([tokenSightings.tokenId])
      .from(tokenSightings)
      .where(inArray(tokenSightings.tokenId, tokenIds))
      .orderBy(tokenSightings.tokenId, desc(tokenSightings.lastSeenAt)),
    db
      .select({ tokenId: tokenSightings.tokenId, addresses: count() })
      .from(tokenSightings)
      .where(inArray(tokenSightings.tokenId, tokenIds))
      .groupBy(tokenSightings.tokenId),
  ]);
  const addresses = new Map(totals.map((row) => [row.tokenId, row.addresses]));
  return new Map(
    latest.map((row) => [
      row.tokenId,
      { last: sightingView(key, row), addresses: addresses.get(row.tokenId) ?? 1 },
    ]),
  );
}

export type NetworkView = {
  label: string;
  status: "known" | "pending";
  firstSeenAt: string;
  lastSeenAt: string;
};

export async function listAgentNetworks(agent: Agent): Promise<NetworkView[]> {
  const key = await ownerKey(agent.ownerId);
  const rows = await db
    .select()
    .from(agentNetworks)
    .where(eq(agentNetworks.agentId, agent.id))
    .orderBy(desc(agentNetworks.lastSeenAt));
  return rows.map((row) => ({
    label: key.open(row.label, labelContext(row.agentId, row.networkDigest)),
    status: row.status,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  }));
}

export async function pruneSightings(): Promise<void> {
  const before = new Date(Date.now() - SIGHTING_RETENTION_MS);
  await db.delete(tokenSightings).where(lt(tokenSightings.lastSeenAt, before));
}
