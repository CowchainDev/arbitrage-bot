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
 * Tracks known credential failures per user+exchange. Key = `${userId}:${exchange}`.
 * Used to deduplicate credential_error events — only the first failure emits an event;
 * subsequent ticks with the same failure are silent. Cleared when credentials succeed.
 */
const credFailures = new Map<string, string>();

function isAuthError(err: unknown): boolean {
  if (err == null) return false;
  const name = (err as { name?: string }).name ?? "";
  const msg = String((err as { message?: string }).message ?? err);
  return (
    name === "AuthenticationError" ||
    name === "PermissionDenied" ||
    /authentication|invalid.?api.?key|api.?key.*(invalid|wrong|bad)|ip.*(whitelist|restrict)|whitelist|forbidden|401|403/i.test(msg)
  );
}

/** Records a credential failure. Returns true only if this is a newly-seen failure (so we emit once). */
function recordCredFailure(userId: string, exchange: string, message: string): boolean {
  const key = `${userId}:${exchange}`;
  const isNew = !credFailures.has(key);
  credFailures.set(key, message);
  return isNew;
}

/** Clears a recorded failure. Returns true if an entry was actually removed (i.e. there was a recorded failure to clear). */
function clearCredFailure(userId: string, exchange: string): boolean {
  const key = `${userId}:${exchange}`;
  if (!credFailures.has(key)) return false;
  credFailures.delete(key);
  return true;
}

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

/**
 * Minimum time a leg must be held open before take-profit is allowed to fire.
 * Prevents phantom-spread closes caused by brief price-cache staleness: if both
 * exchange prices are not simultaneously fresh (they refresh every ~5 s), the
 * computed spread can look like it has collapsed even though no real convergence
 * occurred. Requiring at least 2–3 full cache cycles eliminates those false closes.
 * Stop-loss and force-stop are intentionally exempt — they should fire immediately.
 */
const MIN_LEG_HOLD_MS = 15_000; // 15 s — covers ~3 full price-cache refresh cycles

