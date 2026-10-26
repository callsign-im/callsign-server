import { and, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db, type Tx } from "../db/client.ts";
import {
  agents,
  conversationMembers,
  conversations,
  messages,
  notices,
  ownerQuestions,
  type Agent,
} from "../db/schema.ts";
import { enqueue, type AgentNotification } from "../jobs/queue.ts";
import { subscribeToOwner } from "../lib/events.ts";
import { bestEffort, redis } from "../lib/redis.ts";
import { assertCredentialLive, WAIT_ENDING_EVENTS } from "./access.ts";
import { bodyContext, mentions } from "./conversations.ts";
import { formatHandle, HELLO_HANDLE, isEmailHandle } from "./handles.ts";
import { conversationKey } from "./keys.ts";
import { ledgerHead, listLedgerAfter, type LedgerEventType } from "./ledger.ts";

export const MESSAGE_EVENTS: LedgerEventType[] = ["message.received", "request.received"];
export const INBOX_EVENTS: LedgerEventType[] = [
  ...MESSAGE_EVENTS,
  "group.invited",
  "owner.answered",
  "notice.received",
];
const INBOX_EVENT_NAMES = new Set<string>(INBOX_EVENTS);
const NOTIFICATION_LIMIT = 100;
const WAIT_POLL_MS = 10_000;
const LISTENING_TTL_SECONDS = 70;

export type NotificationEvent =
  | {
      type: "message.received" | "request.received";
      agent: string;
      from: string;
      group?: string;
      mentioned?: boolean;
      conversationId: string;
      messageId: string;
      sentAt: string;
    }
  | { type: "group.invited"; agent: string; from: string; group: string; conversationId: string }
  | { type: "owner.answered"; agent: string; questionId: string }
  | {
      type: "notice.received";
      agent: string;
      notice: string;
      from: string | null;
      conversationId: string | null;
      planId: string | null;
    };

export type Alert = {
  recipient: Agent;
  event: NotificationEvent;
  subject: string;
  summary: string;
  throttleKey: string;
};

export async function notify(tx: Tx, recipient: Agent, job: AgentNotification): Promise<void> {
  // A frozen agent keeps receiving messages, but nothing wakes it until its owner unfreezes it.
  if (recipient.suspendedAt || recipient.frozenAt) return;
  if (isEmailHandle(recipient.handle)) {
    if (job.kind === "request" || job.kind === "message") await enqueue(tx, "email.bridge", job);
    return;
  }
  if (recipient.handle === HELLO_HANDLE) await enqueue(tx, "hello.reply", job);
  if (recipient.webhookUrl) await enqueue(tx, "agent.webhook", job);
  if (recipient.notifyEmail) await enqueue(tx, "agent.email", job);
  if (recipient.wakeUrl) await enqueue(tx, "agent.wake", job);
  if (recipient.eventsUntil && recipient.eventsUntil.getTime() > Date.now()) {
    await enqueue(tx, "agent.events", job);
  }
}

async function agentById(id: string): Promise<Agent | undefined> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, id));
  return agent;
}

export async function describeNotification(payload: AgentNotification): Promise<Alert | null> {
  const recipient = await agentById(payload.agentId);
  if (!recipient || recipient.frozenAt) return null;
  const to = formatHandle(recipient.handle);

  if (payload.kind === "answer") {
    return {
      recipient,
      event: { type: "owner.answered", agent: to, questionId: payload.questionId },
      subject: `Your owner answered ${to} on Callsign`,
      summary: `The owner of ${to} answered one of its questions.`,
      throttleKey: `notify-email:${recipient.id}:answers`,
    };
  }

  if (payload.kind === "notice") {
    const [row] = await db.select().from(notices).where(eq(notices.id, payload.noticeId));
    if (!row) return null;
    const actor = row.actorId ? await agentById(row.actorId) : undefined;
    return {
      recipient,
      event: {
        type: "notice.received",
        agent: to,
        notice: row.kind,
        from: actor ? formatHandle(actor.handle) : null,
        conversationId: row.conversationId,
        planId: row.planId,
      },
      subject:
        row.kind === "agent.unfrozen"
          ? `${to} was unfrozen on Callsign`
          : `Plan update for ${to} on Callsign`,
      summary:
        row.kind === "follow_up"
          ? `A follow-up ${to} scheduled is due.`
          : row.kind === "agent.unfrozen"
            ? `${to} was unfrozen and can make calls again.`
            : `There's an update in one of ${to}'s plans.`,
      throttleKey: `notify-email:${recipient.id}:notices`,
    };
  }

  const [conversation] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, payload.conversationId));
  if (!conversation) return null;
  const group = conversation.name ? `#${conversation.name}` : null;

  if (payload.kind === "invitation") {
    const inviter = await agentById(payload.fromId);
    if (!inviter || !group) return null;
    const from = formatHandle(inviter.handle);
    return {
      recipient,
      event: { type: "group.invited", agent: to, from, group, conversationId: conversation.id },
      subject: `${from} invited ${to} to ${group} on Callsign`,
      summary: `${from} invited ${to} to the group ${group}.`,
      throttleKey: `notify-email:${recipient.id}:invite:${conversation.id}`,
    };
  }

  const [row] = await db
    .select({ message: messages, sender: agents })
    .from(messages)
    .innerJoin(agents, eq(agents.id, messages.senderId))
    .where(and(eq(messages.conversationId, conversation.id), eq(messages.seq, payload.seq)));
  if (!row) return null;
  const from = formatHandle(row.sender.handle);
  const mentioned =
    group !== null &&
    mentions(
      (await conversationKey(conversation)).open(row.message.body, bodyContext(row.message.id)),
      recipient.handle,
    );
  return {
    recipient,
    event: {
      type: payload.kind === "request" ? "request.received" : "message.received",
      agent: to,
      from,
      ...(group && { group, mentioned }),
      conversationId: conversation.id,
      messageId: row.message.id,
      sentAt: row.message.createdAt.toISOString(),
    },
    subject: group
      ? `${from} wrote in ${group} on Callsign`
      : `${from} sent a message to ${to} on Callsign`,
    summary: group ? `${from} wrote in ${group}.` : `${from} sent a message to ${to}.`,
    throttleKey: `notify-email:${recipient.id}:${conversation.id}`,
  };
}

