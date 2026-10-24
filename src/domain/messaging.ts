import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { db, type Executor, type Tx } from "../db/client.ts";
import {
  agentTokens,
  agents,
  conversationMembers,
  conversations,
  invitations,
  messages,
  type Agent,
  type Conversation,
  type ConversationMember,
  type Message,
} from "../db/schema.ts";
import { subscribeToOwner } from "../lib/events.ts";
import { uuidv7 } from "../lib/ids.ts";
import { rateLimit } from "../lib/rate-limit.ts";
import { agentRules, assertReachable, findAgentByHandle, publicProfile } from "./agents.ts";
import { contactsByAgent, type ContactRecord } from "./contacts.ts";
import {
  bodyContext,
  bumpInbox,
  cleanBody,
  directKey,
  inboxKnownEmpty,
  likelyActive,
  markInboxEmpty,
  markRead,
  mentions,
  memberOf,
  messageViews,
  peerProfiles,
  readInboxVersion,
  type MessageView,
  type PeerProfile,
  type ReadReceipt,
} from "./conversations.ts";
import { emailRecipient } from "./email-bridge.ts";
import { AppError, isUniqueViolation } from "./errors.ts";
import { attachFiles } from "./files.ts";
import {
  formatGroupName,
  getGroupConversation,
  groupView,
  isGroupRef,
  respondToGroupInvite,
  sendGroupMessage,
  type GroupView,
} from "./groups.ts";
import { formatHandle, isEmailHandle, normalizeHandle } from "./handles.ts";
import { signalsFor } from "./identity.ts";
import { conversationKey, newConversationKey } from "./keys.ts";
import {
  appendLedgerEvent,
  broadcast,
  ledgerHead,
  listLedgerAfter,
  type Actor,
  type LedgerEventType,
  type RecordedEvent,
} from "./ledger.ts";
import { INBOX_EVENTS, MESSAGE_EVENTS, notify, trackListening } from "./notifications.ts";
import { noticesByIds, takeNotices, type NoticeView } from "./notices.ts";
import { answersByIds, takeAnswers, type OwnerAnswer } from "./questions.ts";

export {
  bumpInbox,
  forgetInbox,
  MAX_BODY_LENGTH,
  UNTRUSTED_NOTICE,
  type MessageView,
  type PeerProfile,
} from "./conversations.ts";

export const PENDING_MESSAGE_LIMIT = 3;
const INBOX_THREAD_LIMIT = 20;
const INBOX_MESSAGES_PER_THREAD = 50;
const INBOX_REPLAY_LIMIT = 200;
// Stays under the 60-second request timeout most MCP clients apply.
export const MAX_WAIT_SECONDS = 50;
const WAIT_POLL_MS = 10_000;
const WAKING_EVENTS = new Set<string>(INBOX_EVENTS);

export type MemberStatus = "active" | "pending" | "declined" | "blocked";
export type Acceptance = "pending" | "accepted" | "declined" | "blocked";
export type SendStatus = "request_sent" | "awaiting_acceptance" | "delivered";
export type ContactDecision = "accept" | "decline" | "block" | "unblock";

export type SendResult = {
  status: SendStatus;
  to: string;
  recipientActive: boolean;
  conversationId: string;
  messageId: string;
  seq: number;
  sentAt: string;
};

export type ContactContext = { name: string; notes: string | null; rules: string | null } | null;

export type InboxThread = {
  conversationId: string;
  kind: "request" | "message" | "invitation";
  with: PeerProfile | null;
  group: GroupView | null;
  sameOwner: boolean;
  contact: ContactContext;
  mentioned: boolean;
  messages: MessageView[];
};

export type Inbox = {
  threads: InboxThread[];
  ownerAnswers: OwnerAnswer[];
  notices: NoticeView[];
  hasMore: boolean;
  rules: string | null;
  cursor: number;
};

export type ConversationSummary = {
  conversationId: string;
  kind: "direct" | "group";
  unread: number;
  lastMessageAt: string | null;
  myAcceptance: Acceptance | null;
  theirAcceptance: Acceptance | null;
  with: ReturnType<typeof publicProfile> | null;
  group: { name: string; status: string; role: string; members: string[] } | null;
  contact: string | null;
};

type ConversationDraft = { id: string; dataKey: string };

