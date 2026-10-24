import { and, asc, desc, eq, gt, inArray, lt, ne } from "drizzle-orm";
import { db, type Executor, type Tx } from "../db/client.ts";
import {
  agents,
  conversationMembers,
  conversations,
  messages,
  type Agent,
  type Conversation,
  type ConversationMember,
} from "../db/schema.ts";
import { uuidv7 } from "../lib/ids.ts";
import { rateLimit } from "../lib/rate-limit.ts";
import { agentRules, assertReachable, findAgentByHandle } from "./agents.ts";
import {
  bodyContext,
  bumpInbox,
  cleanBody,
  likelyActive,
  markRead,
  memberOf,
  messageViews,
  peerProfiles,
  type MessageView,
  type PeerProfile,
  type ReadReceipt,
} from "./conversations.ts";
import { AppError, isUniqueViolation } from "./errors.ts";
import { attachFiles } from "./files.ts";
import { formatHandle, isEmailHandle, normalizeHandle } from "./handles.ts";
import { conversationKey, newConversationKey } from "./keys.ts";
import { appendLedgerEvent, broadcast, type Actor, type RecordedEvent } from "./ledger.ts";
import { notify } from "./notifications.ts";

export const MAX_GROUP_MEMBERS = 20;
const GROUP_NAME = /^[a-z0-9][a-z0-9_-]{2,31}$/;
const VISIBLE_STATUSES = ["active", "invited"];

export type GroupStatus = "active" | "invited" | "declined" | "blocked" | "left" | "removed";

export type GroupMember = PeerProfile & { role: string; status: GroupStatus };

export type GroupView = {
  name: string;
  role: string;
  status: GroupStatus;
  members: GroupMember[];
  invitedBy: string | null;
  note: string | null;
};

const noteContext = (conversationId: string, agentId: string) =>
  `conversation_members.invite_note:${conversationId}:${agentId}`;

export function isGroupRef(raw: string): boolean {
  return raw.trim().startsWith("#");
}

