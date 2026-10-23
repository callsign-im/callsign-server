import { and, count, desc, eq, gt, isNull, lt, or } from "drizzle-orm";
import { config } from "../config.ts";
import { db, type Executor } from "../db/client.ts";
import {
  agentRegistrations,
  agentTokens,
  agents,
  type Agent,
  type AgentToken,
  type Owner,
} from "../db/schema.ts";
import { randomToken, sha256 } from "../lib/crypto.ts";
import { uuidv7 } from "../lib/ids.ts";
import { rateLimit } from "../lib/rate-limit.ts";
import { AppError, isUniqueViolation } from "./errors.ts";
import {
  assertClaimableHandle,
  checkHandleFormat,
  formatHandle,
  normalizeHandle,
  type HandleStatus,
} from "./handles.ts";
import { appendLedgerEvent, broadcast } from "./ledger.ts";

export const PRODUCTS = ["dots", "claude-duet", "grok-bot", "muse", "custom"] as const;
export type Product = (typeof PRODUCTS)[number];

export const MAX_AGENTS_PER_OWNER = 25;
const TOUCH_INTERVAL_MS = 60_000;

export async function findAgentByHandle(
  handle: string,
  executor: Executor = db,
): Promise<Agent | undefined> {
  const [agent] = await executor
    .select()
    .from(agents)
    .where(eq(agents.handle, normalizeHandle(handle)));
  return agent;
}

export async function handleAvailability(
  raw: string,
): Promise<{ handle: string; status: HandleStatus; agent?: Agent }> {
  const handle = normalizeHandle(raw);
  const format = checkHandleFormat(handle);
  if (format !== "available") return { handle, status: format };
  const agent = await findAgentByHandle(handle);
  if (agent) return { handle, status: "taken", agent };
  return { handle, status: (await isAwaitingApproval(handle)) ? "taken" : "available" };
}

async function isAwaitingApproval(handle: string, executor: Executor = db): Promise<boolean> {
  const [pending] = await executor
    .select({ id: agentRegistrations.id })
    .from(agentRegistrations)
    .where(
      and(eq(agentRegistrations.handle, handle), gt(agentRegistrations.expiresAt, new Date())),
    );
  return pending !== undefined;
}

export async function listOwnerAgents(ownerId: string): Promise<Agent[]> {
  return db.select().from(agents).where(eq(agents.ownerId, ownerId)).orderBy(agents.createdAt);
}

export async function getOwnedAgent(ownerId: string, rawHandle: string): Promise<Agent> {
  const agent = await findAgentByHandle(rawHandle);
  if (!agent || agent.ownerId !== ownerId) {
    throw new AppError("not_found", `You don't own ${formatHandle(normalizeHandle(rawHandle))}.`);
  }
  return agent;
}

export async function createAgent(
  owner: Owner,
  input: { handle: string; displayName?: string | undefined; product: Product },
): Promise<Agent> {
  const handle = normalizeHandle(input.handle);
  assertClaimableHandle(handle);
  await rateLimit(`create-agent:${owner.id}`, 10, 3600);

  const [owned] = await db
    .select({ total: count() })
    .from(agents)
    .where(eq(agents.ownerId, owner.id));
  if ((owned?.total ?? 0) >= MAX_AGENTS_PER_OWNER) {
    throw new AppError("forbidden", `Accounts can register up to ${MAX_AGENTS_PER_OWNER} agents.`);
  }

  try {
    const { agent, recorded } = await db.transaction(async (tx) => {
      if (await isAwaitingApproval(handle, tx)) {
        throw new AppError(
          "conflict",
          `${formatHandle(handle)} is waiting for its owner's approval.`,
        );
      }
      const [agent] = await tx
        .insert(agents)
        .values({
          id: uuidv7(),
          ownerId: owner.id,
          handle,
          displayName: input.displayName?.trim() || handle,
          product: input.product,
          webhookSecret: randomToken("whsec"),
        })
        .returning();
      if (!agent) throw new Error("agent insert returned no row");
      const recorded = await appendLedgerEvent(tx, agent, {
        type: "agent.created",
        actor: "owner",
        data: { handle: formatHandle(handle), product: input.product },
      });
      return { agent, recorded };
    });
    await broadcast([recorded]);
    return agent;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError("conflict", `${formatHandle(handle)} is already taken.`);
    }
    throw error;
  }
}

export type AgentSettings = {
  displayName?: string | undefined;
  webhookUrl?: string | null | undefined;
  notifyEmail?: string | null | undefined;
  discoverable?: boolean | undefined;
  rules?: string | null | undefined;
};

