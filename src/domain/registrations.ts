import { and, eq, gt, lte } from "drizzle-orm";
import { config } from "../config.ts";
import { db, type Executor } from "../db/client.ts";
import {
  agentRegistrations,
  agents,
  agentTokens,
  type Agent,
  type AgentRegistration,
  type Owner,
} from "../db/schema.ts";
import { enqueue } from "../jobs/queue.ts";
import { randomToken, sha256 } from "../lib/crypto.ts";
import { uuidv7 } from "../lib/ids.ts";
import { memoryNote } from "../mcp/guide.ts";
import { rateLimit } from "../lib/rate-limit.ts";
import {
  cleanDescription,
  findAgentByHandle,
  mcpUrl,
  newWebhookSecret,
  reserveAgentSlot,
  type Product,
} from "./agents.ts";
import { AppError, isUniqueViolation } from "./errors.ts";
import { assertClaimableHandle, formatHandle, normalizeHandle } from "./handles.ts";
import { appendLedgerEvent, broadcast } from "./ledger.ts";
import { createSession, normalizeEmail, upsertOwner } from "./owners.ts";

const REGISTRATION_TTL_MS = 24 * 3_600_000;
const TOKEN_NAME = "Self-registration";

export type RegistrationRequest = {
  handle: string;
  ownerEmail: string;
  product: Product;
  displayName?: string | undefined;
  description?: string | undefined;
  webhookUrl?: string | undefined;
  notifyEmail?: string | undefined;
};

export function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
}

function approvalUrl(token: string): string {
  const url = new URL("/claim", config.WEB_URL);
  url.searchParams.set("token", token);
  return url.toString();
}

async function sendApproval(executor: Executor, registration: AgentRegistration, token: string) {
  await enqueue(executor, "email.approval", {
    email: registration.ownerEmail,
    handle: formatHandle(registration.handle),
    product: registration.product,
    url: approvalUrl(token),
    expiresAt: registration.expiresAt.toISOString(),
  });
}

export async function pendingRegistrationFor(
  handle: string,
  executor: Executor = db,
): Promise<AgentRegistration | undefined> {
  await executor
    .delete(agentRegistrations)
    .where(
      and(eq(agentRegistrations.handle, handle), lte(agentRegistrations.expiresAt, new Date())),
    );
  const [registration] = await executor
    .select()
    .from(agentRegistrations)
    .where(eq(agentRegistrations.handle, handle));
  return registration;
}

export async function registerAgent(
  request: RegistrationRequest,
  ip: string,
): Promise<{ registration: AgentRegistration; token: string }> {
  const handle = normalizeHandle(request.handle);
  assertClaimableHandle(handle);
  const ownerEmail = normalizeEmail(request.ownerEmail);
  await rateLimit(`register-ip:${ip}`, 10, 3600);
  await rateLimit(`register-email:${ownerEmail}`, 5, 3600);

  const token = randomToken("csk");
  const approval = randomToken();
  try {
    const registration = await db.transaction(async (tx) => {
      if ((await findAgentByHandle(handle, tx)) || (await pendingRegistrationFor(handle, tx))) {
        throw new AppError("conflict", `${formatHandle(handle)} is already taken.`);
      }
      const [registration] = await tx
        .insert(agentRegistrations)
        .values({
          id: uuidv7(),
          handle,
          displayName: request.displayName?.trim() || handle,
          description: cleanDescription(request.description),
          product: request.product,
          ownerEmail,
          tokenHash: sha256(token),
          tokenPrefix: token.slice(0, 12),
          approvalTokenHash: sha256(approval),
          webhookUrl: request.webhookUrl ?? null,
          notifyEmail: request.notifyEmail ?? null,
          expiresAt: new Date(Date.now() + REGISTRATION_TTL_MS),
        })
        .returning();
      if (!registration) throw new Error("registration insert returned no row");
      await sendApproval(tx, registration, approval);
      return registration;
    });
    return { registration, token };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError("conflict", `${formatHandle(handle)} is already taken.`);
    }
    throw error;
  }
}

function live() {
  return gt(agentRegistrations.expiresAt, new Date());
}

export async function findRegistrationByAgentToken(
  token: string,
): Promise<AgentRegistration | undefined> {
  const [registration] = await db
    .select()
    .from(agentRegistrations)
    .where(and(eq(agentRegistrations.tokenHash, sha256(token)), live()));
  return registration;
}

export async function findRegistrationByApprovalToken(token: string): Promise<AgentRegistration> {
  const [registration] = await db
    .select()
    .from(agentRegistrations)
    .where(and(eq(agentRegistrations.approvalTokenHash, sha256(token)), live()));
  if (!registration) {
    throw new AppError("not_found", "This approval link is invalid or has expired.");
  }
  return registration;
}

export async function listPendingRegistrations(owner: Owner): Promise<AgentRegistration[]> {
  return db
    .select()
    .from(agentRegistrations)
    .where(and(eq(agentRegistrations.ownerEmail, owner.email), live()))
    .orderBy(agentRegistrations.createdAt);
}

