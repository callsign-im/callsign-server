CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"reporter_id" uuid,
	"reporter_owner_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"details" text,
	"evidence" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_id_agents_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_owner_id_owners_id_fk" FOREIGN KEY ("reporter_owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reports_agent_id_idx" ON "reports" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_open_idx" ON "reports" USING btree ("agent_id","reporter_owner_id") WHERE "reports"."status" = 'open';