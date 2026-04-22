import { db } from "@workspace/db";
import {
  botConfigsTable,
  botLegsTable,
  closedTradesTable,
  type BotConfig,
  type BotLeg,
} from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { logger } from "../lib/logger";
import { fetchPriceSpreads, createBybitExchange, createBinanceExchange, bybitCreateOrder } from "../routes/exchanges";
import { getStoredCredentials } from "../routes/credentials";

let watcherTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;

const WATCHER_INTERVAL_MS = 1500;

type PriceRow = { symbol: string; bybitPrice: number | null; binancePrice: number | null };

function getSpreadPct(bybitPrice: number | null, binancePrice: number | null): number | null {
  if (!bybitPrice || !binancePrice) return null;
  return ((bybitPrice - binancePrice) / binancePrice) * 100;
}

function computeLegPnl(
  leg: BotLeg,
  bybitPrice: number,
  binancePrice: number,
): number {
  const bybitQty = Number(leg.bybitQty);
  const binanceQty = Number(leg.binanceQty);
  const bybitEntry = Number(leg.bybitEntry);
  const binanceEntry = Number(leg.binanceEntry);

  const bybitPnl =
    leg.bybitSide === "long"
      ? (bybitPrice - bybitEntry) * bybitQty
      : (bybitEntry - bybitPrice) * bybitQty;

  const binancePnl =
    leg.binanceSide === "long"
      ? (binancePrice - binanceEntry) * binanceQty
      : (binanceEntry - binancePrice) * binanceQty;

  return bybitPnl + binancePnl;
}

async function openLeg(config: BotConfig, spreadPct: number): Promise<void> {
  const bybitCreds = await getStoredCredentials("bybit");
  const binanceCreds = await getStoredCredentials("binance");

  if (!bybitCreds || !binanceCreds) {
    logger.warn({ symbol: config.symbol }, "Bot: no server-side credentials, skipping leg open");
    return;
  }

  const halfSize = Number(config.orderSizeUsd) / 2;
  if (halfSize < 5) {
    logger.warn({ symbol: config.symbol }, "Bot: order size too small, min $10 total");
    return;
  }

  const bybitSide = spreadPct >= 0 ? "short" : "long";
  const binanceSide = bybitSide === "long" ? "short" : "long";

  const bybitEx = createBybitExchange(bybitCreds.apiKey, bybitCreds.apiSecret);
  const binanceEx = createBinanceExchange(binanceCreds.apiKey, binanceCreds.apiSecret);

  let bybitResult: { orderId: string; filledQty: number; avgPrice: number } | null = null;

  try {
    if (config.bybitLeverage && config.bybitLeverage !== 1) {
      try { await bybitEx.setLeverage(config.bybitLeverage, `${config.symbol}/USDT:USDT`); } catch (_) {}
    }
    const ticker = await bybitEx.fetchTicker(`${config.symbol}/USDT:USDT`);
    const price = ticker.last ?? ticker.bid ?? 1;
    const qty = halfSize / price;
    const ccxtSide = bybitSide === "long" ? "buy" : "sell";
    const order = await bybitCreateOrder(bybitEx, `${config.symbol}/USDT:USDT`, ccxtSide, qty, { reduceOnly: false }, bybitSide);
    bybitResult = { orderId: String(order.id), filledQty: order.filled ?? qty, avgPrice: order.average ?? price };
  } catch (err) {
    logger.error({ err, symbol: config.symbol }, "Bot: Bybit leg open failed");
    return;
  }

  try {
    if (config.binanceLeverage && config.binanceLeverage !== 1) {
      try { await binanceEx.setLeverage(config.binanceLeverage, `${config.symbol}/USDT:USDT`); } catch (_) {}
    }
    const ticker = await binanceEx.fetchTicker(`${config.symbol}/USDT:USDT`);
    const price = ticker.last ?? ticker.bid ?? 1;
    const qty = halfSize / price;
    const ccxtSide = binanceSide === "long" ? "buy" : "sell";
    const order = await binanceEx.createMarketOrder(
      `${config.symbol}/USDT:USDT`, ccxtSide, qty, undefined, { reduceOnly: false }
    );

    await db.insert(botLegsTable).values({
      botConfigId: config.id,
      symbol: config.symbol,
      bybitOrderId: bybitResult.orderId,
      binanceOrderId: String(order.id),
      bybitQty: String(bybitResult.filledQty),
      binanceQty: String(order.filled ?? qty),
      bybitEntry: String(bybitResult.avgPrice),
      binanceEntry: String(order.average ?? price),
      bybitSide,
      binanceSide,
      spreadAtEntry: String(spreadPct),
      status: "open",
      openedAt: new Date(),
    });

    logger.info({ symbol: config.symbol, bybitSide, spreadPct }, "Bot: opened new leg");
  } catch (err) {
    logger.error({ err, symbol: config.symbol }, "Bot: Binance leg open failed, compensating Bybit");
    const compensateSide = bybitSide === "long" ? "sell" : "buy";
    try {
      await bybitCreateOrder(
        bybitEx, `${config.symbol}/USDT:USDT`, compensateSide, bybitResult.filledQty,
        { reduceOnly: true }, bybitSide
      );
    } catch (compErr) {
      logger.error({ compErr, symbol: config.symbol }, "Bot: Bybit compensation FAILED — manual intervention required");
    }
  }
}

