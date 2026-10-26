import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  lt,
  lte,
  sql,
  type SQL,
} from "drizzle-orm";
import { config } from "../config.ts";
import { db, type Tx } from "../db/client.ts";
import {
  agentNetworks,
  agents,
  heldActions,
  ledgerEvents,
  owners,
  type Agent,
  type HeldAction,
  type HoldKind,
  type HoldStatus,
  type Owner,
} from "../db/schema.ts";
import { enqueue } from "../jobs/queue.ts";
import { randomToken, sha256 } from "../lib/crypto.ts";
import type { DataKey } from "../lib/encryption.ts";
import { uuidv7 } from "../lib/ids.ts";
import { logger } from "../lib/logger.ts";
import { sendMail } from "../lib/mailer.ts";
import { networkOf, normalizeIp } from "../lib/network.ts";
import { assertReachable, findAgentByHandle } from "./agents.ts";
import { raiseAlert } from "./alerts.ts";
import { bumpInbox } from "./conversations.ts";
import { AppError } from "./errors.ts";
import { reserveFiles, unreserveFiles } from "./files.ts";
import {
  createGroup,
  inviteToGroup,
  isGroupRef,
  normalizeGroupName,
  resolveGroup,
} from "./groups.ts";
import type { AgentContext } from "./guard.ts";
import { formatHandle, isEmailHandle, normalizeHandle } from "./handles.ts";
import { invitePerson } from "./invitations.ts";
import { ownerKey } from "./keys.ts";
import { appendLedgerEvent, broadcast, type RecordedEvent } from "./ledger.ts";
import { isFirstContact, sendMessage } from "./messaging.ts";
import { createNotice } from "./notices.ts";
import type { OwnerSession } from "./owners.ts";
import { assertStepUp, ownerHasPasskeys } from "./passkeys.ts";
import { holdsAnything, readPolicy, type Policy } from "./policy.ts";

export type HoldReason =
  | "first_contact"
  | "attachments"
  | "groups"
  | "invite_person"
  | "hourly_limit"
  | "new_network"
  | "tool_write"
  | "queued";

export const REASON_TEXT: Record<HoldReason, string> = {
  first_contact: "it's the first message to someone new",
  attachments: "it sends files",
  groups: "it creates or grows a group",
  invite_person: "it invites someone to Callsign",
  hourly_limit: "it goes over the hourly message limit",
  new_network: "it came from a network the agent hasn't used before",
  tool_write: "it uses a tool that can change things",
  queued: "an earlier action to the same place is waiting for approval",
};

export type HoldRequest =
  | {
      kind: "message";
      input: { to: string; body: string; idempotencyKey?: string; attachments?: string[] };
    }
  | { kind: "group.create"; input: { name: string; members: string[]; note?: string } }
  | { kind: "group.invite"; input: { group: string; handles: string[]; note?: string } }
  | { kind: "invite_person"; input: { email: string; note?: string } }
  | {
      kind: "tool.call";
      input: { tool: string; arguments: Record<string, unknown>; connectionId: string };
      write: boolean;
    };

/** What a held action returns instead of its result. */
export type Held = {
  status: "held_for_approval";
  holdId: string;
  reasons: HoldReason[];
  summary: string;
  expiresAt: string;
  message: string;
};

export function isHeld(value: unknown): value is Held {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { status?: unknown }).status === "held_for_approval"
  );
}

const ACTIVE: HoldStatus[] = ["pending", "approved", "releasing"];
const REPEATED_HOLDS = 5;
const RELEASE_TIMEOUT_MS = 10 * 60_000;
const PAYLOAD_RETENTION_MS = 30 * 86_400_000;
const HOLDS_SHOWN = 100;

const payloadContext = (id: string) => `held_actions.payload:${id}`;
const summaryContext = (id: string) => `held_actions.summary:${id}`;

type Origin = { client: string; ip: string | null; userAgent: string | null };
type StoredPayload = { input: HoldRequest["input"]; origin: Origin };

function excerpt(text: string, length = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
}

