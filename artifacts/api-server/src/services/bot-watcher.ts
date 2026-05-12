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
  getFundingRateEntry,
  getFundingRateForExchange,
  createExchangeForName,
  placeOrderInternal,
  closePositionInternal,
  FUNDING_INTERVAL_MS,
  countSettledFundingIntervals,
  type SupportedCcxtExchange,
} from "../routes/exchanges";
import { getStoredCredentials, type SupportedExchange } from "../routes/credentials";
import { botEventBus } from "../lib/bot-events";

let watcherTimer: ReturnType<typeof setTimeout> | null = null;
let priceRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
let running = false;

const WATCHER_INTERVAL_MS = 1500;
const PRICE_REFRESH_INTERVAL_MS = 5000;
const RECONCILE_INTERVAL_MS = 30_000;

const CRED_CACHE_TTL_MS = 30_000;
type CredEntry = { apiKey: string; apiSecret: string; passphrase?: string | null };
const credCache = new Map<string, { data: CredEntry; ts: number }>();

/**
 * Tracks the last timestamp (ms) at which each bot opened a new leg.
 * Enforces a 2-tick cooldown between consecutive leg openings so that
 * multiple slots don't all fire at once when conditions are broadly met.
 */
const lastLegOpenedAt = new Map<number, number>();
const LEG_OPEN_COOLDOWN_MS = 2 * WATCHER_INTERVAL_MS; // ~3 s

/**
 * Tracks the last timestamp (ms) at which each bot's openLeg() attempt failed
 * (e.g. second-leg auth error, order rejection). Enforces a longer back-off so
 * the bot does not hammer the exchange every 1.5 s while the issue persists,
 * which would continuously create-then-compensate the first leg.
 */
const lastLegFailedAt = new Map<number, number>();
const LEG_OPEN_FAILURE_COOLDOWN_MS = 60_000; // 60 s back-off on any open failure

async function getCachedCredentials(exchange: SupportedExchange): Promise<CredEntry | null> {
  const cached = credCache.get(exchange);
  if (cached && Date.now() - cached.ts < CRED_CACHE_TTL_MS) {
    return cached.data;
  }
  const fresh = await getStoredCredentials(exchange);
  if (!fresh) {
    credCache.delete(exchange);
    return null;
  }
  credCache.set(exchange, { data: fresh, ts: Date.now() });
  return fresh;
}

function invalidateCredCache(exchange?: string) {
  if (exchange) {
    credCache.delete(exchange);
  } else {
    credCache.clear();
  }
}


function getSpreadPct(priceA: number | null, priceB: number | null): number | null {
  if (!priceA || !priceB) return null;
  return ((priceA - priceB) / priceB) * 100;
}

type PriceCacheEntry = NonNullable<ReturnType<typeof getPriceCacheEntry>>;

function priceFromCache(entry: PriceCacheEntry, exchange: string): number | null {
  switch (exchange) {
    case "bybit":   return entry.bybitPrice;
    case "binance": return entry.binancePrice;
    case "mexc":    return entry.mexcPrice;
    case "gate":    return entry.gatePrice;
    case "okx":     return entry.okxPrice;
    case "aster":   return entry.asterPrice;
    case "hyper":   return entry.hyperPrice;
    default:        return null;
  }
}

function computeLegPnl(
  leg: BotLeg,
  priceA: number,
  priceB: number,
  extraFees = 0,
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

  const openFees = Number(leg.openFeeA ?? 0) + Number(leg.openFeeB ?? 0);
  return pnlA + pnlB - openFees - extraFees;
}

/**
 * Retry a DB operation up to maxAttempts times with exponential back-off.
 * Protects against transient "Authentication timed out" / TLS drops that caused
 * leg 97's realized P&L to be silently lost during close.
 */
async function withDbRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxAttempts = 4,
  baseDelayMs = 800,
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxAttempts) {
        logger.error({ err, label, attempt }, "DB operation failed after all retries");
        throw err;
      }
      const delay = baseDelayMs * attempt;
      logger.warn({ err, label, attempt, retryInMs: delay }, "DB operation failed, retrying");
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("unreachable");
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
    getCachedCredentials(exchangeA as SupportedExchange),
    getCachedCredentials(exchangeB as SupportedExchange),
  ]);

  if (!credsA || !credsB) {
    logger.warn({ symbol: config.symbol, exchangeA, exchangeB }, "Bot: missing credentials for exchange pair");
    return null;
  }

  return {
    exA: createExchangeForName(exchangeA, credsA.apiKey, credsA.apiSecret, credsA.passphrase ?? undefined),
    exB: createExchangeForName(exchangeB, credsB.apiKey, credsB.apiSecret, credsB.passphrase ?? undefined),
  };
}