async function closeLeg(leg: BotLeg, bybitPrice: number, binancePrice: number): Promise<void> {
  const bybitCreds = await getStoredCredentials("bybit");
  const binanceCreds = await getStoredCredentials("binance");

  if (!bybitCreds || !binanceCreds) return;

  const bybitEx = createBybitExchange(bybitCreds.apiKey, bybitCreds.apiSecret);
  const binanceEx = createBinanceExchange(binanceCreds.apiKey, binanceCreds.apiSecret);

  const bybitCloseSide = leg.bybitSide === "long" ? "sell" : "buy";
  const binanceCloseSide = leg.binanceSide === "long" ? "sell" : "buy";
  const bybitQty = Number(leg.bybitQty);
  const binanceQty = Number(leg.binanceQty);

  const [bybitOrder, binanceOrder] = await Promise.allSettled([
    bybitCreateOrder(bybitEx, `${leg.symbol}/USDT:USDT`, bybitCloseSide, bybitQty, { reduceOnly: true }, leg.bybitSide as "long" | "short"),
    binanceEx.createMarketOrder(`${leg.symbol}/USDT:USDT`, binanceCloseSide, binanceQty, undefined, { reduceOnly: true }),
  ]);

  const bothClosed = bybitOrder.status === "fulfilled" && binanceOrder.status === "fulfilled";

  const realizedPnl = computeLegPnl(leg, bybitPrice, binancePrice);

  await db
    .update(botLegsTable)
    .set({ status: "closed", closedAt: new Date() })
    .where(eq(botLegsTable.id, leg.id));

  if (bothClosed) {
    try {
      const longExchange = leg.bybitSide === "long" ? "bybit" : "binance";
      const shortExchange = leg.bybitSide === "short" ? "bybit" : "binance";
      await db.insert(closedTradesTable).values({
        symbol: leg.symbol,
        longExchange,
        shortExchange,
        spreadAtEntry: String(leg.spreadAtEntry),
        realizedPnl: String(realizedPnl),
        quantity: String((bybitQty * bybitPrice + binanceQty * binancePrice) / 2),
        entryTime: leg.openedAt,
        closeTime: new Date(),
      });
    } catch (dbErr) {
      logger.error({ dbErr }, "Bot: failed to record closed trade");
    }
  } else {
    if (bybitOrder.status === "rejected") {
      logger.error({ err: bybitOrder.reason, symbol: leg.symbol }, "Bot: Bybit leg close failed");
    }
    if (binanceOrder.status === "rejected") {
      logger.error({ err: binanceOrder.reason, symbol: leg.symbol }, "Bot: Binance leg close failed");
    }
  }

  logger.info({ legId: leg.id, symbol: leg.symbol, realizedPnl, bothClosed }, "Bot: closed leg");
}

async function watcherTick(): Promise<void> {
  try {
    const enabledBots = await db
      .select()
      .from(botConfigsTable)
      .where(eq(botConfigsTable.enabled, true));

    if (enabledBots.length === 0) return;

    const spreadsRaw = await fetchPriceSpreads();
    const priceMap = new Map<string, PriceRow>();
    for (const row of spreadsRaw) {
      priceMap.set(row.symbol, row as PriceRow);
    }

    for (const config of enabledBots) {
      const priceRow = priceMap.get(config.symbol);
      if (!priceRow) continue;

      const spreadPct = getSpreadPct(priceRow.bybitPrice, priceRow.binancePrice);
      if (spreadPct === null) continue;

      const bybitPrice = priceRow.bybitPrice!;
      const binancePrice = priceRow.binancePrice!;

      const openLegs = await db
        .select()
        .from(botLegsTable)
        .where(and(eq(botLegsTable.botConfigId, config.id), eq(botLegsTable.status, "open")));

      const totalPnl = openLegs.reduce((sum, leg) => sum + computeLegPnl(leg, bybitPrice, binancePrice), 0);
      const forceStop = Number(config.forceStopUsd);

      for (const leg of openLegs) {
        const shouldClose =
          Math.abs(spreadPct) <= Math.abs(Number(config.closeSpreadPct)) ||
          (forceStop > 0 && totalPnl <= -forceStop);

        if (shouldClose) {
          await closeLeg(leg, bybitPrice, binancePrice);
        }
      }

      const stillOpenCount = openLegs.length - openLegs.filter((leg) => {
        const legPnl = computeLegPnl(leg, bybitPrice, binancePrice);
        return (
          Math.abs(spreadPct) <= Math.abs(Number(config.closeSpreadPct)) ||
          (forceStop > 0 && totalPnl <= -forceStop)
        );
      }).length;

      const enterSpread = Math.abs(Number(config.enterSpreadPct));
      const shouldOpen =
        Math.abs(spreadPct) >= enterSpread &&
        stillOpenCount < config.maxOrders;

      if (shouldOpen) {
        await openLeg(config, spreadPct);
      }
    }
  } catch (err) {
    logger.error({ err }, "Bot watcher tick error");
  }
}

export function startBotWatcher(): void {
  if (running) return;
  running = true;

  const tick = () => {
    watcherTick().finally(() => {
      if (running) {
        watcherTimer = setTimeout(tick, WATCHER_INTERVAL_MS);
      }
    });
  };

  watcherTimer = setTimeout(tick, WATCHER_INTERVAL_MS);
  logger.info("Bot watcher started");
}

export function stopBotWatcher(): void {
  running = false;
  if (watcherTimer) {
    clearTimeout(watcherTimer);
    watcherTimer = null;
  }
  logger.info("Bot watcher stopped");
}
