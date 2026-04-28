import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { botLegsTable, botConfigsTable, closedTradesTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireBotSecret } from "../middleware/auth";
import {
  getStoredCredentials,
  type SupportedExchange,
} from "./credentials";
import {
  createExchangeForName,
  sumFeesFromOrder,
} from "./exchanges";

const router: IRouter = Router();

async function fetchFeeForOrder(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ex: any,
  orderId: string,
  marketSymbol: string,
): Promise<number> {
  try {
    const order = await ex.fetchOrder(orderId, marketSymbol);
    const fee = sumFeesFromOrder(order);
    if (fee > 0) return fee;
  } catch (_) {}
  return 0;
}

async function fetchCloseFeesViaTrades(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ex: any,
  marketSymbol: string,
  closedAtMs: number,
  closeSide: "buy" | "sell",
): Promise<number> {
  try {
    const since = closedAtMs - 3 * 60 * 1000;
    const until = closedAtMs + 3 * 60 * 1000;
    const trades = await ex.fetchMyTrades(marketSymbol, since, 50);
    const matched = (trades as Array<{ timestamp?: number; side?: string; fee?: { cost?: unknown } }>)
      .filter((t) => {
        if (!t.timestamp) return false;
        if (t.timestamp < since || t.timestamp > until) return false;
        return t.side === closeSide;
      });
    const total = matched.reduce((s, t) => s + sumFeesFromOrder(t), 0);
    return total;
  } catch (_) {}
  return 0;
}

router.post("/admin/backfill-fees", requireBotSecret, async (req, res) => {
  try {
    // Step 1: Add missing columns to production if they don't exist yet
    await db.execute(sql`
      ALTER TABLE bot_legs
        ADD COLUMN IF NOT EXISTS open_fee_a NUMERIC(20, 8) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS open_fee_b NUMERIC(20, 8) NOT NULL DEFAULT 0
    `);
    await db.execute(sql`
      ALTER TABLE closed_trades
        ADD COLUMN IF NOT EXISTS total_fees NUMERIC(20, 8) NOT NULL DEFAULT 0
    `);

    // Step 2: Get all closed legs that have no fees recorded yet
    const closedLegs = await db
      .select()
      .from(botLegsTable)
      .where(and(eq(botLegsTable.status, "closed")));

    const legsToProcess = closedLegs.filter(
      (l) => Number(l.openFeeA ?? 0) === 0 && Number(l.openFeeB ?? 0) === 0,
    );

    const results: Array<{
      legId: number;
      symbol: string;
      openFeeA: number;
      openFeeB: number;
      closeFeeA: number;
      closeFeeB: number;
      totalFees: number;
      oldPnl: number;
      newPnl: number;
    }> = [];

    for (const leg of legsToProcess) {
      try {
        const [config] = await db
          .select()
          .from(botConfigsTable)
          .where(eq(botConfigsTable.id, leg.botConfigId))
          .limit(1);
        if (!config) continue;

        const exchangeA = config.exchangeA ?? "bybit";
        const exchangeB = config.exchangeB ?? "binance";

        const [credsA, credsB] = await Promise.all([
          getStoredCredentials(exchangeA as SupportedExchange),
          getStoredCredentials(exchangeB as SupportedExchange),
        ]);
        if (!credsA || !credsB) continue;

        const exA = createExchangeForName(exchangeA, credsA.apiKey, credsA.apiSecret, credsA.passphrase ?? undefined);
        const exB = createExchangeForName(exchangeB, credsB.apiKey, credsB.apiSecret, credsB.passphrase ?? undefined);

        const marketSymbol = `${leg.symbol}/USDT:USDT`;

        // Fetch open order fees using stored order IDs
        const [openFeeA, openFeeB] = await Promise.all([
          leg.bybitOrderId
            ? fetchFeeForOrder(exA, leg.bybitOrderId, marketSymbol)
            : Promise.resolve(0),
          leg.binanceOrderId
            ? fetchFeeForOrder(exB, leg.binanceOrderId, marketSymbol)
            : Promise.resolve(0),
        ]);

        // Fetch close fees from trade history around the close timestamp
        const closedAtMs = leg.closedAt ? new Date(leg.closedAt).getTime() : 0;
        const closeASide: "buy" | "sell" = leg.bybitSide === "long" ? "sell" : "buy";
        const closeBSide: "buy" | "sell" = leg.binanceSide === "long" ? "sell" : "buy";

        let closeFeeA = 0;
        let closeFeeB = 0;
        if (closedAtMs > 0) {
          [closeFeeA, closeFeeB] = await Promise.all([
            fetchCloseFeesViaTrades(exA, marketSymbol, closedAtMs, closeASide),
            fetchCloseFeesViaTrades(exB, marketSymbol, closedAtMs, closeBSide),
          ]);
        }

        const totalFees = openFeeA + openFeeB + closeFeeA + closeFeeB;

        // Update bot_legs with open fees
        await db
          .update(botLegsTable)
          .set({
            openFeeA: String(openFeeA),
            openFeeB: String(openFeeB),
          })
          .where(eq(botLegsTable.id, leg.id));

        // Find the matching closed_trade by symbol + entry_time ≈ opened_at
        const matchingTrades = await db
          .select()
          .from(closedTradesTable)
          .where(eq(closedTradesTable.symbol, leg.symbol));

        const openedAtMs = new Date(leg.openedAt).getTime();
        const match = matchingTrades.find(
          (t) => Math.abs(new Date(t.entryTime).getTime() - openedAtMs) < 5000,
        );

        if (match && totalFees > 0) {
          const oldPnl = Number(match.realizedPnl);
          const newPnl = oldPnl - totalFees;
          await db
            .update(closedTradesTable)
            .set({
              totalFees: String(totalFees),
              realizedPnl: String(newPnl),
            })
            .where(eq(closedTradesTable.id, match.id));

          results.push({
            legId: leg.id,
            symbol: leg.symbol,
            openFeeA,
            openFeeB,
            closeFeeA,
            closeFeeB,
            totalFees,
            oldPnl,
            newPnl,
          });
        } else if (match) {
          await db
            .update(closedTradesTable)
            .set({ totalFees: "0" })
            .where(eq(closedTradesTable.id, match.id));
        }
      } catch (legErr) {
        req.log.warn({ legErr, legId: leg.id }, "backfill-fees: error processing leg");
      }
    }

    res.json({
      processed: legsToProcess.length,
      updated: results.length,
      results,
    });
  } catch (err) {
    req.log.error({ err }, "backfill-fees: fatal error");
    res.status(500).json({ error: "backfill_failed", message: String(err) });
  }
});

