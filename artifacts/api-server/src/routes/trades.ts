import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { closedTradesTable } from "@workspace/db";
import { desc } from "drizzle-orm";

const router: IRouter = Router();

router.get("/trades", async (req: Request, res: Response) => {
  try {
    const trades = await db
      .select()
      .from(closedTradesTable)
      .orderBy(desc(closedTradesTable.closeTime));

    const totalTrades = trades.length;
    const winningTrades = trades.filter((t) => Number(t.realizedPnl) > 0).length;
    const totalPnl = trades.reduce((sum, t) => sum + Number(t.realizedPnl), 0);
    const pnlValues = trades.map((t) => Number(t.realizedPnl));
    const bestTrade = pnlValues.length > 0 ? Math.max(...pnlValues) : 0;
    const worstTrade = pnlValues.length > 0 ? Math.min(...pnlValues) : 0;

    res.json({
      trades: trades.map((t) => ({
        id: t.id,
        symbol: t.symbol,
        longExchange: t.longExchange,
        shortExchange: t.shortExchange,
        spreadAtEntry: Number(t.spreadAtEntry),
        realizedPnl: Number(t.realizedPnl),
        quantity: Number(t.quantity),
        entryTime: t.entryTime.toISOString(),
        closeTime: t.closeTime.toISOString(),
      })),
      stats: {
        totalTrades,
        winningTrades,
        totalPnl,
        bestTrade,
        worstTrade,
      },
    });
  } catch (err) {
    req.log.error({ err }, "Error fetching trades");
    res.status(500).json({ error: "internal_error", message: "Failed to fetch trades" });
  }
});

export { router as tradesRouter };
