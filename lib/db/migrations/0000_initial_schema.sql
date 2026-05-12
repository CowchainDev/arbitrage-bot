CREATE TABLE "bot_configs" (
        "id" serial PRIMARY KEY NOT NULL,
        "symbol" text NOT NULL,
        "enabled" boolean DEFAULT false NOT NULL,
        "enter_spread_pct" numeric(20, 8) DEFAULT '0.05' NOT NULL,
        "close_spread_pct" numeric(20, 8) DEFAULT '0.01' NOT NULL,
        "stop_loss_spread_pct" numeric(20, 8) DEFAULT '0' NOT NULL,
        "order_size_usd" numeric(20, 8) DEFAULT '50' NOT NULL,
        "max_orders" integer DEFAULT 3 NOT NULL,
        "force_stop_usd" numeric(20, 8) DEFAULT '20' NOT NULL,
        "bybit_leverage" integer DEFAULT 1 NOT NULL,
        "binance_leverage" integer DEFAULT 1 NOT NULL,
        "exchange_a" text DEFAULT 'bybit' NOT NULL,
        "exchange_b" text DEFAULT 'binance' NOT NULL,
        "leverage_a" integer DEFAULT 1 NOT NULL,
        "leverage_b" integer DEFAULT 1 NOT NULL,
        "created_at" timestamp DEFAULT now() NOT NULL,
        "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_legs" (
        "id" serial PRIMARY KEY NOT NULL,
        "bot_config_id" integer NOT NULL,
        "symbol" text NOT NULL,
        "bybit_order_id" text,
        "binance_order_id" text,
        "bybit_qty" numeric(20, 8) DEFAULT '0' NOT NULL,
        "binance_qty" numeric(20, 8) DEFAULT '0' NOT NULL,
        "bybit_entry" numeric(20, 8) DEFAULT '0' NOT NULL,
        "binance_entry" numeric(20, 8) DEFAULT '0' NOT NULL,
        "bybit_side" text DEFAULT 'long' NOT NULL,
        "binance_side" text DEFAULT 'short' NOT NULL,
        "spread_at_entry" numeric(20, 8) DEFAULT '0' NOT NULL,
        "enter_spread_threshold_pct" numeric(20, 8),
        "spread_at_exit" numeric(20, 8),
        "realized_pnl_usd" numeric(20, 8),
        "funding_paid_usd" numeric(20, 8),
        "open_fee_a" numeric(20, 8) DEFAULT '0' NOT NULL,
        "open_fee_b" numeric(20, 8) DEFAULT '0' NOT NULL,
        "contract_size_b" numeric(20, 8),
        "leg_exchange_a" text,
        "leg_exchange_b" text,
        "status" text DEFAULT 'open' NOT NULL,
        "opened_at" timestamp DEFAULT now() NOT NULL,
        "closed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "closed_trades" (
        "id" serial PRIMARY KEY NOT NULL,
        "symbol" text NOT NULL,
        "long_exchange" text NOT NULL,
        "short_exchange" text NOT NULL,
        "spread_at_entry" numeric(20, 8) DEFAULT '0' NOT NULL,
        "enter_spread_threshold_pct" numeric(20, 8),
        "realized_pnl" numeric(20, 8) DEFAULT '0' NOT NULL,
        "quantity" numeric(20, 8) DEFAULT '0' NOT NULL,
        "total_fees" numeric(20, 8) DEFAULT '0' NOT NULL,
        "open_fees" numeric(20, 8) DEFAULT '0' NOT NULL,
        "funding_paid_usd" numeric(20, 8),
        "spread_at_exit" numeric(20, 8),
        "close_reason" text,
        "entry_time" timestamp DEFAULT now() NOT NULL,
        "close_time" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credentials" (
        "exchange" text PRIMARY KEY NOT NULL,
        "api_key" text NOT NULL,
        "api_secret" text NOT NULL,
        "passphrase" text,
        "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bot_legs" ADD CONSTRAINT "bot_legs_bot_config_id_bot_configs_id_fk" FOREIGN KEY ("bot_config_id") REFERENCES "public"."bot_configs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_bot_legs_bot_config_id" ON "bot_legs" USING btree ("bot_config_id");--> statement-breakpoint
CREATE INDEX "idx_bot_legs_status" ON "bot_legs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_closed_trades_close_time" ON "closed_trades" USING btree ("close_time");