type FoundThread = {
  conversation: Conversation;
  member: ConversationMember;
  members: ConversationMember[];
  unread: Message[];
  invitation: boolean;
};

function contactContext(contact: ContactRecord | undefined): ContactContext {
  return contact ? { name: contact.name, notes: contact.notes, rules: contact.rules } : null;
}

function sameOwner(a: Agent, b: Agent): boolean {
  return a.ownerId === b.ownerId;
}

export function acceptance(status: string | null | undefined): Acceptance | null {
  if (!status) return null;
  if (status === "active") return "accepted";
  if (status === "invited") return "pending";
  if (status === "left" || status === "removed") return "declined";
  return status as Acceptance;
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

// Owners connected by an accepted invitation skip message requests, like agents of one owner.
async function linkedByInvitation(executor: Executor, a: Agent, b: Agent): Promise<boolean> {
  const [link] = await executor
    .select({ id: invitations.id })
    .from(invitations)
    .where(
      or(
        and(eq(invitations.inviterId, a.id), eq(invitations.acceptedOwnerId, b.ownerId)),
        and(eq(invitations.inviterId, b.id), eq(invitations.acceptedOwnerId, a.ownerId)),
      ),
    )
    .limit(1);
  return link !== undefined;
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

async function draftConversation(): Promise<ConversationDraft> {
  const id = uuidv7();
  return { id, dataKey: await newConversationKey(id) };
}

async function openDirectConversation(
  tx: Tx,
  draft: ConversationDraft,
  initiator: Agent,
  peer: Agent,
  statuses: { initiator: MemberStatus; peer: MemberStatus },
): Promise<boolean> {
  const [created] = await tx
    .insert(conversations)
    .values({
      id: draft.id,
      kind: "direct",
      directKey: directKey(initiator.id, peer.id),
      createdBy: initiator.id,
      dataKey: draft.dataKey,
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
  input: {
    to: string;
    body: string;
    idempotencyKey?: string | undefined;
    attachments?: string[] | undefined;
  },
): Promise<SendResult> {
  if (isGroupRef(input.to)) return sendGroupMessage(sender, input.to, input);
  const body = cleanBody(input.body);
  const recipient = isEmailHandle(normalizeHandle(input.to))
    ? await emailRecipient(sender, input.to)
    : await resolvePeer(sender, input.to);
  assertReachable(recipient);

  if (input.idempotencyKey) {
    const replay = await replayIdempotentSend(sender, recipient, input.idempotencyKey, body);
    if (replay) return replay;
  }

  await rateLimit(`send:${sender.id}`, 60, 60);
  const existing = await findDirectConversation(sender, recipient);
  if (!existing && !sameOwner(sender, recipient)) {
    await rateLimit(`new-contact:${sender.id}`, 20, 3600);
  }
  const draft = existing ? null : await draftConversation();

  try {
    const { result, recorded } = await db.transaction((tx) =>
      deliver(tx, {
        sender,
        recipient,
        body,
        draft,
        idempotencyKey: input.idempotencyKey,
        attachments: input.attachments ?? [],
      }),
    );
    await bumpInbox(recipient.id);
    await broadcast(recorded);
    return result;
  } catch (error) {
    if (input.idempotencyKey && isUniqueViolation(error)) {
      const replay = await replayIdempotentSend(sender, recipient, input.idempotencyKey, body);
      if (replay) return replay;
    }
    throw error;
  }
}

async function deliver(
  tx: Tx,
  input: {
    sender: Agent;
    recipient: Agent;
    body: string;
    draft: ConversationDraft | null;
    idempotencyKey: string | undefined;
    attachments: string[];
  },
): Promise<{ result: SendResult; recorded: RecordedEvent[] }> {
  const { sender, recipient, body, draft, idempotencyKey } = input;
  const trusted =
    sameOwner(sender, recipient) ||
    (draft !== null && (await linkedByInvitation(tx, sender, recipient)));
  const isNew = draft
    ? await openDirectConversation(tx, draft, sender, recipient, {
        initiator: "active",
        peer: trusted ? "active" : "pending",
      })
    : false;
  const isRequest = isNew && !trusted;
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

  const key = await conversationKey(conversation);
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
    body: key.seal(body, bodyContext(messageId)),
    idempotencyKey: idempotencyKey ?? null,
    createdAt: sentAt,
  });
  const attached = await attachFiles(tx, sender, input.attachments, {
    conversationId: conversation.id,
    messageId,
  });

  const proof = {
    messageId,
    seq,
    contentHash: key.digest(body),
    ...(attached.length > 0 && { attachments: attached }),
  };
  recorded.push(
    await appendLedgerEvent(tx, sender, {
      type: isRequest ? "request.sent" : "message.sent",
      actor: "agent",
      conversationId: conversation.id,
      data: { to, ...proof },
    }),
    await appendLedgerEvent(tx, recipient, {
      type: isRequest ? "request.received" : "message.received",
      actor: "peer",
      conversationId: conversation.id,
      data: { from: formatHandle(sender.handle), ...proof },
    }),
  );

  const job = {
    agentId: recipient.id,
    conversationId: conversation.id,
    seq,
    kind: isRequest ? "request" : "message",
  } as const;
  await notify(tx, recipient, job);

  const status: SendStatus = isRequest
    ? "request_sent"
    : theirs === "pending"
      ? "awaiting_acceptance"
      : "delivered";
  return {
    result: {
      status,
      to,
      recipientActive: likelyActive(recipient),
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
  body: string,
): Promise<SendResult | null> {
  const [row] = await db
    .select({ message: messages, conversation: conversations })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(eq(messages.senderId, sender.id), eq(messages.idempotencyKey, idempotencyKey)));
  if (!row) return null;
  if (row.conversation.directKey !== directKey(sender.id, recipient.id)) {
    throw new AppError("conflict", "This idempotency key was already used for another recipient.");
  }
  const key = await conversationKey(row.conversation);
  if (key.open(row.message.body, bodyContext(row.message.id)) !== body) {
    throw new AppError(
      "conflict",
      "This idempotency key was already used for a different message.",
    );
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
    recipientActive: likelyActive(recipient),
    conversationId: row.message.conversationId,
    messageId: row.message.id,
    seq: row.message.seq,
    sentAt: row.message.createdAt.toISOString(),
  };
}

async function agentsById(ids: string[]): Promise<Map<string, Agent>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select()
    .from(agents)
    .where(inArray(agents.id, [...new Set(ids)]));
  return new Map(rows.map((agent) => [agent.id, agent]));
}

async function membersOf(conversationIds: string[]): Promise<ConversationMember[]> {
  if (conversationIds.length === 0) return [];
  return db
    .select()
    .from(conversationMembers)
    .where(inArray(conversationMembers.conversationId, conversationIds));
}

async function buildThreads(agent: Agent, found: FoundThread[]): Promise<InboxThread[]> {
  const people = await agentsById(found.flatMap((f) => f.members.map((m) => m.agentId)));
  const peerOf = (f: FoundThread) =>
    people.get(f.members.find((m) => m.agentId !== agent.id)?.agentId ?? "");
  const directPeers = found
    .filter((f) => f.conversation.kind !== "group")
    .flatMap((f) => peerOf(f) ?? []);
  const [profiles, known] = await Promise.all([
    peerProfiles(agent, directPeers),
    contactsByAgent(
      agent.ownerId,
      directPeers.map((peer) => peer.id),
    ),
  ]);

  const threads: InboxThread[] = [];
  for (const f of found) {
    const handles = new Map(f.members.map((m) => [m.agentId, people.get(m.agentId)?.handle ?? ""]));
    const list = await messageViews(f.unread, handles, await conversationKey(f.conversation));
    if (f.conversation.kind === "group") {
      threads.push({
        conversationId: f.conversation.id,
        kind: f.invitation ? "invitation" : "message",
        with: null,
        group: await groupView(agent, f.conversation, f.members),
        sameOwner: false,
        contact: null,
        mentioned: list.some((m) => mentions(m.body, agent.handle)),
        messages: list,
      });
      continue;
    }
    const peer = peerOf(f);
    if (!peer) continue;
    threads.push({
      conversationId: f.conversation.id,
      kind: f.member.status === "pending" ? "request" : "message",
      with: profiles.get(peer.id) ?? null,
      group: null,
      sameOwner: sameOwner(agent, peer),
      contact: contactContext(known.get(peer.id)),
      mentioned: false,
      messages: list,
    });
  }
  return threads;
}

async function markNotified(conversationId: string, agentId: string): Promise<void> {
  await db
    .update(conversationMembers)
    .set({ notifiedAt: new Date() })
    .where(and(memberOf(conversationId, agentId), isNull(conversationMembers.notifiedAt)));
}

export async function checkInbox(agent: Agent): Promise<Inbox> {
  const rules = await agentRules(agent);
  const cursor = await ledgerHead(agent.id);
  const version = await readInboxVersion(agent.id);
  if (await inboxKnownEmpty(agent.id, version)) {
    return { threads: [], ownerAnswers: [], notices: [], hasMore: false, rules, cursor };
  }
  const ownerAnswers = await takeAnswers(agent);
  const notices = await takeNotices(agent);

  const rows = await db
    .select({ conversation: conversations, member: conversationMembers })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .where(
      and(
        eq(conversationMembers.agentId, agent.id),
        or(
          and(
            inArray(conversationMembers.status, ["active", "pending"]),
            gt(conversations.lastSeq, conversationMembers.lastReadSeq),
          ),
          and(
            isNotNull(conversationMembers.invitedBy),
            isNull(conversationMembers.notifiedAt),
            inArray(conversationMembers.status, ["active", "invited"]),
          ),
        ),
      ),
    )
    .orderBy(sql`${conversations.lastMessageAt} asc nulls first`)
    .limit(INBOX_THREAD_LIMIT + 1);

  const hasMore = rows.length > INBOX_THREAD_LIMIT;
  const window = rows.slice(0, INBOX_THREAD_LIMIT);
  const allMembers = await membersOf(window.map((row) => row.conversation.id));
  const found: FoundThread[] = [];
  let drained = !hasMore;

  for (const { conversation, member } of window) {
    const invitation = member.invitedBy !== null && member.notifiedAt === null;
    let unread: Message[] = [];
    if (member.status === "active" || member.status === "pending") {
      const floor = Math.max(member.lastReadSeq, member.joinedSeq);
      unread = await db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversation.id),
            gt(messages.seq, floor),
            sql`${messages.senderId} <> ${agent.id}`,
          ),
        )
        .orderBy(asc(messages.seq))
        .limit(INBOX_MESSAGES_PER_THREAD);
      const complete = unread.length < INBOX_MESSAGES_PER_THREAD;
      if (!complete) drained = false;
      const readUpTo = complete ? conversation.lastSeq : (unread.at(-1)?.seq ?? floor);
      if (readUpTo > member.lastReadSeq) await markRead(conversation.id, agent.id, readUpTo);
    }
    if (invitation) await markNotified(conversation.id, agent.id);
    if (unread.length === 0 && !invitation) continue;
    found.push({
      conversation,
      member,
      members: allMembers.filter((m) => m.conversationId === conversation.id),
      unread,
      invitation,
    });
  }

  const threads = await buildThreads(agent, found);
  if (drained) await markInboxEmpty(agent.id, version);
  return { threads, ownerAnswers, notices, hasMore, rules, cursor };
}

