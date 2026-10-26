CREATE TABLE "held_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"token_id" uuid,
	"approver_owner_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"reasons" jsonb NOT NULL,
	"lane_digest" text NOT NULL,
	"payload" text,
	"summary" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"approval_token_hash" text,
	"decided_via" text,
	"decided_at" timestamp with time zone,
	"result" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "held_actions_approval_token_hash_unique" UNIQUE("approval_token_hash")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "policy" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "held_action_id" uuid;--> statement-breakpoint
ALTER TABLE "notices" ADD COLUMN "held_action_id" uuid;--> statement-breakpoint
ALTER TABLE "held_actions" ADD CONSTRAINT "held_actions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "held_actions" ADD CONSTRAINT "held_actions_token_id_agent_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."agent_tokens"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "held_actions" ADD CONSTRAINT "held_actions_approver_owner_id_owners_id_fk" FOREIGN KEY ("approver_owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "held_actions_agent_status_idx" ON "held_actions" USING btree ("agent_id","status","created_at");--> statement-breakpoint
CREATE INDEX "held_actions_approver_status_idx" ON "held_actions" USING btree ("approver_owner_id","status","created_at");--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_held_action_id_held_actions_id_fk" FOREIGN KEY ("held_action_id") REFERENCES "public"."held_actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notices" ADD CONSTRAINT "notices_held_action_id_held_actions_id_fk" FOREIGN KEY ("held_action_id") REFERENCES "public"."held_actions"("id") ON DELETE set null ON UPDATE no action;