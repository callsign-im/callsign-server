import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db, type Tx } from "../db/client.ts";
import {
  agents,
  conversationMembers,
  conversations,
  planTasks,
  plans,
  type Agent,
  type Conversation,
  type Plan,
  type PlanTask,
} from "../db/schema.ts";
import { enqueue, type JobPayloads } from "../jobs/queue.ts";
import type { DataKey } from "../lib/encryption.ts";
import { uuidv7 } from "../lib/ids.ts";
import { rateLimit } from "../lib/rate-limit.ts";
import { findAgentByHandle } from "./agents.ts";
import { bumpInbox, directKey } from "./conversations.ts";
import { AppError } from "./errors.ts";
import { formatGroupName, isGroupRef, normalizeGroupName, resolveGroup } from "./groups.ts";
import { formatHandle, isEmailHandle, normalizeHandle } from "./handles.ts";
import { conversationKey } from "./keys.ts";
import { appendLedgerEvent, broadcast, type RecordedEvent } from "./ledger.ts";
import { createNotice, type NoticeKind } from "./notices.ts";

export const MAX_TASKS = 50;
export const MAX_TITLE_LENGTH = 200;
export const MAX_DETAILS_LENGTH = 2000;
export const MAX_NOTE_LENGTH = 1000;
const MAX_DUE_MS = 366 * 86_400_000;
const TASK_KEY = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export const TASK_STATUSES = ["todo", "in_progress", "done", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export type TaskInput = {
  key?: string | undefined;
  title: string;
  details?: string | undefined;
  assignee?: string | undefined;
  dependsOn?: string[] | undefined;
  due?: string | undefined;
};

export type TaskView = {
  key: string;
  title: string;
  details: string | null;
  assignee: string | null;
  dependsOn: string[];
  status: TaskStatus;
  ready: boolean;
  waitingOn: string[];
  note: string | null;
  dueAt: string | null;
  overdue: boolean;
  completedAt: string | null;
  updatedAt: string;
};

export type PlanView = {
  id: string;
  title: string;
  with: string | null;
  group: string | null;
  conversationId: string;
  createdBy: string | null;
  status: "active" | "done";
  progress: { done: number; total: number };
  createdAt: string;
  updatedAt: string;
  tasks: TaskView[];
};

export const titleContext = (planId: string) => `plans.title:${planId}`;
const taskContext = (planId: string, key: string, field: "title" | "details" | "note") =>
  `plan_tasks.${field}:${planId}:${key}`;

const finished = (status: string) => status === "done" || status === "cancelled";

type Space = { conversation: Conversation; members: Agent[] };

async function activeMembers(conversationId: string): Promise<Agent[]> {
  const rows = await db
    .select({ agent: agents })
    .from(conversationMembers)
    .innerJoin(agents, eq(agents.id, conversationMembers.agentId))
    .where(
      and(
        eq(conversationMembers.conversationId, conversationId),
        eq(conversationMembers.status, "active"),
      ),
    );
  return rows.map((row) => row.agent);
}

// Plans live in a conversation both sides accepted, or in a group the agent belongs to.
export async function spaceFor(agent: Agent, target: string): Promise<Space> {
  const group = isGroupRef(target);
  const name = group
    ? formatGroupName(normalizeGroupName(target))
    : formatHandle(normalizeHandle(target));
  let conversation: Conversation | undefined;
  if (group) {
    conversation = await resolveGroup(target);
  } else {
    const peer = await findAgentByHandle(normalizeHandle(target));
    if (!peer) throw new AppError("not_found", `No agent is registered as ${name}.`);
    if (peer.id === agent.id) {
      throw new AppError("invalid_input", "Share a plan with another agent or a group.");
    }
    if (isEmailHandle(peer.handle)) {
      throw new AppError("invalid_input", "Plans are shared with agents, not email addresses.");
    }
    [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.directKey, directKey(agent.id, peer.id)));
  }
  const members = conversation ? await activeMembers(conversation.id) : [];
  if (!conversation || !members.some((member) => member.id === agent.id)) {
    throw new AppError(
      "forbidden",
      group
        ? `You're not a member of ${name}.`
        : `Plans are shared in conversations both sides accepted. Message ${name} first.`,
    );
  }
  if (!group && members.length < 2) {
    throw new AppError("forbidden", `${name} hasn't accepted your conversation yet.`);
  }
  return { conversation, members };
}

