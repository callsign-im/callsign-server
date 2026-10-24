import { and, asc, count, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.ts";
import { agents, followUps, type Agent } from "../db/schema.ts";
import { enqueue, type JobPayloads } from "../jobs/queue.ts";
import { uuidv7 } from "../lib/ids.ts";
import { rateLimit } from "../lib/rate-limit.ts";
import { bumpInbox } from "./conversations.ts";
import { AppError } from "./errors.ts";
import { ownerKey } from "./keys.ts";
import { appendLedgerEvent, broadcast } from "./ledger.ts";
import { createNotice } from "./notices.ts";
import { conversationLabel, spaceFor } from "./plans.ts";

const MIN_DELAY_MS = 60_000;
const MAX_DELAY_MS = 30 * 86_400_000;
const MAX_PENDING = 50;
const MAX_NOTE_LENGTH = 1000;
const UNITS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

const noteContext = (id: string) => `follow_ups.note:${id}`;

export type FollowUpView = { id: string; dueAt: string; note: string; about: string | null };

// "in" is a delay like 45m, 3h, 2d or 1w; "at" is an ISO 8601 time.
export function followUpTime(input: { in?: string | undefined; at?: string | undefined }): Date {
  let due: Date;
  if (input.in) {
    const match = /^(\d+)\s*(m|min|mins|minutes?|h|hrs?|hours?|d|days?|w|weeks?)$/i.exec(
      input.in.trim(),
    );
    const unit = match?.[2]?.[0]?.toLowerCase();
    if (!match || !unit) {
      throw new AppError(
        "invalid_input",
        `"${input.in}" isn't a delay. Use something like 30m, 4h, 2d or 1w.`,
      );
    }
    due = new Date(Date.now() + Number(match[1]) * (UNITS[unit] ?? 0));
  } else if (input.at) {
    due = new Date(input.at);
    if (Number.isNaN(due.getTime())) {
      throw new AppError("invalid_input", `"${input.at}" isn't a time. Use ISO 8601.`);
    }
  } else {
    throw new AppError("invalid_input", "Say when: in (like 2d) or at (an ISO 8601 time).");
  }
  const delay = due.getTime() - Date.now();
  if (delay < MIN_DELAY_MS - 1000 || delay > MAX_DELAY_MS) {
    throw new AppError("invalid_input", "Follow-ups can be from 1 minute to 30 days ahead.");
  }
  return due;
}

export async function scheduleFollowUp(
  agent: Agent,
  input: {
    in?: string | undefined;
    at?: string | undefined;
    note: string;
    about?: string | undefined;
  },
): Promise<FollowUpView> {
  await rateLimit(`follow-ups:${agent.id}`, 60, 3600);
  const note = input.note.trim();
  if (!note) throw new AppError("invalid_input", "Write what to follow up on.");
  if (note.length > MAX_NOTE_LENGTH) {
    throw new AppError(
      "invalid_input",
      `Follow-up notes are limited to ${MAX_NOTE_LENGTH} characters.`,
    );
  }
  const dueAt = followUpTime(input);
  const [pending] = await db
    .select({ value: count() })
    .from(followUps)
    .where(and(eq(followUps.agentId, agent.id), isNull(followUps.firedAt)));
  if ((pending?.value ?? 0) >= MAX_PENDING) {
    throw new AppError("invalid_input", `You can have up to ${MAX_PENDING} pending follow-ups.`);
  }
  const conversationId = input.about ? (await spaceFor(agent, input.about)).conversation.id : null;
  const id = uuidv7();
  const key = await ownerKey(agent.ownerId);
  const recorded = await db.transaction(async (tx) => {
    await tx.insert(followUps).values({
      id,
      agentId: agent.id,
      conversationId,
      note: key.seal(note, noteContext(id)),
      dueAt,
    });
    await enqueue(tx, "follow_up.due", { followUpId: id }, { runAt: dueAt });
    return appendLedgerEvent(tx, agent, {
      type: "follow_up.scheduled",
      actor: "agent",
      conversationId,
      data: { followUpId: id, dueAt: dueAt.toISOString(), note },
    });
  });
  await broadcast([recorded]);
  return {
    id,
    dueAt: dueAt.toISOString(),
    note,
    about: conversationId ? await conversationLabel(agent, conversationId) : null,
  };
}

export async function listFollowUps(agent: Agent): Promise<FollowUpView[]> {
  const rows = await db
    .select()
    .from(followUps)
    .where(and(eq(followUps.agentId, agent.id), isNull(followUps.firedAt)))
    .orderBy(asc(followUps.dueAt));
  const key = await ownerKey(agent.ownerId);
  const views: FollowUpView[] = [];
  for (const row of rows) {
    views.push({
      id: row.id,
      dueAt: row.dueAt.toISOString(),
      note: key.open(row.note, noteContext(row.id)) ?? "",
      about: row.conversationId ? await conversationLabel(agent, row.conversationId) : null,
    });
  }
  return views;
}

export async function fireFollowUp(payload: JobPayloads["follow_up.due"]): Promise<void> {
  const [row] = await db
    .update(followUps)
    .set({ firedAt: new Date() })
    .where(and(eq(followUps.id, payload.followUpId), isNull(followUps.firedAt)))
    .returning();
  if (!row) return;
  const [agent] = await db.select().from(agents).where(eq(agents.id, row.agentId));
  if (!agent) return;
  const note = (await ownerKey(agent.ownerId)).open(row.note, noteContext(row.id)) ?? "";
  const about = row.conversationId ? await conversationLabel(agent, row.conversationId) : null;
  const recorded = await db.transaction((tx) =>
    createNotice(tx, agent, {
      kind: "follow_up",
      actor: null,
      conversationId: row.conversationId,
      planId: null,
      taskKey: null,
      text: `Follow-up you scheduled${about ? ` about ${about}` : ""}: "${note}"`,
    }),
  );
  await broadcast([recorded]);
  await bumpInbox(agent.id);
}
