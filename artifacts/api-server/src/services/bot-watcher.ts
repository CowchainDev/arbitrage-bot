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
  createExchangeForName,
  placeOrderInternal,
  closePositionInternal,
  type SupportedCcxtExchange,
} from "../routes/exchanges";
import { getStoredCredentials, type SupportedExchange } from "../routes/credentials";

let watcherTimer: ReturnType<typeof setTimeout> | null = null;
let priceRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;

const WATCHER_INTERVAL_MS = 1500;
const PRICE_REFRESH_INTERVAL_MS = 5000;
const RECONCILE_INTERVAL_MS = 30_000;

function getSpreadPct(priceA: number | null, priceB: number | null): number | null {
  if (!priceA || !priceB) return null;
  return ((priceA - priceB) / priceB) * 100;
}

function computeLegPnl(
  leg: BotLeg,
  priceA: number,
  priceB: number,
): number {
  const qtyA = Number(leg.bybitQty);
  const qtyB = Number(leg.binanceQty);
  const entryA = Number(leg.bybitEntry);
  const entryB = Number(leg.binanceEntry);

  const pnlA =
    leg.bybitSide === "long"
      ? (priceA - entryA) * qtyA
      : (entryA - priceA) * qtyA;

  const pnlB =
    leg.binanceSide === "long"
      ? (priceB - entryB) * qtyB
      : (entryB - priceB) * qtyB;

  return pnlA + pnlB;
}

function botExchangeNames(config: BotConfig): { exchangeA: string; exchangeB: string } {
  return {
    exchangeA: config.exchangeA ?? "bybit",
    exchangeB: config.exchangeB ?? "binance",
  };
}

async function getExchangePairForBot(
  config: BotConfig,
): Promise<{ exA: SupportedCcxtExchange; exB: SupportedCcxtExchange } | null> {
  const { exchangeA, exchangeB } = botExchangeNames(config);

  const [credsA, credsB] = await Promise.all([
    getStoredCredentials(exchangeA as SupportedExchange),
    getStoredCredentials(exchangeB as SupportedExchange),
  ]);

  if (!credsA || !credsB) {
    logger.warn({ symbol: config.symbol, exchangeA, exchangeB }, "Bot: missing credentials for exchange pair");
    return null;
  }

  return {
    exA: createExchangeForName(exchangeA, credsA.apiKey, credsA.apiSecret),
    exB: createExchangeForName(exchangeB, credsB.apiKey, credsB.apiSecret),
  };
}

async function openLeg(config: BotConfig, spreadPct: number): Promise<void> {
  const pair = await getExchangePairForBot(config);
  if (!pair) return;
  const { exA, exB } = pair;
  const { exchangeA, exchangeB } = botExchangeNames(config);

  const halfSize = Number(config.orderSizeUsd) / 2;
  if (halfSize < 5) {
    logger.warn({ symbol: config.symbol }, "Bot: order size too small, min $10 total");
    return;
  }

  const sideA: "long" | "short" = spreadPct >= 0 ? "short" : "long";
  const sideB: "long" | "short" = sideA === "long" ? "short" : "long";
  const leverageA = (config.leverageA ?? config.bybitLeverage) || 1;
  const leverageB = (config.leverageB ?? config.binanceLeverage) || 1;

  let resultA: Awaited<ReturnType<typeof placeOrderInternal>> | null = null;

  try {
    resultA = await placeOrderInternal(exA, config.symbol, sideA, halfSize, leverageA);
  } catch (err) {
    logger.error({ err, symbol: config.symbol, exchange: exchangeA }, `Bot: ${exchangeA} leg open failed`);
    return;
  }

  try {
    const resultB = await placeOrderInternal(exB, config.symbol, sideB, halfSize, leverageB);

    await db.insert(botLegsTable).values({
      botConfigId: config.id,
      symbol: config.symbol,
      bybitOrderId: resultA.orderId,
      binanceOrderId: resultB.orderId,
      bybitQty: String(resultA.filledQty),
      binanceQty: String(resultB.filledQty),
      bybitEntry: String(resultA.avgPrice),
      binanceEntry: String(resultB.avgPrice),
      bybitSide: sideA,
      binanceSide: sideB,
      spreadAtEntry: String(spreadPct),
      status: "open",
      openedAt: new Date(),
    });

    logger.info({ symbol: config.symbol, exchangeA, sideA, exchangeB, sideB, spreadPct }, "Bot: opened new leg");
  } catch (err) {
    logger.error({ err, symbol: config.symbol, exchange: exchangeB }, `Bot: ${exchangeB} leg open failed, compensating ${exchangeA}`);
    const compensateSide = sideA === "long" ? "sell" : "buy";
    try {
      await exA.createMarketOrder(`${config.symbol}/USDT:USDT`, compensateSide, resultA.filledQty, undefined, { reduceOnly: true });
      logger.info({ symbol: config.symbol }, `Bot: ${exchangeA} compensation order placed`);
    } catch (compErr) {
      logger.error({ compErr, symbol: config.symbol }, `Bot: ${exchangeA} compensation FAILED — manual intervention required`);
    }
  }
}