function parseDue(raw: string | undefined): Date | null {
  if (raw === undefined || raw.trim() === "") return null;
  const value = raw.trim();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T23:59:59Z`) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new AppError("invalid_input", `"${raw}" isn't a date. Use ISO 8601, e.g. 2026-11-03.`);
  }
  if (date.getTime() - Date.now() > MAX_DUE_MS) {
    throw new AppError("invalid_input", "Due dates can be up to a year ahead.");
  }
  return date;
}

function cleanText(raw: string | undefined, max: number, what: string): string | null {
  const text = raw?.trim();
  if (!text) return null;
  if (text.length > max)
    throw new AppError("invalid_input", `${what} is limited to ${max} characters.`);
  return text;
}

type Draft = {
  key: string;
  title: string;
  details: string | null;
  assignee: Agent;
  dependsOn: string[];
  dueAt: Date | null;
};

type TaskNode = { key: string; status: string; dependsOn: string[] };

function assertAcyclic(nodes: TaskNode[]) {
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const state = new Map<string, "visiting" | "done">();
  const visit = (key: string, path: string[]) => {
    if (state.get(key) === "done") return;
    if (state.get(key) === "visiting") {
      throw new AppError(
        "invalid_input",
        `Tasks depend on each other in a loop: ${[...path, key].join(" → ")}.`,
      );
    }
    state.set(key, "visiting");
    for (const dep of byKey.get(key)?.dependsOn ?? []) visit(dep, [...path, key]);
    state.set(key, "done");
  };
  for (const node of nodes) visit(node.key, []);
}

function draftTasks(
  inputs: TaskInput[],
  existing: TaskNode[],
  members: Agent[],
  actor: Agent,
): Draft[] {
  if (inputs.length === 0) throw new AppError("invalid_input", "Add at least one task.");
  if (existing.length + inputs.length > MAX_TASKS) {
    throw new AppError("invalid_input", `A plan holds up to ${MAX_TASKS} tasks.`);
  }
  const taken = new Set(existing.map((task) => task.key));
  let counter = existing.length;
  const drafts = inputs.map((input) => {
    let key = input.key?.trim().toLowerCase();
    if (key) {
      if (!TASK_KEY.test(key)) {
        throw new AppError(
          "invalid_input",
          `Task ids use letters, numbers, - and _ (up to 32): "${input.key}" doesn't.`,
        );
      }
    } else {
      do key = `t${++counter}`;
      while (taken.has(key));
    }
    if (taken.has(key)) throw new AppError("invalid_input", `Two tasks use the id "${key}".`);
    taken.add(key);
    const title = cleanText(input.title, MAX_TITLE_LENGTH, "A task title");
    if (!title) throw new AppError("invalid_input", "Every task needs a title.");
    const assignee = input.assignee
      ? members.find((member) => member.handle === normalizeHandle(input.assignee ?? ""))
      : actor;
    if (!assignee) {
      throw new AppError(
        "invalid_input",
        `${formatHandle(normalizeHandle(input.assignee ?? ""))} isn't in this conversation, so it can't take a task.`,
      );
    }
    return {
      key,
      title,
      details: cleanText(input.details, MAX_DETAILS_LENGTH, "Task details"),
      assignee,
      dependsOn: [...new Set((input.dependsOn ?? []).map((dep) => dep.trim().toLowerCase()))],
      dueAt: parseDue(input.due),
    };
  });
  for (const draft of drafts) {
    for (const dep of draft.dependsOn) {
      if (dep === draft.key) {
        throw new AppError("invalid_input", `Task "${draft.key}" can't depend on itself.`);
      }
      if (!taken.has(dep)) {
        throw new AppError(
          "invalid_input",
          `Task "${draft.key}" depends on "${dep}", which isn't in the plan.`,
        );
      }
    }
  }
  assertAcyclic([...existing, ...drafts.map((d) => ({ ...d, status: "todo" }))]);
  return drafts;
}

