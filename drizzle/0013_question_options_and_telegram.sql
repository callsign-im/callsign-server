ALTER TABLE "owner_questions" ADD COLUMN "options" text;--> statement-breakpoint
ALTER TABLE "owner_questions" ADD COLUMN "answer_token_hash" text;--> statement-breakpoint
ALTER TABLE "owners" ADD COLUMN "telegram_chat_id" text;--> statement-breakpoint
ALTER TABLE "owner_questions" ADD CONSTRAINT "owner_questions_answer_token_hash_unique" UNIQUE("answer_token_hash");--> statement-breakpoint
ALTER TABLE "owners" ADD CONSTRAINT "owners_telegram_chat_id_unique" UNIQUE("telegram_chat_id");