async function openLeg(config: BotConfig, spreadPct: number): Promise<boolean> {
  const pair = await getExchangePairForBot(config);
  if (!pair) return false;
  const { exA, exB } = pair;
  const { exchangeA, exchangeB } = botExchangeNames(config);

  const halfSize = Number(config.orderSizeUsd) / 2;
  if (halfSize < 5) {
    logger.warn({ symbol: config.symbol }, "Bot: order size too small, min $10 total");
    botEventBus.emitBotEvent({ kind: "order_too_small", symbol: config.symbol });
    return false;
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
    botEventBus.emitBotEvent({ kind: "leg_open_failed", symbol: config.symbol, exchange: exchangeA, message: String(err) });
    return false;
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
      enterSpreadThresholdPct: String(config.enterSpreadPct),
      openFeeA: String(resultA.feeCost),
      openFeeB: String(resultB.feeCost),
      // Store ExB contractSize so closeOnExchange can convert base-unit qty back to contracts.
      // null means qty is already in contracts (legacy behavior); a number means qty is in base units.
      contractSizeB: resultB.contractSize > 1 ? String(resultB.contractSize) : null,
      legExchangeA: exchangeA,
      legExchangeB: exchangeB,
      status: "open",
      openedAt: new Date(),
    });

    logger.info({ symbol: config.symbol, exchangeA, sideA, exchangeB, sideB, spreadPct }, "Bot: opened new leg");
    botEventBus.emitBotEvent({ kind: "leg_opened", symbol: config.symbol, exchangeA, sideA, exchangeB, sideB, spreadPct, usdAmount: Number(config.orderSizeUsd) });
    return true;
  } catch (err) {
    logger.error({ err, symbol: config.symbol, exchange: exchangeB }, `Bot: ${exchangeB} leg open failed, compensating ${exchangeA}`);
    botEventBus.emitBotEvent({ kind: "leg_open_failed", symbol: config.symbol, exchange: exchangeB, message: String(err) });
    const compensateSide = sideA === "long" ? "sell" : "buy";
    try {
      await exA.createMarketOrder(`${config.symbol}/USDT:USDT`, compensateSide, resultA.filledQty, undefined, { reduceOnly: true });
      logger.info({ symbol: config.symbol }, `Bot: ${exchangeA} compensation order placed`);
    } catch (compErr) {
      logger.error({ compErr, symbol: config.symbol }, `Bot: ${exchangeA} compensation FAILED — manual intervention required`);
      botEventBus.emitBotEvent({ kind: "compensation_failed", symbol: config.symbol, exchange: exchangeA });
    }
    return false;
  }
}

