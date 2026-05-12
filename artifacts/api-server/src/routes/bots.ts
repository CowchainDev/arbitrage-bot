import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { botConfigsTable, botLegsTable, type BotConfig, type BotLeg, type InsertBotConfig } from "@workspace/db";
import { eq, and, desc } from "drizzle-orm";
import { CreateBotBody, UpdateBotBody } from "@workspace/api-zod";
import { closeAllLegsForBot, probeCredentialsForBot, isWarmingUp } from "../services/bot-watcher";
import { requireAuth } from "../middleware/auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

export function buildBotUpdateFields(
  data: Partial<{
    enterSpreadPct: number;
    closeSpreadPct: number;
    stopLossSpreadPct: number;
    orderSizeUsd: number;
    maxOrders: number;
    forceStopUsd: number;
    bybitLeverage: number;
    binanceLeverage: number;
    exchangeA: string;
    exchangeB: string;
    leverageA: number;
    leverageB: number;
  }>
): Partial<InsertBotConfig> {
  const updates: Partial<InsertBotConfig> = {};
  if (data.enterSpreadPct !== undefined) updates.enterSpreadPct = String(data.enterSpreadPct);
  if (data.closeSpreadPct !== undefined) updates.closeSpreadPct = String(data.closeSpreadPct);
  if (data.stopLossSpreadPct !== undefined) updates.stopLossSpreadPct = String(data.stopLossSpreadPct);
  if (data.orderSizeUsd !== undefined) updates.orderSizeUsd = String(data.orderSizeUsd);
  if (data.maxOrders !== undefined) updates.maxOrders = data.maxOrders;
  if (data.forceStopUsd !== undefined) updates.forceStopUsd = String(data.forceStopUsd);
  if (data.bybitLeverage !== undefined) updates.bybitLeverage = data.bybitLeverage;
  if (data.binanceLeverage !== undefined) updates.binanceLeverage = data.binanceLeverage;
  if (data.exchangeA !== undefined) updates.exchangeA = data.exchangeA;
  if (data.exchangeB !== undefined) updates.exchangeB = data.exchangeB;
  if (data.leverageA !== undefined) updates.leverageA = data.leverageA;
  if (data.leverageB !== undefined) updates.leverageB = data.leverageB;
  return updates;
}

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

router.get("/bots/status", (_req: Request, res: Response) => {
  res.json({ warming: isWarmingUp() });
});

router.get("/bots", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as any).userId as string;
  try {
    const bots = await db
      .select()
      .from(botConfigsTable)
      .where(eq(botConfigsTable.userId, userId))
      .orderBy(botConfigsTable.createdAt);
    res.json({ bots: bots.map(normalizeBotConfig) });
  } catch (err) {
    res.status(500).json({ error: "internal_error", message: "Failed to fetch bots" });
  }
});

router.post("/bots", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as any).userId as string;

  if (!req.body || typeof req.body !== "object" || Object.keys(req.body).length === 0) {
    res.status(400).json({ error: "bad_request", message: "Request body must not be empty" });
    return;
  }

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
        userId,
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

router.put("/bots/:id", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as any).userId as string;
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

  const updates = buildBotUpdateFields(parsed.data);

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "bad_request", message: "No fields provided to update" });
    return;
  }

  updates.updatedAt = new Date();

  try {
    const [bot] = await db
      .update(botConfigsTable)
      .set(updates)
      .where(and(eq(botConfigsTable.id, id), eq(botConfigsTable.userId, userId)))
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

router.delete("/bots/:id", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as any).userId as string;
  const id = Number(req.params.id);
  if (!id) {
    res.status(400).json({ error: "bad_request", message: "Invalid bot id" });
    return;
  }

  try {
    const [existing] = await db
      .select({ id: botConfigsTable.id })
      .from(botConfigsTable)
      .where(and(eq(botConfigsTable.id, id), eq(botConfigsTable.userId, userId)));
    if (!existing) {
      res.status(404).json({ error: "not_found", message: "Bot not found" });
      return;
    }
    await db.delete(botLegsTable).where(eq(botLegsTable.botConfigId, id));
    await db.delete(botConfigsTable).where(eq(botConfigsTable.id, id));
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: "internal_error", message: "Failed to delete bot" });
  }
});

