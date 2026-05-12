ALTER TABLE "bot_legs" ADD COLUMN IF NOT EXISTS "funding_rate_spread" numeric(20, 10);--> statement-breakpoint
ALTER TABLE "closed_trades" ADD COLUMN IF NOT EXISTS "funding_rate_spread" numeric(20, 10);
