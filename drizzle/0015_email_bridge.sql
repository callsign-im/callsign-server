ALTER TABLE "agents" ADD COLUMN "email_bridge" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "public_email" boolean DEFAULT false NOT NULL;