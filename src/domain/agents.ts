import { and, count, desc, eq, gt, isNull, lt, lte, or } from "drizzle-orm";
import { config } from "../config.ts";
import { db, type Executor, type Tx } from "../db/client.ts";
import {
  agentRegistrations,
  agentTokens,
  agents,
  eventSubscriptions,
  heldHandles,
  type Agent,
  type AgentToken,
  type Owner,
} from "../db/schema.ts";
import { randomToken, sha256 } from "../lib/crypto.ts";
import type { Sealed } from "../lib/encryption.ts";
import { uuidv7 } from "../lib/ids.ts";
import { rateLimit } from "../lib/rate-limit.ts";
import { isPublicHost } from "../lib/safe-fetch.ts";
import { AppError, isUniqueViolation } from "./errors.ts";
import {
  assertClaimableHandle,
  checkHandleFormat,
  formatHandle,
  normalizeHandle,
  type HandleStatus,
} from "./handles.ts";
import { ownerKey } from "./keys.ts";
import { appendLedgerEvent, broadcast } from "./ledger.ts";
import { lockOwner } from "./owners.ts";

export const PRODUCTS = ["dots", "claude-duet", "grok-bot", "muse", "custom"] as const;
export type Product = (typeof PRODUCTS)[number];

export const MAX_AGENTS_PER_OWNER = 25;
export const MAX_DESCRIPTION_LENGTH = 280;
export const HANDLE_HOLD_DAYS = 30;
const TOUCH_INTERVAL_MS = 60_000;

const rulesContext = (agentId: string) => `agents.rules:${agentId}`;
const secretContext = (agentId: string) => `agents.webhook_secret:${agentId}`;

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
): Promise<{ handle: string; status: HandleStatus; agent?: Agent; availableAt?: Date }> {
  const handle = normalizeHandle(raw);
  const format = checkHandleFormat(handle);
  if (format === "invalid") return { handle, status: format };
  const agent = await findAgentByHandle(handle);
  if (agent) return { handle, status: "taken", agent };
  if (format !== "available") return { handle, status: format };
  const availableAt = await heldUntil(handle);
  if (availableAt) return { handle, status: "held", availableAt };
  return { handle, status: (await isAwaitingApproval(handle)) ? "taken" : "available" };
}

async function heldUntil(handle: string, executor: Executor = db): Promise<Date | null> {
  const [held] = await executor
    .select({ availableAt: heldHandles.availableAt })
    .from(heldHandles)
    .where(and(eq(heldHandles.handle, handle), gt(heldHandles.availableAt, new Date())));
  return held?.availableAt ?? null;
}

export async function assertHandleNotHeld(handle: string, executor: Executor = db): Promise<void> {
  const availableAt = await heldUntil(handle, executor);
  if (availableAt) {
    throw new AppError(
      "conflict",
      `${formatHandle(handle)} belonged to a deleted agent and can be claimed again on ${availableAt.toISOString().slice(0, 10)}.`,
    );
  }
}

export async function holdHandle(tx: Tx, handle: string): Promise<void> {
  const availableAt = new Date(Date.now() + HANDLE_HOLD_DAYS * 86_400_000);
  await tx
    .insert(heldHandles)
    .values({ handle, availableAt })
    .onConflictDoUpdate({ target: heldHandles.handle, set: { availableAt } });
}

