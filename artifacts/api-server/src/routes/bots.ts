import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { botConfigsTable, botLegsTable, type BotConfig, type BotLeg, type InsertBotConfig } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { CreateBotBody, UpdateBotBody } from "@workspace/api-zod";
import { closeAllLegsForBot } from "../services/bot-watcher";
import { requireBotSecret } from "../middleware/auth";

const router: IRouter = Router();

function normalizeBotConfig(bot: BotConfig) {
  return {
    ...bot,
    enterSpreadPct: Number(bot.enterSpreadPct),
    closeSpreadPct: Number(bot.closeSpreadPct),
    stopLossSpreadPct: Number(bot.stopLossSpreadPct),
    orderSizeUsd: Number(bot.orderSizeUsd),
    forceStopUsd: Number(bot.forceStopUsd),
    createdAt: bot.createdAt.toISOString(),
    updatedAt: bot.updatedAt.toISOString(),
  };
}

function normalizeBotLeg(leg: BotLeg) {
  return {
    ...leg,
    bybitQty: Number(leg.bybitQty),
    binanceQty: Number(leg.binanceQty),
    bybitEntry: Number(leg.bybitEntry),
    binanceEntry: Number(leg.binanceEntry),
    spreadAtEntry: Number(leg.spreadAtEntry),
    spreadAtExit: leg.spreadAtExit != null ? Number(leg.spreadAtExit) : undefined,
    realizedPnlUsd: leg.realizedPnlUsd != null ? Number(leg.realizedPnlUsd) : undefined,
    openedAt: leg.openedAt.toISOString(),
    closedAt: leg.closedAt ? leg.closedAt.toISOString() : undefined,
  };
}

router.get("/bots", requireBotSecret, async (_req: Request, res: Response) => {
  try {
    const bots = await db.select().from(botConfigsTable).orderBy(botConfigsTable.createdAt);
    res.json({ bots: bots.map(normalizeBotConfig) });
  } catch (err) {
    res.status(500).json({ error: "internal_error", message: "Failed to fetch bots" });
  }
});

router.post("/bots", requireBotSecret, async (req: Request, res: Response) => {
  const parsed = CreateBotBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "bad_request", message: parsed.error.message });
    return;
  }

  const {
    symbol, enterSpreadPct, closeSpreadPct, orderSizeUsd,
    maxOrders, forceStopUsd, bybitLeverage, binanceLeverage,
    exchangeA, exchangeB, leverageA, leverageB, stopLossSpreadPct,
  } = parsed.data;

  try {
    const [bot] = await db
      .insert(botConfigsTable)
      .values({
        symbol: symbol.toUpperCase(),
        enabled: false,
        enterSpreadPct: String(enterSpreadPct),
        closeSpreadPct: String(closeSpreadPct),
        stopLossSpreadPct: String(stopLossSpreadPct ?? 0),
        orderSizeUsd: String(orderSizeUsd),
        maxOrders: maxOrders ?? 3,
        forceStopUsd: String(forceStopUsd ?? 20),
        bybitLeverage: bybitLeverage ?? 1,
        binanceLeverage: binanceLeverage ?? 1,
        exchangeA: exchangeA ?? "bybit",
        exchangeB: exchangeB ?? "binance",
        leverageA: leverageA ?? bybitLeverage ?? 1,
        leverageB: leverageB ?? binanceLeverage ?? 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();

    res.json({ bot: normalizeBotConfig(bot) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to create bot";
    res.status(500).json({ error: "internal_error", message: msg });
  }
});

router.put("/bots/:id", requireBotSecret, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!id) {
    res.status(400).json({ error: "bad_request", message: "Invalid bot id" });
    return;
  }

  const parsed = UpdateBotBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "bad_request", message: parsed.error.message });
    return;
  }

  const {
    enterSpreadPct, closeSpreadPct, orderSizeUsd,
    maxOrders, forceStopUsd, bybitLeverage, binanceLeverage,
    exchangeA, exchangeB, leverageA, leverageB, stopLossSpreadPct,
  } = parsed.data;

  // Typed as Partial<InsertBotConfig> (not Record<string, unknown>) so TypeScript
  // enforces that only real botConfigsTable columns with correct value types are written.
  const updates: Partial<InsertBotConfig> = { updatedAt: new Date() };
  if (enterSpreadPct !== undefined) updates.enterSpreadPct = String(enterSpreadPct);
  if (closeSpreadPct !== undefined) updates.closeSpreadPct = String(closeSpreadPct);
  if (stopLossSpreadPct !== undefined) updates.stopLossSpreadPct = String(stopLossSpreadPct);
  if (orderSizeUsd !== undefined) updates.orderSizeUsd = String(orderSizeUsd);
  if (maxOrders !== undefined) updates.maxOrders = maxOrders;
  if (forceStopUsd !== undefined) updates.forceStopUsd = String(forceStopUsd);
  if (bybitLeverage !== undefined) updates.bybitLeverage = bybitLeverage;
  if (binanceLeverage !== undefined) updates.binanceLeverage = binanceLeverage;
  if (exchangeA !== undefined) updates.exchangeA = exchangeA;
  if (exchangeB !== undefined) updates.exchangeB = exchangeB;
  if (leverageA !== undefined) updates.leverageA = leverageA;
  if (leverageB !== undefined) updates.leverageB = leverageB;

  try {
    const [bot] = await db
      .update(botConfigsTable)
      .set(updates)
      .where(eq(botConfigsTable.id, id))
      .returning();

    if (!bot) {
      res.status(404).json({ error: "not_found", message: "Bot not found" });
      return;
    }

    res.json({ bot: normalizeBotConfig(bot) });
  } catch (err) {
    res.status(500).json({ error: "internal_error", message: "Failed to update bot" });
  }
});

