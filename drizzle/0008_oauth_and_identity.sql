CREATE TABLE "oauth_authorizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"client_name" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"state" text,
	"code_challenge" text NOT NULL,
	"resource" text NOT NULL,
	"nonce_hash" text NOT NULL,
	"code_hash" text,
	"agent_id" uuid,
	"token_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_authorizations_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"secret_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_tokens" ADD COLUMN "client_id" text;--> statement-breakpoint
ALTER TABLE "agent_tokens" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_tokens" ADD COLUMN "refresh_token_hash" text;--> statement-breakpoint
ALTER TABLE "agent_tokens" ADD COLUMN "previous_refresh_token_hash" text;--> statement-breakpoint
ALTER TABLE "agent_tokens" ADD COLUMN "refresh_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "owners" ADD COLUMN "show_domain" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_authorizations" ADD CONSTRAINT "oauth_authorizations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_tokens_previous_refresh_token_hash_idx" ON "agent_tokens" USING btree ("previous_refresh_token_hash");--> statement-breakpoint
ALTER TABLE "agent_tokens" ADD CONSTRAINT "agent_tokens_refresh_token_hash_unique" UNIQUE("refresh_token_hash");