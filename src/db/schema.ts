import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { Sealed } from "../lib/encryption.ts";

export type WakeStatus = { at: string; ok: boolean; status: number | null; error: string | null };

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => timestamptz("created_at").notNull().defaultNow();
const counter = (name: string) => bigint(name, { mode: "number" });

const sealed = customType<{ data: Sealed; driverData: string }>({
  dataType: () => "text",
  toDriver: (value) => value.ciphertext,
  fromDriver: (value) => new Sealed(value),
});

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

export const owners = pgTable("owners", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull().unique(),
  dataKey: text("data_key").notNull(),
  showDomain: boolean("show_domain").notNull().default(true),
  telegramChatId: text("telegram_chat_id").unique(),
  createdAt: createdAt(),
});

export const loginTokens = pgTable("login_tokens", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamptz("expires_at").notNull(),
  consumedAt: timestamptz("consumed_at"),
  createdAt: createdAt(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => owners.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    expiresAt: timestamptz("expires_at").notNull(),
    // A passkey check raises the session to "sudo mode" for a few minutes.
    elevatedUntil: timestamptz("elevated_until"),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_owner_id_idx").on(t.ownerId)],
);

export const ownerPasskeys = pgTable(
  "owner_passkeys",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => owners.id, { onDelete: "cascade" }),
    credentialId: text("credential_id").notNull().unique(),
    publicKey: bytea("public_key").notNull(),
    counter: counter("counter").notNull().default(0),
    transports: jsonb("transports").$type<string[]>(),
    deviceType: text("device_type").notNull(),
    backedUp: boolean("backed_up").notNull().default(false),
    name: text("name").notNull(),
    lastUsedAt: timestamptz("last_used_at"),
    createdAt: createdAt(),
  },
  (t) => [index("owner_passkeys_owner_id_idx").on(t.ownerId)],
);

export const passkeyResets = pgTable(
  "passkey_resets",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => owners.id, { onDelete: "cascade" }),
    cancelTokenHash: text("cancel_token_hash").notNull().unique(),
    runAt: timestamptz("run_at").notNull(),
    status: text("status").$type<"pending" | "cancelled" | "done">().notNull().default("pending"),
    createdAt: createdAt(),
  },
  (t) => [index("passkey_resets_owner_id_idx").on(t.ownerId)],
);

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => owners.id),
    handle: text("handle").notNull().unique(),
    displayName: text("display_name").notNull(),
    description: text("description"),
    product: text("product").notNull(),
    primary: boolean("is_primary").notNull().default(false),
    webhookUrl: text("webhook_url"),
    webhookSecret: sealed("webhook_secret").notNull(),
    notifyEmail: text("notify_email"),
    wakeKind: text("wake_kind"),
    wakeUrl: text("wake_url"),
    wakeToken: sealed("wake_token"),
    wakeStatus: jsonb("wake_status").$type<WakeStatus>(),
    eventsUntil: timestamptz("events_until"),
    discoverable: boolean("discoverable").notNull().default(true),
    emailBridge: boolean("email_bridge").notNull().default(true),
    publicEmail: boolean("public_email").notNull().default(false),
    publicPage: boolean("public_page").notNull().default(false),
    rules: sealed("rules"),
    ledgerSeq: counter("ledger_seq").notNull().default(0),
    ledgerHead: text("ledger_head"),
    lastSeenAt: timestamptz("last_seen_at"),
    suspendedAt: timestamptz("suspended_at"),
    frozenAt: timestamptz("frozen_at"),
    // Whether tools other owners share in its groups show up for it.
    sharedTools: boolean("shared_tools").notNull().default(true),
    // Server-enforced holds; read through readPolicy, which fills in the defaults.
    policy: jsonb("policy").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("agents_owner_id_idx").on(t.ownerId),
    uniqueIndex("agents_owner_id_primary_idx")
      .on(t.ownerId)
      .where(sql`${t.primary}`),
  ],
);

