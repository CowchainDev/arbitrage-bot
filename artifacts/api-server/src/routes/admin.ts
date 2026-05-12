import { Router, type IRouter } from "express";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { botLegsTable, botConfigsTable, closedTradesTable, credentialsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { requireBotSecret, requireAuth } from "../middleware/auth";
import {
  getStoredCredentials,
  type SupportedExchange,
} from "./credentials";
import {
  createExchangeForName,
  extractExchangeRealizedPnl,
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
          getStoredCredentials(config.userId, exchangeA as SupportedExchange),
          getStoredCredentials(config.userId, exchangeB as SupportedExchange),
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
  aster:   0.00050,
  hyper:   0.00035,
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

// POST /api/admin/backfill-funding
// Recomputes funding_paid_usd for bot_legs and closed_trades written before
// the Task-179 interval-snap fix (2026-04-28 10:40:03 UTC).  Those rows used a
// continuous-time ratio (durationMs / 28_800_000) instead of counting discrete
// 8-hour UTC settlement boundaries.  We back-calculate the implicit spread·size
// value from the stored figure and re-apply with the correct discrete count.
//
// Idempotency: a funding_corrected_at column is added to each table on first
// call; only rows where that column is NULL are processed.  Subsequent calls
// skip already-corrected rows.
//
// Atomicity: both table updates run inside a single DB transaction so a partial
// failure leaves the database unchanged.
router.post("/admin/backfill-funding", requireBotSecret, async (req, res) => {
  // Cutoff = moment Task 179 landed in production.
  // Records closed BEFORE this timestamp used the old continuous formula.
  const CUTOFF = new Date("2026-04-28T10:40:03Z");

  try {
    // ── Step 1: Ensure tracking columns exist (idempotent DDL) ─────────────
    await db.execute(sql`
      ALTER TABLE bot_legs
        ADD COLUMN IF NOT EXISTS funding_corrected_at TIMESTAMP
    `);
    await db.execute(sql`
      ALTER TABLE closed_trades
        ADD COLUMN IF NOT EXISTS funding_corrected_at TIMESTAMP
    `);

    // ── Step 2: Run both updates inside a single transaction ────────────────
    const { legsUpdated, tradesUpdated } = await db.transaction(async (tx) => {
      // bot_legs: only rows not yet corrected
      const legsResult = await tx.execute(sql`
        WITH corrected AS (
          SELECT
            id,
            CASE
              WHEN EXTRACT(EPOCH FROM (closed_at - opened_at)) = 0
                THEN funding_paid_usd
              ELSE
                funding_paid_usd::numeric
                * GREATEST(
                    0,
                    FLOOR(EXTRACT(EPOCH FROM closed_at AT TIME ZONE 'UTC') / 28800)
                    - FLOOR(EXTRACT(EPOCH FROM opened_at AT TIME ZONE 'UTC') / 28800)
                  )
                / (EXTRACT(EPOCH FROM (closed_at - opened_at)) / 28800)
            END AS new_funding
          FROM bot_legs
          WHERE status              = 'closed'
            AND funding_paid_usd   IS NOT NULL
            AND closed_at          IS NOT NULL
            AND closed_at           < ${CUTOFF}
            AND funding_corrected_at IS NULL
        )
        UPDATE bot_legs bl
        SET    funding_paid_usd    = c.new_funding,
               funding_corrected_at = NOW()
        FROM   corrected c
        WHERE  bl.id = c.id
      `);

      // closed_trades: only rows not yet corrected
      const tradesResult = await tx.execute(sql`
        WITH corrected AS (
          SELECT
            id,
            CASE
              WHEN EXTRACT(EPOCH FROM (close_time - entry_time)) = 0
                THEN funding_paid_usd
              ELSE
                funding_paid_usd::numeric
                * GREATEST(
                    0,
                    FLOOR(EXTRACT(EPOCH FROM close_time AT TIME ZONE 'UTC') / 28800)
                    - FLOOR(EXTRACT(EPOCH FROM entry_time AT TIME ZONE 'UTC') / 28800)
                  )
                / (EXTRACT(EPOCH FROM (close_time - entry_time)) / 28800)
            END AS new_funding
          FROM closed_trades
          WHERE funding_paid_usd    IS NOT NULL
            AND close_time           < ${CUTOFF}
            AND funding_corrected_at IS NULL
        )
        UPDATE closed_trades ct
        SET    funding_paid_usd    = c.new_funding,
               funding_corrected_at = NOW()
        FROM   corrected c
        WHERE  ct.id = c.id
      `);

      return {
        legsUpdated:   (legsResult   as { rowCount?: number }).rowCount ?? 0,
        tradesUpdated: (tradesResult as { rowCount?: number }).rowCount ?? 0,
      };
    });

    req.log.info(
      { legsUpdated, tradesUpdated, cutoff: CUTOFF.toISOString() },
      "backfill-funding: complete",
    );

    res.json({
      cutoff: CUTOFF.toISOString(),
      legsUpdated,
      tradesUpdated,
      // Next steps once legsUpdated + tradesUpdated both reach 0 on a re-run
      // (meaning all pre-fix rows have been corrected):
      //   1. Remove the funding-estimate caveat from history.tsx (Info icon,
      //      cell tooltip, and "older trades may be estimates" stat-card sub).
      //   2. Optionally drop the funding_corrected_at columns if no longer needed.
    });
  } catch (err) {
    req.log.error({ err }, "backfill-funding: fatal error");
    res.status(500).json({ error: "backfill_failed", message: String(err) });
  }
});

// POST /api/admin/backfill-conditions
// Backfills enter_spread_threshold_pct on closed_trades rows where it is NULL,
// by joining with the nearest matching bot_legs row (same symbol, entry_time ≈ opened_at within 5s).
router.post("/admin/backfill-conditions", requireBotSecret, async (req, res) => {
  try {
    const result = await db.execute(sql`
      WITH matched AS (
        SELECT DISTINCT ON (ct.id)
          ct.id AS ct_id,
          bl.enter_spread_threshold_pct
        FROM closed_trades ct
        JOIN bot_legs bl
          ON ct.symbol = bl.symbol
          AND ABS(EXTRACT(EPOCH FROM (ct.entry_time - bl.opened_at))) < 5
        WHERE ct.enter_spread_threshold_pct IS NULL
          AND bl.enter_spread_threshold_pct IS NOT NULL
        ORDER BY ct.id, ABS(EXTRACT(EPOCH FROM (ct.entry_time - bl.opened_at)))
      )
      UPDATE closed_trades
      SET enter_spread_threshold_pct = matched.enter_spread_threshold_pct
      FROM matched
      WHERE closed_trades.id = matched.ct_id
    `);
    const updated = (result as unknown as { rowCount?: number }).rowCount ?? 0;
    req.log.info({ updated }, "backfill-conditions: complete");
    res.json({ updated });
  } catch (err) {
    req.log.error({ err }, "backfill-conditions: fatal error");
    res.status(500).json({ error: "backfill_failed", message: String(err) });
  }
});

// POST /api/admin/backfill-pnl
// For each closed bot_leg that has at least one stored exchange order ID and has
// not yet been backfilled, fetches the authoritative realized PnL from the
// exchange(s) and writes it back to both bot_legs.realized_pnl_usd and the
// matching closed_trades.realized_pnl row.
//
// Idempotency: a pnl_backfilled_at column is added to bot_legs on first call;
// only rows where that column is NULL are processed.  Subsequent calls skip
// already-backfilled rows.
//
// Partial backfill: if credentials or exchange history are only available for
// one leg, the endpoint still updates with the best available data rather than
// skipping the row entirely.
//
// Rows where neither exchange returns usable history are left unchanged and
// reported in the "skipped" list.
router.post("/admin/backfill-pnl", requireBotSecret, async (req, res) => {
  try {
    // ── Step 1: Ensure idempotency marker column exists ──────────────────────
    await db.execute(sql`
      ALTER TABLE bot_legs
        ADD COLUMN IF NOT EXISTS pnl_backfilled_at TIMESTAMP
    `);

    // ── Step 2: Select target rows ───────────────────────────────────────────
    // All closed legs that have at least one order ID stored and have not yet
    // been processed by a previous backfill run.
    const closedLegs = await db
      .select()
      .from(botLegsTable)
      .where(
        and(
          eq(botLegsTable.status, "closed"),
          sql`pnl_backfilled_at IS NULL`,
          sql`(${botLegsTable.bybitOrderId} IS NOT NULL OR ${botLegsTable.binanceOrderId} IS NOT NULL)`,
        ),
      );

    const results: Array<{
      legId: number;
      symbol: string;
      pnlA: number;
      pnlB: number;
      combinedPnl: number;
      closedTradeId: number | null;
      oldTradePnl: number | null;
    }> = [];
    const skipped: number[] = [];

    // Helper: fetch an order then extract its exchange-reported realized PnL.
    // Returns null if the exchange no longer has history or does not expose PnL.
    async function fetchPnlForOrderId(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ex: any,
      orderId: string,
      marketSymbol: string,
    ): Promise<number | null> {
      try {
        const order = await ex.fetchOrder(orderId, marketSymbol);
        return await extractExchangeRealizedPnl(ex, order, marketSymbol);
      } catch (_) {
        return null;
      }
    }

    for (const leg of closedLegs) {
      try {
        const [config] = await db
          .select()
          .from(botConfigsTable)
          .where(eq(botConfigsTable.id, leg.botConfigId))
          .limit(1);
        if (!config) {
          skipped.push(leg.id);
          continue;
        }

        const exchangeA = (config.exchangeA ?? "bybit") as SupportedExchange;
        const exchangeB = (config.exchangeB ?? "binance") as SupportedExchange;

        const [credsA, credsB] = await Promise.all([
          getStoredCredentials(config.userId, exchangeA),
          getStoredCredentials(config.userId, exchangeB),
        ]);

        const marketSymbol = `${leg.symbol}/USDT:USDT`;

        // Fetch PnL for each side that has a stored order ID.
        // Sides without an order ID contribute zero (no exchange data ever existed).
        const [pnlA, pnlB] = await Promise.all([
          credsA && leg.bybitOrderId
            ? fetchPnlForOrderId(
                createExchangeForName(exchangeA, credsA.apiKey, credsA.apiSecret, credsA.passphrase ?? undefined),
                leg.bybitOrderId,
                marketSymbol,
              )
            : Promise.resolve(leg.bybitOrderId ? null : 0),
          credsB && leg.binanceOrderId
            ? fetchPnlForOrderId(
                createExchangeForName(exchangeB, credsB.apiKey, credsB.apiSecret, credsB.passphrase ?? undefined),
                leg.binanceOrderId,
                marketSymbol,
              )
            : Promise.resolve(leg.binanceOrderId ? null : 0),
        ]);

        // Only update when every side that has an order ID returned authoritative
        // data.  If any such side returned null (exchange history expired or
        // credentials missing), leave the row unchanged — a zero-substituted
        // total would be less accurate than the existing formula estimate.
        if (pnlA === null || pnlB === null) {
          req.log.info(
            { legId: leg.id, symbol: leg.symbol, pnlA, pnlB },
            "backfill-pnl: skipping leg — exchange history unavailable for one or more sides",
          );
          skipped.push(leg.id);
          continue;
        }

        const combinedPnl = pnlA + pnlB;

        // Find the single best-matching closed_trade using SQL ordering so the
        // result is deterministic even when multiple close events for the same
        // symbol fall within the 5-second window (mirrors backfill-open-fees).
        const matchRows = await db.execute<{ id: number; realized_pnl: string }>(sql`
          SELECT id, realized_pnl
          FROM   closed_trades
          WHERE  symbol = ${leg.symbol}
            AND  ABS(EXTRACT(EPOCH FROM (entry_time - ${leg.openedAt}::timestamp))) < 5
          ORDER BY ABS(EXTRACT(EPOCH FROM (entry_time - ${leg.openedAt}::timestamp))) ASC,
                   id ASC
          LIMIT  1
        `);
        const match = matchRows.rows[0] ?? null;

        const closedTradeId: number | null = match ? Number(match.id) : null;
        const oldTradePnl: number | null = match ? Number(match.realized_pnl) : null;

        // Wrap all writes for this leg in a single transaction so that
        // pnl_backfilled_at is only set after every update succeeds.
        // If any write fails the transaction rolls back and the leg retains
        // pnl_backfilled_at = NULL, making it eligible for the next run.
        await db.transaction(async (tx) => {
          await tx
            .update(botLegsTable)
            .set({ realizedPnlUsd: String(combinedPnl) })
            .where(eq(botLegsTable.id, leg.id));

          if (match) {
            await tx
              .update(closedTradesTable)
              .set({ realizedPnl: String(combinedPnl) })
              .where(eq(closedTradesTable.id, match.id));
          }

          // pnl_backfilled_at is set last, inside the transaction, so it is
          // only committed when both preceding writes succeed.  Raw SQL is used
          // because the column is not yet part of the Drizzle schema object.
          await tx.execute(sql`
            UPDATE bot_legs SET pnl_backfilled_at = NOW() WHERE id = ${leg.id}
          `);
        });

        results.push({ legId: leg.id, symbol: leg.symbol, pnlA, pnlB, combinedPnl, closedTradeId, oldTradePnl });
      } catch (legErr) {
        req.log.warn({ legErr, legId: leg.id }, "backfill-pnl: error processing leg");
        skipped.push(leg.id);
      }
    }

    req.log.info(
      { processed: closedLegs.length, updated: results.length, skipped: skipped.length },
      "backfill-pnl: complete",
    );

    res.json({
      processed: closedLegs.length,
      updated: results.length,
      skipped: skipped.length,
      results,
    });
  } catch (err) {
    req.log.error({ err }, "backfill-pnl: fatal error");
    res.status(500).json({ error: "backfill_failed", message: String(err) });
  }
});

// POST /api/admin/migrate-user
// Associates all legacy rows (user_id = '') with the currently signed-in
// user's Clerk ID.  Safe to run multiple times — only touches rows where
// user_id is still empty.  Covers credentials, bot_configs, and closed_trades.
router.post("/admin/migrate-user", requireAuth, async (req, res) => {
  const userId = (req as any).userId as string;
  try {
    const [credsResult, configsResult, tradesResult] = await Promise.all([
      db
        .update(credentialsTable)
        .set({ userId })
        .where(eq(credentialsTable.userId, "")),
      db
        .update(botConfigsTable)
        .set({ userId })
        .where(eq(botConfigsTable.userId, "")),
      db
        .update(closedTradesTable)
        .set({ userId })
        .where(eq(closedTradesTable.userId, "")),
    ]);

    const updated = {
      credentials: (credsResult as unknown as { rowCount?: number }).rowCount ?? 0,
      botConfigs: (configsResult as unknown as { rowCount?: number }).rowCount ?? 0,
      closedTrades: (tradesResult as unknown as { rowCount?: number }).rowCount ?? 0,
    };

    req.log.info({ userId, updated }, "migrate-user: complete");
    res.json({ userId, updated });
  } catch (err) {
    req.log.error({ err }, "migrate-user: fatal error");
    res.status(500).json({ error: "migrate_failed", message: String(err) });
  }
});

export default router;
