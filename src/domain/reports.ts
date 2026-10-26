import { and, desc, eq, gt, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { uuidv7 } from "../lib/ids.ts";
import { config } from "../config.ts";
import { db, type Tx } from "../db/client.ts";
import {
  agents,
  conversationMembers,
  conversations,
  eventSubscriptions,
  messages,
  owners,
  reports,
  type Agent,
  type Owner,
  type Report,
} from "../db/schema.ts";
import { enqueue } from "../jobs/queue.ts";
import { rateLimit } from "../lib/rate-limit.ts";
import { findAgentByHandle } from "./agents.ts";
import { bodyContext } from "./conversations.ts";
import { AppError } from "./errors.ts";
import { formatGroupName } from "./groups.ts";
import { formatHandle, normalizeHandle } from "./handles.ts";
import { conversationKey, ownerKey } from "./keys.ts";
import { appendLedgerEvent, broadcast, type RecordedEvent } from "./ledger.ts";
import { decideContact } from "./messaging.ts";

export const REPORT_REASONS = ["spam", "scam", "harassment", "impersonation", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export const MAX_REPORT_DETAILS = 1000;

// Reports from this many different owners within a day suspend an agent until an admin looks.
export const AUTO_SUSPEND_REPORTERS = 3;
const AUTO_SUSPEND_WINDOW_MS = 86_400_000;
const EVIDENCE_MESSAGES = 5;
const EVIDENCE_CHARS = 2000;

type Evidence = { at: string; group: string | null; body: string };

const detailsContext = (id: string) => `reports.details:${id}`;
const evidenceContext = (id: string) => `reports.evidence:${id}`;

export function isAdmin(owner: Owner): boolean {
  return config.ADMIN_EMAILS.includes(owner.email.toLowerCase());
}

async function recentMessages(reporter: Agent, reported: Agent): Promise<Evidence[]> {
  const rows = await db
    .select({ message: messages, conversation: conversations })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .innerJoin(
      conversationMembers,
      and(
        eq(conversationMembers.conversationId, messages.conversationId),
        eq(conversationMembers.agentId, reporter.id),
      ),
    )
    .where(eq(messages.senderId, reported.id))
    .orderBy(desc(messages.createdAt))
    .limit(EVIDENCE_MESSAGES);
  return Promise.all(
    rows.map(async ({ message, conversation }) => ({
      at: message.createdAt.toISOString(),
      group: conversation.name ? formatGroupName(conversation.name) : null,
      body: (await conversationKey(conversation))
        .open(message.body, bodyContext(message.id))
        .slice(0, EVIDENCE_CHARS),
    })),
  );
}

export async function reportAgent(
  reporter: Agent,
  input: { handle: string; reason: ReportReason; details?: string | undefined },
  actor: "agent" | "owner",
): Promise<{ reported: string; status: "received" | "already_reported"; blocked: true }> {
  const handle = normalizeHandle(input.handle);
  const reported = await findAgentByHandle(handle);
  if (!reported)
    throw new AppError("not_found", `No agent is registered as ${formatHandle(handle)}.`);
  if (reported.ownerId === reporter.ownerId) {
    throw new AppError("invalid_input", "You can't report your own agents.");
  }
  await rateLimit(`report:${reporter.ownerId}`, 20, 86_400);
  const evidence = await recentMessages(reporter, reported);
  if (evidence.length === 0) {
    throw new AppError(
      "invalid_input",
      `${formatHandle(handle)} hasn't messaged you. You can only report agents that wrote to you; to stop someone in advance, block them with respond_to_request.`,
    );
  }

  const id = uuidv7();
  const key = await ownerKey(reporter.ownerId);
  const details = input.details?.trim() || null;
  const [created] = await db
    .insert(reports)
    .values({
      id,
      agentId: reported.id,
      reporterId: reporter.id,
      reporterOwnerId: reporter.ownerId,
      reason: input.reason,
      details: key.seal(details, detailsContext(id)),
      evidence: key.seal(JSON.stringify(evidence), evidenceContext(id)),
    })
    .onConflictDoNothing()
    .returning();
  await decideContact(reporter, handle, "block", actor);
  if (created) await escalate(reported, created);
  return {
    reported: formatHandle(handle),
    status: created ? "received" : "already_reported",
    blocked: true,
  };
}

async function escalate(reported: Agent, report: Report): Promise<void> {
  const since = new Date(Date.now() - AUTO_SUSPEND_WINDOW_MS);
  const [row] = await db
    .select({ reporters: sql<number>`count(distinct ${reports.reporterOwnerId})::int` })
    .from(reports)
    .where(
      and(
        eq(reports.agentId, reported.id),
        eq(reports.status, "open"),
        gt(reports.createdAt, since),
      ),
    );
  const reporters = row?.reporters ?? 0;
  const suspend = reporters >= AUTO_SUSPEND_REPORTERS && !reported.suspendedAt;
  const suspended = await db.transaction(async (tx) => {
    const suspended = suspend ? await suspendAgent(tx, reported) : null;
    const url = new URL("/dashboard/admin", config.APP_URL).toString();
    for (const email of config.ADMIN_EMAILS) {
      await enqueue(tx, "email.report", {
        email,
        handle: formatHandle(reported.handle),
        reason: report.reason,
        reporters,
        suspended: suspend,
        url,
      });
    }
    return suspended;
  });
  if (suspended) await broadcast([suspended]);
}

async function suspendAgent(tx: Tx, agent: Agent): Promise<RecordedEvent | null> {
  const [updated] = await tx
    .update(agents)
    .set({ suspendedAt: new Date() })
    .where(and(eq(agents.id, agent.id), isNull(agents.suspendedAt)))
    .returning({ id: agents.id });
  if (!updated) return null;
  await tx.delete(eventSubscriptions).where(eq(eventSubscriptions.agentId, agent.id));
  const [owner] = await tx.select().from(owners).where(eq(owners.id, agent.ownerId));
  if (owner) {
    await enqueue(tx, "email.suspended", {
      email: owner.email,
      handle: formatHandle(agent.handle),
    });
  }
  return appendLedgerEvent(tx, agent, { type: "agent.suspended", actor: "system", data: {} });
}

async function unsuspendAgent(tx: Tx, agent: Agent): Promise<RecordedEvent | null> {
  const [updated] = await tx
    .update(agents)
    .set({ suspendedAt: null })
    .where(and(eq(agents.id, agent.id), isNotNull(agents.suspendedAt)))
    .returning({ id: agents.id });
  if (!updated) return null;
  return appendLedgerEvent(tx, agent, { type: "agent.unsuspended", actor: "system", data: {} });
}

export async function setSuspended(rawHandle: string, suspended: boolean): Promise<AdminAgent> {
  const agent = await findAgentByHandle(rawHandle);
  if (!agent)
    throw new AppError("not_found", `No agent is registered as ${formatHandle(rawHandle)}.`);
  const recorded = await db.transaction(async (tx) => {
    const recorded = suspended ? await suspendAgent(tx, agent) : await unsuspendAgent(tx, agent);
    await tx
      .update(reports)
      .set({ status: suspended ? "actioned" : "dismissed", resolvedAt: new Date() })
      .where(and(eq(reports.agentId, agent.id), eq(reports.status, "open")));
    return recorded;
  });
  if (recorded) await broadcast([recorded]);
  const view = (await adminAgents([agent.id])).get(agent.id);
  if (!view) throw new Error("agent disappeared while changing its suspension");
  return view;
}

export async function dismissReport(id: string): Promise<void> {
  const [updated] = await db
    .update(reports)
    .set({ status: "dismissed", resolvedAt: new Date() })
    .where(and(eq(reports.id, id), eq(reports.status, "open")))
    .returning({ id: reports.id });
  if (!updated) throw new AppError("not_found", "No open report with that id.");
}

export type AdminAgent = {
  handle: string;
  displayName: string;
  description: string | null;
  product: string;
  ownerEmail: string;
  createdAt: string;
  suspendedAt: string | null;
  openReports: number;
};

async function adminAgents(ids: string[]): Promise<Map<string, AdminAgent>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      agent: agents,
      ownerEmail: owners.email,
      openReports: sql<number>`(select count(*)::int from ${reports} where ${reports.agentId} = ${agents.id} and ${reports.status} = 'open')`,
    })
    .from(agents)
    .innerJoin(owners, eq(owners.id, agents.ownerId))
    .where(inArray(agents.id, ids));
  return new Map(
    rows.map(({ agent, ownerEmail, openReports }) => [
      agent.id,
      {
        handle: formatHandle(agent.handle),
        displayName: agent.displayName,
        description: agent.description,
        product: agent.product,
        ownerEmail,
        createdAt: agent.createdAt.toISOString(),
        suspendedAt: agent.suspendedAt?.toISOString() ?? null,
        openReports,
      },
    ]),
  );
}

