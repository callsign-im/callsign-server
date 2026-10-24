import { createHmac } from "node:crypto";
import { and, desc, eq, gt, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { config } from "../config.ts";
import { db } from "../db/client.ts";
import {
  agents,
  agentTokens,
  eventSubscriptions,
  type Agent,
  type EventSubscription,
} from "../db/schema.ts";
import { enqueue, type AgentNotification, type JobPayloads } from "../jobs/queue.ts";
import { canonicalJson, randomToken, safeEqual, sha256 } from "../lib/crypto.ts";
import { rateLimit } from "../lib/rate-limit.ts";
import { isPublicHost, postJson } from "../lib/safe-fetch.ts";
import { AppError } from "./errors.ts";
import { normalizeGroupName } from "./groups.ts";
import { formatHandle, normalizeHandle } from "./handles.ts";
import { ownerKey } from "./keys.ts";
import { appendLedgerEvent, broadcast } from "./ledger.ts";
import { describeNotification, type NotificationEvent } from "./notifications.ts";

const DEFAULT_TTL_MS = 24 * 3_600_000;
const MIN_TTL_MS = 60_000;
const ROTATION_GRACE_MS = 3_600_000;
const MAX_SUBSCRIPTIONS = 20;
const TIMEOUT_MS = 10_000;

export type CallbackFailure =
  "connection_refused" | "timeout" | "tls_error" | "http_4xx" | "http_5xx" | "challenge_failed";

export class EventsError extends Error {
  readonly kind: "not_found" | "forbidden" | "exhausted" | "unsupported" | "callback" | "invalid";
  readonly data: Record<string, unknown> | undefined;

  constructor(kind: EventsError["kind"], message: string, data?: Record<string, unknown>) {
    super(message);
    this.kind = kind;
    this.data = data;
  }
}

const MessageArguments = z.strictObject({
  from: z.string().max(64).optional().describe("Only fire for messages from this @handle."),
  group: z.string().max(64).optional().describe("Only fire for this #group."),
  mentionsOnly: z
    .boolean()
    .optional()
    .describe("In groups, only fire when a message mentions this agent."),
});

const MessagePayload = z.object({
  kind: z.enum(["message", "request", "invitation", "notice"]),
  agent: z.string(),
  from: z.string().nullable(),
  group: z.string().nullable(),
  mentioned: z.boolean(),
  conversationId: z.string().nullable(),
  messageId: z.string().nullable(),
  notice: z
    .string()
    .optional()
    .describe("For plan updates and reminders: plan.shared, task.ready, follow_up and so on."),
  planId: z.string().nullable().optional(),
});

const AnswerPayload = z.object({ agent: z.string(), questionId: z.string() });

const EVENTS = {
  "message.received": {
    description:
      "Something new arrived in this agent's Callsign inbox: a message or message request from another agent, a message in one of its groups, a group invitation, a plan update or a follow-up it scheduled. Contents are not included: call check_inbox to read and answer it.",
    arguments: MessageArguments,
    payload: MessagePayload,
  },
  "owner.answered": {
    description:
      "The agent's owner answered a question the agent asked with ask_owner. Call check_inbox to read the answer and continue the task.",
    arguments: z.strictObject({}),
    payload: AnswerPayload,
  },
} as const;

type EventName = keyof typeof EVENTS;
type Occurrence = { name: EventName; data: Record<string, unknown> };

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json: Record<string, unknown> = z.toJSONSchema(schema);
  delete json.$schema;
  return json;
}

export function eventCatalog() {
  return Object.entries(EVENTS).map(([name, event]) => ({
    name,
    description: event.description,
    delivery: ["webhook"],
    inputSchema: jsonSchema(event.arguments),
    payloadSchema: jsonSchema(event.payload),
  }));
}

function isEventName(name: string): name is EventName {
  return Object.hasOwn(EVENTS, name);
}

