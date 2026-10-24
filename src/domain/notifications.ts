import { and, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db, type Tx } from "../db/client.ts";
import {
  agents,
  conversationMembers,
  conversations,
  messages,
  ownerQuestions,
  type Agent,
} from "../db/schema.ts";
import { enqueue, type AgentNotification } from "../jobs/queue.ts";
import { subscribeToOwner } from "../lib/events.ts";
import { bestEffort, redis } from "../lib/redis.ts";
import { bodyContext, mentions } from "./conversations.ts";
import { formatHandle } from "./handles.ts";
import { conversationKey } from "./keys.ts";
import { ledgerHead, listLedgerAfter, type LedgerEventType } from "./ledger.ts";

export const MESSAGE_EVENTS: LedgerEventType[] = ["message.received", "request.received"];
export const INBOX_EVENTS: LedgerEventType[] = [
  ...MESSAGE_EVENTS,
  "group.invited",
  "owner.answered",
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
  | { type: "owner.answered"; agent: string; questionId: string };

export type Notice = {
  recipient: Agent;
  event: NotificationEvent;
  subject: string;
  summary: string;
  throttleKey: string;
};

export async function notify(tx: Tx, recipient: Agent, job: AgentNotification): Promise<void> {
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

export async function describeNotification(payload: AgentNotification): Promise<Notice | null> {
  const recipient = await agentById(payload.agentId);
  if (!recipient) return null;
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
export function describeEvent(event: NotificationEvent): string {
  switch (event.type) {
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
  return (threads?.count ?? 0) + (answers?.count ?? 0);
}

export type InboxNotification = {
  seq: number;
  type: LedgerEventType;
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
  signal?: AbortSignal,
): Promise<NotificationFeed> {
  const deadline = Date.now() + seconds * 1000;
  const handle = formatHandle(agent.handle);
  let wakes = 0;
  let wake = () => {};
  const unsubscribe = subscribeToOwner(agent.ownerId, (event) => {
    const type = event.event.type;
    if (event.agent !== handle || typeof type !== "string" || !INBOX_EVENT_NAMES.has(type)) return;
    wakes += 1;
    wake();
  });
  const abort = () => wake();
  signal?.addEventListener("abort", abort);
  const release = await trackListening(agent.id);

  try {
    let cursor = after;
    for (;;) {
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
