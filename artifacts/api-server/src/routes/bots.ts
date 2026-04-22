import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { db } from "@workspace/db";
import { botConfigsTable, botLegsTable, type BotConfig, type BotLeg } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { CreateBotBody, UpdateBotBody } from "@workspace/api-zod";

const router: IRouter = Router();

const BOT_SECRET = process.env["BOT_SECRET"];

function requireBotSecret(req: Request, res: Response, next: NextFunction): void {
  if (!BOT_SECRET) {
    // No secret configured — allow all requests through
    next();
    return;
  }
  if (req.headers["x-bot-secret"] === BOT_SECRET) { next(); return; }
  res.status(401).json({ error: "unauthorized", message: "Missing or invalid X-Bot-Secret header" });
}

function normalizeBotConfig(bot: BotConfig) {
  return {
    ...bot,
    enterSpreadPct: Number(bot.enterSpreadPct),
    closeSpreadPct: Number(bot.closeSpreadPct),
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
    openedAt: leg.openedAt.toISOString(),
    closedAt: leg.closedAt ? leg.closedAt.toISOString() : undefined,
  };
}

router.get("/bots", async (_req: Request, res: Response) => {
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
  } = parsed.data;

  try {
    const [bot] = await db
      .insert(botConfigsTable)
      .values({
        symbol: symbol.toUpperCase(),
        enabled: false,
        enterSpreadPct: String(enterSpreadPct),
        closeSpreadPct: String(closeSpreadPct),
        orderSizeUsd: String(orderSizeUsd),
        maxOrders: maxOrders ?? 3,
        forceStopUsd: String(forceStopUsd ?? 20),
        bybitLeverage: bybitLeverage ?? 1,
        binanceLeverage: binanceLeverage ?? 1,
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
  } = parsed.data;

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (enterSpreadPct !== undefined) updates.enterSpreadPct = String(enterSpreadPct);
  if (closeSpreadPct !== undefined) updates.closeSpreadPct = String(closeSpreadPct);
  if (orderSizeUsd !== undefined) updates.orderSizeUsd = String(orderSizeUsd);
  if (maxOrders !== undefined) updates.maxOrders = maxOrders;
  if (forceStopUsd !== undefined) updates.forceStopUsd = String(forceStopUsd);
  if (bybitLeverage !== undefined) updates.bybitLeverage = bybitLeverage;
  if (binanceLeverage !== undefined) updates.binanceLeverage = binanceLeverage;

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

router.get("/bots/:id/legs", async (req: Request, res: Response) => {
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

    const legs = await db
      .select()
      .from(botLegsTable)
      .where(and(eq(botLegsTable.botConfigId, id), eq(botLegsTable.status, "open")))
      .orderBy(botLegsTable.openedAt);

    res.json({ legs: legs.map(normalizeBotLeg) });
  } catch (err) {
    res.status(500).json({ error: "internal_error", message: "Failed to fetch legs" });
  }
});

export { router as botsRouter };