function occurrenceFor(event: NotificationEvent): Occurrence {
  if (event.type === "owner.answered") {
    return { name: "owner.answered", data: { agent: event.agent, questionId: event.questionId } };
  }
  if (event.type === "notice.received") {
    return {
      name: "message.received",
      data: {
        kind: "notice",
        agent: event.agent,
        from: event.from,
        group: null,
        mentioned: false,
        conversationId: event.conversationId,
        messageId: null,
        notice: event.notice,
        planId: event.planId,
      },
    };
  }
  const invitation = event.type === "group.invited";
  return {
    name: "message.received",
    data: {
      kind: invitation ? "invitation" : event.type === "request.received" ? "request" : "message",
      agent: event.agent,
      from: event.from,
      group: event.group ?? null,
      mentioned: !invitation && (event.mentioned ?? false),
      conversationId: event.conversationId,
      messageId: invitation ? null : event.messageId,
    },
  };
}

function matches(subscription: EventSubscription, occurrence: Occurrence): boolean {
  if (subscription.name !== occurrence.name) return false;
  const args = subscription.arguments as z.infer<typeof MessageArguments>;
  const data = occurrence.data;
  if (args.from && formatHandle(normalizeHandle(args.from)) !== data.from) return false;
  if (args.group && `#${normalizeGroupName(args.group)}` !== data.group) return false;
  if (args.mentionsOnly && data.group && data.kind === "message" && !data.mentioned) return false;
  return true;
}

function decodeSecret(secret: string): Buffer | null {
  if (!/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) return null;
  const bytes = Buffer.from(secret.slice("whsec_".length), "base64");
  return bytes.length >= 24 && bytes.length <= 64 ? bytes : null;
}

export function standardSignature(
  secret: string,
  id: string,
  timestamp: number,
  body: string,
): string {
  const key = decodeSecret(secret);
  if (!key) throw new Error("invalid webhook secret");
  return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
}

function signedHeaders(subscriptionId: string, webhookId: string, body: string, secrets: string[]) {
  const timestamp = Math.floor(Date.now() / 1000);
  return {
    "user-agent": "Callsign-Events/1.0",
    "webhook-id": webhookId,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": secrets
      .map((secret) => standardSignature(secret, webhookId, timestamp, body))
      .join(" "),
    "x-mcp-subscription-id": subscriptionId,
  };
}

function failureOf(err: unknown): CallbackFailure {
  const text =
    err instanceof Error ? `${(err as { code?: string }).code ?? ""} ${err.message}` : "";
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH/.test(text)) {
    return "connection_refused";
  }
  if (/timed out|ETIMEDOUT/.test(text)) return "timeout";
  if (/CERT|TLS|SSL/.test(text)) return "tls_error";
  return "connection_refused";
}

function callbackUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new EventsError("invalid", "delivery.url must be an absolute https URL.");
  }
  const local = config.ALLOW_PRIVATE_WEBHOOKS;
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new EventsError("invalid", "delivery.url must be an https URL.");
  }
  if (!local && !isPublicHost(url)) {
    throw new EventsError("invalid", "delivery.url must be a public address.");
  }
  return url;
}

async function verifyCallback(id: string, url: URL, secret: string): Promise<void> {
  await rateLimit(`event-verify:${url.host}`, 30, 3600);
  const challenge = randomToken();
  const body = JSON.stringify({ type: "verification", challenge });
  const headers = signedHeaders(id, `msg_verification_${randomToken()}`, body, [secret]);
  let response: { status: number; body: string };
  try {
    response = await postJson(url, body, headers, {
      allowPrivate: config.ALLOW_PRIVATE_WEBHOOKS,
      timeoutMs: TIMEOUT_MS,
    });
  } catch (err) {
    throw new EventsError("callback", "The callback URL could not be reached.", {
      reason: failureOf(err),
    });
  }
  if (response.status < 200 || response.status >= 300) {
    throw new EventsError("callback", "The callback URL rejected the verification request.", {
      reason: response.status >= 500 ? "http_5xx" : "http_4xx",
    });
  }
  let echoed = response.body.trim();
  try {
    const parsed = JSON.parse(echoed) as unknown;
    if (parsed && typeof parsed === "object" && "challenge" in parsed) {
      echoed = String(parsed.challenge);
    }
  } catch {
    // A plain-text echo is accepted too.
  }
  if (!safeEqual(echoed, challenge)) {
    throw new EventsError("callback", "The callback URL didn't echo the challenge.", {
      reason: "challenge_failed",
    });
  }
}

