import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import app from "./app";
import { logger } from "./lib/logger";
import { fetchPriceSpreads, prewarmKlinesCache, KLINES_PREWARM_INTERVAL_MS, PREWARM_INTERVALS } from "./routes/exchanges";
import { startBotWatcher } from "./services/bot-watcher";
import { db, botLegsTable, closedTradesTable } from "@workspace/db";
import { sql, eq, isNull, and } from "drizzle-orm";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  if (request.url === "/api/ws/prices") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

let broadcastTimer: ReturnType<typeof setTimeout> | null = null;

async function broadcastPrices() {
  if (wss.clients.size === 0) {
    broadcastTimer = null;
    return;
  }
  try {
    const spreads = await fetchPriceSpreads();
    const payload = JSON.stringify(spreads);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  } catch (err) {
    logger.error({ err }, "WS broadcast: error fetching prices");
  }
  broadcastTimer = setTimeout(broadcastPrices, 1500);
}

wss.on("connection", (ws) => {
  logger.info({ clients: wss.clients.size }, "WS client connected");

  if (!broadcastTimer) {
    broadcastPrices().catch((err) => logger.error({ err }, "WS broadcast loop error"));
  }

  ws.on("close", () => {
    logger.info({ clients: wss.clients.size }, "WS client disconnected");
    if (wss.clients.size === 0 && broadcastTimer) {
      clearTimeout(broadcastTimer);
      broadcastTimer = null;
    }
  });

  ws.on("error", (err) => {
    logger.error({ err }, "WS client error");
  });
});

/**
 * One-time patch for leg 97 (APE, Binance→Bybit).
 * The DB write was lost during a transient "Authentication timed out" error on 2026-04-27.
 * Fill prices confirmed by user from exchange app:
 *   ExA (Binance short 30 APE): entry 0.17990 → exit 0.16080
 *   ExB (Bybit   long  28 APE): entry 0.17827 → exit 0.16289
 */
async function patchOrphanedLegs() {
  try {
    const [leg] = await db
      .select()
      .from(botLegsTable)
      .where(and(eq(botLegsTable.id, 97), eq(botLegsTable.status, "closed"), isNull(botLegsTable.realizedPnlUsd)));

    if (!leg) return; // already patched or doesn't exist

    // pnlA (short): (entry - exit) * qty
    const closePriceA = 0.16080;
    const closePriceB = 0.16289;
    const pnlA = (Number(leg.bybitEntry) - closePriceA) * Number(leg.bybitQty);
    const pnlB = (closePriceB - Number(leg.binanceEntry)) * Number(leg.binanceQty);
    const openFees = Number(leg.openFeeA ?? 0) + Number(leg.openFeeB ?? 0);
    const closeFeeEstimate = 0.001929; // consistent with legs 95 and 96
    const realizedPnl = pnlA + pnlB - openFees - closeFeeEstimate;
    const spreadAtExit = ((closePriceA - closePriceB) / closePriceB) * 100;
    const totalFees = openFees + closeFeeEstimate;
    const quantity = (Number(leg.bybitQty) * Number(leg.bybitEntry) + Number(leg.binanceQty) * Number(leg.binanceEntry)) / 2;

    await db
      .update(botLegsTable)
      .set({
        realizedPnlUsd: String(realizedPnl),
        spreadAtExit: String(spreadAtExit),
      })
      .where(eq(botLegsTable.id, 97));

    // Insert closed_trades record only if not already present for this leg
    const existing = await db
      .select({ id: closedTradesTable.id })
      .from(closedTradesTable)
      .where(and(eq(closedTradesTable.symbol, "APE"), eq(closedTradesTable.entryTime, leg.openedAt!)));

    if (existing.length === 0) {
      await db.insert(closedTradesTable).values({
        symbol: leg.symbol,
        longExchange: "bybit",
        shortExchange: "binance",
        spreadAtEntry: String(leg.spreadAtEntry),
        realizedPnl: String(realizedPnl),
        totalFees: String(totalFees),
        quantity: String(quantity),
        entryTime: leg.openedAt,
        closeTime: leg.closedAt ?? undefined,
      });
    }

    logger.info({ legId: 97, realizedPnl, spreadAtExit, totalFees }, "Patched orphaned leg P&L");
  } catch (err) {
    logger.error({ err }, "patchOrphanedLegs failed — data not written");
  }
}

