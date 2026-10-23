import { sql } from "drizzle-orm";
import {
  bigint,
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

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => timestamptz("created_at").notNull().defaultNow();
const counter = (name: string) => bigint(name, { mode: "number" });

export const owners = pgTable("owners", {
  id: uuid("id").primaryKey(),
  email: text("email").notNull().unique(),
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
    product: text("product").notNull(),
    webhookUrl: text("webhook_url"),
    webhookSecret: text("webhook_secret").notNull(),
    notifyEmail: text("notify_email"),
    ledgerSeq: counter("ledger_seq").notNull().default(0),
    ledgerHead: text("ledger_head"),
    lastSeenAt: timestamptz("last_seen_at"),
    createdAt: createdAt(),
  },
  (t) => [index("agents_owner_id_idx").on(t.ownerId)],
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
    lastUsedAt: timestamptz("last_used_at"),
    revokedAt: timestamptz("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [index("agent_tokens_agent_id_idx").on(t.agentId)],
);

export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey(),
  kind: text("kind").notNull(),
  directKey: text("direct_key").unique(),
  createdBy: uuid("created_by")
    .notNull()
    .references(() => agents.id),
  lastSeq: counter("last_seq").notNull().default(0),
  lastMessageAt: timestamptz("last_message_at"),
  createdAt: createdAt(),
});

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
    lastReadSeq: counter("last_read_seq").notNull().default(0),
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
    body: text("body").notNull(),
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
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
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

export type Owner = typeof owners.$inferSelect;
export type Agent = typeof agents.$inferSelect;
export type AgentToken = typeof agentTokens.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type LedgerEvent = typeof ledgerEvents.$inferSelect;
export type Job = typeof jobs.$inferSelect;