export type SubscribeParams = {
  name: string;
  arguments?: Record<string, unknown> | undefined;
  delivery: { mode: string; url: string; secret?: string | undefined };
  ttlMs?: number | null | undefined;
};

const secretContext = (id: string, field: "secret" | "previous_secret") =>
  `event_subscriptions.${field}:${id}`;

function subscriptionId(agentId: string, url: string, name: string, args: unknown): string {
  return `sub_${sha256(`${agentId}\n${url}\n${name}\n${canonicalJson(args)}`).slice(0, 32)}`;
}

function grantedTtl(ttlMs: number | null | undefined): number {
  if (ttlMs === undefined || ttlMs === null) return DEFAULT_TTL_MS;
  return Math.min(Math.max(ttlMs, MIN_TTL_MS), DEFAULT_TTL_MS);
}

function deliveryStatus(subscription: EventSubscription) {
  return {
    active: subscription.failedSince === null,
    lastDeliveryAt: subscription.lastDeliveryAt?.toISOString() ?? null,
    lastError: subscription.lastError,
    ...(subscription.failedSince && { failedSince: subscription.failedSince.toISOString() }),
  };
}

export async function subscribe(agent: Agent, tokenId: string, params: SubscribeParams) {
  if (!isEventName(params.name)) {
    throw new EventsError("not_found", `Unknown event ${params.name}.`, { kind: "event" });
  }
  if (params.delivery.mode !== "webhook") {
    throw new EventsError("unsupported", "Callsign delivers events by webhook only.", {
      feature: "deliveryMode",
      value: params.delivery.mode,
    });
  }
  const parsed = EVENTS[params.name].arguments.safeParse(params.arguments ?? {});
  if (!parsed.success) {
    throw new EventsError("invalid", `Invalid arguments: ${z.prettifyError(parsed.error)}`);
  }
  const secret = params.delivery.secret ?? "";
  if (!decodeSecret(secret)) {
    throw new EventsError("invalid", "delivery.secret must be whsec_ followed by 24-64 bytes.");
  }
  const url = callbackUrl(params.delivery.url);
  const args = parsed.data as Record<string, unknown>;
  const id = subscriptionId(agent.id, url.toString(), params.name, args);
  const expiresAt = new Date(Date.now() + grantedTtl(params.ttlMs));

  const [existing] = await db
    .select()
    .from(eventSubscriptions)
    .where(and(eq(eventSubscriptions.id, id), eq(eventSubscriptions.agentId, agent.id)));
  const [verified] = await db
    .select({ id: eventSubscriptions.id })
    .from(eventSubscriptions)
    .where(
      and(
        eq(eventSubscriptions.agentId, agent.id),
        eq(eventSubscriptions.url, url.toString()),
        gt(eventSubscriptions.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!existing) {
    const [count] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(eventSubscriptions)
      .where(
        and(eq(eventSubscriptions.agentId, agent.id), gt(eventSubscriptions.expiresAt, new Date())),
      );
    if ((count?.count ?? 0) >= MAX_SUBSCRIPTIONS) {
      throw new EventsError("exhausted", "This agent has too many event subscriptions.", {
        limit: "subscriptions",
        max: MAX_SUBSCRIPTIONS,
      });
    }
  }
  if (!verified) await verifyCallback(id, url, secret);

  const key = await ownerKey(agent.ownerId);
  const previous = existing && key.open(existing.secret, secretContext(id, "secret"));
  const rotated = previous !== undefined && previous !== null && previous !== secret;
  const values = {
    tokenId,
    secret: key.seal(secret, secretContext(id, "secret")),
    expiresAt,
    refreshedAt: new Date(),
    failedSince: null,
    ...(rotated && {
      previousSecret: key.seal(previous, secretContext(id, "previous_secret")),
      secretRotatedAt: new Date(),
    }),
  };

  const { row, recorded } = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(eventSubscriptions)
      .values({
        id,
        agentId: agent.id,
        name: params.name,
        arguments: args,
        url: url.toString(),
        ...values,
      })
      .onConflictDoUpdate({ target: eventSubscriptions.id, set: values })
      .returning();
    if (!row) throw new Error("subscription upsert returned no row");
    await tx
      .update(agents)
      .set({
        eventsUntil: sql`greatest(${agents.eventsUntil}, ${expiresAt.toISOString()}::timestamptz)`,
      })
      .where(eq(agents.id, agent.id));
    const recorded = existing
      ? null
      : await appendLedgerEvent(tx, agent, {
          type: "subscription.created",
          actor: "agent",
          data: { subscriptionId: id, event: params.name, host: url.host },
        });
    return { row, recorded };
  });
  if (recorded) await broadcast([recorded]);

  return {
    id,
    refreshBefore: row.expiresAt.toISOString(),
    cursor: null,
    truncated: false,
    ...(existing && { deliveryStatus: deliveryStatus(existing) }),
  };
}

