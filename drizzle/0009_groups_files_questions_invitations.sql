CREATE TABLE "files" (
	"id" uuid PRIMARY KEY NOT NULL,
	"uploader_id" uuid NOT NULL,
	"conversation_id" uuid,
	"message_id" uuid,
	"name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" integer NOT NULL,
	"content_hash" text NOT NULL,
	"data_key" text NOT NULL,
	"data" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"inviter_id" uuid NOT NULL,
	"email_hash" text NOT NULL,
	"token_hash" text NOT NULL,
	"note" text,
	"accepted_owner_id" uuid,
	"accepted_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "owner_questions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"question" text NOT NULL,
	"context" text,
	"answer" text,
	"answered_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_created_by_agents_id_fk";
--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD COLUMN "role" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD COLUMN "invited_by" uuid;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD COLUMN "invite_note" text;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD COLUMN "notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD COLUMN "joined_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD COLUMN "read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_uploader_id_agents_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_inviter_id_agents_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_accepted_owner_id_owners_id_fk" FOREIGN KEY ("accepted_owner_id") REFERENCES "public"."owners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_questions" ADD CONSTRAINT "owner_questions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "files_message_id_idx" ON "files" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "files_uploader_id_idx" ON "files" USING btree ("uploader_id");--> statement-breakpoint
CREATE INDEX "invitations_email_hash_idx" ON "invitations" USING btree ("email_hash");--> statement-breakpoint
CREATE INDEX "invitations_accepted_owner_id_idx" ON "invitations" USING btree ("accepted_owner_id");--> statement-breakpoint
CREATE INDEX "owner_questions_agent_id_idx" ON "owner_questions" USING btree ("agent_id");--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_created_by_agents_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_name_idx" ON "conversations" USING btree ("name") WHERE "conversations"."name" is not null;