function summarize(request: HoldRequest): string {
  switch (request.kind) {
    case "message": {
      const files = request.input.attachments?.length ?? 0;
      const to = isGroupRef(request.input.to)
        ? `#${normalizeGroupName(request.input.to)}`
        : formatHandle(normalizeHandle(request.input.to));
      return `Message to ${to}: “${excerpt(request.input.body)}”${files > 0 ? ` with ${files} ${files === 1 ? "file" : "files"}` : ""}`;
    }
    case "group.create":
      return `Create #${normalizeGroupName(request.input.name)} with ${request.input.members.map((m) => formatHandle(normalizeHandle(m))).join(", ")}`;
    case "group.invite":
      return `Invite ${request.input.handles.map((m) => formatHandle(normalizeHandle(m))).join(", ")} to #${normalizeGroupName(request.input.group)}`;
    case "invite_person":
      return `Invite ${request.input.email.trim().toLowerCase()} to Callsign`;
    case "tool.call":
      return `Use ${request.input.tool}`;
  }
}

// Actions in one lane are released in the order they were made.
function lane(request: HoldRequest): string {
  switch (request.kind) {
    case "message":
      return isGroupRef(request.input.to)
        ? `group:${normalizeGroupName(request.input.to)}`
        : `to:${normalizeHandle(request.input.to)}`;
    case "group.create":
    case "group.invite":
      return `group:${normalizeGroupName(request.kind === "group.create" ? request.input.name : request.input.group)}`;
    case "invite_person":
      return `invite:${request.input.email.trim().toLowerCase()}`;
    case "tool.call":
      return `tool:${request.input.connectionId}`;
  }
}

async function sentLastHour(agentId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(ledgerEvents)
    .where(
      and(
        eq(ledgerEvents.agentId, agentId),
        inArray(ledgerEvents.type, ["message.sent", "request.sent"]),
        gt(ledgerEvents.createdAt, new Date(Date.now() - 3_600_000)),
      ),
    );
  return row?.total ?? 0;
}

/** Whether this request comes from a network the owner hasn't confirmed yet. */
async function onUnconfirmedNetwork(ctx: AgentContext, key: DataKey): Promise<boolean> {
  const ip = ctx.seen ? normalizeIp(ctx.seen.ip) : null;
  if (!ip) return false;
  const digest = key.digest(`network:${(await networkOf(ip)).id}`);
  const known = await db
    .select({ digest: agentNetworks.networkDigest, status: agentNetworks.status })
    .from(agentNetworks)
    .where(eq(agentNetworks.agentId, ctx.agent.id));
  if (known.length === 0) return false;
  return known.find((row) => row.digest === digest)?.status !== "known";
}

// Checks the action could go through, so it fails now instead of after the owner approves.
async function firstContact(sender: Agent, to: string): Promise<boolean> {
  if (isGroupRef(to)) {
    await resolveGroup(to);
    return false;
  }
  const handle = normalizeHandle(to);
  const peer = await findAgentByHandle(handle);
  if (!peer) {
    if (isEmailHandle(handle)) return true;
    throw new AppError("not_found", `No agent is registered as ${formatHandle(handle)}.`);
  }
  if (peer.id === sender.id) throw new AppError("invalid_input", "An agent can't message itself.");
  assertReachable(peer);
  return isFirstContact(sender, peer);
}

async function evaluate(
  ctx: AgentContext,
  request: HoldRequest,
  policy: Policy,
  key: DataKey,
): Promise<HoldReason[]> {
  const { holds } = policy;
  const reasons: HoldReason[] = [];
  if (request.kind === "message") {
    if (holds.firstContact && (await firstContact(ctx.agent, request.input.to))) {
      reasons.push("first_contact");
    }
    if (holds.attachments && (request.input.attachments?.length ?? 0) > 0) {
      reasons.push("attachments");
    }
    if (
      holds.hourlyMessages !== null &&
      (await sentLastHour(ctx.agent.id)) >= holds.hourlyMessages
    ) {
      reasons.push("hourly_limit");
    }
  }
  if (holds.groups && (request.kind === "group.create" || request.kind === "group.invite")) {
    reasons.push("groups");
  }
  if (holds.invitePerson && request.kind === "invite_person") reasons.push("invite_person");
  if (holds.toolWrites && request.kind === "tool.call" && request.write) reasons.push("tool_write");
  if (holds.newNetwork && (await onUnconfirmedNetwork(ctx, key))) reasons.push("new_network");
  return reasons;
}