async function removeSubscription(
  agent: Agent,
  id: string,
  actor: "agent" | "owner",
): Promise<boolean> {
  const recorded = await db.transaction(async (tx) => {
    const [removed] = await tx
      .delete(eventSubscriptions)
      .where(and(eq(eventSubscriptions.id, id), eq(eventSubscriptions.agentId, agent.id)))
      .returning();
    if (!removed) return null;
    return appendLedgerEvent(tx, agent, {
      type: "subscription.removed",
      actor,
      data: { subscriptionId: id, event: removed.name, host: new URL(removed.url).host },
    });
  });
  if (recorded) await broadcast([recorded]);
  return recorded !== null;
}

export async function unsubscribe(
  agent: Agent,
  params: { name: string; arguments?: Record<string, unknown> | undefined; url: string },
): Promise<void> {
  if (!isEventName(params.name)) return;
  const parsed = EVENTS[params.name].arguments.safeParse(params.arguments ?? {});
  if (!parsed.success) return;
  let url: string;
  try {
    url = new URL(params.url).toString();
  } catch {
    return;
  }
  await removeSubscription(agent, subscriptionId(agent.id, url, params.name, parsed.data), "agent");
}

export async function listSubscriptions(agent: Agent) {
  const rows = await db
    .select({ subscription: eventSubscriptions, client: agentTokens.name })
    .from(eventSubscriptions)
    .innerJoin(agentTokens, eq(agentTokens.id, eventSubscriptions.tokenId))
    .where(
      and(eq(eventSubscriptions.agentId, agent.id), gt(eventSubscriptions.expiresAt, new Date())),
    )
    .orderBy(desc(eventSubscriptions.createdAt));
  return rows.map(({ subscription, client }) => ({
    id: subscription.id,
    event: subscription.name,
    arguments: subscription.arguments,
    host: new URL(subscription.url).host,
    client,
    createdAt: subscription.createdAt.toISOString(),
    refreshedAt: subscription.refreshedAt.toISOString(),
    expiresAt: subscription.expiresAt.toISOString(),
    ...deliveryStatus(subscription),
  }));
}

export async function deleteSubscription(agent: Agent, id: string): Promise<void> {
  if (!(await removeSubscription(agent, id, "owner"))) {
    throw new AppError("not_found", "Subscription not found.");
  }
}

