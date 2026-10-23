ALTER TABLE "agent_registrations" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "is_primary" boolean DEFAULT false NOT NULL;--> statement-breakpoint
UPDATE "agents" SET "is_primary" = true WHERE "id" IN (
  SELECT DISTINCT ON ("owner_id") "id" FROM "agents" ORDER BY "owner_id", "created_at", "id"
);--> statement-breakpoint
CREATE UNIQUE INDEX "agents_owner_id_primary_idx" ON "agents" USING btree ("owner_id") WHERE "agents"."is_primary";