async function laneBusy(agentId: string, laneDigest: string): Promise<boolean> {
  const [busy] = await db
    .select({ id: heldActions.id })
    .from(heldActions)
    .where(
      and(
        eq(heldActions.agentId, agentId),
        eq(heldActions.laneDigest, laneDigest),
        inArray(heldActions.status, ACTIVE),
      ),
    )
    .limit(1);
  return busy !== undefined;
}

function heldMessage(reasons: HoldReason[]): string {
  return `Held for your owner's approval because ${reasons.map((reason) => REASON_TEXT[reason]).join(" and ")}. Don't send it again: when they decide, the result arrives in your inbox as a notice.`;
}

/**
 * Applies the owner's rules to an action. Returns null when it may go ahead, or holds it and
 * returns what to tell the agent.
 */
export async function maybeHold(
  ctx: AgentContext,
  request: HoldRequest,
  options: { approverOwnerId?: string; extraReasons?: HoldReason[] } = {},
): Promise<Held | null> {
  const policy = readPolicy(ctx.agent);
  const key = await ownerKey(ctx.agent.ownerId);
  const laneDigest = key.digest(`lane:${lane(request)}`);
  const reasons = holdsAnything(policy) ? await evaluate(ctx, request, policy, key) : [];
  reasons.push(...(options.extraReasons ?? []));
  if (reasons.length === 0 && (await laneBusy(ctx.agent.id, laneDigest))) reasons.push("queued");
  if (reasons.length === 0) return null;
  return holdAction(ctx, request, {
    reasons,
    laneDigest,
    key,
    hours: policy.holdHours,
    approverOwnerId: options.approverOwnerId ?? ctx.agent.ownerId,
  });
}

async function holdAction(
  ctx: AgentContext,
  request: HoldRequest,
  options: {
    reasons: HoldReason[];
    laneDigest: string;
    key: DataKey;
    hours: number;
    approverOwnerId: string;
  },
): Promise<Held> {
  const { agent } = ctx;
  const id = uuidv7();
  const token = randomToken();
  const expiresAt = new Date(Date.now() + options.hours * 3_600_000);
  const summary = summarize(request);
  const payload: StoredPayload = {
    input: request.input,
    origin: {
      client: ctx.client,
      ip: ctx.seen ? (normalizeIp(ctx.seen.ip) ?? ctx.seen.ip) : null,
      userAgent: ctx.seen?.userAgent ?? null,
    },
  };
  const approveUrl = new URL("/approve", config.APP_URL);
  approveUrl.searchParams.set("token", token);

  const recorded = await db.transaction(async (tx) => {
    await tx.insert(heldActions).values({
      id,
      agentId: agent.id,
      tokenId: ctx.tokenId,
      approverOwnerId: options.approverOwnerId,
      kind: request.kind,
      reasons: options.reasons,
      laneDigest: options.laneDigest,
      payload: options.key.seal(JSON.stringify(payload), payloadContext(id)),
      summary: options.key.seal(summary, summaryContext(id)),
      approvalTokenHash: sha256(token),
      expiresAt,
    });
    if (request.kind === "message") {
      await reserveFiles(tx, agent, request.input.attachments ?? [], id);
    }
    await enqueue(tx, "hold.notify", { holdId: id, approveUrl: approveUrl.toString() });
    await enqueue(tx, "hold.expire", { holdId: id }, { runAt: expiresAt });
    return appendLedgerEvent(tx, agent, {
      type: "action.held",
      actor: "system",
      data: { holdId: id, kind: request.kind, reasons: options.reasons },
    });
  });
  await broadcast([recorded]);
  await alertOnRepeatedHolds(agent);
  return {
    status: "held_for_approval",
    holdId: id,
    reasons: options.reasons,
    summary,
    expiresAt: expiresAt.toISOString(),
    message: heldMessage(options.reasons),
  };
}

async function alertOnRepeatedHolds(agent: Agent): Promise<void> {
  const [row] = await db
    .select({ total: count() })
    .from(heldActions)
    .where(
      and(
        eq(heldActions.agentId, agent.id),
        gt(heldActions.createdAt, new Date(Date.now() - 3_600_000)),
      ),
    );
  if ((row?.total ?? 0) < REPEATED_HOLDS) return;
  await raiseAlert({
    agent,
    kind: "repeated_holds",
    details: { holds: row?.total ?? REPEATED_HOLDS },
  }).catch((err: unknown) => logger.warn({ err }, "couldn't raise a repeated holds alert"));
}

