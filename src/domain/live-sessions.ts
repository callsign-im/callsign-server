import { and, asc, desc, eq, gt, inArray, or } from "drizzle-orm";
import { db, type Tx } from "../db/client.ts";
import {
  agents,
  conversationMembers,
  conversations,
  liveSessionEvents,
  liveSessions,
  type Agent,
  type LiveSession,
  type LiveSessionEvent,
} from "../db/schema.ts";
import type { DataKey } from "../lib/encryption.ts";
import { publishToOwner } from "../lib/events.ts";
import { uuidv7 } from "../lib/ids.ts";
import { rateLimit } from "../lib/rate-limit.ts";
import { AppError } from "./errors.ts";
import { formatGroupName, resolveGroup } from "./groups.ts";
import { formatHandle } from "./handles.ts";
import { liveSessionKey, newLiveSessionKey } from "./keys.ts";
import { appendLedgerEvent, broadcast, type RecordedEvent } from "./ledger.ts";
import { createNotice, takeSessionSteers, type NoticeView } from "./notices.ts";

export const MAX_SESSION_TITLE = 120;
export const MAX_SESSION_TEXT = 2000;
export const MAX_SESSION_BATCH = 50;
export const MAX_LIVE_SESSIONS = 5;
const EVENTS_PER_MINUTE = 600;
const PAGE = 200;

// What the driving agent can report. Steers, handoffs and status changes are written by Callsign.
export const AGENT_EVENT_KINDS = ["step", "tool", "diff", "note"] as const;
export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number];
export type LiveSessionEventKind = AgentEventKind | "steer" | "handoff" | "status";

export type LiveSessionEventView = {
  seq: number;
  kind: LiveSessionEventKind;
  by: string | null;
  fromOwner: boolean;
  text: string;
  at: string;
};

export type LiveSessionView = {
  id: string;
  title: string;
  status: "live" | "ended";
  driver: string | null;
  startedBy: string | null;
  group: string | null;
  client: string | null;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  lastSeq: number;
  events: LiveSessionEventView[];
};

const titleContext = (id: string) => `live_sessions.title:${id}`;
const bodyContext = (id: string) => `live_session_events.body:${id}`;

type NewEvent = {
  kind: LiveSessionEventKind;
  text: string;
  agentId?: string | null;
  ownerId?: string | null;
};

function cleanText(raw: string, what: string): string {
  const text = raw.trim();
  if (!text) throw new AppError("invalid_input", `Write the ${what}.`);
  if (text.length > MAX_SESSION_TEXT) {
    throw new AppError("invalid_input", `Keep the ${what} under ${MAX_SESSION_TEXT} characters.`);
  }
  return text;
}

async function isActiveMember(groupId: string, agentId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: conversationMembers.status })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, groupId),
        eq(conversationMembers.agentId, agentId),
        eq(conversationMembers.status, "active"),
      ),
    );
  return Boolean(row);
}

async function loadSession(id: string): Promise<LiveSession> {
  const [session] = await db.select().from(liveSessions).where(eq(liveSessions.id, id));
  if (!session) throw new AppError("not_found", "There is no such live session.");
  return session;
}

async function lockSession(tx: Tx, id: string): Promise<LiveSession> {
  const [session] = await tx
    .select()
    .from(liveSessions)
    .where(eq(liveSessions.id, id))
    .for("update");
  if (!session) throw new AppError("not_found", "There is no such live session.");
  return session;
}

async function agentById(id: string | null): Promise<Agent | null> {
  if (!id) return null;
  const [agent] = await db.select().from(agents).where(eq(agents.id, id));
  return agent ?? null;
}

// Anyone the session is shared with: its owner's agents, whoever drives it and the members of
// the group it was started in.
export async function canSeeSession(agent: Agent, session: LiveSession): Promise<boolean> {
  if (agent.ownerId === session.ownerId || agent.id === session.driverId) return true;
  if (session.driverId) {
    const driver = await agentById(session.driverId);
    if (driver && driver.ownerId === agent.ownerId) return true;
  }
  return session.groupId ? isActiveMember(session.groupId, agent.id) : false;
}

async function visibleSession(agent: Agent, id: string): Promise<LiveSession> {
  const session = await loadSession(id);
  if (!(await canSeeSession(agent, session))) {
    throw new AppError("not_found", "There is no such live session.");
  }
  return session;
}