// The cursor is the recipient's ledger sequence, which is assigned under a row lock and therefore
// commits in order: replaying from a cursor never skips a message, at worst it repeats one.
export async function inboxSince(agent: Agent, since: number): Promise<Inbox> {
  const rules = await agentRules(agent);
  const head = await ledgerHead(agent.id);
  const events = await listLedgerAfter(agent, {
    after: since,
    upTo: head,
    types: INBOX_EVENTS,
    limit: INBOX_REPLAY_LIMIT + 1,
  });
  const hasMore = events.length > INBOX_REPLAY_LIMIT;
  const window = events.slice(0, INBOX_REPLAY_LIMIT);
  const cursor = hasMore ? (window.at(-1)?.seq ?? since) : Math.max(head, since);

  const messageIds = window
    .filter((event) => MESSAGE_EVENTS.includes(event.type as LedgerEventType))
    .map((event) => String(event.data.messageId));
  const invitedTo = [
    ...new Set(
      window
        .filter((event) => event.type === "group.invited" && event.conversationId)
        .map((event) => String(event.conversationId)),
    ),
  ];
  const ownerAnswers = await answersByIds(
    agent,
    window
      .filter((event) => event.type === "owner.answered")
      .map((event) => String(event.data.questionId)),
  );
  const notices = await noticesByIds(
    agent,
    window
      .filter((event) => event.type === "notice.received")
      .map((event) => String(event.data.noticeId)),
  );

  const rows = messageIds.length
    ? await db
        .select({ message: messages, conversation: conversations, member: conversationMembers })
        .from(messages)
        .innerJoin(conversations, eq(conversations.id, messages.conversationId))
        .innerJoin(
          conversationMembers,
          and(
            eq(conversationMembers.conversationId, messages.conversationId),
            eq(conversationMembers.agentId, agent.id),
          ),
        )
        .where(
          and(
            inArray(messages.id, messageIds),
            inArray(conversationMembers.status, ["active", "pending"]),
          ),
        )
        .orderBy(asc(messages.createdAt), asc(messages.seq))
    : [];

  const invitedRows = invitedTo.length
    ? await db
        .select({ conversation: conversations, member: conversationMembers })
        .from(conversationMembers)
        .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
        .where(
          and(
            eq(conversationMembers.agentId, agent.id),
            inArray(conversationMembers.conversationId, invitedTo),
            inArray(conversationMembers.status, ["active", "invited"]),
          ),
        )
    : [];

  const byConversation = new Map<string, FoundThread>();
  for (const { conversation, member } of invitedRows) {
    byConversation.set(conversation.id, {
      conversation,
      member,
      members: [],
      unread: [],
      invitation: true,
    });
  }
  for (const { message, conversation, member } of rows) {
    const entry = byConversation.get(conversation.id) ?? {
      conversation,
      member,
      members: [],
      unread: [],
      invitation: false,
    };
    entry.unread.push(message);
    byConversation.set(conversation.id, entry);
  }

  const found = [...byConversation.values()];
  const allMembers = await membersOf(found.map((f) => f.conversation.id));
  for (const f of found) {
    f.members = allMembers.filter((m) => m.conversationId === f.conversation.id);
    const readUpTo = Math.max(0, ...f.unread.map((m) => m.seq));
    if (readUpTo > 0) await markRead(f.conversation.id, agent.id, readUpTo);
    if (f.invitation) await markNotified(f.conversation.id, agent.id);
  }

  return {
    threads: await buildThreads(agent, found),
    ownerAnswers,
    notices,
    hasMore,
    rules,
    cursor,
  };
}

