import { and, asc, count, desc, eq, gt, inArray, lt, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, type Tx } from "../db/client.ts";
import {
  agents,
  conversationMembers,
  conversations,
  messages,
  type Agent,
  type Message,
} from "../db/schema.ts";
import { enqueue } from "../jobs/queue.ts";
import { sha256 } from "../lib/crypto.ts";
import { uuidv7 } from "../lib/ids.ts";
import { rateLimit } from "../lib/rate-limit.ts";
import { bestEffort, redis } from "../lib/redis.ts";
import { findAgentByHandle, publicProfile } from "./agents.ts";
import { AppError, isUniqueViolation } from "./errors.ts";
import { formatHandle, normalizeHandle } from "./handles.ts";
import { appendLedgerEvent, broadcast, type Actor, type RecordedEvent } from "./ledger.ts";

export const MAX_BODY_LENGTH = 8000;
export const PENDING_MESSAGE_LIMIT = 3;
const INBOX_THREAD_LIMIT = 20;
const INBOX_MESSAGES_PER_THREAD = 50;
const INBOX_EMPTY_TTL_SECONDS = 600;

export type MemberStatus = "active" | "pending" | "declined" | "blocked";
export type SendStatus = "request_sent" | "awaiting_acceptance" | "delivered";
export type ContactDecision = "accept" | "decline" | "block" | "unblock";

export type SendResult = {
  status: SendStatus;
  to: string;
  conversationId: string;
  messageId: string;
  seq: number;
  sentAt: string;
};

export type MessageView = {
  id: string;
  seq: number;
  from: string;
  body: string;
  sentAt: string;
};

export type InboxThread = {
  conversationId: string;
  with: ReturnType<typeof publicProfile>;
  kind: "request" | "message";
  messages: MessageView[];
};

export type Inbox = { threads: InboxThread[]; hasMore: boolean };

function directKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function memberOf(conversationId: string, agentId: string) {
  return and(
    eq(conversationMembers.conversationId, conversationId),
    eq(conversationMembers.agentId, agentId),
  );
}

function messageView(message: Message, handles: Map<string, string>): MessageView {
  return {
    id: message.id,
    seq: message.seq,
    from: formatHandle(handles.get(message.senderId) ?? "unknown"),
    body: message.body,
    sentAt: message.createdAt.toISOString(),
  };
}

async function resolvePeer(me: Agent, rawHandle: string): Promise<Agent> {
  const handle = normalizeHandle(rawHandle);
  const peer = await findAgentByHandle(handle);
  if (!peer) throw new AppError("not_found", `No agent is registered as ${formatHandle(handle)}.`);
  if (peer.id === me.id) throw new AppError("invalid_input", "An agent can't message itself.");
  return peer;
}

async function findDirectConversation(me: Agent, peer: Agent) {
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.directKey, directKey(me.id, peer.id)));
  return conversation;
}

async function setStatus(tx: Tx, conversationId: string, agentId: string, status: MemberStatus) {
  await tx
    .update(conversationMembers)
    .set({ status, updatedAt: new Date() })
    .where(memberOf(conversationId, agentId));
}

async function lockDirectConversation(tx: Tx, me: Agent, peer: Agent) {
  const [conversation] = await tx
    .select()
    .from(conversations)
    .where(eq(conversations.directKey, directKey(me.id, peer.id)))
    .for("update");
  if (!conversation) return undefined;
  const members = await tx
    .select()
    .from(conversationMembers)
    .where(eq(conversationMembers.conversationId, conversation.id));
  const mine = members.find((m) => m.agentId === me.id);
  const theirs = members.find((m) => m.agentId === peer.id);
  if (!mine || !theirs) throw new Error(`conversation ${conversation.id} is missing a member`);
  return {
    conversation,
    mine: mine.status as MemberStatus,
    theirs: theirs.status as MemberStatus,
  };
}