export type AdminReport = {
  id: string;
  status: string;
  reason: string;
  details: string | null;
  evidence: Evidence[];
  createdAt: string;
  resolvedAt: string | null;
  agent: AdminAgent;
  reporter: { handle: string | null; ownerEmail: string };
};

export async function listReports(status: "open" | "closed", limit = 100): Promise<AdminReport[]> {
  const rows = await db
    .select({ report: reports, reporterEmail: owners.email, reporterHandle: agents.handle })
    .from(reports)
    .innerJoin(owners, eq(owners.id, reports.reporterOwnerId))
    .leftJoin(agents, eq(agents.id, reports.reporterId))
    .where(status === "open" ? eq(reports.status, "open") : ne(reports.status, "open"))
    .orderBy(desc(reports.createdAt))
    .limit(limit);
  const reported = await adminAgents([...new Set(rows.map(({ report }) => report.agentId))]);
  return Promise.all(
    rows.map(async ({ report, reporterEmail, reporterHandle }) => {
      const key = await ownerKey(report.reporterOwnerId);
      const agent = reported.get(report.agentId);
      if (!agent) throw new Error("reported agent missing");
      return {
        id: report.id,
        status: report.status,
        reason: report.reason,
        details: key.open(report.details, detailsContext(report.id)),
        evidence: JSON.parse(key.open(report.evidence, evidenceContext(report.id))) as Evidence[],
        createdAt: report.createdAt.toISOString(),
        resolvedAt: report.resolvedAt?.toISOString() ?? null,
        agent,
        reporter: {
          handle: reporterHandle ? formatHandle(reporterHandle) : null,
          ownerEmail: reporterEmail,
        },
      };
    }),
  );
}

export async function listSuspended(): Promise<AdminAgent[]> {
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(sql`${agents.suspendedAt} is not null`)
    .orderBy(desc(agents.suspendedAt));
  const views = await adminAgents(rows.map(({ id }) => id));
  return rows.flatMap(({ id }) => views.get(id) ?? []);
}
