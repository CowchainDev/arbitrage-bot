import {
  pgTable,
  serial,
  text,
  numeric,
  timestamp,
  boolean,
  integer,
  index,
} from "drizzle-orm/pg-core";

export const credentialsTable = pgTable("credentials", {
  exchange: text("exchange").primaryKey(),
  apiKey: text("api_key").notNull(),
  apiSecret: text("api_secret").notNull(),
  passphrase: text("passphrase"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type Credential = typeof credentialsTable.$inferSelect;
export type InsertCredential = typeof credentialsTable.$inferInsert;

export const closedTradesTable = pgTable(
  "closed_trades",
  {
    id: serial("id").primaryKey(),
    symbol: text("symbol").notNull(),
    longExchange: text("long_exchange").notNull(),
    shortExchange: text("short_exchange").notNull(),
    spreadAtEntry: numeric("spread_at_entry", { precision: 20, scale: 8 })
      .notNull()
      .default("0"),
    realizedPnl: numeric("realized_pnl", { precision: 20, scale: 8 })
      .notNull()
      .default("0"),
    quantity: numeric("quantity", { precision: 20, scale: 8 })
      .notNull()
      .default("0"),
    totalFees: numeric("total_fees", { precision: 20, scale: 8 }).notNull().default("0"),
    entryTime: timestamp("entry_time").notNull().defaultNow(),
    closeTime: timestamp("close_time").notNull().defaultNow(),
  },
  (t) => [index("idx_closed_trades_close_time").on(t.closeTime)],
);

export type ClosedTrade = typeof closedTradesTable.$inferSelect;
export type InsertClosedTrade = typeof closedTradesTable.$inferInsert;

export const botConfigsTable = pgTable("bot_configs", {
  id: serial("id").primaryKey(),
  symbol: text("symbol").notNull().unique(),
  enabled: boolean("enabled").notNull().default(false),
  enterSpreadPct: numeric("enter_spread_pct", { precision: 20, scale: 8 }).notNull().default("0.05"),
  closeSpreadPct: numeric("close_spread_pct", { precision: 20, scale: 8 }).notNull().default("0.01"),
  stopLossSpreadPct: numeric("stop_loss_spread_pct", { precision: 20, scale: 8 }).notNull().default("0"),
  orderSizeUsd: numeric("order_size_usd", { precision: 20, scale: 8 }).notNull().default("50"),
  maxOrders: integer("max_orders").notNull().default(3),
  forceStopUsd: numeric("force_stop_usd", { precision: 20, scale: 8 }).notNull().default("20"),
  bybitLeverage: integer("bybit_leverage").notNull().default(1),
  binanceLeverage: integer("binance_leverage").notNull().default(1),
  exchangeA: text("exchange_a").notNull().default("bybit"),
  exchangeB: text("exchange_b").notNull().default("binance"),
  leverageA: integer("leverage_a").notNull().default(1),
  leverageB: integer("leverage_b").notNull().default(1),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type BotConfig = typeof botConfigsTable.$inferSelect;
export type InsertBotConfig = typeof botConfigsTable.$inferInsert;

export const botLegsTable = pgTable(
  "bot_legs",
  {
    id: serial("id").primaryKey(),
    botConfigId: integer("bot_config_id").notNull().references(() => botConfigsTable.id),
    symbol: text("symbol").notNull(),
    bybitOrderId: text("bybit_order_id"),
    binanceOrderId: text("binance_order_id"),
    bybitQty: numeric("bybit_qty", { precision: 20, scale: 8 }).notNull().default("0"),
    binanceQty: numeric("binance_qty", { precision: 20, scale: 8 }).notNull().default("0"),
    bybitEntry: numeric("bybit_entry", { precision: 20, scale: 8 }).notNull().default("0"),
    binanceEntry: numeric("binance_entry", { precision: 20, scale: 8 }).notNull().default("0"),
    bybitSide: text("bybit_side").notNull().default("long"),
    binanceSide: text("binance_side").notNull().default("short"),
    spreadAtEntry: numeric("spread_at_entry", { precision: 20, scale: 8 }).notNull().default("0"),
    spreadAtExit: numeric("spread_at_exit", { precision: 20, scale: 8 }),
    realizedPnlUsd: numeric("realized_pnl_usd", { precision: 20, scale: 8 }),
    openFeeA: numeric("open_fee_a", { precision: 20, scale: 8 }).notNull().default("0"),
    openFeeB: numeric("open_fee_b", { precision: 20, scale: 8 }).notNull().default("0"),
    status: text("status").notNull().default("open"),
    openedAt: timestamp("opened_at").notNull().defaultNow(),
    closedAt: timestamp("closed_at"),
  },
  (t) => [
    index("idx_bot_legs_bot_config_id").on(t.botConfigId),
    index("idx_bot_legs_status").on(t.status),
  ],
);

export type BotLeg = typeof botLegsTable.$inferSelect;
export type InsertBotLeg = typeof botLegsTable.$inferInsert;
