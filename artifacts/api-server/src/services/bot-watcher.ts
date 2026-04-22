import ccxt from "ccxt";
import { db } from "@workspace/db";
import {
  botConfigsTable,
  botLegsTable,
  closedTradesTable,
  type BotConfig,
  type BotLeg,
} from "@workspace/db";
import { eq, and, inArray } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  fetchPriceSpreads,
  getPriceCacheEntry,
  createBybitExchange,
  createBinanceExchange,
  bybitCreateOrder,
  placeOrderInternal,
  closePositionInternal,
} from "../routes/exchanges";
import { getStoredCredentials } from "../routes/credentials";

let watcherTimer: ReturnType<typeof setTimeout> | null = null;
let priceRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;

const WATCHER_INTERVAL_MS = 1500;
const PRICE_REFRESH_INTERVAL_MS = 5000;

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

  const bybitSide: "long" | "short" = spreadPct >= 0 ? "short" : "long";
  const binanceSide: "long" | "short" = bybitSide === "long" ? "short" : "long";

  const bybitEx = createBybitExchange(bybitCreds.apiKey, bybitCreds.apiSecret);
  const binanceEx = createBinanceExchange(binanceCreds.apiKey, binanceCreds.apiSecret);

  let bybitResult: Awaited<ReturnType<typeof placeOrderInternal>> | null = null;

  try {
    bybitResult = await placeOrderInternal(bybitEx, config.symbol, bybitSide, halfSize, config.bybitLeverage ?? undefined);
  } catch (err) {
    logger.error({ err, symbol: config.symbol }, "Bot: Bybit leg open failed");
    return;
  }

  try {
    const binanceResult = await placeOrderInternal(binanceEx, config.symbol, binanceSide, halfSize, config.binanceLeverage ?? undefined);

    await db.insert(botLegsTable).values({
      botConfigId: config.id,
      symbol: config.symbol,
      bybitOrderId: bybitResult.orderId,
      binanceOrderId: binanceResult.orderId,
      bybitQty: String(bybitResult.filledQty),
      binanceQty: String(binanceResult.filledQty),
      bybitEntry: String(bybitResult.avgPrice),
      binanceEntry: String(binanceResult.avgPrice),
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
        bybitEx as InstanceType<typeof ccxt.bybit>,
        `${config.symbol}/USDT:USDT`,
        compensateSide,
        bybitResult.filledQty,
        { reduceOnly: true },
        bybitSide,
      );
      logger.info({ symbol: config.symbol }, "Bot: Bybit compensation order placed");
    } catch (compErr) {
      logger.error({ compErr, symbol: config.symbol }, "Bot: Bybit compensation FAILED — manual intervention required");
    }
  }
}

async function closeLeg(
  leg: BotLeg,
  bybitPrice: number,
  binancePrice: number,
): Promise<boolean> {
  const bybitCreds = await getStoredCredentials("bybit");
  const binanceCreds = await getStoredCredentials("binance");

  if (!bybitCreds || !binanceCreds) return false;

  const bybitEx = createBybitExchange(bybitCreds.apiKey, bybitCreds.apiSecret);
  const binanceEx = createBinanceExchange(binanceCreds.apiKey, binanceCreds.apiSecret);

  const bybitQty = Number(leg.bybitQty);
  const binanceQty = Number(leg.binanceQty);

  const result = await closePositionInternal({
    bybit: bybitEx,
    binance: binanceEx,
    symbol: leg.symbol,
    bybitSide: leg.bybitSide as "long" | "short",
    binanceSide: leg.binanceSide as "long" | "short",
    bybitQty,
    binanceQty,
  });

  if (!result.bothClosed) {
    if (result.bybitError) {
      logger.error({ err: result.bybitError, symbol: leg.symbol, legId: leg.id },
        "Bot: Bybit leg close failed — leg remains open for retry");
    }
    if (result.binanceError) {
      logger.error({ err: result.binanceError, symbol: leg.symbol, legId: leg.id },
        "Bot: Binance leg close failed — leg remains open for retry");
    }
    return false;
  }

  const realizedPnl = computeLegPnl(leg, bybitPrice, binancePrice);

  await db
    .update(botLegsTable)
    .set({ status: "closed", closedAt: new Date() })
    .where(eq(botLegsTable.id, leg.id));

  try {
    await db.insert(closedTradesTable).values({
      symbol: leg.symbol,
      longExchange: leg.bybitSide === "long" ? "bybit" : "binance",
      shortExchange: leg.bybitSide === "short" ? "bybit" : "binance",
      spreadAtEntry: String(leg.spreadAtEntry),
      realizedPnl: String(realizedPnl),
      quantity: String((bybitQty * bybitPrice + binanceQty * binancePrice) / 2),
      entryTime: leg.openedAt,
      closeTime: new Date(),
    });
  } catch (dbErr) {
    logger.error({ dbErr }, "Bot: failed to record closed trade to history");
  }

  logger.info({ legId: leg.id, symbol: leg.symbol, realizedPnl }, "Bot: closed leg successfully");
  return true;
}