async function insertEvents(
  tx: Tx,
  session: LiveSession,
  key: DataKey,
  events: NewEvent[],
): Promise<number> {
  let seq = session.lastSeq;
  const rows = events.map((event) => {
    const id = uuidv7();
    seq += 1;
    return {
      sessionId: session.id,
      seq,
      id,
      kind: event.kind,
      agentId: event.agentId ?? null,
      ownerId: event.ownerId ?? null,
      body: key.seal(event.text, bodyContext(id)),
    };
  });
  if (rows.length > 0) await tx.insert(liveSessionEvents).values(rows);
  await tx
    .update(liveSessions)
    .set({ lastSeq: seq, updatedAt: new Date() })
    .where(eq(liveSessions.id, session.id));
  return seq;
}

// Owners who can watch the session: its owner, the driver's owner and the owners of the group.
async function watcherOwners(session: LiveSession): Promise<string[]> {
  const ids = new Set([session.ownerId]);
  const driver = await agentById(session.driverId);
  if (driver) ids.add(driver.ownerId);
  if (session.groupId) {
    const members = await db
      .select({ ownerId: agents.ownerId })
      .from(conversationMembers)
      .innerJoin(agents, eq(agents.id, conversationMembers.agentId))
      .where(
        and(
          eq(conversationMembers.conversationId, session.groupId),
          eq(conversationMembers.status, "active"),
        ),
      );
    for (const member of members) ids.add(member.ownerId);
  }
  return [...ids];
}

async function announce(
  session: LiveSession,
  change: "started" | "updated" | "ended" | "taken_over",
): Promise<void> {
  const owners = await watcherOwners(session);
  await Promise.all(
    owners.map((ownerId) =>
      publishToOwner(ownerId, { type: "session", session: session.id, change }),
    ),
  );
}

async function views(
  sessions: LiveSession[],
): Promise<Map<string, Omit<LiveSessionView, "events">>> {
  const agentIds = [
    ...new Set(sessions.flatMap((s) => [s.driverId, s.startedBy].filter((id) => id !== null))),
  ];
  const groupIds = [...new Set(sessions.flatMap((s) => (s.groupId ? [s.groupId] : [])))];
  const [handles, groups] = await Promise.all([
    agentIds.length
      ? db
          .select({ id: agents.id, handle: agents.handle })
          .from(agents)
          .where(inArray(agents.id, agentIds))
      : [],
    groupIds.length
      ? db
          .select({ id: conversations.id, name: conversations.name })
          .from(conversations)
          .where(inArray(conversations.id, groupIds))
      : [],
  ]);
  const handleOf = new Map(handles.map((row) => [row.id, formatHandle(row.handle)]));
  const groupOf = new Map(groups.map((row) => [row.id, formatGroupName(row.name ?? "")]));
  const result = new Map<string, Omit<LiveSessionView, "events">>();
  for (const session of sessions) {
    const key = await liveSessionKey(session);
    result.set(session.id, {
      id: session.id,
      title: key.open(session.title, titleContext(session.id)) ?? "",
      status: session.status === "ended" ? "ended" : "live",
      driver: session.driverId ? (handleOf.get(session.driverId) ?? null) : null,
      startedBy: session.startedBy ? (handleOf.get(session.startedBy) ?? null) : null,
      group: session.groupId ? (groupOf.get(session.groupId) ?? null) : null,
      client: session.client,
      startedAt: session.startedAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
      endedAt: session.endedAt?.toISOString() ?? null,
      lastSeq: session.lastSeq,
    });
  }
  return result;
}

async function eventViews(
  session: LiveSession,
  rows: LiveSessionEvent[],
): Promise<LiveSessionEventView[]> {
  if (rows.length === 0) return [];
  const key = await liveSessionKey(session);
  const agentIds = [...new Set(rows.flatMap((row) => (row.agentId ? [row.agentId] : [])))];
  const handles = agentIds.length
    ? await db
        .select({ id: agents.id, handle: agents.handle })
        .from(agents)
        .where(inArray(agents.id, agentIds))
    : [];
  const handleOf = new Map(handles.map((row) => [row.id, formatHandle(row.handle)]));
  return rows.map((row) => ({
    seq: row.seq,
    kind: row.kind as LiveSessionEventKind,
    by: row.agentId ? (handleOf.get(row.agentId) ?? null) : null,
    fromOwner: row.ownerId !== null,
    text: key.open(row.body, bodyContext(row.id)) ?? "",
    at: row.createdAt.toISOString(),
  }));
}

