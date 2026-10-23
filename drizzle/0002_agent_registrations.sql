CREATE TABLE "agent_registrations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"display_name" text NOT NULL,
	"product" text NOT NULL,
	"owner_email" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"approval_token_hash" text NOT NULL,
	"webhook_url" text,
	"notify_email" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_registrations_handle_unique" UNIQUE("handle"),
	CONSTRAINT "agent_registrations_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "agent_registrations_approval_token_hash_unique" UNIQUE("approval_token_hash")
);
--> statement-breakpoint
CREATE INDEX "agent_registrations_owner_email_idx" ON "agent_registrations" USING btree ("owner_email");