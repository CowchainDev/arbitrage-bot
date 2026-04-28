import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { closedTradesTable, botLegsTable } from "@workspace/db";
import { desc, sql, count, sum, max, min, eq } from "drizzle-orm";

const router: IRouter = Router();

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

router.get("/trades", async (req: Request, res: Response) => {
  const rawLimit = Number(req.query["limit"] ?? DEFAULT_LIMIT);
  const rawOffset = Number(req.query["offset"] ?? 0);
  const limit = Math.min(Math.max(1, isNaN(rawLimit) ? DEFAULT_LIMIT : rawLimit), MAX_LIMIT);
  const offset = Math.max(0, isNaN(rawOffset) ? 0 : rawOffset);

  try {
    const [trades, statsRows, closedBotLegs] = await Promise.all([
      db
        .select()
        .from(closedTradesTable)
        .orderBy(desc(closedTradesTable.closeTime))
        .limit(limit)
        .offset(offset),
      db
        .select({
          totalTrades: count(),
          totalPnl: sum(closedTradesTable.realizedPnl),
          totalFees: sum(closedTradesTable.totalFees),
          bestTrade: max(closedTradesTable.realizedPnl),
          worstTrade: min(closedTradesTable.realizedPnl),
          winningTrades: sql<number>`count(*) filter (where ${closedTradesTable.realizedPnl} > 0)`,
        })
        .from(closedTradesTable),
      db
        .select({
          symbol: botLegsTable.symbol,
          openedAt: botLegsTable.openedAt,
          openFeeA: botLegsTable.openFeeA,
          openFeeB: botLegsTable.openFeeB,
        })
        .from(botLegsTable)
        .where(eq(botLegsTable.status, "closed")),
    ]);

    // Build a lookup map: "symbol_entryTimeMs" -> openFees total
    // closed_trades.entryTime === bot_legs.openedAt (set by bot-watcher when recording the close)
    const openFeesMap = new Map<string, number>();
    for (const leg of closedBotLegs) {
      const key = `${leg.symbol}_${leg.openedAt.getTime()}`;
      const prev = openFeesMap.get(key) ?? 0;
      openFeesMap.set(key, prev + Number(leg.openFeeA ?? 0) + Number(leg.openFeeB ?? 0));
    }

    const s = statsRows[0];

    res.json({
      trades: trades.map((t) => {
        const totalFees = Number(t.totalFees);
        const key = `${t.symbol}_${t.entryTime.getTime()}`;
        const isBotTrade = openFeesMap.has(key);
        const openFees = openFeesMap.get(key) ?? 0;
        const closeFees = Math.max(0, totalFees - openFees);
        return {
          id: t.id,
          symbol: t.symbol,
          longExchange: t.longExchange,
          shortExchange: t.shortExchange,
          spreadAtEntry: Number(t.spreadAtEntry),
          realizedPnl: Number(t.realizedPnl),
          totalFees,
          openFees: isBotTrade ? openFees : undefined,
          closeFees: isBotTrade ? closeFees : undefined,
          quantity: Number(t.quantity),
          entryTime: t.entryTime.toISOString(),
          closeTime: t.closeTime.toISOString(),
        };
      }),
      stats: {
        totalTrades: Number(s?.totalTrades ?? 0),
        winningTrades: Number(s?.winningTrades ?? 0),
        totalPnl: Number(s?.totalPnl ?? 0),
        totalFees: Number(s?.totalFees ?? 0),
        bestTrade: Number(s?.bestTrade ?? 0),
        worstTrade: Number(s?.worstTrade ?? 0),
      },
      pagination: { limit, offset },
    });
  } catch (err) {
    req.log.error({ err }, "Error fetching trades");
    res.status(500).json({ error: "internal_error", message: "Failed to fetch trades" });
  }
});

export { router as tradesRouter };