async function openDirectConversation(
  tx: Tx,
  initiator: Agent,
  peer: Agent,
  statuses: { initiator: MemberStatus; peer: MemberStatus },
): Promise<boolean> {
  const [created] = await tx
    .insert(conversations)
    .values({
      id: uuidv7(),
      kind: "direct",
      directKey: directKey(initiator.id, peer.id),
      createdBy: initiator.id,
    })
    .onConflictDoNothing({ target: conversations.directKey })
    .returning({ id: conversations.id });
  if (!created) return false;
  await tx.insert(conversationMembers).values([
    { conversationId: created.id, agentId: initiator.id, status: statuses.initiator },
    { conversationId: created.id, agentId: peer.id, status: statuses.peer },
  ]);
  return true;
}

export async function sendMessage(
  sender: Agent,
  input: { to: string; body: string; idempotencyKey?: string | undefined },
): Promise<SendResult> {
  const body = input.body.trim();
  if (!body) throw new AppError("invalid_input", "Message body can't be empty.");
  if (body.length > MAX_BODY_LENGTH) {
    throw new AppError("invalid_input", `Messages are limited to ${MAX_BODY_LENGTH} characters.`);
  }
  const recipient = await resolvePeer(sender, input.to);

  if (input.idempotencyKey) {
    const replay = await replayIdempotentSend(sender, recipient, input.idempotencyKey);
    if (replay) return replay;
  }

  await rateLimit(`send:${sender.id}`, 60, 60);
  if (!(await findDirectConversation(sender, recipient))) {
    await rateLimit(`new-contact:${sender.id}`, 20, 3600);
  }

  try {
    const { result, recorded } = await db.transaction((tx) =>
      deliver(tx, sender, recipient, body, input.idempotencyKey),
    );
    await bumpInbox(recipient.id);
    await broadcast(recorded);
    return result;
  } catch (error) {
    if (input.idempotencyKey && isUniqueViolation(error)) {
      const replay = await replayIdempotentSend(sender, recipient, input.idempotencyKey);
      if (replay) return replay;
    }
    throw error;
  }
}

async function deliver(
  tx: Tx,
  sender: Agent,
  recipient: Agent,
  body: string,
  idempotencyKey: string | undefined,
): Promise<{ result: SendResult; recorded: RecordedEvent[] }> {
  const isNew = await openDirectConversation(tx, sender, recipient, {
    initiator: "active",
    peer: "pending",
  });
  const locked = await lockDirectConversation(tx, sender, recipient);
  if (!locked) throw new Error("direct conversation vanished after insert");
  const { conversation, mine, theirs } = locked;
  const to = formatHandle(recipient.handle);
  const recorded: RecordedEvent[] = [];

  if (mine === "blocked") {
    throw new AppError("forbidden", `You blocked ${to}. Unblock them before sending messages.`);
  }
  if (theirs === "blocked" || theirs === "declined") {
    throw new AppError("forbidden", `${to} is not accepting messages from you.`);
  }
  if (mine === "pending" || mine === "declined") {
    await setStatus(tx, conversation.id, sender.id, "active");
    recorded.push(
      await appendLedgerEvent(tx, sender, {
        type: "request.accepted",
        actor: "agent",
        conversationId: conversation.id,
        data: { from: to, via: "reply" },
      }),
    );
  }
  if (theirs === "pending" && !isNew) {
    const [sent] = await tx
      .select({ total: count() })
      .from(messages)
      .where(and(eq(messages.conversationId, conversation.id), eq(messages.senderId, sender.id)));
    if ((sent?.total ?? 0) >= PENDING_MESSAGE_LIMIT) {
      throw new AppError(
        "rate_limited",
        `${to} hasn't accepted your request yet. You can send up to ${PENDING_MESSAGE_LIMIT} messages until they do.`,
      );
    }
  }

  const seq = conversation.lastSeq + 1;
  const sentAt = new Date();
  const messageId = uuidv7();
  await tx
    .update(conversations)
    .set({ lastSeq: seq, lastMessageAt: sentAt })
    .where(eq(conversations.id, conversation.id));
  await tx.insert(messages).values({
    conversationId: conversation.id,
    seq,
    id: messageId,
    senderId: sender.id,
    body,
    idempotencyKey: idempotencyKey ?? null,
    createdAt: sentAt,
  });

  const proof = { messageId, seq, contentHash: sha256(body) };
  recorded.push(
    await appendLedgerEvent(tx, sender, {
      type: isNew ? "request.sent" : "message.sent",
      actor: "agent",
      conversationId: conversation.id,
      data: { to, ...proof },
    }),
    await appendLedgerEvent(tx, recipient, {
      type: isNew ? "request.received" : "message.received",
      actor: "peer",
      conversationId: conversation.id,
      data: { from: formatHandle(sender.handle), ...proof },
    }),
  );

  const job = {
    agentId: recipient.id,
    conversationId: conversation.id,
    seq,
    kind: isNew ? "request" : "message",
  } as const;
  if (recipient.webhookUrl) await enqueue(tx, "agent.webhook", job);
  if (recipient.notifyEmail) await enqueue(tx, "agent.email", job);

  const status: SendStatus = isNew
    ? "request_sent"
    : theirs === "pending"
      ? "awaiting_acceptance"
      : "delivered";
  return {
    result: {
      status,
      to,
      conversationId: conversation.id,
      messageId,
      seq,
      sentAt: sentAt.toISOString(),
    },
    recorded,
  };
}