function mergeInboxes(first: Inbox, second: Inbox): Inbox {
  const threads = new Map(first.threads.map((thread) => [thread.conversationId, thread]));
  for (const thread of second.threads) {
    const existing = threads.get(thread.conversationId);
    if (!existing) {
      threads.set(thread.conversationId, thread);
      continue;
    }
    const seen = new Set(existing.messages.map((message) => message.id));
    threads.set(thread.conversationId, {
      ...existing,
      kind: existing.kind === "message" ? thread.kind : existing.kind,
      mentioned: existing.mentioned || thread.mentioned,
      messages: [...existing.messages, ...thread.messages.filter((m) => !seen.has(m.id))].sort(
        (a, b) => a.seq - b.seq,
      ),
    });
  }
  const answered = new Set(first.ownerAnswers.map((answer) => answer.questionId));
  const noticed = new Set(first.notices.map((notice) => notice.id));
  return {
    threads: [...threads.values()],
    ownerAnswers: [
      ...first.ownerAnswers,
      ...second.ownerAnswers.filter((answer) => !answered.has(answer.questionId)),
    ],
    notices: [...first.notices, ...second.notices.filter((notice) => !noticed.has(notice.id))],
    hasMore: first.hasMore || second.hasMore,
    rules: first.rules,
    cursor: first.cursor,
  };
}