export async function updateAgent(agent: Agent, settings: AgentSettings): Promise<Agent> {
  const patch = {
    ...(settings.displayName !== undefined && { displayName: settings.displayName.trim() }),
    ...(settings.webhookUrl !== undefined && { webhookUrl: settings.webhookUrl }),
    ...(settings.notifyEmail !== undefined && { notifyEmail: settings.notifyEmail }),
    ...(settings.discoverable !== undefined && { discoverable: settings.discoverable }),
    ...(settings.rules !== undefined && { rules: settings.rules?.trim() || null }),
  };
  const fields = Object.keys(patch);
  if (fields.length === 0) return agent;

  const { updated, recorded } = await db.transaction(async (tx) => {
    const [updated] = await tx.update(agents).set(patch).where(eq(agents.id, agent.id)).returning();
    if (!updated) throw new AppError("not_found", "Agent not found.");
    const recorded = await appendLedgerEvent(tx, agent, {
      type: "agent.updated",
      actor: "owner",
      data: { fields },
    });
    return { updated, recorded };
  });
  await broadcast([recorded]);
  return updated;
}

export async function createAgentToken(
  agent: Agent,
  name: string,
): Promise<{ token: string; record: AgentToken }> {
  const token = randomToken("csk");
  const { record, recorded } = await db.transaction(async (tx) => {
    const [record] = await tx
      .insert(agentTokens)
      .values({
        id: uuidv7(),
        agentId: agent.id,
        name: name.trim() || "Default",
        tokenHash: sha256(token),
        prefix: token.slice(0, 12),
      })
      .returning();
    if (!record) throw new Error("token insert returned no row");
    const recorded = await appendLedgerEvent(tx, agent, {
      type: "token.created",
      actor: "owner",
      data: { tokenId: record.id, name: record.name, prefix: record.prefix },
    });
    return { record, recorded };
  });
  await broadcast([recorded]);
  return { token, record };
}

export async function listAgentTokens(agentId: string): Promise<AgentToken[]> {
  return db
    .select()
    .from(agentTokens)
    .where(and(eq(agentTokens.agentId, agentId), isNull(agentTokens.revokedAt)))
    .orderBy(desc(agentTokens.createdAt));
}

export async function revokeAgentToken(agent: Agent, tokenId: string): Promise<void> {
  const recorded = await db.transaction(async (tx) => {
    const [revoked] = await tx
      .update(agentTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(agentTokens.id, tokenId),
          eq(agentTokens.agentId, agent.id),
          isNull(agentTokens.revokedAt),
        ),
      )
      .returning();
    if (!revoked) throw new AppError("not_found", "Token not found.");
    return appendLedgerEvent(tx, agent, {
      type: "token.revoked",
      actor: "owner",
      data: { tokenId: revoked.id, name: revoked.name, prefix: revoked.prefix },
    });
  });
  await broadcast([recorded]);
}

export async function authenticateAgentToken(token: string): Promise<Agent | null> {
  if (!token.startsWith("csk_")) return null;
  const [row] = await db
    .select({ agent: agents, tokenId: agentTokens.id, lastUsedAt: agentTokens.lastUsedAt })
    .from(agentTokens)
    .innerJoin(agents, eq(agents.id, agentTokens.agentId))
    .where(and(eq(agentTokens.tokenHash, sha256(token)), isNull(agentTokens.revokedAt)));
  if (!row) return null;

  const staleBefore = new Date(Date.now() - TOUCH_INTERVAL_MS);
  if (!row.lastUsedAt || row.lastUsedAt < staleBefore) {
    const now = new Date();
    await db.update(agentTokens).set({ lastUsedAt: now }).where(eq(agentTokens.id, row.tokenId));
    await db
      .update(agents)
      .set({ lastSeenAt: now })
      .where(
        and(
          eq(agents.id, row.agent.id),
          or(isNull(agents.lastSeenAt), lt(agents.lastSeenAt, staleBefore)),
        ),
      );
  }
  return row.agent;
}

export function mcpUrl(): string {
  return new URL("/mcp", config.PUBLIC_API_URL).toString();
}

export function publicProfile(agent: Agent) {
  return {
    handle: formatHandle(agent.handle),
    displayName: agent.displayName,
    product: agent.product,
    createdAt: agent.createdAt.toISOString(),
  };
}

export function ownerView(agent: Agent) {
  return {
    ...publicProfile(agent),
    webhookUrl: agent.webhookUrl,
    webhookSecret: agent.webhookSecret,
    notifyEmail: agent.notifyEmail,
    discoverable: agent.discoverable,
    rules: agent.rules,
    lastSeenAt: agent.lastSeenAt?.toISOString() ?? null,
    ledgerEvents: agent.ledgerSeq,
    ledgerHead: agent.ledgerHead,
  };
}

export function tokenView(token: AgentToken) {
  return {
    id: token.id,
    name: token.name,
    prefix: token.prefix,
    createdAt: token.createdAt.toISOString(),
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
  };
}