async function processBotConfig(config: BotConfig, canOpen: boolean): Promise<void> {
  const priceRow = getPriceCacheEntry(config.symbol);
  if (!priceRow) {
    logger.warn({ symbol: config.symbol }, "Bot: symbol not in price cache yet — skipping tick");
    return;
  }

  const spreadPctRaw = getSpreadPct(priceRow.bybitPrice, priceRow.binancePrice);
  if (spreadPctRaw === null) return;
  const spreadPct: number = spreadPctRaw;

  const bybitPrice = priceRow.bybitPrice!;
  const binancePrice = priceRow.binancePrice!;

  const openLegs = await db
    .select()
    .from(botLegsTable)
    .where(and(eq(botLegsTable.botConfigId, config.id), eq(botLegsTable.status, "open")));

  const totalPnl = openLegs.reduce(
    (sum, leg) => sum + computeLegPnl(leg, bybitPrice, binancePrice),
    0,
  );

  const forceStop = Number(config.forceStopUsd);
  const closeSpread = Number(config.closeSpreadPct);
  const enterSpread = Number(config.enterSpreadPct);
  const forceStopTriggered = forceStop > 0 && openLegs.length > 0 && totalPnl <= -forceStop;

  // Per-leg directional close: close when spread has returned to threshold
  // - bybit-short leg (opened at positive spread): close when spreadPct <= closeSpread
  // - bybit-long leg (opened at negative spread): close when spreadPct >= -closeSpread
  // Both catch spread crossing zero (fully reversed arbitrage)
  function legShouldClose(leg: BotLeg): boolean {
    if (leg.bybitSide === "short") return spreadPct <= closeSpread;
    return spreadPct >= -closeSpread;
  }

  let confirmedClosedCount = 0;
  let anyForceStop = false;
  for (const leg of openLegs) {
    if (legShouldClose(leg) || forceStopTriggered) {
      const closed = await closeLeg(leg, bybitPrice, binancePrice);
      if (closed) confirmedClosedCount++;
      if (forceStopTriggered) anyForceStop = true;
    }
  }

  if (anyForceStop) {
    logger.warn({ symbol: config.symbol, totalPnl, forceStopUsd: forceStop },
      "Bot: force-stop triggered — skipping new open this tick");
    return;
  }

  if (!canOpen) return;

  const remainingOpen = openLegs.length - confirmedClosedCount;
  // Open: abs spread >= threshold (works for both spread directions)
  const shouldOpen = Math.abs(spreadPct) >= enterSpread && remainingOpen < config.maxOrders;
  if (shouldOpen) {
    await openLeg(config, spreadPct);
  }
}

async function watcherTick(): Promise<void> {
  try {
    // Phase 1: collect configs to process this tick
    // - Enabled bots: can open new legs AND close existing legs
    // - Disabled bots with open legs: close-only (bot stopped but legs still need monitoring)
    const enabledBots = await db
      .select()
      .from(botConfigsTable)
      .where(eq(botConfigsTable.enabled, true));

    const enabledIds = new Set(enabledBots.map(b => b.id));

    const botsWithLegs = await db
      .selectDistinct({ botConfigId: botLegsTable.botConfigId })
      .from(botLegsTable)
      .where(eq(botLegsTable.status, "open"));

    const disabledWithLegIds = botsWithLegs
      .map(r => r.botConfigId)
      .filter(id => !enabledIds.has(id));

    const disabledWithLegConfigs = disabledWithLegIds.length > 0
      ? await db.select().from(botConfigsTable).where(inArray(botConfigsTable.id, disabledWithLegIds))
      : [];

    if (enabledBots.length === 0 && disabledWithLegConfigs.length === 0) return;

    // Reads from in-memory cache only — priceRefreshLoop keeps it fresh every 5 s
    for (const config of enabledBots) {
      await processBotConfig(config, true);
    }
    for (const config of disabledWithLegConfigs) {
      await processBotConfig(config, false);
    }
  } catch (err) {
    logger.error({ err }, "Bot watcher tick error");
  }
}

function startPriceRefreshLoop(): void {
  const tick = () => {
    fetchPriceSpreads()
      .catch((err) => logger.warn({ err }, "Bot watcher: background price refresh failed"))
      .finally(() => {
        if (running) priceRefreshTimer = setTimeout(tick, PRICE_REFRESH_INTERVAL_MS);
      });
  };
  priceRefreshTimer = setTimeout(tick, 0);
}

export function startBotWatcher(): void {
  if (running) return;
  running = true;

  startPriceRefreshLoop();

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
  if (priceRefreshTimer) {
    clearTimeout(priceRefreshTimer);
    priceRefreshTimer = null;
  }
  logger.info("Bot watcher stopped");
}
