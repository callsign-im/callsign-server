import { and, asc, desc, eq, gt, inArray, lt, lte } from "drizzle-orm";
import { db, type Executor, type Tx } from "../db/client.ts";
import { agents, ledgerEvents, type Agent, type LedgerEvent } from "../db/schema.ts";
import { canonicalJson, sha256 } from "../lib/crypto.ts";
import type { DataKey } from "../lib/encryption.ts";
import { publishToOwner } from "../lib/events.ts";
import { uuidv7 } from "../lib/ids.ts";
import { AppError } from "./errors.ts";
import { formatHandle } from "./handles.ts";
import { ownerKey } from "./keys.ts";

export type LedgerEventType =
  | "agent.created"
  | "agent.updated"
  | "token.created"
  | "token.revoked"
  | "request.sent"
  | "request.received"
  | "request.accepted"
  | "request.declined"
  | "contact.saved"
  | "contact.blocked"
  | "contact.unblocked"
  | "message.sent"
  | "message.received"
  | "action.logged"
  | "group.created"
  | "group.member.invited"
  | "group.invited"
  | "group.joined"
  | "group.declined"
  | "group.left"
  | "group.member.removed"
  | "group.removed"
  | "owner.asked"
  | "owner.answered"
  | "invitation.sent"
  | "invitation.accepted"
  | "subscription.created"
  | "subscription.removed"
  | "plan.created"
  | "plan.tasks.added"
  | "task.updated"
  | "notice.received"
  | "follow_up.scheduled"
  | "handoff.created"
  | "session.started"
  | "session.steered"
  | "session.taken_over"
  | "session.ended";

export type Actor = "agent" | "owner" | "peer";

export type LedgerAgent = Pick<Agent, "id" | "ownerId" | "handle">;

export type LedgerEntry = Omit<LedgerEvent, "data"> & { data: Record<string, unknown> };

export type RecordedEvent = { agent: LedgerAgent; event: LedgerEntry };

type NewLedgerEvent = {
  type: LedgerEventType;
  actor: Actor;
  conversationId?: string | null;
  data: Record<string, unknown>;
};

const dataContext = (eventId: string) => `ledger_events.data:${eventId}`;

function openLedgerEvent(key: DataKey, event: LedgerEvent): LedgerEntry {
  const data = JSON.parse(key.open(event.data, dataContext(event.id))) as Record<string, unknown>;
  return { ...event, data };
}

function isIntact(key: DataKey, event: LedgerEvent): boolean {
  try {
    return hashLedgerEvent(openLedgerEvent(key, event)) === event.hash;
  } catch {
    return false;
  }
}

export function hashLedgerEvent(event: Omit<LedgerEntry, "hash">): string {
  return sha256(
    canonicalJson({
      agentId: event.agentId,
      seq: event.seq,
      id: event.id,
      type: event.type,
      actor: event.actor,
      conversationId: event.conversationId,
      data: event.data,
      prevHash: event.prevHash,
      createdAt: event.createdAt.toISOString(),
    }),
  );
}

export async function appendLedgerEvent(
  tx: Tx,
  agent: LedgerAgent,
  input: NewLedgerEvent,
): Promise<RecordedEvent> {
  const [head] = await tx
    .select({ seq: agents.ledgerSeq, hash: agents.ledgerHead })
    .from(agents)
    .where(eq(agents.id, agent.id))
    .for("update");
  if (!head) throw new AppError("not_found", "Agent not found.");

  const unsigned = {
    agentId: agent.id,
    seq: head.seq + 1,
    id: uuidv7(),
    type: input.type,
    actor: input.actor,
    conversationId: input.conversationId ?? null,
    data: input.data,
    prevHash: head.hash,
    createdAt: new Date(),
  };
  const event = { ...unsigned, hash: hashLedgerEvent(unsigned) };
  const key = await ownerKey(agent.ownerId, tx);

  await tx
    .insert(ledgerEvents)
    .values({ ...event, data: key.seal(JSON.stringify(event.data), dataContext(event.id)) });
  await tx
    .update(agents)
    .set({ ledgerSeq: event.seq, ledgerHead: event.hash })
    .where(eq(agents.id, agent.id));

  return { agent, event };
}

export async function broadcast(recorded: RecordedEvent[]): Promise<void> {
  await Promise.all(
    recorded.map(({ agent, event }) =>
      publishToOwner(agent.ownerId, {
        type: "ledger",
        agent: formatHandle(agent.handle),
        event: serializeLedgerEvent(event, agent.handle),
      }),
    ),
  );
}