export async function findOwnedRegistration(owner: Owner, id: string): Promise<AgentRegistration> {
  const [registration] = await db
    .select()
    .from(agentRegistrations)
    .where(
      and(eq(agentRegistrations.id, id), eq(agentRegistrations.ownerEmail, owner.email), live()),
    );
  if (!registration) throw new AppError("not_found", "Registration not found or expired.");
  return registration;
}

export async function resendApproval(registration: AgentRegistration): Promise<void> {
  await rateLimit(`register-resend:${registration.id}`, 3, 3600);
  const approval = randomToken();
  await db.transaction(async (tx) => {
    await tx
      .update(agentRegistrations)
      .set({ approvalTokenHash: sha256(approval) })
      .where(eq(agentRegistrations.id, registration.id));
    await sendApproval(tx, registration, approval);
  });
}

export async function rejectRegistration(registration: AgentRegistration): Promise<void> {
  await db.delete(agentRegistrations).where(eq(agentRegistrations.id, registration.id));
}

export async function approveRegistration(
  registration: AgentRegistration,
  options: { startSession: boolean },
): Promise<{ owner: Owner; agent: Agent; sessionToken?: string }> {
  try {
    const { owner, agent, sessionToken, recorded } = await db.transaction(async (tx) => {
      const [claimed] = await tx
        .delete(agentRegistrations)
        .where(and(eq(agentRegistrations.id, registration.id), live()))
        .returning();
      if (!claimed) throw new AppError("not_found", "This registration has expired.");

      const owner = await upsertOwner(tx, claimed.ownerEmail);
      const { primary } = await reserveAgentSlot(tx, owner.id);

      const agentId = uuidv7();
      const [agent] = await tx
        .insert(agents)
        .values({
          id: agentId,
          ownerId: owner.id,
          handle: claimed.handle,
          displayName: claimed.displayName,
          description: claimed.description,
          product: claimed.product,
          primary,
          webhookUrl: claimed.webhookUrl,
          notifyEmail: claimed.notifyEmail,
          webhookSecret: await newWebhookSecret(owner.id, agentId, tx),
        })
        .returning();
      if (!agent) throw new Error("agent insert returned no row");
      const tokenId = uuidv7();
      await tx.insert(agentTokens).values({
        id: tokenId,
        agentId: agent.id,
        name: TOKEN_NAME,
        tokenHash: claimed.tokenHash,
        prefix: claimed.tokenPrefix,
      });

      const recorded = [
        await appendLedgerEvent(tx, agent, {
          type: "agent.created",
          actor: "owner",
          data: {
            handle: formatHandle(agent.handle),
            product: agent.product,
            via: "self-registration",
          },
        }),
        await appendLedgerEvent(tx, agent, {
          type: "token.created",
          actor: "agent",
          data: { tokenId, name: TOKEN_NAME, prefix: claimed.tokenPrefix },
        }),
      ];
      const session = options.startSession ? await createSession(tx, owner.id) : undefined;
      return { owner, agent, sessionToken: session?.sessionToken, recorded };
    });
    await broadcast(recorded);
    return { owner, agent, ...(sessionToken && { sessionToken }) };
  } catch (error) {
    if (isUniqueViolation(error)) {
      await rejectRegistration(registration);
      throw new AppError("conflict", `${formatHandle(registration.handle)} was taken meanwhile.`);
    }
    throw error;
  }
}

export async function pruneExpiredRegistrations(): Promise<void> {
  await db.delete(agentRegistrations).where(lte(agentRegistrations.expiresAt, new Date()));
}

export function pendingView(registration: AgentRegistration, token?: string) {
  const handle = formatHandle(registration.handle);
  const sentTo = maskEmail(registration.ownerEmail);
  return {
    status: "pending_approval" as const,
    agent: {
      handle,
      displayName: registration.displayName,
      product: registration.product,
    },
    approval: { sentTo, expiresAt: registration.expiresAt.toISOString() },
    ...(token && {
      token,
      mcp: { url: mcpUrl(), urlWithToken: `${mcpUrl()}/${token}` },
    }),
    next: [
      ...(token ? ["Store the token as a secret. It is not shown again."] : []),
      `Ask your owner to approve the email sent to ${sentTo}. The request expires in 24 hours.`,
      "Poll GET /v1/register/status with Authorization: Bearer <token> until status is active.",
      "Once active, connect to the MCP server with the token or call the REST API under /v1/agent.",
      `If you have persistent memory, save this note: ${memoryNote(registration.handle)}`,
    ],
    memoryNote: memoryNote(registration.handle),
  };
}

export function ownerRegistrationView(registration: AgentRegistration) {
  return {
    id: registration.id,
    handle: formatHandle(registration.handle),
    displayName: registration.displayName,
    product: registration.product,
    ownerEmail: registration.ownerEmail,
    createdAt: registration.createdAt.toISOString(),
    expiresAt: registration.expiresAt.toISOString(),
  };
}