async function sessionView(
  session: LiveSession,
  options: { after?: number | undefined } = {},
): Promise<LiveSessionView> {
  const rows =
    options.after !== undefined
      ? await db
          .select()
          .from(liveSessionEvents)
          .where(
            and(
              eq(liveSessionEvents.sessionId, session.id),
              gt(liveSessionEvents.seq, options.after),
            ),
          )
          .orderBy(asc(liveSessionEvents.seq))
          .limit(PAGE)
      : (
          await db
            .select()
            .from(liveSessionEvents)
            .where(eq(liveSessionEvents.sessionId, session.id))
            .orderBy(desc(liveSessionEvents.seq))
            .limit(PAGE)
        ).reverse();
  const summary = (await views([session])).get(session.id);
  if (!summary) throw new Error("live session view missing");
  return { ...summary, events: await eventViews(session, rows) };
}

export async function startLiveSession(
  agent: Agent,
  input: { title: string; group?: string | undefined },
  client: string | null,
): Promise<LiveSessionView> {
  const title = input.title.trim();
  if (!title) throw new AppError("invalid_input", "Give the session a title.");
  if (title.length > MAX_SESSION_TITLE) {
    throw new AppError("invalid_input", `Keep the title under ${MAX_SESSION_TITLE} characters.`);
  }
  const live = await db
    .select({ id: liveSessions.id })
    .from(liveSessions)
    .where(and(eq(liveSessions.driverId, agent.id), eq(liveSessions.status, "live")));
  if (live.length >= MAX_LIVE_SESSIONS) {
    throw new AppError(
      "conflict",
      `You already drive ${MAX_LIVE_SESSIONS} live sessions. End one with end_session first.`,
    );
  }
  await rateLimit(`live-sessions:${agent.id}`, 30, 3600);

  const group = input.group ? await resolveGroup(input.group) : null;
  if (group && !(await isActiveMember(group.id, agent.id))) {
    throw new AppError(
      "forbidden",
      `You're not a member of ${formatGroupName(group.name ?? "")}, so you can't share a session with it.`,
    );
  }

  const id = uuidv7();
  const dataKey = await newLiveSessionKey(id);
  const key = await liveSessionKey({ id, dataKey });
  const handle = formatHandle(agent.handle);
  const { session, recorded } = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(liveSessions)
      .values({
        id,
        ownerId: agent.ownerId,
        startedBy: agent.id,
        driverId: agent.id,
        groupId: group?.id ?? null,
        title: key.seal(title, titleContext(id)),
        client,
        dataKey,
      })
      .returning();
    if (!created) throw new Error("live session insert returned no row");
    const lastSeq = await insertEvents(tx, created, key, [
      {
        kind: "status",
        agentId: agent.id,
        text: `${handle} started the session${client ? ` in ${client}` : ""}.`,
      },
    ]);
    const recorded = await appendLedgerEvent(tx, agent, {
      type: "session.started",
      actor: "agent",
      conversationId: group?.id ?? null,
      data: {
        sessionId: id,
        title,
        ...(group && { group: formatGroupName(group.name ?? "") }),
        ...(client && { client }),
      },
    });
    return { session: { ...created, lastSeq }, recorded };
  });
  await broadcast([recorded]);
  await announce(session, "started");
  return sessionView(await loadSession(session.id));
}

function requireDriver(agent: Agent, session: LiveSession) {
  if (session.status !== "live") {
    throw new AppError("conflict", "This session has ended. Start a new one with start_session.");
  }
  if (session.driverId !== agent.id) {
    throw new AppError(
      "forbidden",
      "Someone else is driving this session now. Stop working on it; check_inbox says who took over.",
    );
  }
}