function waitingOn(task: { dependsOn: string[] }, all: TaskNode[]): string[] {
  const byKey = new Map(all.map((node) => [node.key, node]));
  return task.dependsOn.filter((dep) => !finished(byKey.get(dep)?.status ?? "done"));
}

const quoted = (key: string, title: string) => `"${key}" ${title}`;
const formatDue = (date: Date) =>
  date
    .toISOString()
    .replace(/:\d\d\.\d{3}Z$/, " UTC")
    .replace("T", " ");

function taskLine(draft: { key: string; title: string; dueAt: Date | null }, waits: string[]) {
  const state = waits.length ? `waiting on ${waits.map((k) => `"${k}"`).join(", ")}` : "ready";
  return `${quoted(draft.key, draft.title)} (${state}${draft.dueAt ? `, due ${formatDue(draft.dueAt)}` : ""})`;
}

export async function loadPlan(agent: Agent, planId: string) {
  const [plan] = await db.select().from(plans).where(eq(plans.id, planId));
  if (!plan) throw new AppError("not_found", "Plan not found.");
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, plan.conversationId));
  const members = conversation ? await activeMembers(conversation.id) : [];
  if (!conversation || !members.some((member) => member.id === agent.id)) {
    throw new AppError("not_found", "Plan not found.");
  }
  const tasks = await db
    .select()
    .from(planTasks)
    .where(eq(planTasks.planId, plan.id))
    .orderBy(asc(planTasks.position));
  return { plan, conversation, members, tasks, key: await conversationKey(conversation) };
}

async function handlesById(ids: (string | null)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => id !== null))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: agents.id, handle: agents.handle })
    .from(agents)
    .where(inArray(agents.id, unique));
  return new Map(rows.map((row) => [row.id, formatHandle(row.handle)]));
}

function viewPlan(
  viewer: Agent,
  plan: Plan,
  conversation: Conversation,
  members: Agent[],
  tasks: PlanTask[],
  key: DataKey,
  handles: Map<string, string>,
): PlanView {
  const now = Date.now();
  const nodes = tasks.map((task) => ({
    key: task.key,
    status: task.status,
    dependsOn: task.dependsOn,
  }));
  const views = tasks.map((task): TaskView => {
    const waits = waitingOn(task, nodes);
    return {
      key: task.key,
      title: key.open(task.title, taskContext(plan.id, task.key, "title")) ?? "",
      details: key.open(task.details, taskContext(plan.id, task.key, "details")),
      assignee: task.assigneeId ? (handles.get(task.assigneeId) ?? null) : null,
      dependsOn: task.dependsOn,
      status: task.status as TaskStatus,
      ready: !finished(task.status) && waits.length === 0,
      waitingOn: finished(task.status) ? [] : waits,
      note: key.open(task.note, taskContext(plan.id, task.key, "note")),
      dueAt: task.dueAt?.toISOString() ?? null,
      overdue: !finished(task.status) && task.dueAt !== null && task.dueAt.getTime() < now,
      completedAt: task.completedAt?.toISOString() ?? null,
      updatedAt: task.updatedAt.toISOString(),
    };
  });
  const done = tasks.filter((task) => finished(task.status)).length;
  const other = members.find((member) => member.id !== viewer.id);
  return {
    id: plan.id,
    title: key.open(plan.title, titleContext(plan.id)) ?? "",
    with: conversation.kind === "group" ? null : other ? formatHandle(other.handle) : null,
    group:
      conversation.kind === "group" && conversation.name
        ? formatGroupName(conversation.name)
        : null,
    conversationId: conversation.id,
    createdBy: plan.createdBy ? (handles.get(plan.createdBy) ?? null) : null,
    status: tasks.length > 0 && done === tasks.length ? "done" : "active",
    progress: { done, total: tasks.length },
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
    tasks: views,
  };
}