async function backfillLegExchanges() {
  try {
    const result = await db.execute(sql`
      UPDATE bot_legs
      SET leg_exchange_a = bc.exchange_a,
          leg_exchange_b = bc.exchange_b
      FROM bot_configs bc
      WHERE bot_legs.bot_config_id = bc.id
        AND bot_legs.leg_exchange_a IS NULL
        AND bot_legs.leg_exchange_b IS NULL
    `);
    const updated = (result as { rowCount?: number }).rowCount ?? 0;
    if (updated > 0) {
      logger.info({ updated }, "Backfilled leg_exchange_a/b for historical bot_legs rows");
    } else {
      logger.info("No bot_legs rows needed leg_exchange_a/b backfill");
    }

    const remaining = await db.execute(sql`
      SELECT COUNT(*) AS cnt FROM bot_legs
      WHERE leg_exchange_a IS NULL OR leg_exchange_b IS NULL
    `);
    const remainingCount = Number((remaining as unknown as { rows?: { cnt: string }[] }).rows?.[0]?.cnt ?? 0);
    if (remainingCount > 0) {
      logger.warn(
        { remainingCount },
        "bot_legs rows still have NULL leg_exchange_a/b after backfill — likely orphaned legs with no matching bot config",
      );
    }
  } catch (err) {
    logger.error({ err }, "backfillLegExchanges failed — historical rows may still have NULL exchanges");
  }
}

async function runMigrations() {
  try {
    await db.execute(sql`
      ALTER TABLE bot_legs
        ADD COLUMN IF NOT EXISTS spread_at_exit NUMERIC(20, 8),
        ADD COLUMN IF NOT EXISTS realized_pnl_usd NUMERIC(20, 8)
    `);
    logger.info("DB migrations applied (bot_legs: spread_at_exit, realized_pnl_usd)");
  } catch (err) {
    logger.warn({ err }, "DB migration warning — columns may already exist");
  }
  try {
    await db.execute(sql`
      ALTER TABLE bot_legs
        ADD COLUMN IF NOT EXISTS leg_exchange_a TEXT,
        ADD COLUMN IF NOT EXISTS leg_exchange_b TEXT
    `);
    logger.info("DB migrations applied (bot_legs: leg_exchange_a, leg_exchange_b)");
  } catch (err) {
    logger.warn({ err }, "DB migration warning (leg_exchange_a/b) — columns may already exist");
  }
  try {
    await db.execute(sql`
      ALTER TABLE closed_trades
        ADD COLUMN IF NOT EXISTS open_fees NUMERIC(20, 8) NOT NULL DEFAULT '0'
    `);
    logger.info("DB migrations applied (closed_trades: open_fees)");
  } catch (err) {
    logger.warn({ err }, "DB migration warning (closed_trades: open_fees) — column may already exist");
  }
  try {
    await db.execute(sql`
      ALTER TABLE closed_trades
        ADD COLUMN IF NOT EXISTS spread_at_exit NUMERIC(20, 8),
        ADD COLUMN IF NOT EXISTS close_reason TEXT
    `);
    logger.info("DB migrations applied (closed_trades: spread_at_exit, close_reason)");
  } catch (err) {
    logger.warn({ err }, "DB migration warning (closed_trades: spread_at_exit/close_reason) — columns may already exist");
  }
}

server.listen(port, (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  (async () => {
    await runMigrations();
    await patchOrphanedLegs();
    await backfillLegExchanges();
    startBotWatcher();
  })().catch((e) => logger.error({ err: e }, "Startup failed during migration or bot watcher init"));

  // Run price fetch and klines prewarm in parallel — previously sequential, causing ~24s cold-start delay.
  // prewarmKlinesCache falls back to PREWARM_SYMBOLS when priceCache is empty so the order is fine.
  Promise.all([
    fetchPriceSpreads().then(() => logger.info("Startup price cache warm-up complete")),
    prewarmKlinesCache().then(({ succeeded, failed, symbols }) => {
      const total = symbols.length * PREWARM_INTERVALS.length;
      if (failed > 0) {
        logger.warn({ succeeded, failed, total, symbols }, "Startup klines cache pre-warm completed with failures");
      } else {
        logger.info({ succeeded, total, symbols }, "Startup klines cache pre-warm complete");
      }
    }),
  ]).catch((e) => logger.warn({ err: e }, "Startup price/klines cache warm-up failed"));

  setInterval(() => {
    prewarmKlinesCache()
      .then(({ succeeded, failed }) => {
        if (failed > 0) {
          logger.warn({ succeeded, failed }, "Scheduled klines cache pre-warm completed with failures");
        }
      })
      .catch((e) => logger.warn({ err: e }, "Scheduled klines cache pre-warm failed"));
  }, KLINES_PREWARM_INTERVAL_MS);
});