export const agentTokens = pgTable(
  "agent_tokens",
  {
    id: uuid("id").primaryKey(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    prefix: text("prefix").notNull(),
    clientId: text("client_id"),
    expiresAt: timestamptz("expires_at"),
    refreshTokenHash: text("refresh_token_hash").unique(),
    previousRefreshTokenHash: text("previous_refresh_token_hash"),
    refreshExpiresAt: timestamptz("refresh_expires_at"),
    inboxCursor: counter("inbox_cursor"),
    lastUsedAt: timestamptz("last_used_at"),
    revokedAt: timestamptz("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("agent_tokens_agent_id_idx").on(t.agentId),
    index("agent_tokens_previous_refresh_token_hash_idx").on(t.previousRefreshTokenHash),
  ],
);

// Where each token was used from. IPs are sealed with the owner's key and matched by an HMAC digest.
export const tokenSightings = pgTable(
  "token_sightings",
  {
    id: uuid("id").primaryKey(),
    tokenId: uuid("token_id")
      .notNull()
      .references(() => agentTokens.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    ipDigest: text("ip_digest").notNull(),
    ip: sealed("ip").notNull(),
    userAgent: sealed("user_agent"),
    network: sealed("network"),
    networkDigest: text("network_digest"),
    firstSeenAt: timestamptz("first_seen_at").notNull().defaultNow(),
    lastSeenAt: timestamptz("last_seen_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("token_sightings_token_ip_idx").on(t.tokenId, t.ipDigest),
    index("token_sightings_agent_id_idx").on(t.agentId),
  ],
);

export const agentNetworks = pgTable(
  "agent_networks",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    networkDigest: text("network_digest").notNull(),
    label: sealed("label").notNull(),
    status: text("status").$type<"known" | "pending">().notNull(),
    firstSeenAt: timestamptz("first_seen_at").notNull().defaultNow(),
    lastSeenAt: timestamptz("last_seen_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.networkDigest] })],
);

export type AlertKind =
  "new_network" | "burst" | "refresh_token_reused" | "code_reused" | "repeated_holds";
export type AlertStatus = "open" | "acknowledged" | "frozen" | "resolved";

export const securityAlerts = pgTable(
  "security_alerts",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => owners.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
    tokenId: uuid("token_id").references(() => agentTokens.id, { onDelete: "set null" }),
    kind: text("kind").$type<AlertKind>().notNull(),
    details: sealed("details").notNull(),
    networkDigest: text("network_digest"),
    actionTokenHash: text("action_token_hash").unique(),
    status: text("status").$type<AlertStatus>().notNull().default("open"),
    resolvedVia: text("resolved_via"),
    resolvedAt: timestamptz("resolved_at"),
    createdAt: createdAt(),
  },
  (t) => [index("security_alerts_owner_status_idx").on(t.ownerId, t.status, t.createdAt)],
);

export type HoldKind = "message" | "group.create" | "group.invite" | "invite_person" | "tool.call";
export type HoldStatus =
  "pending" | "approved" | "releasing" | "released" | "denied" | "expired" | "failed";

// An action the server held for its owner's approval. The payload is sealed with the acting
// agent's owner key and dropped 30 days after the decision.
export const heldActions = pgTable(
  "held_actions",
  {
    id: uuid("id").primaryKey(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    tokenId: uuid("token_id").references(() => agentTokens.id, { onDelete: "set null" }),
    approverOwnerId: uuid("approver_owner_id")
      .notNull()
      .references(() => owners.id, { onDelete: "cascade" }),
    kind: text("kind").$type<HoldKind>().notNull(),
    reasons: jsonb("reasons").$type<string[]>().notNull(),
    laneDigest: text("lane_digest").notNull(),
    payload: sealed("payload"),
    summary: sealed("summary").notNull(),
    status: text("status").$type<HoldStatus>().notNull().default("pending"),
    approvalTokenHash: text("approval_token_hash").unique(),
    decidedVia: text("decided_via"),
    decidedAt: timestamptz("decided_at"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    expiresAt: timestamptz("expires_at").notNull(),
    releasedAt: timestamptz("released_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("held_actions_agent_status_idx").on(t.agentId, t.status, t.createdAt),
    index("held_actions_approver_status_idx").on(t.approverOwnerId, t.status, t.createdAt),
  ],
);

export const eventSubscriptions = pgTable(
  "event_subscriptions",
  {
    id: text("id").primaryKey(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    tokenId: uuid("token_id")
      .notNull()
      .references(() => agentTokens.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    arguments: jsonb("arguments").$type<Record<string, unknown>>().notNull(),
    url: text("url").notNull(),
    secret: sealed("secret").notNull(),
    previousSecret: sealed("previous_secret"),
    secretRotatedAt: timestamptz("secret_rotated_at"),
    expiresAt: timestamptz("expires_at").notNull(),
    lastDeliveryAt: timestamptz("last_delivery_at"),
    lastError: text("last_error"),
    failedSince: timestamptz("failed_since"),
    refreshedAt: timestamptz("refreshed_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    index("event_subscriptions_agent_id_idx").on(t.agentId),
    index("event_subscriptions_token_id_idx").on(t.tokenId),
  ],
);

export const oauthClients = pgTable("oauth_clients", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  redirectUris: jsonb("redirect_uris").$type<string[]>().notNull(),
  secretHash: text("secret_hash"),
  createdAt: createdAt(),
});

export const oauthAuthorizations = pgTable("oauth_authorizations", {
  id: uuid("id").primaryKey(),
  clientId: text("client_id").notNull(),
  clientName: text("client_name").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  state: text("state"),
  codeChallenge: text("code_challenge").notNull(),
  resource: text("resource").notNull(),
  nonceHash: text("nonce_hash").notNull(),
  codeHash: text("code_hash").unique(),
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "cascade" }),
  tokenId: uuid("token_id"),
  expiresAt: timestamptz("expires_at").notNull(),
  consumedAt: timestamptz("consumed_at"),
  createdAt: createdAt(),
});

export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => owners.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    name: sealed("name").notNull(),
    notes: sealed("notes"),
    rules: sealed("rules"),
    createdAt: createdAt(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("contacts_owner_id_agent_id_idx").on(t.ownerId, t.agentId)],
);

export const heldHandles = pgTable("held_handles", {
  handle: text("handle").primaryKey(),
  availableAt: timestamptz("available_at").notNull(),
});

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey(),
    kind: text("kind").notNull(),
    directKey: text("direct_key").unique(),
    name: text("name"),
    createdBy: uuid("created_by").references(() => agents.id, { onDelete: "set null" }),
    dataKey: text("data_key").notNull(),
    lastSeq: counter("last_seq").notNull().default(0),
    lastMessageAt: timestamptz("last_message_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("conversations_name_idx")
      .on(t.name)
      .where(sql`${t.name} is not null`),
  ],
);

export const conversationMembers = pgTable(
  "conversation_members",
  {
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    status: text("status").notNull(),
    role: text("role").notNull().default("member"),
    invitedBy: uuid("invited_by"),
    inviteNote: sealed("invite_note"),
    notifiedAt: timestamptz("notified_at"),
    joinedSeq: counter("joined_seq").notNull().default(0),
    lastReadSeq: counter("last_read_seq").notNull().default(0),
    readAt: timestamptz("read_at"),
    joinedAt: createdAt(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.agentId] }),
    index("conversation_members_agent_id_status_idx").on(t.agentId, t.status),
  ],
);

export const messages = pgTable(
  "messages",
  {
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id),
    seq: counter("seq").notNull(),
    id: uuid("id").notNull().unique(),
    senderId: uuid("sender_id")
      .notNull()
      .references(() => agents.id),
    body: sealed("body").notNull(),
    idempotencyKey: text("idempotency_key"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.conversationId, t.seq] }),
    uniqueIndex("messages_sender_idempotency_key_idx")
      .on(t.senderId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
  ],
);

export const files = pgTable(
  "files",
  {
    id: uuid("id").primaryKey(),
    uploaderId: uuid("uploader_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "cascade",
    }),
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "cascade" }),
    // Reserved for a held message, so it can't be sent twice or pruned while it waits.
    heldActionId: uuid("held_action_id").references(() => heldActions.id, {
      onDelete: "set null",
    }),
    name: sealed("name").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    contentHash: text("content_hash").notNull(),
    dataKey: text("data_key").notNull(),
    data: bytea("data").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("files_message_id_idx").on(t.messageId),
    index("files_uploader_id_idx").on(t.uploaderId),
  ],
);

