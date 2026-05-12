ALTER TABLE "closed_trades" ADD COLUMN "pnl_partial" boolean;--> statement-breakpoint
ALTER TABLE "closed_trades" ADD COLUMN "long_entry_price" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "closed_trades" ADD COLUMN "short_entry_price" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "closed_trades" ADD COLUMN "long_exit_price" numeric(20, 8);--> statement-breakpoint
ALTER TABLE "closed_trades" ADD COLUMN "short_exit_price" numeric(20, 8);