async function getCachedCredentials(userId: string, exchange: SupportedExchange): Promise<CredEntry | null> {
  const cacheKey = `${userId}:${exchange}`;
  const cached = credCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CRED_CACHE_TTL_MS) {
    return cached.data;
  }
  const fresh = await getStoredCredentials(userId, exchange);
  if (!fresh) {
    credCache.delete(cacheKey);
    return null;
  }
  credCache.set(cacheKey, { data: fresh, ts: Date.now() });
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
  const userId = config.userId;

  const [credsA, credsB] = await Promise.all([
    getCachedCredentials(userId, exchangeA as SupportedExchange),
    getCachedCredentials(userId, exchangeB as SupportedExchange),
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
    if (isAuthError(err)) {
      const msg = String((err as { message?: string }).message ?? err);
      if (recordCredFailure(config.userId, exchangeA, msg)) {
        botEventBus.emitBotEvent({ kind: "credential_error", exchange: exchangeA, message: `${exchangeA} credentials rejected — check API key or IP whitelist` });
      }
    }
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
    // Orders succeeded — clear any prior credential failure records for both exchanges
    // and emit credential_ok so the frontend warning banner clears immediately.
    if (clearCredFailure(config.userId, exchangeA)) {
      botEventBus.emitBotEvent({ kind: "credential_ok", exchange: exchangeA });
    }
    if (clearCredFailure(config.userId, exchangeB)) {
      botEventBus.emitBotEvent({ kind: "credential_ok", exchange: exchangeB });
    }
    return true;
  } catch (err) {
    logger.error({ err, symbol: config.symbol, exchange: exchangeB }, `Bot: ${exchangeB} leg open failed, compensating ${exchangeA}`);
    botEventBus.emitBotEvent({ kind: "leg_open_failed", symbol: config.symbol, exchange: exchangeB, message: String(err) });
    if (isAuthError(err)) {
      const msg = String((err as { message?: string }).message ?? err);
      if (recordCredFailure(config.userId, exchangeB, msg)) {
        botEventBus.emitBotEvent({ kind: "credential_error", exchange: exchangeB, message: `${exchangeB} credentials rejected — check API key or IP whitelist` });
      }
    }
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
  const marketSymbol = `${leg.symbol}/USDT:USDT`;

  // Use actual fill prices from the close orders when available.
  // When the exchange doesn't return a fill price, try to fetch the last
  // traded price via ticker before falling back to the (potentially stale)
  // cache price that triggered the close. Log a warning so the gap is visible.
  let closePriceA = result.closePriceA;
  if (closePriceA == null) {
    let tickerPriceA: number | null = null;
    try {
      const ticker = await exA.fetchTicker(marketSymbol);
      tickerPriceA = (ticker?.last ?? ticker?.info?.markPrice ?? null) as number | null;
    } catch (_) {}
    const source = tickerPriceA != null ? "ticker" : "cache";
    closePriceA = tickerPriceA ?? priceA;
    logger.warn(
      { legId: leg.id, symbol: leg.symbol, closePriceA, source },
      `Bot: exA fill price absent from close order — exit spread price resolved from ${source}`,
    );
  }

  let closePriceB = result.closePriceB;
  if (closePriceB == null) {
    let tickerPriceB: number | null = null;
    try {
      const ticker = await exB.fetchTicker(marketSymbol);
      tickerPriceB = (ticker?.last ?? ticker?.info?.markPrice ?? null) as number | null;
    } catch (_) {}
    const source = tickerPriceB != null ? "ticker" : "cache";
    closePriceB = tickerPriceB ?? priceB;
    logger.warn(
      { legId: leg.id, symbol: leg.symbol, closePriceB, source },
      `Bot: exB fill price absent from close order — exit spread price resolved from ${source}`,
    );
  }

  // Compute per-leg PnL independently: use exchange value when available, spread formula
  // otherwise. Fee policy by source:
  //   - Exchange leg: value used as-is, with NO additional fee subtraction. Each exchange
  //     accounts for fees differently inside its own PnL field (e.g. Bybit's closedPnl is
  //     already net of maker/taker fees). Applying a blanket deduction would cause
  //     systematic drift and double-counting.
  //   - Formula leg: gross price-spread PnL minus the per-leg open and close fees for that
  //     leg only, so the formula path stays self-consistent whether one or both legs fall
  //     back. When both legs are formula-sourced the result equals the old computeLegPnl()
  //     output (rawPnlA + rawPnlB − allOpenFees − allCloseFees).
  const qtyA = Number(leg.bybitQty);
  const qtyB = Number(leg.binanceQty);
  const entryA = Number(leg.bybitEntry);
  const entryB = Number(leg.binanceEntry);

  const rawFormulaPnlA =
    leg.bybitSide === "long"
      ? (closePriceA - entryA) * qtyA
      : (entryA - closePriceA) * qtyA;
  const rawFormulaPnlB =
    leg.binanceSide === "long"
      ? (closePriceB - entryB) * qtyB
      : (entryB - closePriceB) * qtyB;

  const legAPnlSource: "exchange" | "formula" =
    result.exchangeRealizedPnlA != null ? "exchange" : "formula";
  const legBPnlSource: "exchange" | "formula" =
    result.exchangeRealizedPnlB != null ? "exchange" : "formula";

  const pnlA =
    result.exchangeRealizedPnlA != null
      ? result.exchangeRealizedPnlA
      : rawFormulaPnlA - Number(leg.openFeeA ?? 0) - result.closeFeeA;
  const pnlB =
    result.exchangeRealizedPnlB != null
      ? result.exchangeRealizedPnlB
      : rawFormulaPnlB - Number(leg.openFeeB ?? 0) - result.closeFeeB;

  const realizedPnl = pnlA + pnlB;
  const pnlSource: "exchange" | "formula" | "blended" =
    legAPnlSource === legBPnlSource ? legAPnlSource : "blended";

  logger.info(
    {
      legId: leg.id,
      symbol: leg.symbol,
      exchangePnlA: result.exchangeRealizedPnlA,
      exchangePnlB: result.exchangeRealizedPnlB,
      pnlA,
      pnlB,
      legAPnlSource,
      legBPnlSource,
      realizedPnl,
    },
    pnlSource === "exchange"
      ? "Bot: using exchange-reported realized PnL for both legs"
      : pnlSource === "formula"
      ? "Bot: exchange PnL unavailable for both legs — using local spread formula"
      : "Bot: blended PnL — one leg from exchange, one from spread formula",
  );
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
        userId: config.userId,
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
        pnlFromExchange: pnlSource === "exchange",
      }),
    `closeLeg insert closed_trade leg=${leg.id}`,
  );

  logger.info({ legId: leg.id, symbol: leg.symbol, realizedPnl, totalFees, pnlSource }, "Bot: closed leg successfully");
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
    const heldMs = Date.now() - leg.openedAt.getTime();
    const tpAllowed = heldMs >= MIN_LEG_HOLD_MS;
    if (leg.bybitSide === "short") {
      if (spreadPct <= closeSpread && tpAllowed) return { close: true, reason: "take_profit" };
      if (stopLossSpread > 0 && spreadPct >= stopLossSpread) return { close: true, reason: "stop_loss" };
    } else {
      if (spreadPct >= -closeSpread && tpAllowed) return { close: true, reason: "take_profit" };
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

  // ── Early credential check ─────────────────────────────────────────────────
  // Runs on every tick (credentials are cached for 30 s — no DB hit most ticks)
  // so that a "missing credentials" warning surfaces immediately even when the
  // spread has not yet reached the entry threshold.
  const [credsA, credsB] = await Promise.all([
    getCachedCredentials(config.userId, exchangeA as SupportedExchange),
    getCachedCredentials(config.userId, exchangeB as SupportedExchange),
  ]);
  if (!credsA || !credsB) {
    logger.warn(
      { symbol: config.symbol, exchangeA, exchangeB, missingA: !credsA, missingB: !credsB },
      "Bot: skipping open — server credentials not synced for exchange pair",
    );
    if (!credsA && recordCredFailure(config.userId, exchangeA, "API credentials missing")) {
      botEventBus.emitBotEvent({ kind: "credential_error", exchange: exchangeA, message: `${exchangeA} API credentials missing — add them in Settings` });
    }
    if (!credsB && recordCredFailure(config.userId, exchangeB, "API credentials missing")) {
      botEventBus.emitBotEvent({ kind: "credential_error", exchange: exchangeB, message: `${exchangeB} API credentials missing — add them in Settings` });
    }
    return;
  }
  // ──────────────────────────────────────────────────────────────────────────

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
    // Credentials were already verified present above; pass to openLeg via config.
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
      const mktSymbol = `${leg.symbol}/USDT:USDT`;

      let closePriceA = result.closePriceA;
      if (closePriceA == null) {
        let tickerPriceA: number | null = null;
        try {
          const ticker = await exA.fetchTicker(mktSymbol);
          tickerPriceA = (ticker?.last ?? ticker?.info?.markPrice ?? null) as number | null;
        } catch (_) {}
        const sourceA = tickerPriceA != null ? "ticker" : "cache";
        closePriceA = tickerPriceA ?? priceA;
        logger.warn(
          { legId: leg.id, symbol: leg.symbol, closePriceA, source: sourceA },
          `stop-and-close: exA fill price absent — exit spread price resolved from ${sourceA}`,
        );
      }

      let closePriceB = result.closePriceB;
      if (closePriceB == null) {
        let tickerPriceB: number | null = null;
        try {
          const ticker = await exB.fetchTicker(mktSymbol);
          tickerPriceB = (ticker?.last ?? ticker?.info?.markPrice ?? null) as number | null;
        } catch (_) {}
        const sourceB = tickerPriceB != null ? "ticker" : "cache";
        closePriceB = tickerPriceB ?? priceB;
        logger.warn(
          { legId: leg.id, symbol: leg.symbol, closePriceB, source: sourceB },
          `stop-and-close: exB fill price absent — exit spread price resolved from ${sourceB}`,
        );
      }

      // Compute per-leg PnL independently — exchange value if available, formula otherwise.
      // Fee policy: exchange legs are used as-is (exchange PnL already reflects fees in
      // exchange-specific ways); formula legs subtract per-leg open and close fees only.
      // See the closeLeg function comment for full rationale.
      const scQtyA = Number(leg.bybitQty);
      const scQtyB = Number(leg.binanceQty);
      const scEntryA = Number(leg.bybitEntry);
      const scEntryB = Number(leg.binanceEntry);

      const scRawFormulaPnlA =
        leg.bybitSide === "long"
          ? (closePriceA - scEntryA) * scQtyA
          : (scEntryA - closePriceA) * scQtyA;
      const scRawFormulaPnlB =
        leg.binanceSide === "long"
          ? (closePriceB - scEntryB) * scQtyB
          : (scEntryB - closePriceB) * scQtyB;

      const scLegAPnlSource: "exchange" | "formula" =
        result.exchangeRealizedPnlA != null ? "exchange" : "formula";
      const scLegBPnlSource: "exchange" | "formula" =
        result.exchangeRealizedPnlB != null ? "exchange" : "formula";

      const scPnlA =
        result.exchangeRealizedPnlA != null
          ? result.exchangeRealizedPnlA
          : scRawFormulaPnlA - Number(leg.openFeeA ?? 0) - result.closeFeeA;
      const scPnlB =
        result.exchangeRealizedPnlB != null
          ? result.exchangeRealizedPnlB
          : scRawFormulaPnlB - Number(leg.openFeeB ?? 0) - result.closeFeeB;

      const realizedPnl = scPnlA + scPnlB;
      const scPnlSource: "exchange" | "formula" | "blended" =
        scLegAPnlSource === scLegBPnlSource ? scLegAPnlSource : "blended";

      const totalFees = Number(leg.openFeeA ?? 0) + Number(leg.openFeeB ?? 0) + closeFees;
      const spreadAtExit = getSpreadPct(closePriceA, closePriceB);
      await db.update(botLegsTable).set({
        status: "closed",
        closedAt: new Date(),
        spreadAtExit: spreadAtExit != null ? String(spreadAtExit) : undefined,
        realizedPnlUsd: String(realizedPnl),
      }).where(eq(botLegsTable.id, leg.id));
      // pnlFromExchange must be set explicitly here — this path bypasses closeLeg()
      // and has its own DB insert. Without it the row would store NULL, making it
      // indistinguishable from pre-feature historical records.
      // true  → both legs used exchange-reported PnL
      // false → at least one leg fell back to the spread formula (covers "formula" and "blended")
      const pnlFromExchange = scPnlSource === "exchange";
      try {
        await db.insert(closedTradesTable).values({
          userId: botConfig.userId,
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
          pnlFromExchange,
        });
      } catch {}
      closed++;
      logger.info(
        {
          legId: leg.id,
          symbol: leg.symbol,
          exchangePnlA: result.exchangeRealizedPnlA,
          exchangePnlB: result.exchangeRealizedPnlB,
          scLegAPnlSource,
          scLegBPnlSource,
          pnlFromExchange,
          realizedPnl,
          totalFees,
        },
        scPnlSource === "exchange"
          ? "stop-and-close: leg closed — using exchange-reported PnL for both legs"
          : scPnlSource === "formula"
          ? "stop-and-close: leg closed — using spread formula for both legs"
          : "stop-and-close: leg closed — blended PnL (one leg from exchange, one from formula)",
      );
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

  for (const config of botConfigs) {
    for (const exName of [config.exchangeA ?? "bybit", config.exchangeB ?? "binance"]) {
      const creds = await getCachedCredentials(config.userId, exName as SupportedExchange);
      if (!creds) continue;
      if (activePositionsByExchange.has(exName)) continue;
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

/**
 * Pre-warms the in-memory credential cache for all currently enabled bots.
 * Called once on startup so the very first watcher tick has credentials ready
 * instead of hitting the DB cold under load.
 */
async function warmCredentialCache(): Promise<void> {
  const enabledBots = await db
    .select()
    .from(botConfigsTable)
    .where(eq(botConfigsTable.enabled, true));

  if (enabledBots.length === 0) {
    logger.info("Bot watcher: no enabled bots — credential cache warmup skipped");
    return;
  }

  // Deduplicate (userId, exchange) pairs — many bots may share credentials.
  const uniquePairs = new Map<string, { userId: string; exchange: SupportedExchange }>();
  for (const config of enabledBots) {
    const { exchangeA, exchangeB } = botExchangeNames(config);
    for (const ex of [exchangeA, exchangeB]) {
      const key = `${config.userId}:${ex}`;
      if (!uniquePairs.has(key)) {
        uniquePairs.set(key, { userId: config.userId, exchange: ex as SupportedExchange });
      }
    }
  }

  logger.info(
    { bots: enabledBots.length, credentialPairs: uniquePairs.size },
    "Bot watcher: warming credential cache for enabled bots",
  );

  const results = await Promise.allSettled(
    Array.from(uniquePairs.values()).map(({ userId, exchange }) =>
      getCachedCredentials(userId, exchange),
    ),
  );

  const loaded = results.filter(
    (r) => r.status === "fulfilled" && r.value !== null,
  ).length;
  const missing = results.filter(
    (r) => r.status === "fulfilled" && r.value === null,
  ).length;
  const failed = results.filter((r) => r.status === "rejected").length;

  logger.info(
    { loaded, missing, failed },
    "Bot watcher: credential cache warmup complete",
  );
}

function startWatcherLoop(): void {
  const tick = () => {
    watcherTick().finally(() => {
      if (running) watcherTimer = setTimeout(tick, WATCHER_INTERVAL_MS);
    });
  };
  watcherTimer = setTimeout(tick, WATCHER_INTERVAL_MS);
}

/**
 * Probes credentials for every currently-enabled bot immediately on startup.
 * Called after the credential cache is warmed so that auth errors (bad keys,
 * expired secrets, IP whitelist mismatches) surface via credential_error events
 * without waiting for the spread threshold to be reached.
 */
async function probeAllEnabledBotsOnStartup(): Promise<void> {
  const enabledBots = await db
    .select()
    .from(botConfigsTable)
    .where(eq(botConfigsTable.enabled, true));

  if (enabledBots.length === 0) return;

  logger.info(
    { count: enabledBots.length },
    "Bot watcher: probing credentials for all enabled bots on startup",
  );

  await Promise.allSettled(
    enabledBots.map((bot) => probeCredentialsForBot(bot).catch((err) => {
      logger.warn({ err, botId: bot.id }, "Bot watcher: startup credential probe failed");
    })),
  );
}

export function startBotWatcher(): void {
  if (running) return;
  running = true;

  // Price refresh doesn't need credentials — start it immediately.
  startPriceRefreshLoop();

  // Startup sequence:
  //   1. Pre-warm credential cache (DB reads, fast)
  //   2. Probe all enabled bots via fetchBalance (validates API keys, catches
  //      auth errors before any trade is attempted)
  //   3. Start the reconcile and watcher loops only after probing completes
  //
  // Sequencing the probe before startWatcherLoop() ensures that the first
  // watcher tick cannot race against the probe — credential_error events are
  // guaranteed to fire first.
  warmCredentialCache()
    .catch((err) =>
      logger.warn({ err }, "Bot watcher: credential cache warmup failed — continuing without pre-warm"),
    )
    .then(() => probeAllEnabledBotsOnStartup())
    .catch((err) =>
      logger.warn({ err }, "Bot watcher: startup credential probe sweep failed — starting loops anyway"),
    )
    .finally(() => {
      if (!running) return;
      startReconcileLoop();
      startWatcherLoop();
      logger.info("Bot watcher started");
    });
}

/**
 * Probes exchange credentials for a bot immediately on startup by doing a
 * lightweight fetchBalance on each exchange. If credentials are missing or
 * rejected with an auth error, a credential_error event is emitted right away
 * so the frontend can show a warning before the first trade attempt.
 *
 * Non-auth failures (rate limits, network timeouts) are intentionally ignored —
 * they don't indicate bad credentials.
 *
 * Call fire-and-forget: `probeCredentialsForBot(bot).catch(() => {})`.
 */
export async function probeCredentialsForBot(config: BotConfig): Promise<void> {
  const { exchangeA, exchangeB } = botExchangeNames(config);
  const { userId } = config;

  const [credsA, credsB] = await Promise.all([
    getCachedCredentials(userId, exchangeA as SupportedExchange),
    getCachedCredentials(userId, exchangeB as SupportedExchange),
  ]);

  // Each exchange is probed independently so a missing/broken credential on
  // one side never silently prevents the other side from being validated.
  await Promise.allSettled([
    (async () => {
      if (!credsA) {
        if (recordCredFailure(userId, exchangeA, "API credentials missing")) {
          botEventBus.emitBotEvent({ kind: "credential_error", exchange: exchangeA, message: `${exchangeA} API credentials missing — add them in Settings` });
        }
        return;
      }
      try {
        const exA = createExchangeForName(exchangeA, credsA.apiKey, credsA.apiSecret, credsA.passphrase ?? undefined);
        await exA.fetchBalance();
        if (clearCredFailure(userId, exchangeA)) {
          botEventBus.emitBotEvent({ kind: "credential_ok", exchange: exchangeA });
        }
      } catch (err) {
        if (isAuthError(err)) {
          const msg = String((err as { message?: string }).message ?? err);
          logger.warn({ exchange: exchangeA, botId: config.id }, "Bot startup credential probe: auth error");
          if (recordCredFailure(userId, exchangeA, msg)) {
            botEventBus.emitBotEvent({ kind: "credential_error", exchange: exchangeA, message: `${exchangeA} credentials rejected — check API key or IP whitelist` });
          }
        }
        // Non-auth errors (rate limit, network) are not flagged —
        // they don't indicate bad credentials.
      }
    })(),
    (async () => {
      if (!credsB) {
        if (recordCredFailure(userId, exchangeB, "API credentials missing")) {
          botEventBus.emitBotEvent({ kind: "credential_error", exchange: exchangeB, message: `${exchangeB} API credentials missing — add them in Settings` });
        }
        return;
      }
      try {
        const exB = createExchangeForName(exchangeB, credsB.apiKey, credsB.apiSecret, credsB.passphrase ?? undefined);
        await exB.fetchBalance();
        if (clearCredFailure(userId, exchangeB)) {
          botEventBus.emitBotEvent({ kind: "credential_ok", exchange: exchangeB });
        }
      } catch (err) {
        if (isAuthError(err)) {
          const msg = String((err as { message?: string }).message ?? err);
          logger.warn({ exchange: exchangeB, botId: config.id }, "Bot startup credential probe: auth error");
          if (recordCredFailure(userId, exchangeB, msg)) {
            botEventBus.emitBotEvent({ kind: "credential_error", exchange: exchangeB, message: `${exchangeB} credentials rejected — check API key or IP whitelist` });
          }
        }
      }
    })(),
  ]);
}

/** Returns all currently recorded credential failures for a given user. */
export function getCredentialFailuresForUser(userId: string): Array<{ exchange: string; message: string }> {
  const result: Array<{ exchange: string; message: string }> = [];
  for (const [key, message] of credFailures.entries()) {
    const colonIdx = key.indexOf(":");
    if (colonIdx === -1) continue;
    const storedUserId = key.slice(0, colonIdx);
    const exchange = key.slice(colonIdx + 1);
    if (storedUserId === userId) {
      result.push({ exchange, message });
    }
  }
  return result;
}

export function stopBotWatcher(): void {
  running = false;
  if (watcherTimer) { clearTimeout(watcherTimer); watcherTimer = null; }
  if (priceRefreshTimer) { clearTimeout(priceRefreshTimer); priceRefreshTimer = null; }
  if (reconcileTimer) { clearTimeout(reconcileTimer); reconcileTimer = null; }
  logger.info("Bot watcher stopped");
}