function liveSubscriptions(agentId: string) {
  return db
    .select({ subscription: eventSubscriptions })
    .from(eventSubscriptions)
    .innerJoin(agentTokens, eq(agentTokens.id, eventSubscriptions.tokenId))
    .where(
      and(
        eq(eventSubscriptions.agentId, agentId),
        gt(eventSubscriptions.expiresAt, new Date()),
        isNull(agentTokens.revokedAt),
        or(isNull(agentTokens.refreshExpiresAt), gt(agentTokens.refreshExpiresAt, new Date())),
      ),
    );
}

export async function fanOutEvent(job: AgentNotification): Promise<void> {
  const notice = await describeNotification(job);
  if (!notice) return;
  const occurrence = occurrenceFor(notice.event);
  const eventId = `evt_${sha256(canonicalJson(job)).slice(0, 32)}`;
  const timestamp = "sentAt" in notice.event ? notice.event.sentAt : new Date().toISOString();
  for (const { subscription } of await liveSubscriptions(notice.recipient.id)) {
    if (!matches(subscription, occurrence)) continue;
    await enqueue(db, "event.delivery", {
      subscriptionId: subscription.id,
      eventId,
      name: occurrence.name,
      timestamp,
      data: occurrence.data,
    });
  }
}

async function recordFailure(subscription: EventSubscription, failure: CallbackFailure) {
  await db
    .update(eventSubscriptions)
    .set({ lastError: failure, failedSince: subscription.failedSince ?? new Date() })
    .where(eq(eventSubscriptions.id, subscription.id));
}

export async function deliverEvent(payload: JobPayloads["event.delivery"]): Promise<void> {
  const [row] = await db
    .select({ subscription: eventSubscriptions, agent: agents })
    .from(eventSubscriptions)
    .innerJoin(agents, eq(agents.id, eventSubscriptions.agentId))
    .innerJoin(agentTokens, eq(agentTokens.id, eventSubscriptions.tokenId))
    .where(
      and(
        eq(eventSubscriptions.id, payload.subscriptionId),
        gt(eventSubscriptions.expiresAt, new Date()),
        isNull(agentTokens.revokedAt),
      ),
    );
  if (!row) return;
  const { subscription, agent } = row;
  const key = await ownerKey(agent.ownerId);
  const secrets = [key.open(subscription.secret, secretContext(subscription.id, "secret"))];
  const rotatedAt = subscription.secretRotatedAt?.getTime() ?? 0;
  if (subscription.previousSecret && Date.now() - rotatedAt < ROTATION_GRACE_MS) {
    secrets.push(
      key.open(subscription.previousSecret, secretContext(subscription.id, "previous_secret")),
    );
  }
  const body = JSON.stringify({
    eventId: payload.eventId,
    name: payload.name,
    timestamp: payload.timestamp,
    data: payload.data,
    cursor: null,
  });
  const headers = signedHeaders(
    subscription.id,
    payload.eventId,
    body,
    secrets.filter((secret): secret is string => secret !== null),
  );

  let status: number;
  try {
    ({ status } = await postJson(new URL(subscription.url), body, headers, {
      allowPrivate: config.ALLOW_PRIVATE_WEBHOOKS,
      timeoutMs: TIMEOUT_MS,
    }));
  } catch (err) {
    await recordFailure(subscription, failureOf(err));
    throw err;
  }
  if (status >= 200 && status < 300) {
    await db
      .update(eventSubscriptions)
      .set({ lastDeliveryAt: new Date(), lastError: null, failedSince: null })
      .where(eq(eventSubscriptions.id, subscription.id));
    return;
  }
  await recordFailure(subscription, status >= 500 ? "http_5xx" : "http_4xx");
  if (status === 410 || status === 413) return;
  throw new Error(`event delivery responded with ${status}`);
}

export async function pruneSubscriptions(): Promise<void> {
  await db
    .delete(eventSubscriptions)
    .where(lt(eventSubscriptions.expiresAt, new Date(Date.now() - 86_400_000)));
}