export function normalizeGroupName(raw: string): string {
  return raw.trim().replace(/^#/, "").toLowerCase();
}

export function formatGroupName(name: string): string {
  return `#${name}`;
}

export async function resolveGroup(raw: string, tx: Executor = db): Promise<Conversation> {
  const name = normalizeGroupName(raw);
  const [group] = await tx
    .select()
    .from(conversations)
    .where(and(eq(conversations.name, name), eq(conversations.kind, "group")));
  if (!group) throw new AppError("not_found", `There is no group called ${formatGroupName(name)}.`);
  return group;
}

async function lockGroup(tx: Tx, raw: string) {
  const name = normalizeGroupName(raw);
  const [group] = await tx
    .select()
    .from(conversations)
    .where(and(eq(conversations.name, name), eq(conversations.kind, "group")))
    .for("update");
  if (!group) throw new AppError("not_found", `There is no group called ${formatGroupName(name)}.`);
  const members = await tx
    .select()
    .from(conversationMembers)
    .where(eq(conversationMembers.conversationId, group.id));
  return { group, members };
}

function requireActive(group: Conversation, member: ConversationMember | undefined) {
  const name = formatGroupName(group.name ?? "");
  if (member?.status === "invited") {
    throw new AppError(
      "forbidden",
      `Accept the invitation to ${name} first with respond_to_request.`,
    );
  }
  if (member?.status !== "active")
    throw new AppError("forbidden", `You're not a member of ${name}.`);
}

async function resolveInvitees(inviter: Agent, handles: string[]): Promise<Agent[]> {
  const unique = [...new Set(handles.map(normalizeHandle))];
  const invitees: Agent[] = [];
  for (const handle of unique) {
    const agent = await findAgentByHandle(handle);
    if (!agent)
      throw new AppError("not_found", `No agent is registered as ${formatHandle(handle)}.`);
    assertReachable(agent);
    if (isEmailHandle(agent.handle)) {
      throw new AppError(
        "invalid_input",
        `${agent.handle} is an email address; groups are for agents. Email them directly instead.`,
      );
    }
    if (agent.id !== inviter.id) invitees.push(agent);
  }
  for (const agent of invitees) {
    if (agent.ownerId !== inviter.ownerId) await rateLimit(`new-contact:${inviter.id}`, 20, 3600);
  }
  return invitees;
}

async function addInvitees(
  tx: Tx,
  input: {
    group: Conversation;
    inviter: Agent;
    invitees: Agent[];
    existing: ConversationMember[];
    note: string | undefined;
  },
): Promise<{ invited: Agent[]; recorded: RecordedEvent[] }> {
  const { group, inviter, existing } = input;
  const key = await conversationKey(group);
  const ref = formatGroupName(group.name ?? "");
  const invited: Agent[] = [];
  const recorded: RecordedEvent[] = [];

  for (const invitee of input.invitees) {
    const current = existing.find((member) => member.agentId === invitee.id);
    if (current && ["active", "invited", "blocked"].includes(current.status)) continue;
    const fields = {
      status: invitee.ownerId === inviter.ownerId ? "active" : "invited",
      role: "member",
      invitedBy: inviter.id,
      inviteNote: input.note ? key.seal(input.note, noteContext(group.id, invitee.id)) : null,
      notifiedAt: null,
      joinedSeq: group.lastSeq,
      lastReadSeq: group.lastSeq,
      updatedAt: new Date(),
    };
    if (current) {
      await tx.update(conversationMembers).set(fields).where(memberOf(group.id, invitee.id));
    } else {
      await tx
        .insert(conversationMembers)
        .values({ conversationId: group.id, agentId: invitee.id, ...fields });
    }
    invited.push(invitee);
    recorded.push(
      await appendLedgerEvent(tx, invitee, {
        type: "group.invited",
        actor: "peer",
        conversationId: group.id,
        data: { group: ref, by: formatHandle(inviter.handle), joined: fields.status === "active" },
      }),
    );
    const job = {
      kind: "invitation",
      agentId: invitee.id,
      conversationId: group.id,
      fromId: inviter.id,
    } as const;
    await notify(tx, invitee, job);
  }
  return { invited, recorded };
}

function capacityCheck(members: ConversationMember[], adding: Agent[]) {
  const ids = new Set(
    members.filter((m) => VISIBLE_STATUSES.includes(m.status)).map((m) => m.agentId),
  );
  for (const agent of adding) ids.add(agent.id);
  if (ids.size > MAX_GROUP_MEMBERS) {
    throw new AppError("invalid_input", `Groups can have up to ${MAX_GROUP_MEMBERS} agents.`);
  }
}

export async function createGroup(
  creator: Agent,
  input: { name: string; members: string[]; note?: string | undefined },
): Promise<GroupView> {
  const name = normalizeGroupName(input.name);
  if (!GROUP_NAME.test(name)) {
    throw new AppError(
      "invalid_input",
      "Group names are 3 to 32 lowercase letters, numbers, dashes or underscores, like #launch-team.",
    );
  }
  await rateLimit(`create-group:${creator.id}`, 10, 3600);
  const invitees = await resolveInvitees(creator, input.members);
  if (invitees.length === 0)
    throw new AppError("invalid_input", "Invite at least one other agent.");
  if (invitees.length + 1 > MAX_GROUP_MEMBERS) {
    throw new AppError("invalid_input", `Groups can have up to ${MAX_GROUP_MEMBERS} agents.`);
  }

  const id = uuidv7();
  const dataKey = await newConversationKey(id);
  try {
    const { invited, recorded } = await db.transaction(async (tx) => {
      const [group] = await tx
        .insert(conversations)
        .values({ id, kind: "group", name, createdBy: creator.id, dataKey })
        .returning();
      if (!group) throw new Error("group insert returned no row");
      await tx
        .insert(conversationMembers)
        .values({ conversationId: id, agentId: creator.id, status: "active", role: "admin" });
      const added = await addInvitees(tx, {
        group,
        inviter: creator,
        invitees,
        existing: [],
        note: input.note?.trim() || undefined,
      });
      added.recorded.unshift(
        await appendLedgerEvent(tx, creator, {
          type: "group.created",
          actor: "agent",
          conversationId: id,
          data: {
            group: formatGroupName(name),
            members: added.invited.map((agent) => formatHandle(agent.handle)),
          },
        }),
      );
      return added;
    });
    await Promise.all(invited.map((agent) => bumpInbox(agent.id)));
    await broadcast(recorded);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new AppError("conflict", `${formatGroupName(name)} is taken. Pick another name.`);
    }
    throw error;
  }
  return groupFor(creator, name);
}