async function viewFor(agent: Agent, planId: string): Promise<PlanView> {
  const { plan, conversation, members, tasks, key } = await loadPlan(agent, planId);
  const handles = await handlesById([plan.createdBy, ...tasks.map((task) => task.assigneeId)]);
  return viewPlan(agent, plan, conversation, members, tasks, key, handles);
}

async function scheduleDue(tx: Tx, planId: string, key: string, dueAt: Date | null) {
  if (!dueAt) return;
  await enqueue(tx, "task.due", { planId, key, dueAt: dueAt.toISOString() }, { runAt: dueAt });
}

type Delivery = {
  recipient: Agent;
  kind: NoticeKind;
  taskKey: string | null;
  text: string;
};

async function deliver(
  tx: Tx,
  actor: Agent | null,
  plan: Plan,
  deliveries: Delivery[],
): Promise<RecordedEvent[]> {
  const recorded: RecordedEvent[] = [];
  for (const delivery of deliveries) {
    recorded.push(
      await createNotice(tx, delivery.recipient, {
        kind: delivery.kind,
        actor,
        conversationId: plan.conversationId,
        planId: plan.id,
        taskKey: delivery.taskKey,
        text: delivery.text,
      }),
    );
  }
  return recorded;
}

async function finish(recorded: RecordedEvent[], deliveries: Delivery[]) {
  await broadcast(recorded);
  for (const id of new Set(deliveries.map((delivery) => delivery.recipient.id))) {
    await bumpInbox(id);
  }
}

export async function createPlan(
  agent: Agent,
  input: { with: string; title: string; tasks: TaskInput[] },
): Promise<PlanView> {
  await rateLimit(`plans:${agent.id}`, 30, 3600);
  const title = cleanText(input.title, MAX_TITLE_LENGTH, "A plan title");
  if (!title) throw new AppError("invalid_input", "Give the plan a title.");
  const { conversation, members } = await spaceFor(agent, input.with);
  const drafts = draftTasks(input.tasks, [], members, agent);
  const key = await conversationKey(conversation);
  const id = uuidv7();
  const actor = formatHandle(agent.handle);
  const where =
    conversation.kind === "group" && conversation.name
      ? ` in ${formatGroupName(conversation.name)}`
      : "";
  const nodes = drafts.map((draft) => ({ ...draft, status: "todo" }));

  const recipients =
    conversation.kind === "group"
      ? members.filter((m) => m.id !== agent.id && drafts.some((d) => d.assignee.id === m.id))
      : members.filter((m) => m.id !== agent.id);
  const deliveries = recipients.map((recipient): Delivery => {
    const mine = drafts.filter((draft) => draft.assignee.id === recipient.id);
    return {
      recipient,
      kind: "plan.shared",
      taskKey: null,
      text: [
        `${actor} shared the plan "${title}" (plan ${id})${where} with ${drafts.length} task${drafts.length === 1 ? "" : "s"}.`,
        mine.length
          ? `Your tasks: ${mine.map((d) => taskLine(d, waitingOn(d, nodes))).join("; ")}.`
          : "None are assigned to you.",
        "Call get_plan to see the whole plan.",
      ].join(" "),
    };
  });

  const recorded = await db.transaction(async (tx) => {
    const [plan] = await tx
      .insert(plans)
      .values({
        id,
        conversationId: conversation.id,
        createdBy: agent.id,
        title: key.seal(title, titleContext(id)),
      })
      .returning();
    if (!plan) throw new Error("plan insert returned no row");
    await tx.insert(planTasks).values(
      drafts.map((draft, position) => ({
        planId: id,
        key: draft.key,
        position,
        title: key.seal(draft.title, taskContext(id, draft.key, "title")),
        details: key.seal(draft.details, taskContext(id, draft.key, "details")),
        assigneeId: draft.assignee.id,
        dependsOn: draft.dependsOn,
        dueAt: draft.dueAt,
      })),
    );
    for (const draft of drafts) await scheduleDue(tx, id, draft.key, draft.dueAt);
    return [
      await appendLedgerEvent(tx, agent, {
        type: "plan.created",
        actor: "agent",
        conversationId: conversation.id,
        data: { planId: id, title, tasks: drafts.map((d) => d.key) },
      }),
      ...(await deliver(tx, agent, plan, deliveries)),
    ];
  });
  await finish(recorded, deliveries);
  return viewFor(agent, id);
}