// ---- views -----------------------------------------------------------------------------------

export type HoldView = {
  id: string;
  agent: string;
  kind: HoldKind;
  status: HoldStatus;
  reasons: HoldReason[];
  why: string[];
  summary: string;
  details: StoredPayload["input"] | null;
  origin: Origin | null;
  result: Record<string, unknown> | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedVia: string | null;
};

function holdView(key: DataKey, row: HeldAction, handle: string): HoldView {
  const payload = row.payload
    ? (JSON.parse(key.open(row.payload, payloadContext(row.id))) as StoredPayload)
    : null;
  const reasons = row.reasons as HoldReason[];
  return {
    id: row.id,
    agent: formatHandle(handle),
    kind: row.kind,
    status: row.status,
    reasons,
    why: reasons.map((reason) => REASON_TEXT[reason] ?? reason),
    summary: key.open(row.summary, summaryContext(row.id)),
    details: payload?.input ?? null,
    origin: payload?.origin ?? null,
    result: row.result ?? null,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedVia: row.decidedVia,
  };
}

async function views(rows: { hold: HeldAction; agent: Agent }[]): Promise<HoldView[]> {
  const keys = new Map<string, DataKey>();
  const out: HoldView[] = [];
  for (const { hold, agent } of rows) {
    let key = keys.get(agent.ownerId);
    if (!key) {
      key = await ownerKey(agent.ownerId);
      keys.set(agent.ownerId, key);
    }
    out.push(holdView(key, hold, agent.handle));
  }
  return out;
}

export async function listHolds(
  owner: Owner,
  options: { status: "pending" | "all"; agent?: Agent },
): Promise<HoldView[]> {
  const rows = await db
    .select({ hold: heldActions, agent: agents })
    .from(heldActions)
    .innerJoin(agents, eq(agents.id, heldActions.agentId))
    .where(
      and(
        eq(heldActions.approverOwnerId, owner.id),
        options.status === "pending" ? eq(heldActions.status, "pending") : undefined,
        options.agent ? eq(heldActions.agentId, options.agent.id) : undefined,
      ),
    )
    .orderBy(
      options.status === "pending" ? asc(heldActions.createdAt) : desc(heldActions.createdAt),
    )
    .limit(HOLDS_SHOWN);
  return views(rows);
}

export async function pendingHoldCount(ownerId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(heldActions)
    .where(and(eq(heldActions.approverOwnerId, ownerId), eq(heldActions.status, "pending")));
  return row?.total ?? 0;
}

/** The agent's own view: what it asked for and what happened, without who saw it. */
export async function agentHolds(agent: Agent, id?: string) {
  const rows = await db
    .select({ hold: heldActions, agent: agents })
    .from(heldActions)
    .innerJoin(agents, eq(agents.id, heldActions.agentId))
    .where(and(eq(heldActions.agentId, agent.id), id ? eq(heldActions.id, id) : undefined))
    .orderBy(desc(heldActions.createdAt))
    .limit(50);
  if (id && rows.length === 0) throw new AppError("not_found", "No held action with that id.");
  return (await views(rows)).map(({ origin: _origin, details: _details, ...view }) => view);
}

export async function activeHoldCount(agentId: string): Promise<number> {
  const [row] = await db
    .select({ total: count() })
    .from(heldActions)
    .where(and(eq(heldActions.agentId, agentId), eq(heldActions.status, "pending")));
  return row?.total ?? 0;
}

// ---- deciding --------------------------------------------------------------------------------

export type Decision = "approve" | "deny";
export type DecisionChannel = "dashboard" | "email" | "telegram";

async function findHold(where: SQL) {
  const [row] = await db
    .select({ hold: heldActions, agent: agents })
    .from(heldActions)
    .innerJoin(agents, eq(agents.id, heldActions.agentId))
    .where(where);
  return row;
}

async function ownedHold(ownerId: string, id: string) {
  const found = await findHold(eq(heldActions.id, id));
  if (!found || found.hold.approverOwnerId !== ownerId) {
    throw new AppError("not_found", "No held action with that id.");
  }
  return found;
}