const TAKER_RATES: Record<string, number> = {
  bybit:   0.00055,
  binance: 0.00040,
  gate:    0.00050,
  okx:     0.00050,
  mexc:    0.00050,
};

// POST /api/backfill-estimated-fees
// Estimates fees for any closed_trades record where totalFees = 0,
// using per-exchange taker rates applied to position quantity.
router.post("/backfill-estimated-fees", requireBotSecret, async (req, res) => {
  try {
    const zeroFeeRows = await db
      .select()
      .from(closedTradesTable)
      .where(sql`${closedTradesTable.totalFees} = '0' AND ${closedTradesTable.quantity} > '0'`);

    const results: Array<{ id: number; symbol: string; estimatedFee: string; adjustedPnl: string }> = [];

    for (const row of zeroFeeRows) {
      const qty = Number(row.quantity);
      if (!qty) continue;
      const rateA = TAKER_RATES[row.longExchange ?? "binance"] ?? 0.0005;
      const rateB = TAKER_RATES[row.shortExchange ?? "bybit"] ?? 0.0005;
      const estimatedFee = qty * (rateA + rateB);
      const oldPnl = Number(row.realizedPnl ?? 0);
      const adjustedPnl = oldPnl - estimatedFee;

      await db
        .update(closedTradesTable)
        .set({
          totalFees: String(estimatedFee),
          realizedPnl: String(adjustedPnl),
        })
        .where(eq(closedTradesTable.id, row.id));

      results.push({
        id: row.id,
        symbol: row.symbol,
        estimatedFee: estimatedFee.toFixed(8),
        adjustedPnl: adjustedPnl.toFixed(8),
      });
    }

    res.json({ updated: results.length, results });
  } catch (err) {
    req.log.error({ err }, "backfill-estimated-fees: fatal error");
    res.status(500).json({ error: "backfill_failed", message: String(err) });
  }
});

// POST /api/admin/backfill-open-fees
// Retroactively populates open_fees on closed_trades by joining with bot_legs
// on symbol + entryTime (≈ openedAt within 5 seconds).
// When multiple legs could match the same closed_trade the nearest one is used
// (deterministic tie-break: smallest time delta, then smallest leg id).
// Rows with no matching leg or where the leg has 0 fees are left with open_fees = 0.
router.post("/admin/backfill-open-fees", requireBotSecret, async (req, res) => {
  try {
    // Ensure the open_fees column exists (safe no-op if already present)
    await db.execute(sql`
      ALTER TABLE closed_trades
        ADD COLUMN IF NOT EXISTS open_fees NUMERIC(20, 8) NOT NULL DEFAULT 0
    `);

    // Use a CTE that picks the single nearest matching bot_leg per closed_trade
    // so the UPDATE is always deterministic even when multiple legs share a symbol
    // and were opened within the 5-second window.
    const result = await db.execute(sql`
      WITH best_match AS (
        SELECT DISTINCT ON (ct.id)
               ct.id          AS trade_id,
               bl.open_fee_a + bl.open_fee_b AS open_fees
        FROM   closed_trades ct
        JOIN   bot_legs bl
               ON  bl.status = 'closed'
               AND bl.symbol = ct.symbol
               AND ABS(EXTRACT(EPOCH FROM (ct.entry_time - bl.opened_at))) < 5
               AND (bl.open_fee_a + bl.open_fee_b) > 0
        WHERE  ct.open_fees = 0
        ORDER BY ct.id,
                 ABS(EXTRACT(EPOCH FROM (ct.entry_time - bl.opened_at))) ASC,
                 bl.id ASC
      )
      UPDATE closed_trades ct
      SET    open_fees = bm.open_fees
      FROM   best_match bm
      WHERE  ct.id = bm.trade_id
    `);

    const rowsUpdated = (result as { rowCount?: number }).rowCount ?? 0;
    res.json({ updated: rowsUpdated });
  } catch (err) {
    req.log.error({ err }, "backfill-open-fees: fatal error");
    res.status(500).json({ error: "backfill_failed", message: String(err) });
  }
});

export default router;