export async function addTasks(
  agent: Agent,
  planId: string,
  inputs: TaskInput[],
): Promise<PlanView> {
  await rateLimit(`plans:${agent.id}`, 30, 3600);
  const { plan, members, tasks, key } = await loadPlan(agent, planId);
  const existing = tasks.map((task) => ({
    key: task.key,
    status: task.status,
    dependsOn: task.dependsOn,
  }));
  const drafts = draftTasks(inputs, existing, members, agent);
  const planTitle = key.open(plan.title, titleContext(plan.id)) ?? "";
  const nodes = [...existing, ...drafts.map((draft) => ({ ...draft, status: "todo" }))];
  const actor = formatHandle(agent.handle);
  const deliveries = members
    .filter((m) => m.id !== agent.id && drafts.some((d) => d.assignee.id === m.id))
    .map((recipient): Delivery => {
      const mine = drafts.filter((draft) => draft.assignee.id === recipient.id);
      return {
        recipient,
        kind: "task.assigned",
        taskKey: mine.length === 1 ? (mine[0]?.key ?? null) : null,
        text: `${actor} added ${mine.length === 1 ? "a task" : "tasks"} for you to the plan "${planTitle}" (plan ${plan.id}): ${mine.map((d) => taskLine(d, waitingOn(d, nodes))).join("; ")}.`,
      };
    });

  const recorded = await db.transaction(async (tx) => {
    await tx.insert(planTasks).values(
      drafts.map((draft, index) => ({
        planId: plan.id,
        key: draft.key,
        position: tasks.length + index,
        title: key.seal(draft.title, taskContext(plan.id, draft.key, "title")),
        details: key.seal(draft.details, taskContext(plan.id, draft.key, "details")),
        assigneeId: draft.assignee.id,
        dependsOn: draft.dependsOn,
        dueAt: draft.dueAt,
      })),
    );
    await tx.update(plans).set({ updatedAt: new Date() }).where(eq(plans.id, plan.id));
    for (const draft of drafts) await scheduleDue(tx, plan.id, draft.key, draft.dueAt);
    return [
      await appendLedgerEvent(tx, agent, {
        type: "plan.tasks.added",
        actor: "agent",
        conversationId: plan.conversationId,
        data: { planId: plan.id, tasks: drafts.map((d) => d.key) },
      }),
      ...(await deliver(tx, agent, plan, deliveries)),
    ];
  });
  await finish(recorded, deliveries);
  return viewFor(agent, plan.id);
}

export type TaskChange = {
  status?: TaskStatus | undefined;
  note?: string | undefined;
  due?: string | null | undefined;
  assignee?: string | undefined;
};

const VERBS: Record<TaskStatus, string> = {
  done: "finished",
  cancelled: "cancelled",
  in_progress: "started",
  todo: "reopened",
};

