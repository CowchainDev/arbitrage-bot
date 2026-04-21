import {
  pgTable,
  serial,
  text,
  numeric,
  timestamp,
} from "drizzle-orm/pg-core";

export const closedTradesTable = pgTable("closed_trades", {
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
  entryTime: timestamp("entry_time").notNull().defaultNow(),
  closeTime: timestamp("close_time").notNull().defaultNow(),
});

export type ClosedTrade = typeof closedTradesTable.$inferSelect;
export type InsertClosedTrade = typeof closedTradesTable.$inferInsert;
