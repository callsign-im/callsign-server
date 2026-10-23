import { and, asc, desc, eq, gt, lt } from "drizzle-orm";
import { db, type Executor, type Tx } from "../db/client.ts";
import { agents, ledgerEvents, type Agent, type LedgerEvent } from "../db/schema.ts";
import { canonicalJson, sha256 } from "../lib/crypto.ts";
import { publishToOwner } from "../lib/events.ts";
import { uuidv7 } from "../lib/ids.ts";
import { AppError } from "./errors.ts";
import { formatHandle } from "./handles.ts";

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
  | "action.logged";

export type Actor = "agent" | "owner" | "peer";

export type LedgerAgent = Pick<Agent, "id" | "ownerId" | "handle">;

export type RecordedEvent = { agent: LedgerAgent; event: LedgerEvent };

type NewLedgerEvent = {
  type: LedgerEventType;
  actor: Actor;
  conversationId?: string | null;
  data: Record<string, unknown>;
};

export function hashLedgerEvent(event: Omit<LedgerEvent, "hash">): string {
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

  await tx.insert(ledgerEvents).values(event);
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

export function serializeLedgerEvent(event: LedgerEvent, handle: string) {
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
  agentId: string,
  options: { before?: number; limit: number },
  executor: Executor = db,
): Promise<LedgerEvent[]> {
  return executor
    .select()
    .from(ledgerEvents)
    .where(
      and(
        eq(ledgerEvents.agentId, agentId),
        options.before === undefined ? undefined : lt(ledgerEvents.seq, options.before),
      ),
    )
    .orderBy(desc(ledgerEvents.seq))
    .limit(options.limit);
}

export async function listOwnerActivity(
  ownerId: string,
  options: { before?: Date; limit: number },
): Promise<{ event: LedgerEvent; handle: string }[]> {
  return db
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
}

export type LedgerVerification = {
  valid: boolean;
  events: number;
  head: string | null;
  brokenAtSeq: number | null;
};

const VERIFY_BATCH = 500;

export async function verifyLedger(agentId: string): Promise<LedgerVerification> {
  let previous: string | null = null;
  let checked = 0;

  for (;;) {
    const batch = await db
      .select()
      .from(ledgerEvents)
      .where(and(eq(ledgerEvents.agentId, agentId), gt(ledgerEvents.seq, checked)))
      .orderBy(asc(ledgerEvents.seq))
      .limit(VERIFY_BATCH);

    for (const event of batch) {
      const intact =
        event.seq === checked + 1 &&
        event.prevHash === previous &&
        hashLedgerEvent(event) === event.hash;
      if (!intact) {
        return { valid: false, events: checked, head: previous, brokenAtSeq: event.seq };
      }
      previous = event.hash;
      checked = event.seq;
    }
    if (batch.length < VERIFY_BATCH) break;
  }

  const [agent] = await db
    .select({ seq: agents.ledgerSeq, head: agents.ledgerHead })
    .from(agents)
    .where(eq(agents.id, agentId));
  const consistent = agent?.seq === checked && agent.head === previous;

  return {
    valid: consistent,
    events: checked,
    head: previous,
    brokenAtSeq: consistent ? null : checked + 1,
  };
}