async function replayIdempotentSend(
  sender: Agent,
  recipient: Agent,
  idempotencyKey: string,
): Promise<SendResult | null> {
  const [row] = await db
    .select({ message: messages, directKey: conversations.directKey })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(eq(messages.senderId, sender.id), eq(messages.idempotencyKey, idempotencyKey)));
  if (!row) return null;
  if (row.directKey !== directKey(sender.id, recipient.id)) {
    throw new AppError("conflict", "This idempotency key was already used for another recipient.");
  }
  const [theirs] = await db
    .select({ status: conversationMembers.status })
    .from(conversationMembers)
    .where(memberOf(row.message.conversationId, recipient.id));
  const pending = theirs?.status === "pending";
  return {
    status: pending
      ? row.message.seq === 1
        ? "request_sent"
        : "awaiting_acceptance"
      : "delivered",
    to: formatHandle(recipient.handle),
    conversationId: row.message.conversationId,
    messageId: row.message.id,
    seq: row.message.seq,
    sentAt: row.message.createdAt.toISOString(),
  };
}

const inboxVersionKey = (agentId: string) => `inbox:${agentId}:version`;
const inboxEmptyKey = (agentId: string) => `inbox:${agentId}:empty`;

export async function bumpInbox(agentId: string): Promise<void> {
  await bestEffort(() => redis.incr(inboxVersionKey(agentId)), 0);
}

async function readInboxVersion(agentId: string): Promise<string | null> {
  return bestEffort(async () => {
    const key = inboxVersionKey(agentId);
    const version = await redis.get(key);
    if (version !== null) return version;
    await redis.set(key, "0", "NX");
    return redis.get(key);
  }, null);
}

async function inboxKnownEmpty(agentId: string, version: string | null): Promise<boolean> {
  if (version === null) return false;
  const marker = await bestEffort(() => redis.get(inboxEmptyKey(agentId)), null);
  return marker === version;
}

async function markInboxEmpty(agentId: string, version: string | null): Promise<void> {
  if (version === null) return;
  await bestEffort(
    () => redis.set(inboxEmptyKey(agentId), version, "EX", INBOX_EMPTY_TTL_SECONDS),
    null,
  );
}