export async function updateTask(
  agent: Agent,
  planId: string,
  rawKey: string,
  change: TaskChange,
  by: "agent" | "owner" = "agent",
): Promise<PlanView> {
  await rateLimit(`plan-updates:${agent.id}`, 240, 3600);
  const { plan, conversation, members, tasks, key } = await loadPlan(agent, planId);
  const taskKey = rawKey.trim().toLowerCase();
  const task = tasks.find((t) => t.key === taskKey);
  if (!task) throw new AppError("not_found", `The plan has no task "${taskKey}".`);
  const isCreator = plan.createdBy === agent.id;
  if (task.assigneeId && task.assigneeId !== agent.id && !isCreator) {
    throw new AppError(
      "forbidden",
      "Only the task's assignee or the plan's creator can update it.",
    );
  }
  let assignee: Agent | undefined;
  if (change.assignee !== undefined) {
    if (!isCreator) throw new AppError("forbidden", "Only the plan's creator can reassign tasks.");
    assignee = members.find((m) => m.handle === normalizeHandle(change.assignee ?? ""));
    if (!assignee) {
      throw new AppError(
        "invalid_input",
        `${formatHandle(normalizeHandle(change.assignee))} isn't in this conversation.`,
      );
    }
  }
  const note = cleanText(change.note, MAX_NOTE_LENGTH, "A note");
  const dueAt =
    change.due === undefined ? undefined : change.due === null ? null : parseDue(change.due);
  const status = change.status ?? (task.status as TaskStatus);
  const statusChanged = status !== task.status;
  if (!statusChanged && note === null && dueAt === undefined && !assignee) {
    throw new AppError(
      "invalid_input",
      "Change the status, add a note, set a due date or reassign the task.",
    );
  }

  const before = tasks.map((t) => ({ key: t.key, status: t.status, dependsOn: t.dependsOn }));
  const after = before.map((t) => (t.key === task.key ? { ...t, status } : t));
  const planTitle = key.open(plan.title, titleContext(plan.id)) ?? "";
  const title = (t: PlanTask) => key.open(t.title, taskContext(plan.id, t.key, "title")) ?? "";
  const actor =
    by === "owner" ? `${formatHandle(agent.handle)}'s owner` : formatHandle(agent.handle);
  const noteText = note ? `: "${note}"` : "";
  const byId = new Map(members.map((m) => [m.id, m]));

  const deliveries: Delivery[] = [];
  const notified = new Set<string>([agent.id]);
  if (finished(status) && !finished(task.status)) {
    for (const other of tasks) {
      if (other.key === task.key || finished(other.status) || !other.assigneeId) continue;
      const wasWaiting =
        waitingOn(before.find((t) => t.key === other.key) ?? other, before).length > 0;
      const nowWaiting =
        waitingOn(after.find((t) => t.key === other.key) ?? other, after).length > 0;
      const recipient = byId.get(other.assigneeId);
      if (!wasWaiting || nowWaiting || !recipient || recipient.id === agent.id) continue;
      notified.add(recipient.id);
      deliveries.push({
        recipient,
        kind: "task.ready",
        taskKey: other.key,
        text: `Your task ${quoted(other.key, title(other))} in "${planTitle}" (plan ${plan.id}) is ready: ${actor} ${VERBS[status]} ${quoted(task.key, title(task))}${noteText}.`,
      });
    }
  }
  if (assignee && assignee.id !== agent.id && !notified.has(assignee.id)) {
    notified.add(assignee.id);
    deliveries.push({
      recipient: assignee,
      kind: "task.assigned",
      taskKey: task.key,
      text: `${actor} gave you the task ${quoted(task.key, title(task))} in "${planTitle}" (plan ${plan.id}).`,
    });
  }
  const watchers =
    conversation.kind === "group"
      ? [plan.createdBy, task.assigneeId].flatMap((id) => {
          const member = id ? byId.get(id) : undefined;
          return member ? [member] : [];
        })
      : members;
  const what = statusChanged
    ? VERBS[status]
    : dueAt !== undefined
      ? "moved the due date of"
      : assignee
        ? "reassigned"
        : "added a note to";
  for (const watcher of watchers) {
    if (notified.has(watcher.id)) continue;
    notified.add(watcher.id);
    deliveries.push({
      recipient: watcher,
      kind: "task.updated",
      taskKey: task.key,
      text: `${actor} ${what} ${quoted(task.key, title(task))} in "${planTitle}" (plan ${plan.id})${noteText}.`,
    });
  }

  const recorded = await db.transaction(async (tx) => {
    const now = new Date();
    await tx
      .update(planTasks)
      .set({
        status,
        updatedAt: now,
        completedAt: status === "done" ? (task.completedAt ?? now) : null,
        ...(note !== null && { note: key.seal(note, taskContext(plan.id, task.key, "note")) }),
        ...(dueAt !== undefined && { dueAt }),
        ...(assignee && { assigneeId: assignee.id }),
      })
      .where(and(eq(planTasks.planId, plan.id), eq(planTasks.key, task.key)));
    await tx.update(plans).set({ updatedAt: now }).where(eq(plans.id, plan.id));
    if (dueAt) await scheduleDue(tx, plan.id, task.key, dueAt);
    return [
      await appendLedgerEvent(tx, agent, {
        type: "task.updated",
        actor: by,
        conversationId: plan.conversationId,
        data: {
          planId: plan.id,
          task: task.key,
          status,
          ...(note && { note }),
          ...(dueAt !== undefined && { dueAt: dueAt?.toISOString() ?? null }),
          ...(assignee && { assignee: formatHandle(assignee.handle) }),
        },
      }),
      ...(await deliver(tx, agent, plan, deliveries)),
    ];
  });
  await finish(recorded, deliveries);
  return viewFor(agent, plan.id);
}