// Each connection (an OAuth sign-in or a token) keeps its own place in the inbox, so an agent
// running in two clients gets every new message in both: whatever arrived since the connection
// last read, plus anything older that no connection has read yet.
export async function readInbox(agent: Agent, tokenId: string | undefined): Promise<Inbox> {
  if (!tokenId) return checkInbox(agent);
  const [token] = await db
    .select({ cursor: agentTokens.inboxCursor })
    .from(agentTokens)
    .where(eq(agentTokens.id, tokenId));
  const cursor = token?.cursor ?? null;
  const inbox =
    cursor === null
      ? await checkInbox(agent)
      : mergeInboxes(await inboxSince(agent, cursor), await checkInbox(agent));
  if (cursor !== null || !inbox.hasMore) {
    await db
      .update(agentTokens)
      .set({ inboxCursor: sql`greatest(coalesce(${agentTokens.inboxCursor}, 0), ${inbox.cursor})` })
      .where(eq(agentTokens.id, tokenId));
  }
  return inbox;
}

// Live events wake a waiting agent at once; polling covers events lost while Valkey is down.
export async function waitForInbox(
  agent: Agent,
  seconds: number,
  options: {
    signal?: AbortSignal | undefined;
    since?: number | undefined;
    tokenId?: string | undefined;
  } = {},
): Promise<Inbox> {
  const { signal, since, tokenId } = options;
  const deadline = Date.now() + Math.min(seconds, MAX_WAIT_SECONDS) * 1000;
  const handle = formatHandle(agent.handle);
  let wakes = 0;
  let wake = () => {};
  const unsubscribe = subscribeToOwner(agent.ownerId, (event) => {
    const type = event.event.type;
    if (event.agent !== handle || typeof type !== "string" || !WAKING_EVENTS.has(type)) return;
    wakes += 1;
    wake();
  });
  const abort = () => wake();
  signal?.addEventListener("abort", abort);
  const release = await trackListening(agent.id);

  try {
    for (;;) {
      const seen = wakes;
      const inbox =
        since === undefined ? await readInbox(agent, tokenId) : await inboxSince(agent, since);
      const remaining = deadline - Date.now();
      const arrived =
        inbox.threads.length > 0 || inbox.ownerAnswers.length > 0 || inbox.notices.length > 0;
      if (arrived || remaining <= 0 || signal?.aborted) return inbox;
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

export async function getConversation(
  me: Agent,
  peerHandle: string,
  options: {
    limit: number;
    before?: number | undefined;
    after?: number | undefined;
    markRead: boolean;
  },
) {
  if (isGroupRef(peerHandle)) {
    const group = await getGroupConversation(me, peerHandle, options);
    return {
      ...group,
      with: null,
      sameOwner: false,
      contact: null,
      myAcceptance: acceptance(group.group.status),
      theirAcceptance: null,
    };
  }
  const peer = await resolvePeer(me, peerHandle);
  const contact = contactContext((await contactsByAgent(me.ownerId, [peer.id])).get(peer.id));
  const rules = await agentRules(me);
  const profile: PeerProfile = { ...publicProfile(peer), owner: await signalsFor(me, peer) };
  const conversation = await findDirectConversation(me, peer);
  if (!conversation) {
    return {
      conversationId: null,
      with: profile,
      group: null,
      sameOwner: sameOwner(me, peer),
      contact,
      rules,
      myAcceptance: null,
      theirAcceptance: null,
      readBy: [] as ReadReceipt[],
      messages: [] as MessageView[],
    };
  }

  const members = await membersOf([conversation.id]);
  const forward = options.after !== undefined;
  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversation.id),
        options.before === undefined ? undefined : lt(messages.seq, options.before),
        options.after === undefined ? undefined : gt(messages.seq, options.after),
      ),
    )
    .orderBy(forward ? asc(messages.seq) : desc(messages.seq))
    .limit(options.limit);
  if (!forward) rows.reverse();

  const latest = rows.at(-1)?.seq;
  if (options.markRead && options.before === undefined && latest !== undefined) {
    await markRead(conversation.id, me.id, latest);
  }

  const handles = new Map([
    [me.id, me.handle],
    [peer.id, peer.handle],
  ]);
  const theirs = members.find((m) => m.agentId === peer.id);
  return {
    conversationId: conversation.id,
    with: profile,
    group: null,
    sameOwner: sameOwner(me, peer),
    contact,
    rules,
    myAcceptance: acceptance(members.find((m) => m.agentId === me.id)?.status),
    theirAcceptance: acceptance(theirs?.status),
    readBy: theirs
      ? [
          {
            handle: formatHandle(peer.handle),
            seq: theirs.lastReadSeq,
            at: theirs.readAt?.toISOString() ?? null,
          },
        ]
      : [],
    messages: await messageViews(rows, handles, await conversationKey(conversation)),
  };
}

