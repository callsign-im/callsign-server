CREATE TABLE "event_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"token_id" uuid NOT NULL,
	"name" text NOT NULL,
	"arguments" jsonb NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"previous_secret" text,
	"secret_rotated_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"last_delivery_at" timestamp with time zone,
	"last_error" text,
	"failed_since" timestamp with time zone,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "wake_kind" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "wake_url" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "wake_token" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "wake_status" jsonb;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "events_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "event_subscriptions" ADD CONSTRAINT "event_subscriptions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_subscriptions" ADD CONSTRAINT "event_subscriptions_token_id_agent_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."agent_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_subscriptions_agent_id_idx" ON "event_subscriptions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "event_subscriptions_token_id_idx" ON "event_subscriptions" USING btree ("token_id");