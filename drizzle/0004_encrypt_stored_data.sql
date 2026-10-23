ALTER TABLE "ledger_events" ALTER COLUMN "data" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "data_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "owners" ADD COLUMN "data_key" text NOT NULL;