async function notice(
  tx: Tx,
  agent: Agent,
  hold: HeldAction,
  kind: "action.approved" | "action.denied" | "action.expired" | "action.failed",
  text: string,
): Promise<RecordedEvent> {
  return createNotice(tx, agent, {
    kind,
    actor: null,
    actorKind: kind === "action.expired" || kind === "action.failed" ? "system" : "owner",
    conversationId: null,
    planId: null,
    taskKey: null,
    heldActionId: hold.id,
    text,
  });
}

async function decide(
  found: { hold: HeldAction; agent: Agent },
  decision: Decision,
  via: DecisionChannel,
): Promise<HoldView> {
  const { hold, agent } = found;
  const key = await ownerKey(agent.ownerId);
  const summary = key.open(hold.summary, summaryContext(hold.id));
  if (decision === "approve" && agent.frozenAt) {
    throw new AppError(
      "conflict",
      `${formatHandle(agent.handle)} is frozen. Unfreeze it before approving its actions.`,
    );
  }
  const recorded = await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(heldActions)
      .set({
        status: decision === "approve" ? "approved" : "denied",
        decidedVia: via,
        decidedAt: new Date(),
      })
      .where(and(eq(heldActions.id, hold.id), eq(heldActions.status, "pending")))
      .returning();
    if (!updated) throw new AppError("conflict", "This action was already decided or expired.");
    const events = [
      await appendLedgerEvent(tx, agent, {
        type: "action.decided",
        actor: "owner",
        data: { holdId: hold.id, kind: hold.kind, decision, via },
      }),
    ];
    if (decision === "approve") {
      await enqueue(tx, "hold.release", { agentId: agent.id });
    } else {
      await unreserveFiles(tx, hold.id);
      events.push(
        await notice(
          tx,
          agent,
          hold,
          "action.denied",
          `Your owner declined this, so it didn't happen: ${summary}. Don't try it again unless they ask you to.`,
        ),
      );
    }
    return events;
  });
  await broadcast(recorded);
  if (decision === "deny") await bumpInbox(agent.id);
  if (decision === "approve") {
    await releaseApproved({ agentId: agent.id }).catch((err: unknown) =>
      logger.warn({ err, holdId: hold.id }, "release after approval failed; the job retries"),
    );
  }
  const after = await findHold(eq(heldActions.id, hold.id));
  return holdView(key, after?.hold ?? hold, agent.handle);
}

export async function decideHold(
  owner: Owner,
  session: OwnerSession,
  id: string,
  decision: Decision,
): Promise<HoldView> {
  const found = await ownedHold(owner.id, id);
  if (decision === "approve") await assertStepUp(owner.id, session);
  return decide(found, decision, "dashboard");
}

export async function decideHolds(
  owner: Owner,
  session: OwnerSession,
  ids: string[],
  decision: Decision,
): Promise<{ decided: HoldView[]; failed: { id: string; error: string }[] }> {
  if (decision === "approve") await assertStepUp(owner.id, session);
  const decided: HoldView[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const id of ids) {
    try {
      decided.push(await decide(await ownedHold(owner.id, id), decision, "dashboard"));
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      failed.push({ id, error: error.message });
    }
  }
  return { decided, failed };
}

// Links and Telegram buttons approve only for owners without a passkey; declining always works.
async function assertOneTapApproval(ownerId: string): Promise<void> {
  if (await ownerHasPasskeys(ownerId)) {
    throw new AppError("forbidden", "Approve it from the dashboard with your passkey.", {
      reason: "passkey_required",
    });
  }
}

export async function decideHoldFromTelegram(
  owner: Owner,
  id: string,
  decision: Decision,
): Promise<HoldView> {
  const found = await ownedHold(owner.id, id);
  if (decision === "approve") await assertOneTapApproval(owner.id);
  return decide(found, decision, "telegram");
}

async function byLink(token: string) {
  const found = await findHold(eq(heldActions.approvalTokenHash, sha256(token)));
  if (!found) throw new AppError("not_found", "This link isn't valid anymore.");
  return found;
}

export async function holdLinkView(token: string): Promise<HoldView & { needsPasskey: boolean }> {
  const found = await byLink(token);
  const view = holdView(await ownerKey(found.agent.ownerId), found.hold, found.agent.handle);
  return { ...view, needsPasskey: await ownerHasPasskeys(found.hold.approverOwnerId) };
}