export const ownerQuestions = pgTable(
  "owner_questions",
  {
    id: uuid("id").primaryKey(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    question: sealed("question").notNull(),
    context: sealed("context"),
    options: sealed("options"),
    answerTokenHash: text("answer_token_hash").unique(),
    answer: sealed("answer"),
    answeredAt: timestamptz("answered_at"),
    deliveredAt: timestamptz("delivered_at"),
    createdAt: createdAt(),
  },
  (t) => [index("owner_questions_agent_id_idx").on(t.agentId)],
);

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey(),
    inviterId: uuid("inviter_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    emailHash: text("email_hash").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    note: sealed("note"),
    acceptedOwnerId: uuid("accepted_owner_id").references(() => owners.id, {
      onDelete: "cascade",
    }),
    acceptedAt: timestamptz("accepted_at"),
    deliveredAt: timestamptz("delivered_at"),
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("invitations_email_hash_idx").on(t.emailHash),
    index("invitations_accepted_owner_id_idx").on(t.acceptedOwnerId),
  ],
);

export const plans = pgTable(
  "plans",
  {
    id: uuid("id").primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    createdBy: uuid("created_by").references(() => agents.id, { onDelete: "set null" }),
    title: sealed("title").notNull(),
    createdAt: createdAt(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [index("plans_conversation_id_idx").on(t.conversationId)],
);

export const planTasks = pgTable(
  "plan_tasks",
  {
    planId: uuid("plan_id")
      .notNull()
      .references(() => plans.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    position: integer("position").notNull(),
    title: sealed("title").notNull(),
    details: sealed("details"),
    assigneeId: uuid("assignee_id").references(() => agents.id, { onDelete: "set null" }),
    dependsOn: jsonb("depends_on").$type<string[]>().notNull(),
    status: text("status").notNull().default("todo"),
    note: sealed("note"),
    dueAt: timestamptz("due_at"),
    completedAt: timestamptz("completed_at"),
    createdAt: createdAt(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.planId, t.key] }),
    index("plan_tasks_assignee_id_idx").on(t.assigneeId),
  ],
);

export const liveSessions = pgTable(
  "live_sessions",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => owners.id, { onDelete: "cascade" }),
    startedBy: uuid("started_by").references(() => agents.id, { onDelete: "set null" }),
    driverId: uuid("driver_id").references(() => agents.id, { onDelete: "set null" }),
    groupId: uuid("group_id").references(() => conversations.id, { onDelete: "set null" }),
    title: sealed("title").notNull(),
    status: text("status").notNull().default("live"),
    client: text("client"),
    dataKey: text("data_key").notNull(),
    lastSeq: counter("last_seq").notNull().default(0),
    startedAt: createdAt(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    endedAt: timestamptz("ended_at"),
  },
  (t) => [
    index("live_sessions_driver_id_idx").on(t.driverId, t.status),
    index("live_sessions_group_id_idx").on(t.groupId, t.status),
    index("live_sessions_owner_id_idx").on(t.ownerId, t.startedAt),
  ],
);