// Steps the driver reports. Returns any corrections that arrived meanwhile, so the agent sees them
// in the same call instead of on its next inbox check.
export async function recordLiveSessionEvents(
  agent: Agent,
  sessionId: string,
  events: { kind: AgentEventKind; text: string }[],
): Promise<{ lastSeq: number; steers: NoticeView[] }> {
  if (events.length === 0) throw new AppError("invalid_input", "Send at least one event.");
  if (events.length > MAX_SESSION_BATCH) {
    throw new AppError("invalid_input", `Send at most ${MAX_SESSION_BATCH} events at a time.`);
  }
  const cleaned = events.map((event) => ({
    kind: event.kind,
    text: cleanText(event.text, "event"),
    agentId: agent.id,
  }));
  await rateLimit(`live-session-events:${sessionId}`, EVENTS_PER_MINUTE, 60);
  const session = await db.transaction(async (tx) => {
    const session = await lockSession(tx, sessionId);
    requireDriver(agent, session);
    const lastSeq = await insertEvents(tx, session, await liveSessionKey(session), cleaned);
    return { ...session, lastSeq };
  });
  await announce(session, "updated");
  return { lastSeq: session.lastSeq, steers: await takeSessionSteers(agent, sessionId) };
}

export async function liveSessionSteers(agent: Agent, sessionId: string): Promise<NoticeView[]> {
  const session = await loadSession(sessionId);
  requireDriver(agent, session);
  return takeSessionSteers(agent, sessionId);
}

export async function endLiveSession(
  agent: Agent,
  sessionId: string,
  input: { summary: string; next?: string | undefined },
): Promise<LiveSessionView> {
  const summary = cleanText(input.summary, "summary");
  const next = input.next?.trim() ? cleanText(input.next, "next steps") : null;
  const handle = formatHandle(agent.handle);
  const { session, recorded } = await db.transaction(async (tx) => {
    const session = await lockSession(tx, sessionId);
    requireDriver(agent, session);
    const key = await liveSessionKey(session);
    const lastSeq = await insertEvents(tx, session, key, [
      {
        kind: "handoff",
        agentId: agent.id,
        text: next ? `${summary}\nNext: ${next}` : summary,
      },
      { kind: "status", agentId: agent.id, text: `${handle} ended the session.` },
    ]);
    const endedAt = new Date();
    await tx
      .update(liveSessions)
      .set({ status: "ended", endedAt, updatedAt: endedAt })
      .where(eq(liveSessions.id, session.id));
    const recorded = await appendLedgerEvent(tx, agent, {
      type: "session.ended",
      actor: "agent",
      conversationId: session.groupId,
      data: { sessionId: session.id, summary, ...(next && { next }) },
    });
    return { session: { ...session, lastSeq, status: "ended" }, recorded };
  });
  await broadcast([recorded]);
  await announce(session, "ended");
  return sessionView(await loadSession(session.id));
}

async function mayTakeOver(agent: Agent, session: LiveSession): Promise<boolean> {
  if (agent.ownerId === session.ownerId) return true;
  const driver = await agentById(session.driverId);
  if (driver && driver.ownerId === agent.ownerId) return true;
  return session.groupId ? isActiveMember(session.groupId, agent.id) : false;
}

export async function takeOverLiveSession(
  agent: Agent,
  sessionId: string,
): Promise<LiveSessionView> {
  const before = await loadSession(sessionId);
  if (before.status !== "live") {
    throw new AppError("conflict", "This session has ended, so there is nothing to take over.");
  }
  if (before.driverId === agent.id) {
    throw new AppError("conflict", "You're already driving this session.");
  }
  if (!(await mayTakeOver(agent, before))) {
    throw new AppError("not_found", "There is no such live session.");
  }
  const handle = formatHandle(agent.handle);
  const { session, recorded } = await db.transaction(async (tx) => {
    const session = await lockSession(tx, sessionId);
    if (session.status !== "live" || session.driverId === agent.id) {
      throw new AppError("conflict", "The session changed meanwhile. Look at it again.");
    }
    const previous = session.driverId ? await agentById(session.driverId) : null;
    const key = await liveSessionKey(session);
    const title = key.open(session.title, titleContext(session.id)) ?? "";
    const lastSeq = await insertEvents(tx, session, key, [
      {
        kind: "status",
        agentId: agent.id,
        text: previous
          ? `${handle} took over from ${formatHandle(previous.handle)}.`
          : `${handle} took over the session.`,
      },
    ]);
    await tx
      .update(liveSessions)
      .set({ driverId: agent.id, updatedAt: new Date() })
      .where(eq(liveSessions.id, session.id));
    const recorded: RecordedEvent[] = [
      await appendLedgerEvent(tx, agent, {
        type: "session.taken_over",
        actor: "agent",
        conversationId: session.groupId,
        data: {
          sessionId: session.id,
          title,
          ...(previous && { from: formatHandle(previous.handle) }),
        },
      }),
    ];
    if (previous) {
      recorded.push(
        await createNotice(tx, previous, {
          kind: "session.taken_over",
          actor: agent,
          conversationId: session.groupId,
          planId: null,
          liveSessionId: session.id,
          taskKey: null,
          text: `${handle} took over the live session "${title}" (session ${session.id}). Stop working on it: what you report from now on is not accepted.`,
        }),
      );
    }
    return { session: { ...session, lastSeq, driverId: agent.id }, recorded };
  });
  await broadcast(recorded);
  await announce(session, "taken_over");
  return sessionView(await loadSession(session.id));
}