export async function getPlan(agent: Agent, planId: string): Promise<PlanView> {
  return viewFor(agent, planId);
}

export async function listPlans(agent: Agent, options: { with?: string | undefined } = {}) {
  const conversationIds = options.with
    ? [(await spaceFor(agent, options.with)).conversation.id]
    : (
        await db
          .select({ id: conversationMembers.conversationId })
          .from(conversationMembers)
          .where(
            and(
              eq(conversationMembers.agentId, agent.id),
              eq(conversationMembers.status, "active"),
            ),
          )
      ).map((row) => row.id);
  if (conversationIds.length === 0) return [];
  const rows = await db
    .select()
    .from(plans)
    .where(inArray(plans.conversationId, conversationIds))
    .orderBy(desc(plans.updatedAt))
    .limit(30);
  const views: PlanView[] = [];
  for (const plan of rows) views.push(await viewFor(agent, plan.id));
  return views;
}

export async function remindOverdueTask(payload: JobPayloads["task.due"]): Promise<void> {
  const [row] = await db
    .select({ task: planTasks, plan: plans })
    .from(planTasks)
    .innerJoin(plans, eq(plans.id, planTasks.planId))
    .where(and(eq(planTasks.planId, payload.planId), eq(planTasks.key, payload.key)));
  if (!row || finished(row.task.status) || row.task.dueAt?.toISOString() !== payload.dueAt) return;
  const { task, plan } = row;
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, plan.conversationId));
  if (!conversation) return;
  const members = await activeMembers(conversation.id);
  const byId = new Map(members.map((m) => [m.id, m]));
  const key = await conversationKey(conversation);
  const planTitle = key.open(plan.title, titleContext(plan.id)) ?? "";
  const label = quoted(
    task.key,
    key.open(task.title, taskContext(plan.id, task.key, "title")) ?? "",
  );
  const due = formatDue(task.dueAt ?? new Date());
  const assignee = task.assigneeId ? byId.get(task.assigneeId) : undefined;
  const creator = plan.createdBy ? byId.get(plan.createdBy) : undefined;

  const deliveries: Delivery[] = [];
  if (assignee) {
    deliveries.push({
      recipient: assignee,
      kind: "task.overdue",
      taskKey: task.key,
      text: `Your task ${label} in "${planTitle}" (plan ${plan.id}) was due ${due} and isn't done. Finish it, or update it with a note and a new due date.`,
    });
  }
  if (creator && creator.id !== assignee?.id) {
    deliveries.push({
      recipient: creator,
      kind: "task.overdue",
      taskKey: task.key,
      text: `${assignee ? `${formatHandle(assignee.handle)}'s task` : "The task"} ${label} in "${planTitle}" (plan ${plan.id}) was due ${due} and isn't done.`,
    });
  }
  if (deliveries.length === 0) return;
  const recorded = await db.transaction((tx) => deliver(tx, null, plan, deliveries));
  await finish(recorded, deliveries);
}

export async function conversationLabel(
  viewer: Agent,
  conversationId: string,
): Promise<string | null> {
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId));
  if (!conversation) return null;
  if (conversation.kind === "group" && conversation.name) return formatGroupName(conversation.name);
  const other = (await activeMembers(conversation.id)).find((m) => m.id !== viewer.id);
  return other ? formatHandle(other.handle) : null;
}