export async function inviteToGroup(
  inviter: Agent,
  raw: string,
  input: { handles: string[]; note?: string | undefined },
): Promise<GroupView> {
  const invitees = await resolveInvitees(inviter, input.handles);
  const { invited, recorded } = await db.transaction(async (tx) => {
    const { group, members } = await lockGroup(tx, raw);
    requireActive(
      group,
      members.find((m) => m.agentId === inviter.id),
    );
    capacityCheck(members, invitees);
    const added = await addInvitees(tx, {
      group,
      inviter,
      invitees,
      existing: members,
      note: input.note?.trim() || undefined,
    });
    if (added.invited.length > 0) {
      added.recorded.push(
        await appendLedgerEvent(tx, inviter, {
          type: "group.member.invited",
          actor: "agent",
          conversationId: group.id,
          data: {
            group: formatGroupName(group.name ?? ""),
            members: added.invited.map((agent) => formatHandle(agent.handle)),
          },
        }),
      );
    }
    return added;
  });
  await Promise.all(invited.map((agent) => bumpInbox(agent.id)));
  await broadcast(recorded);
  return groupFor(inviter, raw);
}

export async function respondToGroupInvite(
  agent: Agent,
  raw: string,
  decision: "accept" | "decline" | "block",
  actor: Exclude<Actor, "peer">,
): Promise<{ with: string; status: GroupStatus }> {
  const { status, recorded, ref } = await db.transaction(async (tx) => {
    const { group, members } = await lockGroup(tx, raw);
    const ref = formatGroupName(group.name ?? "");
    const mine = members.find((m) => m.agentId === agent.id);
    if (!mine || !["invited", "declined", "active"].includes(mine.status)) {
      throw new AppError("not_found", `You have no invitation to ${ref}.`);
    }
    const next: GroupStatus =
      decision === "accept" ? "active" : decision === "decline" ? "declined" : "blocked";
    if (next === mine.status) return { status: next, recorded: [], ref };
    if (next === "active" && mine.status !== "invited" && mine.status !== "declined") {
      throw new AppError("conflict", `You're already in ${ref}.`);
    }
    await tx
      .update(conversationMembers)
      .set({ status: next, updatedAt: new Date() })
      .where(memberOf(group.id, agent.id));
    const recorded = await appendLedgerEvent(tx, agent, {
      type: next === "active" ? "group.joined" : "group.declined",
      actor,
      conversationId: group.id,
      data: { group: ref, ...(next === "blocked" && { blocked: true }) },
    });
    return { status: next, recorded: [recorded], ref };
  });
  if (status === "active") await bumpInbox(agent.id);
  await broadcast(recorded);
  return { with: ref, status };
}

export async function leaveGroup(
  agent: Agent,
  raw: string,
  actor: Exclude<Actor, "peer">,
): Promise<void> {
  const recorded = await db.transaction(async (tx) => {
    const { group, members } = await lockGroup(tx, raw);
    const mine = members.find((m) => m.agentId === agent.id);
    if (!mine || !VISIBLE_STATUSES.includes(mine.status)) {
      throw new AppError("not_found", `You're not in ${formatGroupName(group.name ?? "")}.`);
    }
    await tx
      .update(conversationMembers)
      .set({ status: "left", role: "member", updatedAt: new Date() })
      .where(memberOf(group.id, agent.id));
    if (mine.role === "admin") await promoteSuccessor(tx, group.id, agent.id);
    return appendLedgerEvent(tx, agent, {
      type: "group.left",
      actor,
      conversationId: group.id,
      data: { group: formatGroupName(group.name ?? "") },
    });
  });
  await broadcast([recorded]);
}

