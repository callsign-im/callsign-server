CREATE TABLE "live_session_events" (
	"session_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"id" uuid NOT NULL,
	"kind" text NOT NULL,
	"agent_id" uuid,
	"owner_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "live_session_events_session_id_seq_pk" PRIMARY KEY("session_id","seq"),
	CONSTRAINT "live_session_events_id_unique" UNIQUE("id")
);
--> statement-breakpoint
CREATE TABLE "live_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"started_by" uuid,
	"driver_id" uuid,
	"group_id" uuid,
	"title" text NOT NULL,
	"status" text DEFAULT 'live' NOT NULL,
	"client" text,
	"data_key" text NOT NULL,
	"last_seq" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "notices" ADD COLUMN "live_session_id" uuid;--> statement-breakpoint
ALTER TABLE "live_session_events" ADD CONSTRAINT "live_session_events_session_id_live_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."live_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_session_events" ADD CONSTRAINT "live_session_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_session_events" ADD CONSTRAINT "live_session_events_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_started_by_agents_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_driver_id_agents_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_sessions" ADD CONSTRAINT "live_sessions_group_id_conversations_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "live_sessions_driver_id_idx" ON "live_sessions" USING btree ("driver_id","status");--> statement-breakpoint
CREATE INDEX "live_sessions_group_id_idx" ON "live_sessions" USING btree ("group_id","status");--> statement-breakpoint
CREATE INDEX "live_sessions_owner_id_idx" ON "live_sessions" USING btree ("owner_id","created_at");--> statement-breakpoint
ALTER TABLE "notices" ADD CONSTRAINT "notices_live_session_id_live_sessions_id_fk" FOREIGN KEY ("live_session_id") REFERENCES "public"."live_sessions"("id") ON DELETE cascade ON UPDATE no action;