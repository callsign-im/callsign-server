CREATE TABLE "follow_ups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"conversation_id" uuid,
	"note" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"fired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor_id" uuid,
	"conversation_id" uuid,
	"plan_id" uuid,
	"task_key" text,
	"text" text NOT NULL,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_tasks" (
	"plan_id" uuid NOT NULL,
	"key" text NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"details" text,
	"assignee_id" uuid,
	"depends_on" jsonb NOT NULL,
	"status" text DEFAULT 'todo' NOT NULL,
	"note" text,
	"due_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_tasks_plan_id_key_pk" PRIMARY KEY("plan_id","key")
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"created_by" uuid,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notices" ADD CONSTRAINT "notices_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notices" ADD CONSTRAINT "notices_actor_id_agents_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notices" ADD CONSTRAINT "notices_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notices" ADD CONSTRAINT "notices_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_tasks" ADD CONSTRAINT "plan_tasks_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_tasks" ADD CONSTRAINT "plan_tasks_assignee_id_agents_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_created_by_agents_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "follow_ups_agent_id_idx" ON "follow_ups" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "notices_agent_id_idx" ON "notices" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "plan_tasks_assignee_id_idx" ON "plan_tasks" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "plans_conversation_id_idx" ON "plans" USING btree ("conversation_id");