// A group keeps working when its admin leaves: the longest-standing member takes over.
export async function promoteSuccessor(tx: Tx, conversationId: string, leaving: string) {
  const [next] = await tx
    .select({ agentId: conversationMembers.agentId })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.status, "active"),
        ne(conversationMembers.agentId, leaving),
      ),
    )
    .orderBy(asc(conversationMembers.joinedAt))
    .limit(1);
  if (next) {
    await tx
      .update(conversationMembers)
      .set({ role: "admin" })
      .where(memberOf(conversationId, next.agentId));
  }
}

export async function removeFromGroup(admin: Agent, raw: string, handle: string): Promise<void> {
  const target = await findAgentByHandle(handle);
  const recorded = await db.transaction(async (tx) => {
    const { group, members } = await lockGroup(tx, raw);
    const ref = formatGroupName(group.name ?? "");
    const mine = members.find((m) => m.agentId === admin.id);
    requireActive(group, mine);
    if (mine?.role !== "admin") {
      throw new AppError("forbidden", `Only the admin of ${ref} can remove members.`);
    }
    const theirs = target && members.find((m) => m.agentId === target.id);
    if (!target || !theirs || !VISIBLE_STATUSES.includes(theirs.status) || target.id === admin.id) {
      throw new AppError("not_found", `${formatHandle(normalizeHandle(handle))} isn't in ${ref}.`);
    }
    await tx
      .update(conversationMembers)
      .set({ status: "removed", updatedAt: new Date() })
      .where(memberOf(group.id, target.id));
    return [
      await appendLedgerEvent(tx, admin, {
        type: "group.member.removed",
        actor: "agent",
        conversationId: group.id,
        data: { group: ref, member: formatHandle(target.handle) },
      }),
      await appendLedgerEvent(tx, target, {
        type: "group.removed",
        actor: "peer",
        conversationId: group.id,
        data: { group: ref, by: formatHandle(admin.handle) },
      }),
    ];
  });
  await broadcast(recorded);
}

export type GroupSendResult = {
  status: "delivered";
  to: string;
  recipientActive: boolean;
  conversationId: string;
  messageId: string;
  seq: number;
  sentAt: string;
};

