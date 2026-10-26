CREATE TABLE "agent_networks" (
	"agent_id" uuid NOT NULL,
	"network_digest" text NOT NULL,
	"label" text NOT NULL,
	"status" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_networks_agent_id_network_digest_pk" PRIMARY KEY("agent_id","network_digest")
);
--> statement-breakpoint
CREATE TABLE "owner_passkeys" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" "bytea" NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" jsonb,
	"device_type" text NOT NULL,
	"backed_up" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_passkeys_credential_id_unique" UNIQUE("credential_id")
);
--> statement-breakpoint
CREATE TABLE "passkey_resets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"cancel_token_hash" text NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "passkey_resets_cancel_token_hash_unique" UNIQUE("cancel_token_hash")
);
--> statement-breakpoint
CREATE TABLE "security_alerts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"agent_id" uuid,
	"token_id" uuid,
	"kind" text NOT NULL,
	"details" text NOT NULL,
	"network_digest" text,
	"action_token_hash" text,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_via" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "security_alerts_action_token_hash_unique" UNIQUE("action_token_hash")
);
--> statement-breakpoint
CREATE TABLE "token_sightings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"token_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"ip_digest" text NOT NULL,
	"ip" text NOT NULL,
	"user_agent" text,
	"network" text,
	"network_digest" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "frozen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "elevated_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_networks" ADD CONSTRAINT "agent_networks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_passkeys" ADD CONSTRAINT "owner_passkeys_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey_resets" ADD CONSTRAINT "passkey_resets_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_alerts" ADD CONSTRAINT "security_alerts_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_alerts" ADD CONSTRAINT "security_alerts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_alerts" ADD CONSTRAINT "security_alerts_token_id_agent_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."agent_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_sightings" ADD CONSTRAINT "token_sightings_token_id_agent_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."agent_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "token_sightings" ADD CONSTRAINT "token_sightings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "owner_passkeys_owner_id_idx" ON "owner_passkeys" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "passkey_resets_owner_id_idx" ON "passkey_resets" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "security_alerts_owner_status_idx" ON "security_alerts" USING btree ("owner_id","status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "token_sightings_token_ip_idx" ON "token_sightings" USING btree ("token_id","ip_digest");--> statement-breakpoint
CREATE INDEX "token_sightings_agent_id_idx" ON "token_sightings" USING btree ("agent_id");