export async function listConversations(agent: Agent): Promise<ConversationSummary[]> {
  const rows = await db
    .select({
      conversation: conversations,
      member: conversationMembers,
      unread: sql<number>`(
        select count(*)::int from ${messages}
        where ${messages.conversationId} = ${conversations.id}
          and ${messages.seq} > greatest(${conversationMembers.lastReadSeq}, ${conversationMembers.joinedSeq})
          and ${messages.senderId} <> ${agent.id}
      )`,
    })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .where(eq(conversationMembers.agentId, agent.id))
    .orderBy(sql`${conversations.lastMessageAt} desc nulls last`)
    .limit(200);

  const allMembers = await membersOf(rows.map((row) => row.conversation.id));
  const people = await agentsById(allMembers.map((m) => m.agentId));
  const known = await contactsByAgent(agent.ownerId, [...people.keys()]);

  return rows.flatMap(({ conversation, member, unread }): ConversationSummary[] => {
    const members = allMembers.filter((m) => m.conversationId === conversation.id);
    const base = {
      conversationId: conversation.id,
      unread: member.status === "invited" ? 0 : unread,
      lastMessageAt: conversation.lastMessageAt?.toISOString() ?? null,
      myAcceptance: acceptance(member.status),
    };
    if (conversation.kind === "group") {
      return [
        {
          ...base,
          kind: "group",
          with: null,
          group: {
            name: formatGroupName(conversation.name ?? ""),
            status: member.status,
            role: member.role,
            members: members
              .filter((m) => m.status === "active")
              .map((m) => formatHandle(people.get(m.agentId)?.handle ?? "")),
          },
          contact: null,
          theirAcceptance: null,
        },
      ];
    }
    const theirs = members.find((m) => m.agentId !== agent.id);
    const peer = theirs && people.get(theirs.agentId);
    if (!theirs || !peer) return [];
    return [
      {
        ...base,
        kind: "direct",
        with: publicProfile(peer),
        group: null,
        contact: known.get(peer.id)?.name ?? null,
        theirAcceptance: acceptance(theirs.status),
      },
    ];
  });
}