router.delete("/bots/:id", requireBotSecret, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!id) {
    res.status(400).json({ error: "bad_request", message: "Invalid bot id" });
    return;
  }

  try {
    await db.delete(botLegsTable).where(eq(botLegsTable.botConfigId, id));
    const [deleted] = await db
      .delete(botConfigsTable)
      .where(eq(botConfigsTable.id, id))
      .returning();

    if (!deleted) {
      res.status(404).json({ error: "not_found", message: "Bot not found" });
      return;
    }

    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: "internal_error", message: "Failed to delete bot" });
  }
});

router.post("/bots/:id/start", requireBotSecret, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!id) {
    res.status(400).json({ error: "bad_request", message: "Invalid bot id" });
    return;
  }

  try {
    const [bot] = await db
      .update(botConfigsTable)
      .set({ enabled: true, updatedAt: new Date() })
      .where(eq(botConfigsTable.id, id))
      .returning();

    if (!bot) {
      res.status(404).json({ error: "not_found", message: "Bot not found" });
      return;
    }

    res.json({ bot: normalizeBotConfig(bot) });
  } catch (err) {
    res.status(500).json({ error: "internal_error", message: "Failed to start bot" });
  }
});

router.post("/bots/:id/stop", requireBotSecret, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!id) {
    res.status(400).json({ error: "bad_request", message: "Invalid bot id" });
    return;
  }

  try {
    const [bot] = await db
      .update(botConfigsTable)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(botConfigsTable.id, id))
      .returning();

    if (!bot) {
      res.status(404).json({ error: "not_found", message: "Bot not found" });
      return;
    }

    res.json({ bot: normalizeBotConfig(bot) });
  } catch (err) {
    res.status(500).json({ error: "internal_error", message: "Failed to stop bot" });
  }
});

router.post("/bots/:id/stop-and-close", requireBotSecret, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!id) {
    res.status(400).json({ error: "bad_request", message: "Invalid bot id" });
    return;
  }

  try {
    const [bot] = await db
      .update(botConfigsTable)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(botConfigsTable.id, id))
      .returning();

    if (!bot) {
      res.status(404).json({ error: "not_found", message: "Bot not found" });
      return;
    }

    const { closed, failed } = await closeAllLegsForBot(id);
    res.json({ bot: normalizeBotConfig(bot), closed, failed });
  } catch (err) {
    res.status(500).json({ error: "internal_error", message: "Failed to stop bot and close positions" });
  }
});