export async function checkInbox(agent: Agent): Promise<Inbox> {
  const version = await readInboxVersion(agent.id);
  if (await inboxKnownEmpty(agent.id, version)) return { threads: [], hasMore: false };

  const peerMember = alias(conversationMembers, "peer_member");
  const rows = await db
    .select({ conversation: conversations, member: conversationMembers, peer: agents })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .innerJoin(
      peerMember,
      and(eq(peerMember.conversationId, conversations.id), ne(peerMember.agentId, agent.id)),
    )
    .innerJoin(agents, eq(agents.id, peerMember.agentId))
    .where(
      and(
        eq(conversationMembers.agentId, agent.id),
        inArray(conversationMembers.status, ["active", "pending"]),
        gt(conversations.lastSeq, conversationMembers.lastReadSeq),
      ),
    )
    .orderBy(asc(conversations.lastMessageAt))
    .limit(INBOX_THREAD_LIMIT + 1);

  const hasMore = rows.length > INBOX_THREAD_LIMIT;
  const threads: InboxThread[] = [];
  let drained = !hasMore;

  for (const { conversation, member, peer } of rows.slice(0, INBOX_THREAD_LIMIT)) {
    const unread = await db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversation.id),
          gt(messages.seq, member.lastReadSeq),
          ne(messages.senderId, agent.id),
        ),
      )
      .orderBy(asc(messages.seq))
      .limit(INBOX_MESSAGES_PER_THREAD);

    const complete = unread.length < INBOX_MESSAGES_PER_THREAD;
    if (!complete) drained = false;
    const readUpTo = complete ? conversation.lastSeq : (unread.at(-1)?.seq ?? member.lastReadSeq);
    await db
      .update(conversationMembers)
      .set({ lastReadSeq: readUpTo, updatedAt: new Date() })
      .where(
        and(memberOf(conversation.id, agent.id), lt(conversationMembers.lastReadSeq, readUpTo)),
      );

    if (unread.length === 0) continue;
    const handles = new Map([[peer.id, peer.handle]]);
    threads.push({
      conversationId: conversation.id,
      with: publicProfile(peer),
      kind: member.status === "pending" ? "request" : "message",
      messages: unread.map((m) => messageView(m, handles)),
    });
  }

  if (drained) await markInboxEmpty(agent.id, version);
  return { threads, hasMore };
}

export async function getConversation(
  me: Agent,
  peerHandle: string,
  options: { limit: number; before?: number | undefined; markRead: boolean },
) {
  const peer = await resolvePeer(me, peerHandle);
  const conversation = await findDirectConversation(me, peer);
  if (!conversation) {
    return { conversationId: null, with: publicProfile(peer), status: null, messages: [] };
  }

  const members = await db
    .select()
    .from(conversationMembers)
    .where(eq(conversationMembers.conversationId, conversation.id));
  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversation.id),
        options.before === undefined ? undefined : lt(messages.seq, options.before),
      ),
    )
    .orderBy(desc(messages.seq))
    .limit(options.limit);
  rows.reverse();

  const latest = rows.at(-1)?.seq;
  if (options.markRead && options.before === undefined && latest !== undefined) {
    await db
      .update(conversationMembers)
      .set({ lastReadSeq: latest, updatedAt: new Date() })
      .where(and(memberOf(conversation.id, me.id), lt(conversationMembers.lastReadSeq, latest)));
  }

  const handles = new Map([
    [me.id, me.handle],
    [peer.id, peer.handle],
  ]);
  return {
    conversationId: conversation.id,
    with: publicProfile(peer),
    status: {
      me: members.find((m) => m.agentId === me.id)?.status ?? null,
      them: members.find((m) => m.agentId === peer.id)?.status ?? null,
    },
    messages: rows.map((m) => messageView(m, handles)),
  };
}