export async function sendGroupMessage(
  sender: Agent,
  raw: string,
  input: { body: string; idempotencyKey?: string | undefined; attachments?: string[] | undefined },
): Promise<GroupSendResult> {
  const body = cleanBody(input.body);
  const group = await resolveGroup(raw);
  const ref = formatGroupName(group.name ?? "");

  if (input.idempotencyKey) {
    const replay = await replayGroupSend(sender, group, input.idempotencyKey, body);
    if (replay) return replay;
  }
  await rateLimit(`send:${sender.id}`, 60, 60);
  await rateLimit(`group-sender:${group.id}:${sender.id}`, 10, 60);
  // Caps the whole group so agents replying to each other can't loop without end.
  await rateLimit(`group:${group.id}`, 30, 60);

  const { result, recorded, recipients } = await db.transaction(async (tx) => {
    const { group: locked, members } = await lockGroup(tx, raw);
    requireActive(
      locked,
      members.find((m) => m.agentId === sender.id),
    );
    const recipientIds = members
      .filter((m) => m.status === "active" && m.agentId !== sender.id)
      .map((m) => m.agentId);
    const recipients = recipientIds.length
      ? await tx.select().from(agents).where(inArray(agents.id, recipientIds))
      : [];

    const key = await conversationKey(locked);
    const seq = locked.lastSeq + 1;
    const sentAt = new Date();
    const messageId = uuidv7();
    await tx
      .update(conversations)
      .set({ lastSeq: seq, lastMessageAt: sentAt })
      .where(eq(conversations.id, locked.id));
    await tx.insert(messages).values({
      conversationId: locked.id,
      seq,
      id: messageId,
      senderId: sender.id,
      body: key.seal(body, bodyContext(messageId)),
      idempotencyKey: input.idempotencyKey ?? null,
      createdAt: sentAt,
    });
    const attached = await attachFiles(tx, sender, input.attachments ?? [], {
      conversationId: locked.id,
      messageId,
    });
    const proof = {
      messageId,
      seq,
      contentHash: key.digest(body),
      ...(attached.length > 0 && { attachments: attached }),
    };
    const recorded = [
      await appendLedgerEvent(tx, sender, {
        type: "message.sent",
        actor: "agent",
        conversationId: locked.id,
        data: { to: ref, ...proof },
      }),
    ];
    for (const recipient of recipients) {
      recorded.push(
        await appendLedgerEvent(tx, recipient, {
          type: "message.received",
          actor: "peer",
          conversationId: locked.id,
          data: { from: formatHandle(sender.handle), group: ref, ...proof },
        }),
      );
      const job = {
        kind: "message",
        agentId: recipient.id,
        conversationId: locked.id,
        seq,
      } as const;
      await notify(tx, recipient, job);
    }
    return {
      recipients,
      recorded,
      result: {
        status: "delivered" as const,
        to: ref,
        recipientActive: recipients.some(likelyActive),
        conversationId: locked.id,
        messageId,
        seq,
        sentAt: sentAt.toISOString(),
      },
    };
  });
  await Promise.all(recipients.map((agent) => bumpInbox(agent.id)));
  await broadcast(recorded);
  return result;
}

async function replayGroupSend(
  sender: Agent,
  group: Conversation,
  idempotencyKey: string,
  body: string,
): Promise<GroupSendResult | null> {
  const [message] = await db
    .select()
    .from(messages)
    .where(and(eq(messages.senderId, sender.id), eq(messages.idempotencyKey, idempotencyKey)));
  if (!message) return null;
  const key = await conversationKey(group);
  if (
    message.conversationId !== group.id ||
    key.open(message.body, bodyContext(message.id)) !== body
  ) {
    throw new AppError(
      "conflict",
      "This idempotency key was already used for a different message.",
    );
  }
  return {
    status: "delivered",
    to: formatGroupName(group.name ?? ""),
    recipientActive: true,
    conversationId: group.id,
    messageId: message.id,
    seq: message.seq,
    sentAt: message.createdAt.toISOString(),
  };
}

export async function groupView(
  viewer: Agent,
  group: Conversation,
  members: ConversationMember[],
): Promise<GroupView> {
  const visible = members.filter((m) => VISIBLE_STATUSES.includes(m.status));
  const ids = visible.map((m) => m.agentId);
  const rows = ids.length ? await db.select().from(agents).where(inArray(agents.id, ids)) : [];
  const profiles = await peerProfiles(viewer, rows);
  const mine = members.find((m) => m.agentId === viewer.id);
  const inviter = mine?.invitedBy
    ? await db.select().from(agents).where(eq(agents.id, mine.invitedBy))
    : [];
  const key = await conversationKey(group);
  return {
    name: formatGroupName(group.name ?? ""),
    role: mine?.role ?? "member",
    status: (mine?.status ?? "removed") as GroupStatus,
    members: visible.flatMap((m) => {
      const profile = profiles.get(m.agentId);
      return profile ? [{ ...profile, role: m.role, status: m.status as GroupStatus }] : [];
    }),
    invitedBy: inviter[0] ? formatHandle(inviter[0].handle) : null,
    note: mine ? key.open(mine.inviteNote, noteContext(group.id, viewer.id)) : null,
  };
}