export async function decideHoldByLink(token: string, decision: Decision): Promise<HoldView> {
  const found = await byLink(token);
  if (decision === "approve") await assertOneTapApproval(found.hold.approverOwnerId);
  return decide(found, decision, "email");
}

// ---- releasing -------------------------------------------------------------------------------

async function nextToRelease(agentId: string): Promise<HeldAction | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`hold-release:${agentId}`}))`);
    const active = await tx
      .select()
      .from(heldActions)
      .where(and(eq(heldActions.agentId, agentId), inArray(heldActions.status, ACTIVE)))
      .orderBy(asc(heldActions.createdAt));
    const blocked = new Set<string>();
    for (const hold of active) {
      if (hold.status === "approved" && !blocked.has(hold.laneDigest)) {
        const [claimed] = await tx
          .update(heldActions)
          .set({ status: "releasing" })
          .where(and(eq(heldActions.id, hold.id), eq(heldActions.status, "approved")))
          .returning();
        return claimed ?? null;
      }
      blocked.add(hold.laneDigest);
    }
    return null;
  });
}

async function run(agent: Agent, hold: HeldAction, input: StoredPayload["input"]) {
  switch (hold.kind) {
    case "message": {
      const message = input as Extract<HoldRequest, { kind: "message" }>["input"];
      const sent = await sendMessage(agent, {
        to: message.to,
        body: message.body,
        attachments: message.attachments,
        idempotencyKey: `hold:${hold.id}`,
        reservedBy: hold.id,
      });
      return {
        text: `It was sent to ${sent.to}.`,
        result: { to: sent.to, messageId: sent.messageId },
      };
    }
    case "group.create": {
      const group = await createGroup(agent, input as { name: string; members: string[] });
      return { text: `${group.name} was created.`, result: { group: group.name } };
    }
    case "group.invite": {
      const invite = input as { group: string; handles: string[]; note?: string };
      const group = await inviteToGroup(agent, invite.group, {
        handles: invite.handles,
        note: invite.note,
      });
      return { text: `The invitations to ${group.name} went out.`, result: { group: group.name } };
    }
    case "invite_person": {
      const sent = await invitePerson(agent, input as { email: string; note?: string });
      return { text: `The invitation went to ${sent.sentTo}.`, result: { sentTo: sent.sentTo } };
    }
    case "tool.call":
      throw new AppError("conflict", "Tool calls can't be released on this server.");
  }
}

async function release(hold: HeldAction): Promise<void> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, hold.agentId));
  if (!agent) return;
  const key = await ownerKey(agent.ownerId);
  const summary = key.open(hold.summary, summaryContext(hold.id));
  const payload = hold.payload
    ? (JSON.parse(key.open(hold.payload, payloadContext(hold.id))) as StoredPayload)
    : null;

  let outcome: { text: string; result: Record<string, unknown> } | { error: string };
  try {
    if (!payload) throw new AppError("conflict", "The action's details are gone.");
    outcome = await run(agent, hold, payload.input);
  } catch (error) {
    if (!(error instanceof AppError))
      logger.error({ err: error, holdId: hold.id }, "release failed");
    outcome = { error: error instanceof AppError ? error.message : "Something went wrong." };
  }

  const error = "error" in outcome ? outcome.error : null;
  const done = "error" in outcome ? null : outcome;
  const recorded = await db.transaction(async (tx) => {
    const failed = error !== null;
    await tx
      .update(heldActions)
      .set({
        status: failed ? "failed" : "released",
        result: done ? done.result : { error },
        releasedAt: new Date(),
      })
      .where(eq(heldActions.id, hold.id));
    if (failed) await unreserveFiles(tx, hold.id);
    return [
      await appendLedgerEvent(tx, agent, {
        type: failed ? "action.failed" : "action.released",
        actor: "system",
        data: { holdId: hold.id, kind: hold.kind },
      }),
      await notice(
        tx,
        agent,
        hold,
        failed ? "action.failed" : "action.approved",
        done
          ? `Your owner approved this, and it went through: ${summary}. ${done.text}`
          : `Your owner approved this, but it couldn't be done: ${summary}. ${error}`,
      ),
    ];
  });
  await broadcast(recorded);
  await bumpInbox(agent.id);
}