async function closeLeg(
  config: BotConfig,
  leg: BotLeg,
  priceA: number,
  priceB: number,
): Promise<boolean> {
  const pair = await getExchangePairForBot(config);
  if (!pair) return false;
  const { exA, exB } = pair;
  const { exchangeA } = botExchangeNames(config);

  const result = await closePositionInternal({
    exA,
    exB,
    symbol: leg.symbol,
    sideA: leg.bybitSide as "long" | "short",
    sideB: leg.binanceSide as "long" | "short",
    qtyA: Number(leg.bybitQty),
    qtyB: Number(leg.binanceQty),
    longExchange: leg.bybitSide === "long" ? exchangeA : config.exchangeB ?? "binance",
    shortExchange: leg.bybitSide === "short" ? exchangeA : config.exchangeB ?? "binance",
  });

  if (!result.bothClosed) {
    if (result.errorA) logger.error({ err: result.errorA, symbol: leg.symbol, legId: leg.id }, "Bot: exA leg close failed");
    if (result.errorB) logger.error({ err: result.errorB, symbol: leg.symbol, legId: leg.id }, "Bot: exB leg close failed");
    return false;
  }

  const realizedPnl = computeLegPnl(leg, priceA, priceB);

  await db
    .update(botLegsTable)
    .set({ status: "closed", closedAt: new Date() })
    .where(eq(botLegsTable.id, leg.id));

  try {
    await db.insert(closedTradesTable).values({
      symbol: leg.symbol,
      longExchange: leg.bybitSide === "long" ? (config.exchangeA ?? "bybit") : (config.exchangeB ?? "binance"),
      shortExchange: leg.bybitSide === "short" ? (config.exchangeA ?? "bybit") : (config.exchangeB ?? "binance"),
      spreadAtEntry: String(leg.spreadAtEntry),
      realizedPnl: String(realizedPnl),
      quantity: String((Number(leg.bybitQty) * priceA + Number(leg.binanceQty) * priceB) / 2),
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

  const priceA = priceRow.bybitPrice!;
  const priceB = priceRow.binancePrice!;

  const openLegs = await db
    .select()
    .from(botLegsTable)
    .where(and(eq(botLegsTable.botConfigId, config.id), eq(botLegsTable.status, "open")));

  const totalPnl = openLegs.reduce(
    (sum, leg) => sum + computeLegPnl(leg, priceA, priceB),
    0,
  );

  const forceStop = Number(config.forceStopUsd);
  const closeSpread = Number(config.closeSpreadPct);
  const enterSpread = Number(config.enterSpreadPct);
  const forceStopTriggered = forceStop > 0 && openLegs.length > 0 && totalPnl <= -forceStop;

  function legShouldClose(leg: BotLeg): boolean {
    if (leg.bybitSide === "short") return spreadPct <= closeSpread;
    return spreadPct >= -closeSpread;
  }

  let confirmedClosedCount = 0;
  let anyForceStop = false;
  for (const leg of openLegs) {
    if (legShouldClose(leg) || forceStopTriggered) {
      const closed = await closeLeg(config, leg, priceA, priceB);
      if (closed) confirmedClosedCount++;
      if (forceStopTriggered) anyForceStop = true;
    }
  }

  if (anyForceStop) {
    logger.warn({ symbol: config.symbol, totalPnl, forceStopUsd: forceStop }, "Bot: force-stop triggered");
    return;
  }

  if (!canOpen) return;

  const remainingOpen = openLegs.length - confirmedClosedCount;
  const shouldOpen = Math.abs(spreadPct) >= enterSpread && remainingOpen < config.maxOrders;
  if (shouldOpen) {
    await openLeg(config, spreadPct);
  }
}

export async function closeAllLegsForBot(botId: number): Promise<{ closed: number; failed: number }> {
  const [botConfig] = await db.select().from(botConfigsTable).where(eq(botConfigsTable.id, botId)).limit(1);
  if (!botConfig) return { closed: 0, failed: 0 };

  const pair = await getExchangePairForBot(botConfig);
  if (!pair) return { closed: 0, failed: 0 };
  const { exA, exB } = pair;
  const { exchangeA, exchangeB } = botExchangeNames(botConfig);

  const openLegs = await db
    .select()
    .from(botLegsTable)
    .where(and(eq(botLegsTable.botConfigId, botId), eq(botLegsTable.status, "open")));

  let closed = 0;
  let failed = 0;

  for (const leg of openLegs) {
    const priceRow = getPriceCacheEntry(leg.symbol);
    const priceA = priceRow?.bybitPrice ?? Number(leg.bybitEntry);
    const priceB = priceRow?.binancePrice ?? Number(leg.binanceEntry);

    const result = await closePositionInternal({
      exA,
      exB,
      symbol: leg.symbol,
      sideA: leg.bybitSide as "long" | "short",
      sideB: leg.binanceSide as "long" | "short",
      qtyA: Number(leg.bybitQty),
      qtyB: Number(leg.binanceQty),
      spreadAtEntry: Number(leg.spreadAtEntry),
      entryTime: leg.openedAt,
      longExchange: leg.bybitSide === "long" ? exchangeA : exchangeB,
      shortExchange: leg.bybitSide === "short" ? exchangeA : exchangeB,
    });

    if (result.bothClosed) {
      const realizedPnl = computeLegPnl(leg, priceA, priceB);
      await db.update(botLegsTable).set({ status: "closed", closedAt: new Date() }).where(eq(botLegsTable.id, leg.id));
      try {
        await db.insert(closedTradesTable).values({
          symbol: leg.symbol,
          longExchange: leg.bybitSide === "long" ? exchangeA : exchangeB,
          shortExchange: leg.bybitSide === "short" ? exchangeA : exchangeB,
          spreadAtEntry: String(leg.spreadAtEntry),
          realizedPnl: String(realizedPnl),
          quantity: String((Number(leg.bybitQty) * priceA + Number(leg.binanceQty) * priceB) / 2),
          entryTime: leg.openedAt,
          closeTime: new Date(),
        });
      } catch {}
      closed++;
      logger.info({ legId: leg.id, symbol: leg.symbol }, "stop-and-close: leg closed");
    } else {
      failed++;
      logger.warn({ legId: leg.id, errorA: result.errorA, errorB: result.errorB }, "stop-and-close: leg close failed");
    }
  }

  return { closed, failed };
}

async function reconcileOpenLegs(): Promise<void> {
  const openLegs = await db
    .select()
    .from(botLegsTable)
    .where(eq(botLegsTable.status, "open"));

  if (openLegs.length === 0) return;

  const botIds = [...new Set(openLegs.map(l => l.botConfigId))];
  const botConfigs = botIds.length > 0
    ? await db.select().from(botConfigsTable).where(inArray(botConfigsTable.id, botIds))
    : [];
  const configMap = new Map(botConfigs.map(c => [c.id, c]));

  const exchangePairCache = new Map<number, Awaited<ReturnType<typeof getExchangePairForBot>>>();
  for (const config of botConfigs) {
    exchangePairCache.set(config.id, await getExchangePairForBot(config));
  }

  const activePositionsByExchange = new Map<string, Set<string>>();

  const allExchanges = new Set<string>();
  for (const config of botConfigs) {
    allExchanges.add(config.exchangeA ?? "bybit");
    allExchanges.add(config.exchangeB ?? "binance");
  }

  for (const exName of allExchanges) {
    const creds = await getStoredCredentials(exName as SupportedExchange);
    if (!creds) continue;
    try {
      const ex = createExchangeForName(exName, creds.apiKey, creds.apiSecret);
      const fetchType = exName === "binance" ? "future" : "linear";
      const positions = await ex.fetchPositions(undefined, { type: fetchType });
      const active = new Set<string>();
      for (const pos of positions) {
        if ((pos.contracts ?? 0) === 0) continue;
        const sym = (pos.symbol ?? "").split("/")[0];
        const side = pos.side === "long" ? "long" : "short";
        active.add(`${sym}:${side}`);
      }
      activePositionsByExchange.set(exName, active);
    } catch (err) {
      logger.warn({ err, exchange: exName }, "Reconcile: failed to fetch positions from exchange");
    }
  }

  for (const leg of openLegs) {
    const config = configMap.get(leg.botConfigId);
    if (!config) continue;

    const exAName = config.exchangeA ?? "bybit";
    const exBName = config.exchangeB ?? "binance";

    const activeA = activePositionsByExchange.get(exAName);
    const activeB = activePositionsByExchange.get(exBName);

    if (!activeA && !activeB) continue;

    const keyA = `${leg.symbol}:${leg.bybitSide}`;
    const keyB = `${leg.symbol}:${leg.binanceSide}`;

    const aGone = activeA ? !activeA.has(keyA) : false;
    const bGone = activeB ? !activeB.has(keyB) : false;

    if (aGone && bGone) {
      await db.update(botLegsTable)
        .set({ status: "closed", closedAt: new Date() })
        .where(eq(botLegsTable.id, leg.id));
      logger.info({ legId: leg.id, symbol: leg.symbol }, "Reconcile: leg marked closed (both sides gone)");
    }
  }
}

async function watcherTick(): Promise<void> {
  try {
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

function startReconcileLoop(): void {
  const tick = () => {
    reconcileOpenLegs()
      .catch((err) => logger.warn({ err }, "Bot watcher: reconcile tick failed"))
      .finally(() => {
        if (running) reconcileTimer = setTimeout(tick, RECONCILE_INTERVAL_MS);
      });
  };
  reconcileTimer = setTimeout(tick, RECONCILE_INTERVAL_MS);
}

export function startBotWatcher(): void {
  if (running) return;
  running = true;

  startPriceRefreshLoop();
  startReconcileLoop();

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
  if (watcherTimer) { clearTimeout(watcherTimer); watcherTimer = null; }
  if (priceRefreshTimer) { clearTimeout(priceRefreshTimer); priceRefreshTimer = null; }
  if (reconcileTimer) { clearTimeout(reconcileTimer); reconcileTimer = null; }
  logger.info("Bot watcher stopped");
}