router.get("/bots/:id/stats", requireBotSecret, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!id) {
    res.status(400).json({ error: "bad_request", message: "Invalid bot id" });
    return;
  }

  try {
    const [bot] = await db
      .select({ id: botConfigsTable.id })
      .from(botConfigsTable)
      .where(eq(botConfigsTable.id, id));
    if (!bot) {
      res.status(404).json({ error: "not_found", message: "Bot not found" });
      return;
    }

    const closedLegs = await db
      .select()
      .from(botLegsTable)
      .where(and(eq(botLegsTable.botConfigId, id), eq(botLegsTable.status, "closed")));

    const count = closedLegs.length;

    let totalRealizedPnlUsd = 0;
    let sumEntrySpread = 0;
    let sumExitSpread = 0;
    let exitSpreadCount = 0;
    let totalVolumeUsd = 0;

    for (const leg of closedLegs) {
      const bybitQty = Number(leg.bybitQty);
      const binanceQty = Number(leg.binanceQty);
      const bybitEntry = Number(leg.bybitEntry);
      const binanceEntry = Number(leg.binanceEntry);

      if (leg.realizedPnlUsd != null) totalRealizedPnlUsd += Number(leg.realizedPnlUsd);
      sumEntrySpread += Number(leg.spreadAtEntry);
      if (leg.spreadAtExit != null) {
        sumExitSpread += Number(leg.spreadAtExit);
        exitSpreadCount++;
      }
      totalVolumeUsd += bybitQty * bybitEntry + binanceQty * binanceEntry;
    }

    const EXCHANGE_DISPLAY: Record<string, string> = {
      bybit: "Bybit",
      binance: "Binance",
      okx: "OKX",
      gate: "Gate",
      mexc: "MEXC",
    };
    const displayExchange = (name: string) => EXCHANGE_DISPLAY[name.toLowerCase()] ?? name;
    const closedLegsByPair: Record<string, number> = {};
    for (const leg of closedLegs) {
      const label =
        leg.legExchangeA && leg.legExchangeB
          ? `${displayExchange(leg.legExchangeA)}/${displayExchange(leg.legExchangeB)}`
          : "Unknown/Unknown";
      closedLegsByPair[label] = (closedLegsByPair[label] ?? 0) + 1;
    }

    res.json({
      totalRealizedPnlUsd,
      avgEntrySpread: count > 0 ? sumEntrySpread / count : 0,
      avgExitSpread: exitSpreadCount > 0 ? sumExitSpread / exitSpreadCount : 0,
      totalVolumeUsd,
      closedLegCount: count,
      closedLegsByPair,
    });
  } catch (err) {
    res.status(500).json({ error: "internal_error", message: "Failed to fetch bot stats" });
  }
});

router.get("/bots/:id/leg-history", requireBotSecret, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!id) {
    res.status(400).json({ error: "bad_request", message: "Invalid bot id" });
    return;
  }

  try {
    const [bot] = await db.select({ id: botConfigsTable.id }).from(botConfigsTable).where(eq(botConfigsTable.id, id));
    if (!bot) {
      res.status(404).json({ error: "not_found", message: "Bot not found" });
      return;
    }

    const closedLegs = await db
      .select({ closedAt: botLegsTable.closedAt })
      .from(botLegsTable)
      .where(and(eq(botLegsTable.botConfigId, id), eq(botLegsTable.status, "closed")))
      .orderBy(botLegsTable.closedAt);

    const countsByDate: Record<string, number> = {};
    for (const leg of closedLegs) {
      if (!leg.closedAt) continue;
      const date = leg.closedAt.toISOString().slice(0, 10);
      countsByDate[date] = (countsByDate[date] ?? 0) + 1;
    }

    const sorted = Object.keys(countsByDate).sort();
    let cumulative = 0;
    const buckets = sorted.map((date) => {
      cumulative += countsByDate[date];
      return { date, count: countsByDate[date], cumulative };
    });

    res.json({ buckets });
  } catch (err) {
    res.status(500).json({ error: "internal_error", message: "Failed to fetch leg history" });
  }
});

router.get("/bots/:id/legs", requireBotSecret, async (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!id) {
    res.status(400).json({ error: "bad_request", message: "Invalid bot id" });
    return;
  }

  const status = req.query.status === "closed" ? "closed" : "open";

  try {
    const [bot] = await db.select({ id: botConfigsTable.id }).from(botConfigsTable).where(eq(botConfigsTable.id, id));
    if (!bot) {
      res.status(404).json({ error: "not_found", message: "Bot not found" });
      return;
    }

    const legs = await db
      .select()
      .from(botLegsTable)
      .where(and(eq(botLegsTable.botConfigId, id), eq(botLegsTable.status, status)))
      .orderBy(status === "closed" ? desc(botLegsTable.closedAt) : botLegsTable.openedAt);

    res.json({ legs: legs.map(normalizeBotLeg) });
  } catch (err) {
    res.status(500).json({ error: "internal_error", message: "Failed to fetch legs" });
  }
});

export { router as botsRouter };
