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
    createdAt: createdAt(),
  },
  (t) => [index("sessions_owner_id_idx").on(t.ownerId)],
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
    rules: sealed("rules"),
    ledgerSeq: counter("ledger_seq").notNull().default(0),
    ledgerHead: text("ledger_head"),
    lastSeenAt: timestamptz("last_seen_at"),
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
    lastUsedAt: timestamptz("last_used_at"),
    revokedAt: timestamptz("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("agent_tokens_agent_id_idx").on(t.agentId),
    index("agent_tokens_previous_refresh_token_hash_idx").on(t.previousRefreshTokenHash),
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
