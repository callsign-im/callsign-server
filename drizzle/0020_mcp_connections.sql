CREATE TABLE "mcp_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"agent_id" uuid,
	"share_id" uuid,
	"tool" text NOT NULL,
	"status" text NOT NULL,
	"duration_ms" integer,
	"args_digest" text NOT NULL,
	"args" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_connection_tools" (
	"connection_id" uuid NOT NULL,
	"name" text NOT NULL,
	"definition" text NOT NULL,
	"definition_hash" text NOT NULL,
	"approved_hash" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"write" boolean NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_connection_tools_connection_id_name_pk" PRIMARY KEY("connection_id","name")
);
--> statement-breakpoint
CREATE TABLE "mcp_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"server_url" text NOT NULL,
	"auth_kind" text NOT NULL,
	"data_key" text NOT NULL,
	"credentials" text,
	"oauth_client" text,
	"oauth_pending" text,
	"pending_state_hash" text,
	"credentials_version" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"sync_failures" integer DEFAULT 0 NOT NULL,
	"tools_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_connections_pending_state_hash_unique" UNIQUE("pending_state_hash")
);
--> statement-breakpoint
CREATE TABLE "mcp_grants" (
	"connection_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"access" text NOT NULL,
	"tools" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_grants_connection_id_agent_id_pk" PRIMARY KEY("connection_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "mcp_share_opt_outs" (
	"share_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_share_opt_outs_share_id_agent_id_pk" PRIMARY KEY("share_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "mcp_shares" (
	"id" uuid PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sharer_agent_id" uuid NOT NULL,
	"tools" jsonb NOT NULL,
	"approval" text DEFAULT 'write' NOT NULL,
	"per_agent_daily" integer DEFAULT 50 NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "shared_tools" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_calls" ADD CONSTRAINT "mcp_calls_connection_id_mcp_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_calls" ADD CONSTRAINT "mcp_calls_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_calls" ADD CONSTRAINT "mcp_calls_share_id_mcp_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."mcp_shares"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_connection_tools" ADD CONSTRAINT "mcp_connection_tools_connection_id_mcp_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_connections" ADD CONSTRAINT "mcp_connections_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_grants" ADD CONSTRAINT "mcp_grants_connection_id_mcp_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_grants" ADD CONSTRAINT "mcp_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_share_opt_outs" ADD CONSTRAINT "mcp_share_opt_outs_share_id_mcp_shares_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."mcp_shares"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_share_opt_outs" ADD CONSTRAINT "mcp_share_opt_outs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_shares" ADD CONSTRAINT "mcp_shares_connection_id_mcp_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."mcp_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_shares" ADD CONSTRAINT "mcp_shares_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_shares" ADD CONSTRAINT "mcp_shares_sharer_agent_id_agents_id_fk" FOREIGN KEY ("sharer_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_calls_connection_idx" ON "mcp_calls" USING btree ("connection_id","created_at");--> statement-breakpoint
CREATE INDEX "mcp_calls_agent_idx" ON "mcp_calls" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_connections_owner_slug_idx" ON "mcp_connections" USING btree ("owner_id","slug");--> statement-breakpoint
CREATE INDEX "mcp_grants_agent_id_idx" ON "mcp_grants" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "mcp_shares_conversation_id_idx" ON "mcp_shares" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "mcp_shares_connection_id_idx" ON "mcp_shares" USING btree ("connection_id");