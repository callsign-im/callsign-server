CREATE TABLE "handoffs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"plan_id" uuid,
	"client" text,
	"summary" text NOT NULL,
	"next" text,
	"files" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_tokens" ADD COLUMN "inbox_cursor" bigint;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "handoffs_agent_id_idx" ON "handoffs" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "handoffs_plan_id_idx" ON "handoffs" USING btree ("plan_id","created_at");