router.post("/bots/:id/start", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as any).userId as string;
  const id = Number(req.params.id);
  if (!id) {
    res.status(400).json({ error: "bad_request", message: "Invalid bot id" });
    return;
  }

  try {
    const [bot] = await db
      .update(botConfigsTable)
      .set({ enabled: true, updatedAt: new Date() })
      .where(and(eq(botConfigsTable.id, id), eq(botConfigsTable.userId, userId)))
      .returning();

    if (!bot) {
      res.status(404).json({ error: "not_found", message: "Bot not found" });
      return;
    }

    // Fire-and-forget: probe credentials immediately so the frontend gets a
    // credential_error event before the first watcher tick even fires.
    probeCredentialsForBot(bot).catch((err) => {
      logger.warn({ err, botId: id }, "Bot start: credential probe error");
    });

    res.json({ bot: normalizeBotConfig(bot) });
  } catch (err) {
    res.status(500).json({ error: "internal_error", message: "Failed to start bot" });
  }
});

router.post("/bots/:id/stop", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as any).userId as string;
  const id = Number(req.params.id);
  if (!id) {
    res.status(400).json({ error: "bad_request", message: "Invalid bot id" });
    return;
  }

  try {
    const [bot] = await db
      .update(botConfigsTable)
      .set({ enabled: false, updatedAt: new Date() })
      .where(and(eq(botConfigsTable.id, id), eq(botConfigsTable.userId, userId)))
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

router.post("/bots/:id/stop-and-close", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as any).userId as string;
  const id = Number(req.params.id);
  if (!id) {
    res.status(400).json({ error: "bad_request", message: "Invalid bot id" });
    return;
  }

  try {
    const [bot] = await db
      .update(botConfigsTable)
      .set({ enabled: false, updatedAt: new Date() })
      .where(and(eq(botConfigsTable.id, id), eq(botConfigsTable.userId, userId)))
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

router.get("/bots/:id/stats", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as any).userId as string;
  const id = Number(req.params.id);
  if (!id) {
    res.status(400).json({ error: "bad_request", message: "Invalid bot id" });
    return;
  }

  try {
    const [bot] = await db
      .select({ id: botConfigsTable.id })
      .from(botConfigsTable)
      .where(and(eq(botConfigsTable.id, id), eq(botConfigsTable.userId, userId)));
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
      bybit: "Bybit", binance: "Binance", okx: "OKX", gate: "Gate", mexc: "MEXC",
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
      avgEntrySpread: count > 0 ? sumEntrySpread / count : null,
      avgExitSpread: exitSpreadCount > 0 ? sumExitSpread / exitSpreadCount : null,
      totalVolumeUsd,
      closedLegCount: count,
      closedLegsByPair,
    });
  } catch (err) {
    res.status(500).json({ error: "internal_error", message: "Failed to fetch bot stats" });
  }
});

router.get("/bots/:id/leg-history", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as any).userId as string;
  const id = Number(req.params.id);
  if (!id) {
    res.status(400).json({ error: "bad_request", message: "Invalid bot id" });
    return;
  }

  try {
    const [bot] = await db
      .select({ id: botConfigsTable.id })
      .from(botConfigsTable)
      .where(and(eq(botConfigsTable.id, id), eq(botConfigsTable.userId, userId)));
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

router.get("/bots/:id/legs", requireAuth, async (req: Request, res: Response) => {
  const userId = (req as any).userId as string;
  const id = Number(req.params.id);
  if (!id) {
    res.status(400).json({ error: "bad_request", message: "Invalid bot id" });
    return;
  }

  const status = req.query.status === "closed" ? "closed" : "open";

  try {
    const [bot] = await db
      .select({ id: botConfigsTable.id })
      .from(botConfigsTable)
      .where(and(eq(botConfigsTable.id, id), eq(botConfigsTable.userId, userId)));
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
