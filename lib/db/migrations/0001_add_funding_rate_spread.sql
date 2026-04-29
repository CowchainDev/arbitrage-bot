ALTER TABLE "bot_legs" ADD COLUMN "funding_rate_spread" numeric(20, 10);--> statement-breakpoint
ALTER TABLE "closed_trades" ADD COLUMN "funding_rate_spread" numeric(20, 10);