export async function exportConversations(agent: Agent) {
  const rows = await db
    .select({ conversation: conversations, member: conversationMembers })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .where(eq(conversationMembers.agentId, agent.id))
    .orderBy(asc(conversations.createdAt));
  const allMembers = await membersOf(rows.map((row) => row.conversation.id));
  const people = await agentsById(allMembers.map((m) => m.agentId));

  return Promise.all(
    rows.map(async ({ conversation, member }) => {
      const members = allMembers.filter((m) => m.conversationId === conversation.id);
      const history = await db
        .select()
        .from(messages)
        .where(
          and(eq(messages.conversationId, conversation.id), gt(messages.seq, member.joinedSeq)),
        )
        .orderBy(asc(messages.seq));
      const handles = new Map(members.map((m) => [m.agentId, people.get(m.agentId)?.handle ?? ""]));
      const peer = members.find((m) => m.agentId !== agent.id);
      return {
        conversationId: conversation.id,
        with:
          conversation.kind === "group"
            ? formatGroupName(conversation.name ?? "")
            : formatHandle(people.get(peer?.agentId ?? "")?.handle ?? "unknown"),
        messages: await messageViews(history, handles, await conversationKey(conversation)),
      };
    }),
  );
}

export async function decideContact(
  me: Agent,
  peerHandle: string,
  decision: ContactDecision,
  actor: Exclude<Actor, "peer">,
): Promise<{ with: string; myAcceptance: Acceptance }> {
  if (isGroupRef(peerHandle)) {
    if (decision === "unblock") {
      throw new AppError("invalid_input", "Groups can't be unblocked; ask a member to invite you.");
    }
    const outcome = await respondToGroupInvite(me, peerHandle, decision, actor);
    return { with: outcome.with, myAcceptance: acceptance(outcome.status) ?? "pending" };
  }
  const peer = await resolvePeer(me, peerHandle);
  const ref = formatHandle(peer.handle);
  const draft =
    decision === "block" && !(await findDirectConversation(me, peer))
      ? await draftConversation()
      : null;

  const { status, recorded } = await db.transaction(async (tx) => {
    if (draft) {
      await openDirectConversation(tx, draft, me, peer, { initiator: "active", peer: "pending" });
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
  return { with: ref, myAcceptance: acceptance(status) ?? "pending" };
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

export async function lookupAgent(viewer: Agent, rawHandle: string): Promise<PeerProfile> {
  const handle = normalizeHandle(rawHandle);
  const agent = await findAgentByHandle(handle);
  if (!agent) throw new AppError("not_found", `No agent is registered as ${formatHandle(handle)}.`);
  assertReachable(agent);
  return { ...publicProfile(agent), owner: await signalsFor(viewer, agent) };
}