async function groupFor(viewer: Agent, raw: string): Promise<GroupView> {
  const group = await resolveGroup(raw);
  const members = await db
    .select()
    .from(conversationMembers)
    .where(eq(conversationMembers.conversationId, group.id));
  return groupView(viewer, group, members);
}

export async function listGroups(agent: Agent) {
  const rows = await db
    .select({ group: conversations, member: conversationMembers })
    .from(conversationMembers)
    .innerJoin(conversations, eq(conversations.id, conversationMembers.conversationId))
    .where(
      and(
        eq(conversationMembers.agentId, agent.id),
        eq(conversations.kind, "group"),
        inArray(conversationMembers.status, VISIBLE_STATUSES),
      ),
    )
    .orderBy(desc(conversations.lastMessageAt));
  const counts = rows.length
    ? await db
        .select({ conversationId: conversationMembers.conversationId })
        .from(conversationMembers)
        .where(
          and(
            inArray(
              conversationMembers.conversationId,
              rows.map((row) => row.group.id),
            ),
            eq(conversationMembers.status, "active"),
          ),
        )
    : [];
  return rows.map(({ group, member }) => ({
    name: formatGroupName(group.name ?? ""),
    status: member.status as GroupStatus,
    role: member.role,
    members: counts.filter((row) => row.conversationId === group.id).length,
    unread: Math.max(0, group.lastSeq - Math.max(member.lastReadSeq, member.joinedSeq)),
    lastMessageAt: group.lastMessageAt?.toISOString() ?? null,
  }));
}

export function readReceipts(
  members: ConversationMember[],
  viewerId: string,
  handles: Map<string, string>,
): ReadReceipt[] {
  return members
    .filter((m) => m.agentId !== viewerId && m.status === "active")
    .map((m) => ({
      handle: formatHandle(handles.get(m.agentId) ?? "unknown"),
      seq: m.lastReadSeq,
      at: m.readAt?.toISOString() ?? null,
    }));
}

export async function getGroupConversation(
  me: Agent,
  raw: string,
  options: {
    limit: number;
    before?: number | undefined;
    after?: number | undefined;
    markRead: boolean;
  },
) {
  const group = await resolveGroup(raw);
  const members = await db
    .select()
    .from(conversationMembers)
    .where(eq(conversationMembers.conversationId, group.id));
  const mine = members.find((m) => m.agentId === me.id);
  if (!mine || !VISIBLE_STATUSES.includes(mine.status)) {
    throw new AppError("not_found", `You're not in ${formatGroupName(group.name ?? "")}.`);
  }
  const view = await groupView(me, group, members);
  const rules = await agentRules(me);
  if (mine.status !== "active") {
    return {
      conversationId: group.id,
      group: view,
      rules,
      readBy: [],
      messages: [] as MessageView[],
    };
  }

  const forward = options.after !== undefined;
  const floor = Math.max(mine.joinedSeq, options.after ?? 0);
  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, group.id),
        options.before === undefined ? undefined : lt(messages.seq, options.before),
        floor > 0 ? gt(messages.seq, floor) : undefined,
      ),
    )
    .orderBy(forward ? asc(messages.seq) : desc(messages.seq))
    .limit(options.limit);
  if (!forward) rows.reverse();

  const latest = rows.at(-1)?.seq;
  if (options.markRead && options.before === undefined && latest !== undefined) {
    await markRead(group.id, me.id, latest);
  }
  const senderIds = [
    ...new Set([...rows.map((m) => m.senderId), ...members.map((m) => m.agentId)]),
  ];
  const senders = senderIds.length
    ? await db
        .select({ id: agents.id, handle: agents.handle })
        .from(agents)
        .where(inArray(agents.id, senderIds))
    : [];
  const handles = new Map(senders.map((agent) => [agent.id, agent.handle]));
  return {
    conversationId: group.id,
    group: view,
    rules,
    readBy: readReceipts(members, me.id, handles),
    messages: await messageViews(rows, handles, await conversationKey(group)),
  };
}
