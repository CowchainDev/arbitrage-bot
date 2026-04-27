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
    startBotWatcher();
  })().catch((e) => logger.error({ err: e }, "Startup failed during migration or bot watcher init"));

  fetchPriceSpreads()
    .then(() => {
      logger.info("Startup price cache warm-up complete");
      return prewarmKlinesCache();
    })
    .then(({ succeeded, failed, symbols }) => {
      const total = symbols.length * PREWARM_INTERVALS.length;
      if (failed > 0) {
        logger.warn({ succeeded, failed, total, symbols }, "Startup klines cache pre-warm completed with failures");
      } else {
        logger.info({ succeeded, total, symbols }, "Startup klines cache pre-warm complete");
      }
    })
    .catch((e) => logger.warn({ err: e }, "Startup price/klines cache warm-up failed"));

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
