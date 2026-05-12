ALTER TABLE "closed_trades" ADD COLUMN IF NOT EXISTS "pnl_partial" boolean;--> statement-breakpoint
ALTER TABLE "closed_trades" ADD COLUMN IF NOT EXISTS "long_entry_price" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "closed_trades" ADD COLUMN IF NOT EXISTS "short_entry_price" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "closed_trades" ADD COLUMN IF NOT EXISTS "long_exit_price" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "closed_trades" ADD COLUMN IF NOT EXISTS "short_exit_price" numeric(20, 8);