async function closeLeg(
  config: BotConfig,
  leg: BotLeg,
  priceA: number,
  priceB: number,
  closeReason: string = "manual",
): Promise<boolean> {
  const pair = await getExchangePairForBot(config);
  if (!pair) return false;
  const { exA, exB } = pair;
  const { exchangeA, exchangeB } = botExchangeNames(config);

  const result = await closePositionInternal({
    exA,
    exB,
    symbol: leg.symbol,
    sideA: leg.bybitSide as "long" | "short",
    sideB: leg.binanceSide as "long" | "short",
    qtyA: Number(leg.bybitQty),
    qtyB: Number(leg.binanceQty),
    // Pass stored contractSizeB so the close order qty is correctly converted back to contracts.
    // null = legacy leg (qty already in contracts, no conversion needed).
    contractSizeB: leg.contractSizeB != null ? Number(leg.contractSizeB) : null,
    longExchange: leg.bybitSide === "long" ? exchangeA : exchangeB,
    shortExchange: leg.bybitSide === "short" ? exchangeA : exchangeB,
  });

  if (!result.bothClosed) {
    if (result.errorA) logger.error({ err: result.errorA, symbol: leg.symbol, legId: leg.id }, "Bot: exA leg close failed");
    if (result.errorB) logger.error({ err: result.errorB, symbol: leg.symbol, legId: leg.id }, "Bot: exB leg close failed");
    return false;
  }

  const closeFees = result.closeFeeA + result.closeFeeB;
  // Use actual fill prices from the close orders when available — cache prices are stale
  // and can differ from real fills, especially on illiquid tokens. Fall back to the
  // cache prices that triggered the close trigger if the exchange didn't return an avgPrice.
  const closePriceA = result.closePriceA ?? priceA;
  const closePriceB = result.closePriceB ?? priceB;
  const realizedPnl = computeLegPnl(leg, closePriceA, closePriceB, closeFees);
  const totalFees =
    Number(leg.openFeeA ?? 0) + Number(leg.openFeeB ?? 0) + closeFees;
  const spreadAtExit = getSpreadPct(closePriceA, closePriceB);
  const closedAt = new Date();

  const longExchangeName = leg.bybitSide === "long" ? exchangeA : exchangeB;
  const shortExchangeName = leg.bybitSide === "short" ? exchangeA : exchangeB;
  const usdSize = Number(leg.bybitQty) * Number(leg.bybitEntry) + Number(leg.binanceQty) * Number(leg.binanceEntry);

  // Estimate net funding accrued over the life of this leg.
  // Also record the raw rate spread (shortRate - longRate) so the calculation
  // is transparent and auditable without reverse-engineering from fundingPaidUsd.
  let estimatedFundingUsd: number | null = null;
  let fundingRateSpread: number | null = null;
  const fundingEntry = getFundingRateEntry(leg.symbol);
  if (fundingEntry) {
    const longRate = getFundingRateForExchange(fundingEntry, longExchangeName);
    const shortRate = getFundingRateForExchange(fundingEntry, shortExchangeName);
    fundingRateSpread = shortRate - longRate;
    const longIntervalMs  = FUNDING_INTERVAL_MS[longExchangeName]  ?? 28_800_000;
    const shortIntervalMs = FUNDING_INTERVAL_MS[shortExchangeName] ?? 28_800_000;
    const longIntervals  = countSettledFundingIntervals(leg.openedAt.getTime(), closedAt.getTime(), longIntervalMs);
    const shortIntervals = countSettledFundingIntervals(leg.openedAt.getTime(), closedAt.getTime(), shortIntervalMs);
    estimatedFundingUsd = (shortIntervals * shortRate - longIntervals * longRate) * usdSize;
  }

  // Retry the DB write — a transient connection drop here silently orphans the P&L
  // (the position stays "open" in the DB while already closed on the exchange).
  await withDbRetry(
    () =>
      db
        .update(botLegsTable)
        .set({
          status: "closed",
          closedAt,
          spreadAtExit: spreadAtExit != null ? String(spreadAtExit) : undefined,
          realizedPnlUsd: String(realizedPnl),
          fundingPaidUsd: estimatedFundingUsd != null ? String(estimatedFundingUsd) : undefined,
          fundingRateSpread: fundingRateSpread != null ? String(fundingRateSpread) : undefined,
        })
        .where(eq(botLegsTable.id, leg.id)),
    `closeLeg update leg=${leg.id}`,
  );

  await withDbRetry(
    () =>
      db.insert(closedTradesTable).values({
        symbol: leg.symbol,
        longExchange: longExchangeName,
        shortExchange: shortExchangeName,
        spreadAtEntry: String(leg.spreadAtEntry),
        enterSpreadThresholdPct: leg.enterSpreadThresholdPct != null ? String(leg.enterSpreadThresholdPct) : undefined,
        spreadAtExit: spreadAtExit != null ? String(spreadAtExit) : undefined,
        closeReason,
        realizedPnl: String(realizedPnl),
        totalFees: String(totalFees),
        openFees: String(Number(leg.openFeeA ?? 0) + Number(leg.openFeeB ?? 0)),
        fundingPaidUsd: estimatedFundingUsd != null ? String(estimatedFundingUsd) : undefined,
        fundingRateSpread: fundingRateSpread != null ? String(fundingRateSpread) : undefined,
        quantity: String(usdSize / 2),
        entryTime: leg.openedAt,
        closeTime: closedAt,
      }),
    `closeLeg insert closed_trade leg=${leg.id}`,
  );

  logger.info({ legId: leg.id, symbol: leg.symbol, realizedPnl, totalFees }, "Bot: closed leg successfully");
  botEventBus.emitBotEvent({ kind: "leg_closed", symbol: leg.symbol, legId: leg.id, realizedPnl, totalFees, trigger: closeReason });
  return true;
}