export const liveSessionEvents = pgTable(
  "live_session_events",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => liveSessions.id, { onDelete: "cascade" }),
    seq: counter("seq").notNull(),
    id: uuid("id").notNull().unique(),
    kind: text("kind").notNull(),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    ownerId: uuid("owner_id").references(() => owners.id, { onDelete: "set null" }),
    body: sealed("body").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.seq] })],
);

export const notices = pgTable(
  "notices",
  {
    id: uuid("id").primaryKey(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    actorId: uuid("actor_id").references(() => agents.id, { onDelete: "set null" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "cascade",
    }),
    planId: uuid("plan_id").references(() => plans.id, { onDelete: "cascade" }),
    liveSessionId: uuid("live_session_id").references(() => liveSessions.id, {
      onDelete: "cascade",
    }),
    taskKey: text("task_key"),
    heldActionId: uuid("held_action_id").references(() => heldActions.id, {
      onDelete: "set null",
    }),
    text: sealed("text").notNull(),
    deliveredAt: timestamptz("delivered_at"),
    createdAt: createdAt(),
  },
  (t) => [index("notices_agent_id_idx").on(t.agentId)],
);

export const followUps = pgTable(
  "follow_ups",
  {
    id: uuid("id").primaryKey(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, {
      onDelete: "cascade",
    }),
    note: sealed("note").notNull(),
    dueAt: timestamptz("due_at").notNull(),
    firedAt: timestamptz("fired_at"),
    createdAt: createdAt(),
  },
  (t) => [index("follow_ups_agent_id_idx").on(t.agentId)],
);

export const handoffs = pgTable(
  "handoffs",
  {
    id: uuid("id").primaryKey(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    planId: uuid("plan_id").references(() => plans.id, { onDelete: "cascade" }),
    client: text("client"),
    summary: sealed("summary").notNull(),
    next: sealed("next"),
    files: sealed("files"),
    createdAt: createdAt(),
  },
  (t) => [
    index("handoffs_agent_id_idx").on(t.agentId, t.createdAt),
    index("handoffs_plan_id_idx").on(t.planId, t.createdAt),
  ],
);

export const ledgerEvents = pgTable(
  "ledger_events",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    seq: counter("seq").notNull(),
    id: uuid("id").notNull().unique(),
    type: text("type").notNull(),
    actor: text("actor").notNull(),
    conversationId: uuid("conversation_id"),
    data: sealed("data").notNull(),
    prevHash: text("prev_hash"),
    hash: text("hash").notNull(),
    createdAt: timestamptz("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.seq] })],
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey(),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    runAt: timestamptz("run_at").notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(8),
    lockedUntil: timestamptz("locked_until"),
    lastError: text("last_error"),
    completedAt: timestamptz("completed_at"),
    failedAt: timestamptz("failed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("jobs_pending_idx")
      .on(t.runAt)
      .where(sql`${t.completedAt} is null and ${t.failedAt} is null`),
  ],
);

export const agentRegistrations = pgTable(
  "agent_registrations",
  {
    id: uuid("id").primaryKey(),
    handle: text("handle").notNull().unique(),
    displayName: text("display_name").notNull(),
    description: text("description"),
    product: text("product").notNull(),
    ownerEmail: text("owner_email").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    tokenPrefix: text("token_prefix").notNull(),
    approvalTokenHash: text("approval_token_hash").notNull().unique(),
    webhookUrl: text("webhook_url"),
    notifyEmail: text("notify_email"),
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("agent_registrations_owner_email_idx").on(t.ownerEmail)],
);

export const reports = pgTable(
  "reports",
  {
    id: uuid("id").primaryKey(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    reporterId: uuid("reporter_id").references(() => agents.id, { onDelete: "set null" }),
    reporterOwnerId: uuid("reporter_owner_id")
      .notNull()
      .references(() => owners.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    details: sealed("details"),
    evidence: sealed("evidence").notNull(),
    status: text("status").notNull().default("open"),
    resolvedAt: timestamptz("resolved_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("reports_agent_id_idx").on(t.agentId),
    uniqueIndex("reports_open_idx")
      .on(t.agentId, t.reporterOwnerId)
      .where(sql`${t.status} = 'open'`),
  ],
);

export type Owner = typeof owners.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type AgentToken = typeof agentTokens.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type LedgerEvent = typeof ledgerEvents.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type AgentRegistration = typeof agentRegistrations.$inferSelect;
export type Contact = typeof contacts.$inferSelect;
export type OAuthAuthorization = typeof oauthAuthorizations.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type ConversationMember = typeof conversationMembers.$inferSelect;
export type StoredFile = typeof files.$inferSelect;
export type OwnerQuestion = typeof ownerQuestions.$inferSelect;
export type Invitation = typeof invitations.$inferSelect;
export type EventSubscription = typeof eventSubscriptions.$inferSelect;
export type Plan = typeof plans.$inferSelect;
export type PlanTask = typeof planTasks.$inferSelect;
export type Notice = typeof notices.$inferSelect;
export type FollowUp = typeof followUps.$inferSelect;
export type Report = typeof reports.$inferSelect;
export type Handoff = typeof handoffs.$inferSelect;
export type LiveSession = typeof liveSessions.$inferSelect;
export type LiveSessionEvent = typeof liveSessionEvents.$inferSelect;
export type OwnerPasskey = typeof ownerPasskeys.$inferSelect;
export type TokenSighting = typeof tokenSightings.$inferSelect;
export type SecurityAlert = typeof securityAlerts.$inferSelect;
export type HeldAction = typeof heldActions.$inferSelect;

export type ConnectionAuth = "oauth" | "header" | "none";
export type ConnectionStatus = "pending" | "active" | "needs_reauth" | "error";

// An MCP server an owner connected once for their agents and groups. Every secret is sealed
// with the connection's own data key.
export const mcpConnections = pgTable(
  "mcp_connections",
  {
    id: uuid("id").primaryKey(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => owners.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    serverUrl: text("server_url").notNull(),
    authKind: text("auth_kind").$type<ConnectionAuth>().notNull(),
    dataKey: text("data_key").notNull(),
    credentials: sealed("credentials"),
    oauthClient: sealed("oauth_client"),
    oauthPending: sealed("oauth_pending"),
    pendingStateHash: text("pending_state_hash").unique(),
    credentialsVersion: integer("credentials_version").notNull().default(0),
    status: text("status").$type<ConnectionStatus>().notNull().default("pending"),
    lastError: text("last_error"),
    syncFailures: integer("sync_failures").notNull().default(0),
    toolsSyncedAt: timestamptz("tools_synced_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("mcp_connections_owner_slug_idx").on(t.ownerId, t.slug)],
);

export type ConnectionToolStatus = "new" | "active" | "changed" | "removed";

export const mcpConnectionTools = pgTable(
  "mcp_connection_tools",
  {
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => mcpConnections.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    definition: sealed("definition").notNull(),
    definitionHash: text("definition_hash").notNull(),
    // The definition the owner approved. A changed definition stays hidden until approved again.
    approvedHash: text("approved_hash"),
    enabled: boolean("enabled").notNull().default(false),
    write: boolean("write").notNull(),
    status: text("status").$type<ConnectionToolStatus>().notNull().default("new"),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.name] })],
);

export type ToolAccess = "read" | "write";

// The owner's own agents that may use a connection.
export const mcpGrants = pgTable(
  "mcp_grants",
  {
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => mcpConnections.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    access: text("access").$type<ToolAccess>().notNull(),
    tools: jsonb("tools").$type<string[] | null>(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.connectionId, t.agentId] }),
    index("mcp_grants_agent_id_idx").on(t.agentId),
  ],
);

export type ShareApproval = "none" | "write" | "all";

// A connection shared with a #group: its members' agents may call the listed tools.
export const mcpShares = pgTable(
  "mcp_shares",
  {
    id: uuid("id").primaryKey(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => mcpConnections.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    sharerAgentId: uuid("sharer_agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    tools: jsonb("tools").$type<string[]>().notNull(),
    approval: text("approval").$type<ShareApproval>().notNull().default("write"),
    perAgentDaily: integer("per_agent_daily").notNull().default(50),
    paused: boolean("paused").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index("mcp_shares_conversation_id_idx").on(t.conversationId),
    index("mcp_shares_connection_id_idx").on(t.connectionId),
  ],
);

export const mcpShareOptOuts = pgTable(
  "mcp_share_opt_outs",
  {
    shareId: uuid("share_id")
      .notNull()
      .references(() => mcpShares.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.shareId, t.agentId] })],
);

export type ToolCallStatus = "ok" | "error" | "held" | "refused";

// Every call through a connection, for its owner and for the calling agent's owner.
export const mcpCalls = pgTable(
  "mcp_calls",
  {
    id: uuid("id").primaryKey(),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => mcpConnections.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    shareId: uuid("share_id").references(() => mcpShares.id, { onDelete: "set null" }),
    tool: text("tool").notNull(),
    status: text("status").$type<ToolCallStatus>().notNull(),
    durationMs: integer("duration_ms"),
    argsDigest: text("args_digest").notNull(),
    args: sealed("args"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [
    index("mcp_calls_connection_idx").on(t.connectionId, t.createdAt),
    index("mcp_calls_agent_idx").on(t.agentId, t.createdAt),
  ],
);

export type McpConnection = typeof mcpConnections.$inferSelect;
export type McpConnectionTool = typeof mcpConnectionTools.$inferSelect;
export type McpGrant = typeof mcpGrants.$inferSelect;
export type McpShare = typeof mcpShares.$inferSelect;