// One line an agent can act on, without any message content.
const NOTICE_TEXT: Record<string, (agent: string, from: string) => string> = {
  "plan.shared": (agent, from) => `${from} shared a plan with ${agent}.`,
  "task.assigned": (agent, from) => `${from} gave ${agent} a task in a plan.`,
  "task.ready": (agent) => `A task assigned to ${agent} is ready to start.`,
  "task.updated": (agent, from) => `${from} updated a task in a plan ${agent} is part of.`,
  "task.overdue": (agent) => `A task in one of ${agent}'s plans is overdue.`,
  follow_up: (agent) => `A follow-up ${agent} scheduled is due.`,
  handoff: (agent, from) => `${from} left a handoff on a plan ${agent} is part of.`,
  "agent.unfrozen": (agent) => `${agent}'s owner unfroze it.`,
  "action.approved": (agent) => `${agent}'s owner approved an action it was holding.`,
  "action.denied": (agent) => `${agent}'s owner declined an action it was holding.`,
  "action.expired": (agent) => `An action ${agent} was holding for approval expired.`,
  "action.failed": (agent) => `An action ${agent}'s owner approved couldn't be completed.`,
  "tools.shared": (agent, from) => `${from} shared tools with a group ${agent} is in.`,
};

export function describeEvent(event: NotificationEvent): string {
  switch (event.type) {
    case "notice.received":
      return (NOTICE_TEXT[event.notice] ?? NOTICE_TEXT["task.updated"]!)(
        event.agent,
        event.from ?? "Another agent",
      );
    case "owner.answered":
      return `Your owner answered one of ${event.agent}'s questions.`;
    case "group.invited":
      return `${event.from} invited ${event.agent} to the group ${event.group}.`;
    case "request.received":
      return `${event.from} sent ${event.agent} a message request.`;
    case "message.received":
      if (!event.group) return `${event.from} sent ${event.agent} a message.`;
      return event.mentioned
        ? `${event.from} mentioned ${event.agent} in ${event.group}.`
        : `${event.from} wrote in ${event.group}.`;
  }
}

const listeningKey = (agentId: string) => `listening:${agentId}`;

// Counts open waits (wait_for_reply, listeners) so wake-ups skip agents that are already listening.
export async function trackListening(agentId: string): Promise<() => Promise<void>> {
  const key = listeningKey(agentId);
  await bestEffort(() => redis.multi().incr(key).expire(key, LISTENING_TTL_SECONDS).exec(), null);
  return async () => {
    await bestEffort(() => redis.decr(key), 0);
  };
}

const listenerKey = (agentId: string) => `listener:${agentId}`;
const LISTENER_TTL_SECONDS = 3600;

export async function hasListener(agentId: string): Promise<boolean> {
  return (await bestEffort(() => redis.exists(listenerKey(agentId)), 0)) > 0;
}

export async function isListening(agentId: string): Promise<boolean> {
  return Number(await bestEffort(() => redis.get(listeningKey(agentId)), null)) > 0;
}

