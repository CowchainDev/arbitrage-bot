import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "@workspace/db";
import { closedTradesTable } from "@workspace/db";
import { desc, sql, count, sum, max, min, avg } from "drizzle-orm";

const router: IRouter = Router();

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

router.get("/trades", async (req: Request, res: Response) => {
  const rawLimit = Number(req.query["limit"] ?? DEFAULT_LIMIT);
  const rawOffset = Number(req.query["offset"] ?? 0);
  const limit = Math.min(Math.max(1, isNaN(rawLimit) ? DEFAULT_LIMIT : rawLimit), MAX_LIMIT);
  const offset = Math.max(0, isNaN(rawOffset) ? 0 : rawOffset);

  try {
    const [trades, statsRows] = await Promise.all([
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
          totalOpenFees: sql<string | null>`sum(${closedTradesTable.openFees}) filter (where ${closedTradesTable.openFees} > 0)`,
          totalCloseFees: sql<string | null>`sum(${closedTradesTable.totalFees} - ${closedTradesTable.openFees}) filter (where ${closedTradesTable.openFees} > 0)`,
          bestTrade: max(closedTradesTable.realizedPnl),
          worstTrade: min(closedTradesTable.realizedPnl),
          winningTrades: sql<number>`count(*) filter (where ${closedTradesTable.realizedPnl} > 0)`,
          totalFunding: sql<string | null>`sum(coalesce(${closedTradesTable.fundingPaidUsd}, 0))`,
          avgFundingRateSpread: avg(closedTradesTable.fundingRateSpread),
        })
        .from(closedTradesTable),
    ]);

    const s = statsRows[0];

    res.json({
      trades: trades.map((t) => {
        const totalFees = Number(t.totalFees);
        const openFees = Number(t.openFees ?? 0);
        const isBotTrade = openFees > 0;
        const closeFees = isBotTrade ? Math.max(0, totalFees - openFees) : undefined;
        return {
          id: t.id,
          symbol: t.symbol,
          longExchange: t.longExchange,
          shortExchange: t.shortExchange,
          spreadAtEntry: Number(t.spreadAtEntry),
          enterSpreadThresholdPct: t.enterSpreadThresholdPct != null ? Number(t.enterSpreadThresholdPct) : undefined,
          realizedPnl: Number(t.realizedPnl),
          totalFees,
          openFees: isBotTrade ? openFees : undefined,
          closeFees,
          fundingPaidUsd: t.fundingPaidUsd != null ? Number(t.fundingPaidUsd) : undefined,
          fundingRateSpread: t.fundingRateSpread != null ? Number(t.fundingRateSpread) : undefined,
          spreadAtExit: t.spreadAtExit != null ? Number(t.spreadAtExit) : undefined,
          closeReason: t.closeReason ?? undefined,
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
        totalOpenFees: s?.totalOpenFees != null ? Number(s.totalOpenFees) : null,
        totalCloseFees: s?.totalCloseFees != null ? Number(s.totalCloseFees) : null,
        bestTrade: Number(s?.bestTrade ?? 0),
        worstTrade: Number(s?.worstTrade ?? 0),
        totalFunding: Number(s?.totalFunding ?? 0),
        netPnl: Number(s?.totalPnl ?? 0) + Number(s?.totalFunding ?? 0),
        avgFundingRateSpread: s?.avgFundingRateSpread != null ? Number(s.avgFundingRateSpread) : null,
      },
      pagination: { limit, offset },
    });
  } catch (err) {
    req.log.error({ err }, "Error fetching trades");
    res.status(500).json({ error: "internal_error", message: "Failed to fetch trades" });
  }
});

router.get("/trades/pnl-chart", async (req: Request, res: Response) => {
  try {
    const rows = await db
      .select({
        closeTime: closedTradesTable.closeTime,
        realizedPnl: closedTradesTable.realizedPnl,
        fundingPaidUsd: closedTradesTable.fundingPaidUsd,
        symbol: closedTradesTable.symbol,
      })
      .from(closedTradesTable)
      .orderBy(closedTradesTable.closeTime);

    let cumPnl = 0;
    let cumNetPnl: number | null = 0;
    const points = rows.map((r) => {
      const pnl = Number(r.realizedPnl);
      cumPnl = parseFloat((cumPnl + pnl).toFixed(6));
      const funding = r.fundingPaidUsd != null ? Number(r.fundingPaidUsd) : null;
      if (cumNetPnl !== null && funding !== null) {
        cumNetPnl = parseFloat((cumNetPnl + pnl + funding).toFixed(6));
      } else {
        cumNetPnl = null;
      }
      return {
        closeTime: r.closeTime.toISOString(),
        pnl: parseFloat(pnl.toFixed(6)),
        cumPnl: parseFloat(cumPnl.toFixed(2)),
        funding,
        cumNetPnl: cumNetPnl !== null ? parseFloat(cumNetPnl.toFixed(2)) : null,
        symbol: r.symbol,
      };
    });

    res.json({ points });
  } catch (err) {
    req.log.error({ err }, "Error fetching pnl chart data");
    res.status(500).json({ error: "internal_error", message: "Failed to fetch pnl chart data" });
  }
});

export { router as tradesRouter };