// A correction from a person watching the session, sent from the dashboard through one of their
// agents that can see it. It reaches the driver like a notice and wakes it up.
export async function steerLiveSession(
  through: Agent,
  sessionId: string,
  rawText: string,
): Promise<LiveSessionView> {
  const text = cleanText(rawText, "correction");
  const visible = await visibleSession(through, sessionId);
  if (visible.status !== "live") {
    throw new AppError("conflict", "This session has ended, so there's no one to correct.");
  }
  await rateLimit(`live-session-steers:${through.ownerId}`, 60, 3600);
  const { session, recorded } = await db.transaction(async (tx) => {
    const session = await lockSession(tx, sessionId);
    const driver = await agentById(session.driverId);
    if (session.status !== "live" || !driver) {
      throw new AppError("conflict", "This session has no one driving it right now.");
    }
    const key = await liveSessionKey(session);
    const title = key.open(session.title, titleContext(session.id)) ?? "";
    const group = session.groupId
      ? await tx
          .select({ name: conversations.name })
          .from(conversations)
          .where(eq(conversations.id, session.groupId))
          .then(([row]) => (row?.name ? formatGroupName(row.name) : null))
      : null;
    const ownOwner = through.ownerId === driver.ownerId;
    const lastSeq = await insertEvents(tx, session, key, [
      { kind: "steer", agentId: through.id, ownerId: through.ownerId, text },
    ]);
    const recorded: RecordedEvent[] = [
      await createNotice(tx, driver, {
        kind: "session.steer",
        actor: ownOwner ? null : through,
        actorKind: ownOwner ? "owner" : "peer",
        conversationId: session.groupId,
        planId: null,
        liveSessionId: session.id,
        taskKey: null,
        text: ownOwner
          ? `Your owner, watching your live session "${title}", says: ${text}`
          : `The person behind ${formatHandle(through.handle)}, watching your live session "${title}"${group ? ` in ${group}` : ""}, says: ${text}`,
      }),
      await appendLedgerEvent(tx, through, {
        type: "session.steered",
        actor: "owner",
        conversationId: session.groupId,
        data: { sessionId: session.id, title, driver: formatHandle(driver.handle), text },
      }),
    ];
    return { session: { ...session, lastSeq }, recorded };
  });
  await broadcast(recorded);
  await announce(session, "updated");
  return sessionView(await loadSession(session.id));
}

export async function getLiveSession(
  agent: Agent,
  sessionId: string,
  options: { after?: number | undefined } = {},
): Promise<LiveSessionView> {
  return sessionView(await visibleSession(agent, sessionId), options);
}

// Sessions an agent drives, started, or can watch through its groups; newest activity first.
export async function listLiveSessions(agent: Agent): Promise<Omit<LiveSessionView, "events">[]> {
  const groups = await db
    .select({ id: conversationMembers.conversationId })
    .from(conversationMembers)
    .where(
      and(eq(conversationMembers.agentId, agent.id), eq(conversationMembers.status, "active")),
    );
  const groupIds = groups.map((group) => group.id);
  const rows = await db
    .select()
    .from(liveSessions)
    .where(
      or(
        eq(liveSessions.driverId, agent.id),
        eq(liveSessions.startedBy, agent.id),
        ...(groupIds.length ? [inArray(liveSessions.groupId, groupIds)] : []),
      ),
    )
    .orderBy(desc(liveSessions.updatedAt))
    .limit(50);
  const summaries = await views(rows);
  return rows.flatMap((row) => {
    const summary = summaries.get(row.id);
    return summary ? [summary] : [];
  });
}