export async function unreadCount(agentId: string): Promise<number> {
  const [threads] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .where(
      and(
        eq(conversationMembers.agentId, agentId),
        or(
          and(
            inArray(conversationMembers.status, ["active", "pending"]),
            gt(conversations.lastSeq, conversationMembers.lastReadSeq),
            sql`exists (
              select 1 from ${messages}
              where ${messages.conversationId} = ${conversations.id}
                and ${messages.seq} > greatest(${conversationMembers.lastReadSeq}, ${conversationMembers.joinedSeq})
                and ${messages.senderId} <> ${agentId}
            )`,
          ),
          and(
            isNotNull(conversationMembers.invitedBy),
            isNull(conversationMembers.notifiedAt),
            inArray(conversationMembers.status, ["active", "invited"]),
          ),
        ),
      ),
    );
  const [answers] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(ownerQuestions)
    .where(
      and(
        eq(ownerQuestions.agentId, agentId),
        isNotNull(ownerQuestions.answeredAt),
        isNull(ownerQuestions.deliveredAt),
      ),
    );
  const [pending] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notices)
    .where(and(eq(notices.agentId, agentId), isNull(notices.deliveredAt)));
  return (threads?.count ?? 0) + (answers?.count ?? 0) + (pending?.count ?? 0);
}

export type InboxNotification = {
  seq: number;
  type: LedgerEventType;
  notice: string | null;
  from: string | null;
  group: string | null;
  mentioned: boolean;
  conversationId: string | null;
  at: string;
};

export type NotificationFeed = {
  notifications: InboxNotification[];
  cursor: number;
  unread: number;
};

async function mentionedIn(agent: Agent, messageIds: string[]): Promise<Set<string>> {
  if (messageIds.length === 0) return new Set();
  const rows = await db
    .select({ message: messages, conversation: conversations })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(inArray(messages.id, messageIds));
  const found = new Set<string>();
  for (const { message, conversation } of rows) {
    const key = await conversationKey(conversation);
    if (mentions(key.open(message.body, bodyContext(message.id)), agent.handle)) {
      found.add(message.id);
    }
  }
  return found;
}

// What arrived after a ledger cursor, without marking anything read: listeners use it to
// decide when to start the agent, and the agent then reads its inbox as usual.
export async function listNotifications(
  agent: Agent,
  after: number | undefined,
): Promise<NotificationFeed> {
  const head = await ledgerHead(agent.id);
  const unread = await unreadCount(agent.id);
  if (after === undefined || after >= head) {
    return { notifications: [], cursor: Math.max(head, after ?? 0), unread };
  }
  const events = await listLedgerAfter(agent, {
    after,
    upTo: head,
    types: INBOX_EVENTS,
    limit: NOTIFICATION_LIMIT + 1,
  });
  const window = events.slice(0, NOTIFICATION_LIMIT);
  const groupMessages = window
    .filter((event) => MESSAGE_EVENTS.includes(event.type as LedgerEventType) && event.data.group)
    .map((event) => String(event.data.messageId));
  const mentioned = await mentionedIn(agent, groupMessages);
  return {
    notifications: window.map((event) => ({
      seq: event.seq,
      type: event.type as LedgerEventType,
      notice: typeof event.data.kind === "string" ? event.data.kind : null,
      from:
        typeof event.data.from === "string"
          ? event.data.from
          : typeof event.data.by === "string"
            ? event.data.by
            : null,
      group: typeof event.data.group === "string" ? event.data.group : null,
      mentioned: mentioned.has(String(event.data.messageId)),
      conversationId: event.conversationId,
      at: event.createdAt.toISOString(),
    })),
    cursor: events.length > NOTIFICATION_LIMIT ? (window.at(-1)?.seq ?? after) : head,
    unread,
  };
}

export async function waitForNotifications(
  agent: Agent,
  after: number | undefined,
  seconds: number,
  options: { signal?: AbortSignal | undefined; tokenId?: string | undefined } = {},
): Promise<NotificationFeed> {
  const { signal, tokenId } = options;
  const deadline = Date.now() + seconds * 1000;
  const handle = formatHandle(agent.handle);
  let wakes = 0;
  let wake = () => {};
  const unsubscribe = subscribeToOwner(agent.ownerId, (event) => {
    if (event.type !== "ledger") return;
    const type = event.event.type;
    if (event.agent !== handle || typeof type !== "string") return;
    if (!INBOX_EVENT_NAMES.has(type) && !WAIT_ENDING_EVENTS.has(type)) return;
    wakes += 1;
    wake();
  });
  const abort = () => wake();
  signal?.addEventListener("abort", abort);
  const release = await trackListening(agent.id);
  await bestEffort(() => redis.set(listenerKey(agent.id), "1", "EX", LISTENER_TTL_SECONDS), null);

  try {
    let cursor = after;
    for (let round = 0; ; round += 1) {
      if (round > 0) await assertCredentialLive(agent.id, tokenId);
      const seen = wakes;
      const feed = await listNotifications(agent, cursor);
      cursor ??= feed.cursor;
      const remaining = deadline - Date.now();
      if (feed.notifications.length > 0 || remaining <= 0 || signal?.aborted) return feed;
      if (wakes !== seen) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(remaining, WAIT_POLL_MS));
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    unsubscribe();
    await release();
  }
}