export async function pruneReleasedHandles(): Promise<void> {
  await db.delete(heldHandles).where(lte(heldHandles.availableAt, new Date()));
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

export function assertWebhookUrl(
  url: string | null | undefined,
  allowPrivate = config.ALLOW_PRIVATE_WEBHOOKS,
): void {
  if (!url || allowPrivate || isPublicHost(new URL(url))) return;
  throw new AppError(
    "invalid_input",
    "Webhook URLs must be reachable on the public internet, not a private or local address.",
  );
}

export function cleanDescription(description: string | null | undefined): string | null {
  return description?.replace(/\s+/g, " ").trim() || null;
}

export async function reserveAgentSlot(tx: Tx, ownerId: string): Promise<{ primary: boolean }> {
  await lockOwner(tx, ownerId);
  const [owned] = await tx
    .select({ total: count() })
    .from(agents)
    .where(eq(agents.ownerId, ownerId));
  const total = owned?.total ?? 0;
  if (total >= MAX_AGENTS_PER_OWNER) {
    throw new AppError("forbidden", `Accounts can register up to ${MAX_AGENTS_PER_OWNER} agents.`);
  }
  return { primary: total === 0 };
}

export async function createAgent(
  owner: Owner,
  input: {
    handle: string;
    displayName?: string | undefined;
    description?: string | null | undefined;
    product: Product;
    rules?: string | null | undefined;
  },
  options: { system?: boolean } = {},
): Promise<Agent> {
  const handle = normalizeHandle(input.handle);
  if (!options.system) {
    assertClaimableHandle(handle);
    await rateLimit(`create-agent:${owner.id}`, 10, 3600);
  }

  const id = uuidv7();
  const webhookSecret = await newWebhookSecret(owner.id, id);
  try {
    const { agent, recorded } = await db.transaction(async (tx) => {
      const { primary } = await reserveAgentSlot(tx, owner.id);
      if (await isAwaitingApproval(handle, tx)) {
        throw new AppError(
          "conflict",
          `${formatHandle(handle)} is waiting for its owner's approval.`,
        );
      }
      await assertHandleNotHeld(handle, tx);
      const [agent] = await tx
        .insert(agents)
        .values({
          id,
          ownerId: owner.id,
          handle,
          displayName: input.displayName?.trim() || handle,
          description: cleanDescription(input.description),
          product: input.product,
          primary,
          webhookSecret,
          rules: await sealAgentRules(owner.id, id, input.rules, tx),
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

export async function newWebhookSecret(
  ownerId: string,
  agentId: string,
  executor: Executor = db,
): Promise<Sealed> {
  const key = await ownerKey(ownerId, executor);
  return key.seal(randomToken("whsec"), secretContext(agentId));
}

export async function sealAgentRules(
  ownerId: string,
  agentId: string,
  rules: string | null | undefined,
  executor: Executor = db,
): Promise<Sealed | null> {
  const text = rules?.trim();
  if (!text) return null;
  return (await ownerKey(ownerId, executor)).seal(text, rulesContext(agentId));
}

export async function agentRules(agent: Agent): Promise<string | null> {
  return (await ownerKey(agent.ownerId)).open(agent.rules, rulesContext(agent.id));
}

export async function webhookSecret(agent: Agent): Promise<string> {
  return (await ownerKey(agent.ownerId)).open(agent.webhookSecret, secretContext(agent.id));
}

export type AgentSettings = {
  displayName?: string | undefined;
  description?: string | null | undefined;
  primary?: true | undefined;
  webhookUrl?: string | null | undefined;
  notifyEmail?: string | null | undefined;
  discoverable?: boolean | undefined;
  rules?: string | null | undefined;
  wake?: Partial<Pick<Agent, "wakeKind" | "wakeUrl" | "wakeToken" | "wakeStatus">> | undefined;
};

export async function updateAgent(
  agent: Agent,
  settings: AgentSettings,
  actor: "owner" | "agent" = "owner",
): Promise<Agent> {
  assertWebhookUrl(settings.webhookUrl);
  const key = await ownerKey(agent.ownerId);
  const patch = {
    ...(settings.displayName !== undefined && { displayName: settings.displayName.trim() }),
    ...(settings.description !== undefined && {
      description: cleanDescription(settings.description),
    }),
    ...(settings.primary && !agent.primary && { primary: true }),
    ...(settings.webhookUrl !== undefined && { webhookUrl: settings.webhookUrl }),
    ...(settings.notifyEmail !== undefined && { notifyEmail: settings.notifyEmail }),
    ...(settings.discoverable !== undefined && { discoverable: settings.discoverable }),
    ...(settings.rules !== undefined && {
      rules: key.seal(settings.rules?.trim() || null, rulesContext(agent.id)),
    }),
    ...settings.wake,
  };
  const fields = [...new Set(Object.keys(patch).map((f) => (f.startsWith("wake") ? "wake" : f)))];
  if (fields.length === 0) return agent;

  const { updated, recorded } = await db.transaction(async (tx) => {
    if (patch.primary) {
      await lockOwner(tx, agent.ownerId);
      await tx
        .update(agents)
        .set({ primary: false })
        .where(and(eq(agents.ownerId, agent.ownerId), eq(agents.primary, true)));
    }
    const [updated] = await tx.update(agents).set(patch).where(eq(agents.id, agent.id)).returning();
    if (!updated) throw new AppError("not_found", "Agent not found.");
    const recorded = await appendLedgerEvent(tx, agent, {
      type: "agent.updated",
      actor,
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
    .where(
      and(
        eq(agentTokens.agentId, agentId),
        isNull(agentTokens.revokedAt),
        or(isNull(agentTokens.refreshExpiresAt), gt(agentTokens.refreshExpiresAt, new Date())),
      ),
    )
    .orderBy(desc(agentTokens.createdAt));
}

export async function revokeAgentToken(
  agent: Agent,
  tokenId: string,
  actor: "owner" | "agent" = "owner",
): Promise<void> {
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
    await tx.delete(eventSubscriptions).where(eq(eventSubscriptions.tokenId, revoked.id));
    return appendLedgerEvent(tx, agent, {
      type: "token.revoked",
      actor,
      data: { tokenId: revoked.id, name: revoked.name, prefix: revoked.prefix },
    });
  });
  await broadcast([recorded]);
}

export async function authenticateAgentToken(token: string): Promise<Agent | null> {
  return (await authenticateAgentCredential(token))?.agent ?? null;
}

export async function authenticateAgentCredential(
  token: string,
): Promise<{ agent: Agent; tokenId: string } | null> {
  if (!token.startsWith("csk_")) return null;
  const [row] = await db
    .select({ agent: agents, tokenId: agentTokens.id, lastUsedAt: agentTokens.lastUsedAt })
    .from(agentTokens)
    .innerJoin(agents, eq(agents.id, agentTokens.agentId))
    .where(
      and(
        eq(agentTokens.tokenHash, sha256(token)),
        isNull(agentTokens.revokedAt),
        or(isNull(agentTokens.expiresAt), gt(agentTokens.expiresAt, new Date())),
      ),
    );
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
  return { agent: row.agent, tokenId: row.tokenId };
}

export function mcpUrl(): string {
  return new URL("/mcp", config.PUBLIC_API_URL).toString();
}

export function assertReachable(agent: Agent): void {
  if (agent.suspendedAt) {
    throw new AppError(
      "forbidden",
      `${formatHandle(agent.handle)} is suspended after reports of abuse and can't receive messages.`,
    );
  }
}

export function publicProfile(agent: Agent) {
  return {
    handle: formatHandle(agent.handle),
    displayName: agent.displayName,
    description: agent.description,
    product: agent.product,
    createdAt: agent.createdAt.toISOString(),
  };
}

export async function ownerView(agent: Agent) {
  const key = await ownerKey(agent.ownerId);
  return {
    ...publicProfile(agent),
    primary: agent.primary,
    webhookUrl: agent.webhookUrl,
    webhookSecret: key.open(agent.webhookSecret, secretContext(agent.id)),
    notifyEmail: agent.notifyEmail,
    discoverable: agent.discoverable,
    rules: key.open(agent.rules, rulesContext(agent.id)),
    wake: agent.wakeKind
      ? {
          kind: agent.wakeKind,
          url: agent.wakeUrl,
          hasToken: agent.wakeToken !== null,
          last: agent.wakeStatus,
        }
      : null,
    lastSeenAt: agent.lastSeenAt?.toISOString() ?? null,
    suspendedAt: agent.suspendedAt?.toISOString() ?? null,
    ledgerEvents: agent.ledgerSeq,
    ledgerHead: agent.ledgerHead,
  };
}

export function tokenView(token: AgentToken) {
  return {
    id: token.id,
    name: token.name,
    kind: token.clientId ? ("oauth" as const) : ("token" as const),
    prefix: token.prefix,
    createdAt: token.createdAt.toISOString(),
    lastUsedAt: token.lastUsedAt?.toISOString() ?? null,
  };
}