/** Runs approved actions in order, one lane at a time. Safe to call from several places. */
export async function releaseApproved({ agentId }: { agentId: string }): Promise<void> {
  const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
  if (!agent || agent.frozenAt || agent.suspendedAt) return;
  for (;;) {
    const next = await nextToRelease(agentId);
    if (!next) return;
    await release(next);
  }
}

// ---- expiry and notifications ----------------------------------------------------------------

export async function expireHold({ holdId }: { holdId: string }): Promise<void> {
  const found = await findHold(eq(heldActions.id, holdId));
  if (!found || found.hold.status !== "pending") return;
  const { hold, agent } = found;
  if (hold.expiresAt.getTime() > Date.now()) return;
  const summary = (await ownerKey(agent.ownerId)).open(hold.summary, summaryContext(hold.id));
  const recorded = await db.transaction(async (tx) => {
    const [expired] = await tx
      .update(heldActions)
      .set({ status: "expired", decidedAt: new Date() })
      .where(and(eq(heldActions.id, hold.id), eq(heldActions.status, "pending")))
      .returning({ id: heldActions.id });
    if (!expired) return [];
    await unreserveFiles(tx, hold.id);
    return [
      await appendLedgerEvent(tx, agent, {
        type: "action.expired",
        actor: "system",
        data: { holdId: hold.id, kind: hold.kind },
      }),
      await notice(
        tx,
        agent,
        hold,
        "action.expired",
        `Nobody approved this in time, so it didn't happen: ${summary}. Ask your owner before trying again.`,
      ),
    ];
  });
  await broadcast(recorded);
  if (recorded.length > 0) await bumpInbox(agent.id);
}

/** The pending hold behind a notification, with what the approver needs to decide. */
export async function holdForApprover(holdId: string) {
  const [found] = await db
    .select({ hold: heldActions, agent: agents, owner: owners })
    .from(heldActions)
    .innerJoin(agents, eq(agents.id, heldActions.agentId))
    .innerJoin(owners, eq(owners.id, heldActions.approverOwnerId))
    .where(eq(heldActions.id, holdId));
  if (!found || found.hold.status !== "pending") return null;
  return {
    owner: found.owner,
    view: holdView(await ownerKey(found.agent.ownerId), found.hold, found.agent.handle),
    passkey: await ownerHasPasskeys(found.owner.id),
    dashboard: new URL("/dashboard/approvals", config.APP_URL).toString(),
  };
}

export async function emailHold({
  holdId,
  approveUrl,
}: {
  holdId: string;
  approveUrl: string;
}): Promise<void> {
  const found = await holdForApprover(holdId);
  if (!found) return;
  const { owner, view, passkey, dashboard } = found;
  await sendMail({
    to: owner.email,
    subject: `${view.agent} is waiting for your approval`,
    text: [
      `${view.agent} wants to do this, and your rules hold it until you decide:`,
      "",
      view.summary,
      "",
      `It's held because ${view.why.join(" and ")}.`,
      "",
      passkey
        ? `Approve it with your passkey in the dashboard, or decline it from this link: ${approveUrl}`
        : `Approve or decline it: ${approveUrl}`,
      "",
      `Everything waiting for you: ${dashboard}`,
      "",
      `If nobody decides by ${new Date(view.expiresAt).toUTCString()}, it expires and doesn't happen. Don't forward this email: its link acts for you.`,
    ].join("\n"),
  });
}

/** Expires what timed out, fails releases that got stuck and drops old payloads. */
export async function pruneHolds(): Promise<void> {
  const overdue = await db
    .select({ id: heldActions.id })
    .from(heldActions)
    .where(and(eq(heldActions.status, "pending"), lte(heldActions.expiresAt, new Date())));
  for (const { id } of overdue) await expireHold({ holdId: id });

  await db
    .update(heldActions)
    .set({ status: "failed", result: { error: "It stopped while running." } })
    .where(
      and(
        eq(heldActions.status, "releasing"),
        lt(heldActions.decidedAt, new Date(Date.now() - RELEASE_TIMEOUT_MS)),
      ),
    );
  await db
    .update(heldActions)
    .set({ payload: null })
    .where(
      and(
        isNotNull(heldActions.payload),
        inArray(heldActions.status, ["released", "denied", "expired", "failed"]),
        lt(heldActions.decidedAt, new Date(Date.now() - PAYLOAD_RETENTION_MS)),
      ),
    );
}