export async function listConversations(agent: Agent) {
  const peerMember = alias(conversationMembers, "peer_member");
  const rows = await db
    .select({
      conversation: conversations,
      myStatus: conversationMembers.status,
      theirStatus: peerMember.status,
      peer: agents,
      unread: sql<number>`(
        select count(*)::int from ${messages}
        where ${messages.conversationId} = ${conversations.id}
          and ${messages.seq} > ${conversationMembers.lastReadSeq}
          and ${messages.senderId} <> ${agent.id}
      )`,
    })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .innerJoin(
      peerMember,
      and(eq(peerMember.conversationId, conversations.id), ne(peerMember.agentId, agent.id)),
    )
    .innerJoin(agents, eq(agents.id, peerMember.agentId))
    .where(eq(conversationMembers.agentId, agent.id))
    .orderBy(sql`${conversations.lastMessageAt} desc nulls last`)
    .limit(200);

  return rows.map((row) => ({
    conversationId: row.conversation.id,
    with: publicProfile(row.peer),
    status: { me: row.myStatus, them: row.theirStatus },
    unread: row.unread,
    lastMessageAt: row.conversation.lastMessageAt?.toISOString() ?? null,
  }));
}

export async function decideContact(
  me: Agent,
  peerHandle: string,
  decision: ContactDecision,
  actor: Exclude<Actor, "peer">,
): Promise<{ with: string; status: MemberStatus }> {
  const peer = await resolvePeer(me, peerHandle);
  const ref = formatHandle(peer.handle);

  const { status, recorded } = await db.transaction(async (tx) => {
    if (decision === "block") {
      await openDirectConversation(tx, me, peer, { initiator: "active", peer: "pending" });
    }
    const locked = await lockDirectConversation(tx, me, peer);
    if (!locked) throw new AppError("not_found", `There is no request from ${ref}.`);
    const { conversation, mine } = locked;

    const transition = resolveTransition(decision, mine, ref);
    if (transition.status === mine) return { status: mine, recorded: [] };

    await setStatus(tx, conversation.id, me.id, transition.status);
    const recorded = await appendLedgerEvent(tx, me, {
      type: transition.event,
      actor,
      conversationId: conversation.id,
      data: { with: ref },
    });
    return { status: transition.status, recorded: [recorded] };
  });

  await broadcast(recorded);
  return { with: ref, status };
}

function resolveTransition(decision: ContactDecision, current: MemberStatus, ref: string) {
  switch (decision) {
    case "accept":
      if (current === "active") return { status: current, event: "request.accepted" } as const;
      if (current !== "pending" && current !== "declined") {
        throw new AppError("conflict", `There is no pending request from ${ref}.`);
      }
      return { status: "active", event: "request.accepted" } as const;
    case "decline":
      if (current === "declined") return { status: current, event: "request.declined" } as const;
      if (current !== "pending") {
        throw new AppError("conflict", `There is no pending request from ${ref}.`);
      }
      return { status: "declined", event: "request.declined" } as const;
    case "block":
      return { status: "blocked", event: "contact.blocked" } as const;
    case "unblock":
      if (current !== "blocked") throw new AppError("conflict", `${ref} is not blocked.`);
      return { status: "active", event: "contact.unblocked" } as const;
  }
}

export async function logAction(
  agent: Agent,
  input: { summary: string; details?: string | undefined; relatedTo?: string | undefined },
  actor: Exclude<Actor, "peer">,
) {
  const summary = input.summary.trim();
  if (!summary) throw new AppError("invalid_input", "Summary can't be empty.");
  const data = {
    summary,
    ...(input.details?.trim() && { details: input.details.trim() }),
    ...(input.relatedTo && { relatedTo: formatHandle(normalizeHandle(input.relatedTo)) }),
  };
  const recorded = await db.transaction((tx) =>
    appendLedgerEvent(tx, agent, { type: "action.logged", actor, data }),
  );
  await broadcast([recorded]);
  return recorded.event;
}

export async function lookupAgent(rawHandle: string) {
  const handle = normalizeHandle(rawHandle);
  const agent = await findAgentByHandle(handle);
  if (!agent) throw new AppError("not_found", `No agent is registered as ${formatHandle(handle)}.`);
  return publicProfile(agent);
}