async function processBotConfig(config: BotConfig, canOpen: boolean): Promise<void> {
  const priceRow = getPriceCacheEntry(config.symbol);
  if (!priceRow) {
    logger.warn({ symbol: config.symbol }, "Bot: symbol not in price cache yet — skipping tick");
    return;
  }

  const { exchangeA, exchangeB } = botExchangeNames(config);
  const priceA = priceFromCache(priceRow, exchangeA);
  const priceB = priceFromCache(priceRow, exchangeB);

  const spreadPctRaw = getSpreadPct(priceA, priceB);
  if (spreadPctRaw === null) return;
  const spreadPct: number = spreadPctRaw;

  if (!priceA || !priceB) return;

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
  const stopLossSpread = Number(config.stopLossSpreadPct ?? 0);
  const forceStopTriggered = forceStop > 0 && openLegs.length > 0 && totalPnl <= -forceStop;

  function legShouldClose(leg: BotLeg): { close: boolean; reason: string } {
    if (leg.bybitSide === "short") {
      if (spreadPct <= closeSpread) return { close: true, reason: "take_profit" };
      if (stopLossSpread > 0 && spreadPct >= stopLossSpread) return { close: true, reason: "stop_loss" };
    } else {
      if (spreadPct >= -closeSpread) return { close: true, reason: "take_profit" };
      if (stopLossSpread > 0 && spreadPct <= -stopLossSpread) return { close: true, reason: "stop_loss" };
    }
    return { close: false, reason: "" };
  }

  let confirmedClosedCount = 0;
  let anyForceStop = false;
  for (const leg of openLegs) {
    const { close, reason } = legShouldClose(leg);
    if (close || forceStopTriggered) {
      const trigger = forceStopTriggered ? "force_stop" : reason;
      logger.info({ legId: leg.id, symbol: leg.symbol, trigger, spreadPct }, "Bot: close trigger fired");
      const closed = await closeLeg(config, leg, priceA, priceB, trigger);
      if (closed) confirmedClosedCount++;
      if (forceStopTriggered) anyForceStop = true;
    }
  }

  if (anyForceStop) {
    logger.warn({ symbol: config.symbol, totalPnl, forceStopUsd: forceStop }, "Bot: force-stop triggered");
    botEventBus.emitBotEvent({ kind: "force_stop", symbol: config.symbol, totalPnl });
    return;
  }

  if (!canOpen) return;

  const remainingOpen = openLegs.length - confirmedClosedCount;
  const spreadMeetsThreshold = Math.abs(spreadPct) >= enterSpread;
  const belowMaxOrders = remainingOpen < config.maxOrders;

  // Cooldown: require at least 2 watcher ticks (~3 s) between consecutive leg openings
  // so that multiple DCA slots don't all fire in the same burst when conditions are met.
  const lastOpenMs = lastLegOpenedAt.get(config.id) ?? 0;
  const cooldownElapsed = Date.now() - lastOpenMs >= LEG_OPEN_COOLDOWN_MS;

  // Failure back-off: when a previous openLeg() attempt failed (e.g. second-leg auth
  // error), wait 60 s before retrying. Without this the bot hammers the exchange every
  // 1.5 s, continuously opening-then-compensating the first leg.
  const lastFailMs = lastLegFailedAt.get(config.id) ?? 0;
  const failureCooldownElapsed = Date.now() - lastFailMs >= LEG_OPEN_FAILURE_COOLDOWN_MS;

  if (spreadMeetsThreshold && belowMaxOrders && cooldownElapsed && failureCooldownElapsed) {
    const [credsA, credsB] = await Promise.all([
      getCachedCredentials(exchangeA as SupportedExchange),
      getCachedCredentials(exchangeB as SupportedExchange),
    ]);
    if (!credsA || !credsB) {
      logger.warn(
        { symbol: config.symbol, exchangeA, exchangeB, missingA: !credsA, missingB: !credsB },
        "Bot: skipping open — server credentials not synced for exchange pair",
      );
      return;
    }
    const opened = await openLeg(config, spreadPct);
    if (opened) {
      lastLegOpenedAt.set(config.id, Date.now());
    } else {
      lastLegFailedAt.set(config.id, Date.now());
      logger.warn(
        { symbol: config.symbol, backOffMs: LEG_OPEN_FAILURE_COOLDOWN_MS },
        "Bot: leg open failed — backing off before next attempt",
      );
    }
  } else if (spreadMeetsThreshold && belowMaxOrders && !cooldownElapsed) {
    logger.debug(
      { symbol: config.symbol, cooldownRemainingMs: LEG_OPEN_COOLDOWN_MS - (Date.now() - lastOpenMs) },
      "Bot: spread meets threshold but cooldown not elapsed — skipping open this tick",
    );
  } else if (spreadMeetsThreshold && belowMaxOrders && !failureCooldownElapsed) {
    logger.debug(
      { symbol: config.symbol, backOffRemainingMs: LEG_OPEN_FAILURE_COOLDOWN_MS - (Date.now() - lastFailMs) },
      "Bot: spread meets threshold but failure back-off active — skipping open this tick",
    );
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

  // Close all legs in parallel — each closePositionInternal itself fires
  // both exchange orders concurrently, so running N legs in parallel is safe
  // and avoids chaining N × round-trip latencies sequentially.
  const legResults = await Promise.allSettled(
    openLegs.map(async (leg) => {
      const priceRow = getPriceCacheEntry(leg.symbol);
      const priceA = (priceRow ? priceFromCache(priceRow, exchangeA) : null) ?? Number(leg.bybitEntry);
      const priceB = (priceRow ? priceFromCache(priceRow, exchangeB) : null) ?? Number(leg.binanceEntry);

      const result = await closePositionInternal({
        exA,
        exB,
        symbol: leg.symbol,
        sideA: leg.bybitSide as "long" | "short",
        sideB: leg.binanceSide as "long" | "short",
        qtyA: Number(leg.bybitQty),
        qtyB: Number(leg.binanceQty),
        contractSizeB: leg.contractSizeB != null ? Number(leg.contractSizeB) : null,
        spreadAtEntry: Number(leg.spreadAtEntry),
        entryTime: leg.openedAt,
        longExchange: leg.bybitSide === "long" ? exchangeA : exchangeB,
        shortExchange: leg.bybitSide === "short" ? exchangeA : exchangeB,
      });

      return { leg, result, priceA, priceB };
    })
  );

  let closed = 0;
  let failed = 0;

  for (const outcome of legResults) {
    if (outcome.status === "rejected") {
      failed++;
      logger.warn({ err: outcome.reason }, "stop-and-close: leg close threw unexpectedly");
      continue;
    }
    const { leg, result, priceA, priceB } = outcome.value;

    if (result.bothClosed) {
      const closeFees = result.closeFeeA + result.closeFeeB;
      const closePriceA = result.closePriceA ?? priceA;
      const closePriceB = result.closePriceB ?? priceB;
      const realizedPnl = computeLegPnl(leg, closePriceA, closePriceB, closeFees);
      const totalFees = Number(leg.openFeeA ?? 0) + Number(leg.openFeeB ?? 0) + closeFees;
      const spreadAtExit = getSpreadPct(closePriceA, closePriceB);
      await db.update(botLegsTable).set({
        status: "closed",
        closedAt: new Date(),
        spreadAtExit: spreadAtExit != null ? String(spreadAtExit) : undefined,
        realizedPnlUsd: String(realizedPnl),
      }).where(eq(botLegsTable.id, leg.id));
      try {
        await db.insert(closedTradesTable).values({
          symbol: leg.symbol,
          longExchange: leg.bybitSide === "long" ? exchangeA : exchangeB,
          shortExchange: leg.bybitSide === "short" ? exchangeA : exchangeB,
          spreadAtEntry: String(leg.spreadAtEntry),
          enterSpreadThresholdPct: leg.enterSpreadThresholdPct != null ? String(leg.enterSpreadThresholdPct) : undefined,
          spreadAtExit: spreadAtExit != null ? String(spreadAtExit) : undefined,
          closeReason: "manual",
          realizedPnl: String(realizedPnl),
          totalFees: String(totalFees),
          openFees: String(Number(leg.openFeeA ?? 0) + Number(leg.openFeeB ?? 0)),
          quantity: String((Number(leg.bybitQty) * Number(leg.bybitEntry) + Number(leg.binanceQty) * Number(leg.binanceEntry)) / 2),
          entryTime: leg.openedAt,
          closeTime: new Date(),
        });
      } catch {}
      closed++;
      logger.info({ legId: leg.id, symbol: leg.symbol, realizedPnl, totalFees }, "stop-and-close: leg closed");
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
