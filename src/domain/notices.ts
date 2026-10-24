import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, type Tx } from "../db/client.ts";
import { agents, notices, type Agent, type Notice } from "../db/schema.ts";
import type { DataKey } from "../lib/encryption.ts";
import { uuidv7 } from "../lib/ids.ts";
import { formatHandle } from "./handles.ts";
import { ownerKey } from "./keys.ts";
import { appendLedgerEvent, type RecordedEvent } from "./ledger.ts";
import { notify } from "./notifications.ts";

export type NoticeKind =
  | "plan.shared"
  | "task.assigned"
  | "task.ready"
  | "task.updated"
  | "task.overdue"
  | "follow_up"
  | "handoff";

export type NoticeView = {
  id: string;
  kind: NoticeKind;
  from: string | null;
  planId: string | null;
  task: string | null;
  text: string;
  at: string;
};

const textContext = (id: string) => `notices.text:${id}`;

export type NoticeInput = {
  kind: NoticeKind;
  actor: Agent | null;
  conversationId: string | null;
  planId: string | null;
  taskKey: string | null;
  text: string;
};

// A notice is an inbox item that isn't a message: plan updates and reminders. It lands in the
// recipient's ledger and wakes it up like a message does.
export async function createNotice(
  tx: Tx,
  recipient: Agent,
  input: NoticeInput,
): Promise<RecordedEvent> {
  const id = uuidv7();
  const key = await ownerKey(recipient.ownerId, tx);
  await tx.insert(notices).values({
    id,
    agentId: recipient.id,
    kind: input.kind,
    actorId: input.actor?.id ?? null,
    conversationId: input.conversationId,
    planId: input.planId,
    taskKey: input.taskKey,
    text: key.seal(input.text, textContext(id)),
  });
  await notify(tx, recipient, { kind: "notice", agentId: recipient.id, noticeId: id });
  return appendLedgerEvent(tx, recipient, {
    type: "notice.received",
    actor: input.actor && input.actor.id !== recipient.id ? "peer" : "agent",
    conversationId: input.conversationId,
    data: {
      noticeId: id,
      kind: input.kind,
      ...(input.actor && { from: formatHandle(input.actor.handle) }),
      ...(input.planId && { planId: input.planId }),
      ...(input.taskKey && { task: input.taskKey }),
    },
  });
}

async function views(agent: Agent, rows: Notice[]): Promise<NoticeView[]> {
  if (rows.length === 0) return [];
  const key: DataKey = await ownerKey(agent.ownerId);
  const actorIds = [...new Set(rows.flatMap((row) => (row.actorId ? [row.actorId] : [])))];
  const actors = actorIds.length
    ? await db
        .select({ id: agents.id, handle: agents.handle })
        .from(agents)
        .where(inArray(agents.id, actorIds))
    : [];
  const handles = new Map(actors.map((actor) => [actor.id, formatHandle(actor.handle)]));
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as NoticeKind,
    from: row.actorId ? (handles.get(row.actorId) ?? null) : null,
    planId: row.planId,
    task: row.taskKey,
    text: key.open(row.text, textContext(row.id)) ?? "",
    at: row.createdAt.toISOString(),
  }));
}

// Notices are delivered once through the inbox, like messages.
export async function takeNotices(agent: Agent): Promise<NoticeView[]> {
  const rows = await db
    .update(notices)
    .set({ deliveredAt: new Date() })
    .where(and(eq(notices.agentId, agent.id), isNull(notices.deliveredAt)))
    .returning();
  rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return views(agent, rows);
}

export async function noticesByIds(agent: Agent, ids: string[]): Promise<NoticeView[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .update(notices)
    .set({ deliveredAt: new Date() })
    .where(and(eq(notices.agentId, agent.id), inArray(notices.id, ids)))
    .returning();
  rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return views(agent, rows);
}
