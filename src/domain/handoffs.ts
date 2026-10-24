import { desc, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.ts";
import { agents, conversations, handoffs, plans, type Agent, type Handoff } from "../db/schema.ts";
import type { DataKey } from "../lib/encryption.ts";
import { uuidv7 } from "../lib/ids.ts";
import { rateLimit } from "../lib/rate-limit.ts";
import { bumpInbox } from "./conversations.ts";
import { AppError } from "./errors.ts";
import { formatHandle } from "./handles.ts";
import { conversationKey, ownerKey } from "./keys.ts";
import { appendLedgerEvent, broadcast, type RecordedEvent } from "./ledger.ts";
import { createNotice } from "./notices.ts";
import { loadPlan, titleContext } from "./plans.ts";

export const MAX_HANDOFF_TEXT = 4000;
export const MAX_HANDOFF_FILES = 20;
export const MAX_HANDOFF_FILE_LENGTH = 500;

export type HandoffView = {
  id: string;
  by: string;
  client: string | null;
  planId: string | null;
  summary: string;
  next: string | null;
  files: string[];
  at: string;
};

export type HandoffInput = {
  summary: string;
  next?: string | undefined;
  files?: string[] | undefined;
  plan?: string | undefined;
};

const fieldContext = (id: string, field: "summary" | "next" | "files") => `handoffs.${field}:${id}`;

function view(key: DataKey, row: Handoff, by: string): HandoffView {
  const files = key.open(row.files, fieldContext(row.id, "files"));
  return {
    id: row.id,
    by,
    client: row.client,
    planId: row.planId,
    summary: key.open(row.summary, fieldContext(row.id, "summary")),
    next: key.open(row.next, fieldContext(row.id, "next")),
    files: files ? (JSON.parse(files) as string[]) : [],
    at: row.createdAt.toISOString(),
  };
}

function cleanFiles(raw: string[] | undefined): string[] {
  const files = [...new Set((raw ?? []).map((file) => file.trim()).filter(Boolean))];
  if (files.length > MAX_HANDOFF_FILES) {
    throw new AppError("invalid_input", `List at most ${MAX_HANDOFF_FILES} files.`);
  }
  if (files.some((file) => file.length > MAX_HANDOFF_FILE_LENGTH)) {
    throw new AppError("invalid_input", "Keep each file path or link shorter.");
  }
  return files;
}

// A handoff is the note an agent leaves when it stops: the next session, in any client, reads it
// on connect. Shared on a plan, it's sealed with the plan's conversation key and its members are
// told about it; otherwise only the agent's owner key opens it.
export async function createHandoff(
  agent: Agent,
  input: HandoffInput,
  client: string | null,
): Promise<HandoffView> {
  const summary = input.summary.trim();
  if (!summary) throw new AppError("invalid_input", "Say where the work stands.");
  const next = input.next?.trim() || null;
  const files = cleanFiles(input.files);
  await rateLimit(`handoffs:${agent.id}`, 60, 3600);

  const loaded = input.plan ? await loadPlan(agent, input.plan) : null;
  const key = loaded ? loaded.key : await ownerKey(agent.ownerId);
  const id = uuidv7();
  const handle = formatHandle(agent.handle);
  const recipients = loaded
    ? loaded.members.filter(
        (member) =>
          member.id !== agent.id &&
          (loaded.conversation.kind !== "group" ||
            member.id === loaded.plan.createdBy ||
            loaded.tasks.some((task) => task.assigneeId === member.id)),
      )
    : [];

  const { row, recorded } = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(handoffs)
      .values({
        id,
        agentId: agent.id,
        planId: loaded?.plan.id ?? null,
        client,
        summary: key.seal(summary, fieldContext(id, "summary")),
        next: key.seal(next, fieldContext(id, "next")),
        files: key.seal(files.length ? JSON.stringify(files) : null, fieldContext(id, "files")),
      })
      .returning();
    if (!row) throw new Error("handoff insert returned no row");
    const recorded: RecordedEvent[] = [
      await appendLedgerEvent(tx, agent, {
        type: "handoff.created",
        actor: "agent",
        conversationId: loaded?.plan.conversationId ?? null,
        data: {
          handoffId: id,
          summary,
          ...(loaded && { planId: loaded.plan.id }),
          ...(client && { client }),
        },
      }),
    ];
    if (loaded) {
      const title = key.open(loaded.plan.title, titleContext(loaded.plan.id));
      for (const recipient of recipients) {
        recorded.push(
          await createNotice(tx, recipient, {
            kind: "handoff",
            actor: agent,
            conversationId: loaded.plan.conversationId,
            planId: loaded.plan.id,
            taskKey: null,
            text: [
              `${handle} left a handoff on "${title}" (plan ${loaded.plan.id}): ${summary}`,
              ...(next ? [`Next: ${next}`] : []),
              ...(files.length ? [`Files: ${files.join(", ")}`] : []),
            ].join("\n"),
          }),
        );
      }
    }
    return { row, recorded };
  });
  await broadcast(recorded);
  await Promise.all(recipients.map((recipient) => bumpInbox(recipient.id)));
  return view(key, row, handle);
}

export async function latestHandoff(agent: Agent): Promise<HandoffView | null> {
  const [found] = await db
    .select({ handoff: handoffs, dataKey: conversations.dataKey, conversationId: conversations.id })
    .from(handoffs)
    .leftJoin(plans, eq(plans.id, handoffs.planId))
    .leftJoin(conversations, eq(conversations.id, plans.conversationId))
    .where(eq(handoffs.agentId, agent.id))
    .orderBy(desc(handoffs.createdAt))
    .limit(1);
  if (!found) return null;
  const key =
    found.conversationId && found.dataKey
      ? await conversationKey({ id: found.conversationId, dataKey: found.dataKey })
      : await ownerKey(agent.ownerId);
  return view(key, found.handoff, formatHandle(agent.handle));
}

// The latest handoff on each plan, for plans the caller already knows the agent belongs to.
export async function planHandoffs(planIds: string[]): Promise<Map<string, HandoffView>> {
  if (planIds.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([handoffs.planId], {
      handoff: handoffs,
      handle: agents.handle,
      conversation: { id: conversations.id, dataKey: conversations.dataKey },
    })
    .from(handoffs)
    .innerJoin(agents, eq(agents.id, handoffs.agentId))
    .innerJoin(plans, eq(plans.id, handoffs.planId))
    .innerJoin(conversations, eq(conversations.id, plans.conversationId))
    .where(inArray(handoffs.planId, planIds))
    .orderBy(handoffs.planId, desc(handoffs.createdAt));
  const views = await Promise.all(
    rows.map(async ({ handoff, handle, conversation }) =>
      view(await conversationKey(conversation), handoff, formatHandle(handle)),
    ),
  );
  return new Map(views.map((handoff) => [handoff.planId ?? "", handoff]));
}