export function serializeLedgerEvent(event: LedgerEntry, handle: string) {
  return {
    id: event.id,
    agent: formatHandle(handle),
    seq: event.seq,
    type: event.type,
    actor: event.actor,
    conversationId: event.conversationId,
    data: event.data,
    prevHash: event.prevHash,
    hash: event.hash,
    createdAt: event.createdAt.toISOString(),
  };
}

export async function listLedger(
  agent: LedgerAgent,
  options: { before?: number; limit: number },
  executor: Executor = db,
): Promise<LedgerEntry[]> {
  const key = await ownerKey(agent.ownerId, executor);
  const events = await executor
    .select()
    .from(ledgerEvents)
    .where(
      and(
        eq(ledgerEvents.agentId, agent.id),
        options.before === undefined ? undefined : lt(ledgerEvents.seq, options.before),
      ),
    )
    .orderBy(desc(ledgerEvents.seq))
    .limit(options.limit);
  return events.map((event) => openLedgerEvent(key, event));
}

export async function listLedgerAfter(
  agent: LedgerAgent,
  options: { after: number; upTo: number; types: LedgerEventType[]; limit: number },
): Promise<LedgerEntry[]> {
  const key = await ownerKey(agent.ownerId);
  const events = await db
    .select()
    .from(ledgerEvents)
    .where(
      and(
        eq(ledgerEvents.agentId, agent.id),
        gt(ledgerEvents.seq, options.after),
        lte(ledgerEvents.seq, options.upTo),
        inArray(ledgerEvents.type, options.types),
      ),
    )
    .orderBy(asc(ledgerEvents.seq))
    .limit(options.limit);
  return events.map((event) => openLedgerEvent(key, event));
}

export async function ledgerHead(agentId: string): Promise<number> {
  const [head] = await db
    .select({ seq: agents.ledgerSeq })
    .from(agents)
    .where(eq(agents.id, agentId));
  return head?.seq ?? 0;
}

export async function listOwnerActivity(
  ownerId: string,
  options: { before?: Date; limit: number },
): Promise<{ event: LedgerEntry; handle: string }[]> {
  const key = await ownerKey(ownerId);
  const rows = await db
    .select({ event: ledgerEvents, handle: agents.handle })
    .from(ledgerEvents)
    .innerJoin(agents, eq(agents.id, ledgerEvents.agentId))
    .where(
      and(
        eq(agents.ownerId, ownerId),
        options.before === undefined ? undefined : lt(ledgerEvents.createdAt, options.before),
      ),
    )
    .orderBy(desc(ledgerEvents.createdAt), desc(ledgerEvents.seq))
    .limit(options.limit);
  return rows.map(({ event, handle }) => ({ event: openLedgerEvent(key, event), handle }));
}

export async function exportLedger(agent: LedgerAgent) {
  const key = await ownerKey(agent.ownerId);
  const events = await db
    .select()
    .from(ledgerEvents)
    .where(eq(ledgerEvents.agentId, agent.id))
    .orderBy(asc(ledgerEvents.seq));
  return events.map((event) => serializeLedgerEvent(openLedgerEvent(key, event), agent.handle));
}

export type LedgerVerification = {
  valid: boolean;
  events: number;
  head: string | null;
  brokenAtSeq: number | null;
};

const VERIFY_BATCH = 500;

export async function verifyLedger(agent: LedgerAgent): Promise<LedgerVerification> {
  const key = await ownerKey(agent.ownerId);
  let previous: string | null = null;
  let checked = 0;

  for (;;) {
    const batch = await db
      .select()
      .from(ledgerEvents)
      .where(and(eq(ledgerEvents.agentId, agent.id), gt(ledgerEvents.seq, checked)))
      .orderBy(asc(ledgerEvents.seq))
      .limit(VERIFY_BATCH);

    for (const event of batch) {
      const intact =
        event.seq === checked + 1 && event.prevHash === previous && isIntact(key, event);
      if (!intact) {
        return { valid: false, events: checked, head: previous, brokenAtSeq: event.seq };
      }
      previous = event.hash;
      checked = event.seq;
    }
    if (batch.length < VERIFY_BATCH) break;
  }

  const [head] = await db
    .select({ seq: agents.ledgerSeq, head: agents.ledgerHead })
    .from(agents)
    .where(eq(agents.id, agent.id));
  const consistent = head?.seq === checked && head.head === previous;

  return {
    valid: consistent,
    events: checked,
    head: previous,
    brokenAtSeq: consistent ? null : checked + 1,
  };
}
