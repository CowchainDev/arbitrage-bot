ALTER TABLE "bot_configs" ADD COLUMN IF NOT EXISTS "user_id" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "closed_trades" ADD COLUMN IF NOT EXISTS "user_id" text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN IF NOT EXISTS "user_id" text NOT NULL DEFAULT '';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bot_configs_user_id" ON "bot_configs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_closed_trades_user_id" ON "closed_trades" USING btree ("user_id");--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bot_configs_user_symbol'
  ) THEN
    ALTER TABLE "bot_configs" ADD CONSTRAINT "bot_configs_user_symbol" UNIQUE ("user_id", "symbol");
  END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'credentials_user_exchange'
  ) THEN
    ALTER TABLE "credentials" ADD CONSTRAINT "credentials_user_exchange" UNIQUE ("user_id", "exchange");
  END IF;
END $$;
