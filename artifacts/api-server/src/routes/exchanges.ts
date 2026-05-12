import { Router, type IRouter, type Request, type Response } from "express";
import ccxt from "ccxt";
import { requireBotSecret } from "../middleware/auth";
import {
  PlaceOrderBody,
  ClosePositionBody,
  JumpInBody,
  CANDLE_LIMIT_BY_INTERVAL,
} from "@workspace/api-zod";
import { db } from "@workspace/db";
import { closedTradesTable, botLegsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import {
  asterFetchTicker,
  asterFetchMarketStepSize,
  asterFetchBalance,
  asterPlaceOrder,
  asterClosePosition,
  asterSetLeverage,
  roundToStepSize,
} from "../lib/aster-client";

const router: IRouter = Router();

let priceCache: { data: unknown[]; ts: number } | null = null;
let priceFetchInFlight: Promise<unknown[]> | null = null;
const PRICE_CACHE_TTL_MS = 9_000;

type KlinesCacheEntry = { data: Record<string, { t: number; c: number }[]>; ts: number };
const klinesCache = new Map<string, KlinesCacheEntry>();
const KLINES_TTL_SHORT_MS = 2 * 60 * 1000;
const KLINES_TTL_LONG_MS  = 10 * 60 * 1000;
const KLINES_CACHE_MAX_SIZE = 200;
const KLINES_CACHE_SWEEP_MS = 5 * 60 * 1000;

function evictKlinesCacheIfNeeded(): void {
  if (klinesCache.size <= KLINES_CACHE_MAX_SIZE) return;
  const toRemove = klinesCache.size - KLINES_CACHE_MAX_SIZE;
  const entries = [...klinesCache.entries()].sort((a, b) => a[1].ts - b[1].ts);
  for (let i = 0; i < toRemove; i++) {
    klinesCache.delete(entries[i][0]);
  }
}

function sweepExpiredKlinesCache(): void {
  const now = Date.now();
  for (const [key, entry] of klinesCache.entries()) {
    const interval = key.split(":")[1] ?? "1h";
    const ttl = getKlinesCacheTtl(interval);
    if (now - entry.ts > ttl) {
      klinesCache.delete(key);
    }
  }
}

setInterval(sweepExpiredKlinesCache, KLINES_CACHE_SWEEP_MS).unref();

const symbolHitCounts = new Map<string, number>();
const SYMBOL_HIT_COUNT_MAX = 500;

export function recordKlinesHit(symbol: string): void {
  symbolHitCounts.set(symbol, (symbolHitCounts.get(symbol) ?? 0) + 1);
  if (symbolHitCounts.size > SYMBOL_HIT_COUNT_MAX) {
    const entries = [...symbolHitCounts.entries()].sort((a, b) => a[1] - b[1]);
    const toRemove = entries.slice(0, Math.floor(SYMBOL_HIT_COUNT_MAX * 0.1));
    for (const [sym] of toRemove) symbolHitCounts.delete(sym);
  }
}

function getKlinesCacheTtl(interval: string): number {
  if (interval === "4h" || interval === "1d") return KLINES_TTL_LONG_MS;
  if (interval === "1m") return 30_000;
  if (interval === "5m") return 60_000;
  return KLINES_TTL_SHORT_MS;
}

export const PREWARM_SYMBOLS = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE"];
export const PREWARM_INTERVALS = ["15m", "1h", "4h", "1d"];
const PREWARM_CONCURRENCY = 10;
const PREWARM_TOP_N = 10;
const KLINES_TIMEOUT_MS = 4000;
const RELAY_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// Direct REST fetch helpers (no ccxt) — used by the relay endpoint and as
// fallback when KLINES_RELAY_URL is configured.
// These functions return { t: ms, c: closePrice }[] sorted oldest-first.
// ---------------------------------------------------------------------------

type OhlcvPoint = { t: number; o: number; h: number; l: number; c: number };

async function fetchBinanceOhlcvDirect(symbol: string, interval: string, limit: number): Promise<OhlcvPoint[]> {
  const intervalMap: Record<string, string> = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" };
  const tf = intervalMap[interval] ?? "1h";
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}USDT&interval=${tf}&limit=${Math.min(limit, 500)}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`Binance HTTP ${resp.status}`);
  const rows = await resp.json() as [number, string, string, string, string, ...unknown[]][];
  return rows.map((r) => ({ t: r[0], o: parseFloat(r[1]), h: parseFloat(r[2]), l: parseFloat(r[3]), c: parseFloat(r[4]) })).filter((p) => p.t > 0 && p.c > 0);
}

async function fetchBybitOhlcvDirect(symbol: string, interval: string, limit: number): Promise<OhlcvPoint[]> {
  const intervalMap: Record<string, string> = { "1m": "1", "5m": "5", "15m": "15", "1h": "60", "4h": "240", "1d": "D" };
  const tf = intervalMap[interval] ?? "60";
  const clampedLimit = Math.min(limit, 200);
  const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}USDT&interval=${tf}&limit=${clampedLimit}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`Bybit HTTP ${resp.status}`);
  type BybitResp = { retCode: number; result: { list: [string, string, string, string, string, ...unknown[]][] } };
  const json = await resp.json() as BybitResp;
  if (json.retCode !== 0) throw new Error(`Bybit retCode ${json.retCode}`);
  return json.result.list
    .map((r) => ({ t: parseInt(r[0], 10), o: parseFloat(r[1]), h: parseFloat(r[2]), l: parseFloat(r[3]), c: parseFloat(r[4]) }))
    .filter((p) => p.t > 0 && p.c > 0)
    .reverse();
}

async function fetchGateOhlcvDirect(symbol: string, interval: string, limit: number): Promise<OhlcvPoint[]> {
  const intervalMap: Record<string, string> = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" };
  const tf = intervalMap[interval] ?? "1h";
  const contract = `${symbol}_USDT`;
  const url = `https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${contract}&interval=${tf}&limit=${Math.min(limit, 2000)}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`Gate HTTP ${resp.status}`);
  type GateCandle = { t: number; o: string; h: string; l: string; c: string };
  const rows = await resp.json() as GateCandle[];
  return rows.map((r) => ({ t: r.t * 1000, o: parseFloat(r.o), h: parseFloat(r.h), l: parseFloat(r.l), c: parseFloat(r.c) })).filter((p) => p.t > 0 && p.c > 0);
}

async function fetchOkxOhlcvDirect(symbol: string, interval: string, limit: number): Promise<OhlcvPoint[]> {
  const intervalMap: Record<string, string> = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D" };
  const bar = intervalMap[interval] ?? "1H";
  const instId = `${symbol}-USDT-SWAP`;
  const OKX_MAX = 100;
  const points: OhlcvPoint[] = [];

  let after: string | undefined;
  let remaining = Math.min(limit, 500);

  while (remaining > 0) {
    const batchSize = Math.min(remaining, OKX_MAX);
    let url = `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${batchSize}`;
    if (after) url += `&after=${after}`;

    const resp = await fetch(url, { signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) });
    if (!resp.ok) throw new Error(`OKX HTTP ${resp.status}`);
    type OkxResp = { data: [string, string, string, string, string, ...unknown[]][] };
    const json = await resp.json() as OkxResp;
    if (!json.data || json.data.length === 0) break;

    const batch = json.data.map((r) => ({ t: parseInt(r[0], 10), o: parseFloat(r[1]), h: parseFloat(r[2]), l: parseFloat(r[3]), c: parseFloat(r[4]) })).filter((p) => p.t > 0 && p.c > 0);
    points.unshift(...batch);
    remaining -= batch.length;
    if (batch.length < batchSize) break;
    after = String(json.data[json.data.length - 1][0]);
  }

  return points;
}

async function fetchMexcOhlcvDirect(symbol: string, interval: string, limit: number): Promise<OhlcvPoint[]> {
  const intervalMap: Record<string, string> = { "1m": "Min1", "5m": "Min5", "15m": "Min15", "1h": "Min60", "4h": "Hour4", "1d": "Day1" };
  const tf = intervalMap[interval] ?? "Min60";
  const intervalMs: Record<string, number> = { "1m": 60_000, "5m": 5 * 60_000, "15m": 15 * 60_000, "1h": 60 * 60_000, "4h": 4 * 60 * 60_000, "1d": 24 * 60 * 60_000 };
  const msPerCandle = intervalMs[interval] ?? 60 * 60_000;
  const end = Date.now();
  const start = end - msPerCandle * Math.min(limit, 2000);
  const contract = `${symbol}_USDT`;
  const url = `https://contract.mexc.com/api/v1/contract/kline/${contract}?interval=${tf}&start=${Math.floor(start / 1000)}&end=${Math.floor(end / 1000)}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`MEXC HTTP ${resp.status}`);
  type MexcResp = { success: boolean; data: { time: number[]; open: number[]; high: number[]; low: number[]; close: number[] } };
  const json = await resp.json() as MexcResp;
  if (!json.success || !json.data) throw new Error("MEXC response error");
  return json.data.time
    .map((t, i) => ({ t: t * 1000, o: json.data.open[i], h: json.data.high[i], l: json.data.low[i], c: json.data.close[i] }))
    .filter((p) => p.t > 0 && p.c > 0);
}

async function fetchAsterOhlcvDirect(symbol: string, interval: string, limit: number): Promise<OhlcvPoint[]> {
  const intervalMap: Record<string, string> = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" };
  const tf = intervalMap[interval] ?? "1h";
  const url = `https://fapi.asterdex.com/fapi/v1/klines?symbol=${symbol}USDT&interval=${tf}&limit=${Math.min(limit, 500)}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`AsterDex HTTP ${resp.status}`);
  const rows = await resp.json() as [number, string, string, string, string, ...unknown[]][];
  return rows.map((r) => ({ t: r[0], o: parseFloat(r[1]), h: parseFloat(r[2]), l: parseFloat(r[3]), c: parseFloat(r[4]) })).filter((p) => p.t > 0 && p.c > 0);
}

async function fetchHyperLiquidOhlcvDirect(symbol: string, interval: string, limit: number): Promise<OhlcvPoint[]> {
  const intervalMap: Record<string, string> = { "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" };
  const hlInterval = intervalMap[interval] ?? "1h";
  const intervalMs: Record<string, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };
  const msPer = intervalMs[interval] ?? 3_600_000;
  const endTime = Date.now();
  const startTime = endTime - msPer * Math.min(limit, 500);
  const resp = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "candleSnapshot", req: { coin: symbol, interval: hlInterval, startTime, endTime } }),
    signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`HyperLiquid OHLCV HTTP ${resp.status}`);
  type HLCandle = { t: number; o: string; h: string; l: string; c: string };
  const rows = await resp.json() as HLCandle[];
  return rows.map((r) => ({ t: r.t, o: parseFloat(r.o), h: parseFloat(r.h), l: parseFloat(r.l), c: parseFloat(r.c) })).filter((p) => p.t > 0 && p.c > 0);
}

type HyperTickerEntry = { last: number; bid: number; ask: number; quoteVolume: number };
type HyperFundingEntry = { fundingRate: number; fundingDatetime: string };

async function fetchHyperLiquidMarketData(timeoutMs: number): Promise<{
  tickerMap: Map<string, HyperTickerEntry>;
  fundingMap: Map<string, HyperFundingEntry>;
}> {
  type HyperAssetCtx = {
    funding: string;
    dayNtlVlm: string;
    markPx: string;
    midPx: string | null;
    impactPxs: [string, string] | null;
  };
  type HyperMeta = { universe: Array<{ name: string }> };
  const resp = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error(`HyperLiquid market data HTTP ${resp.status}`);
  const [meta, assetCtxs] = await resp.json() as [HyperMeta, HyperAssetCtx[]];
  const nextFundingMs = Math.ceil(Date.now() / 3_600_000) * 3_600_000;
  const nextFundingDatetime = new Date(nextFundingMs).toISOString();
  const tickerMap = new Map<string, HyperTickerEntry>();
  const fundingMap = new Map<string, HyperFundingEntry>();
  meta.universe.forEach((coin, i) => {
    const ctx = assetCtxs[i];
    if (!ctx) return;
    const price = parseFloat(ctx.markPx || ctx.midPx || "0");
    if (!price) return;
    const bid = ctx.impactPxs ? parseFloat(ctx.impactPxs[0]) : price;
    const ask = ctx.impactPxs ? parseFloat(ctx.impactPxs[1]) : price;
    const quoteVolume = parseFloat(ctx.dayNtlVlm || "0");
    const fundingRate = parseFloat(ctx.funding || "0");
    tickerMap.set(coin.name, { last: price, bid, ask, quoteVolume });
    fundingMap.set(coin.name, { fundingRate, fundingDatetime: nextFundingDatetime });
  });
  return { tickerMap, fundingMap };
}

const DIRECT_FETCHERS: Record<string, (symbol: string, interval: string, limit: number) => Promise<OhlcvPoint[]>> = {
  binance: fetchBinanceOhlcvDirect,
  bybit:   fetchBybitOhlcvDirect,
  gate:    fetchGateOhlcvDirect,
  okx:     fetchOkxOhlcvDirect,
  mexc:    fetchMexcOhlcvDirect,
  aster:   fetchAsterOhlcvDirect,
  hyper:   fetchHyperLiquidOhlcvDirect,
};

// ---------------------------------------------------------------------------
// Relay fetcher: try KLINES_RELAY_URL for a single exchange, returns null on
// failure so the caller can fall back to ccxt.
// ---------------------------------------------------------------------------

async function fetchViaRelay(
  relayUrl: string,
  exchange: string,
  symbol: string,
  interval: string,
  limit: number,
): Promise<OhlcvPoint[] | null> {
  try {
    const url = new URL(relayUrl);
    url.searchParams.set("exchange", exchange);
    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("limit", String(limit));
    const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) });
    if (!resp.ok) return null;
    const data = await resp.json() as OhlcvPoint[];
    if (!Array.isArray(data) || data.length === 0) return null;
    return data;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Core per-exchange fetch.
// Strategy when KLINES_RELAY_URL is set:
//   relay → ccxt fallback (skip direct REST to avoid double timeouts)
// Strategy without relay:
//   direct REST → ccxt fallback
// ---------------------------------------------------------------------------
async function fetchExchangeKlines(
  exchangeName: string,
  symbol: string,
  interval: string,
  limit: number,
  ccxtFallback: () => Promise<OhlcvPoint[]>,
): Promise<OhlcvPoint[]> {
  const relayUrl = process.env.KLINES_RELAY_URL;

  if (relayUrl) {
    const relayData = await fetchViaRelay(relayUrl, exchangeName, symbol, interval, limit);
    if (relayData && relayData.length > 0) return relayData;
    // relay failed — try direct REST before ccxt
  }

  const directFetcher = DIRECT_FETCHERS[exchangeName];
  if (directFetcher) {
    try {
      const directData = await directFetcher(symbol, interval, limit);
      if (directData.length > 0) return directData;
    } catch {
      // fall through to ccxt
    }
  }

  return ccxtFallback();
}

async function fetchKlinesForSymbol(
  symbol: string,
  interval: string,
  limit: number
): Promise<void> {
  const cacheKey = `${symbol}:${interval}:${limit}`;
  const cached = klinesCache.get(cacheKey);
  const ttl = getKlinesCacheTtl(interval);
  if (cached && Date.now() - cached.ts < ttl) return;

  const ccxtSymbol = `${symbol}/USDT:USDT`;
  const timeframeMap: Record<string, string> = {
    "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d",
  };
  const timeframe = timeframeMap[interval] ?? "1h";

  type OhlcvRow = [number, number, number, number, number, number?];

  const exchangeDefs = [
    { name: "bybit",   create: () => createBybitExchange() },
    { name: "binance", create: () => createBinanceExchange() },
    { name: "gate",    create: () => createGateExchange() },
    { name: "okx",     create: () => createOkxExchange() },
    { name: "mexc",    create: () => createMexcExchange() },
    { name: "aster",   create: () => createAsterExchange() },
    { name: "hyper",   create: () => createHyperLiquidExchange() },
  ];

  const results = await Promise.allSettled(
    exchangeDefs.map(async ({ name, create }) => {
      const data = await fetchExchangeKlines(name, symbol, interval, limit, async () => {
        const ex = create();
        const raw = await Promise.race([
          ex.fetchOHLCV(ccxtSymbol, timeframe, undefined, limit) as Promise<OhlcvRow[]>,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("klines timeout")), KLINES_TIMEOUT_MS)
          ),
        ]);
        return raw.map((row) => ({ t: row[0], o: row[1], h: row[2], l: row[3], c: row[4] })).filter((p) => p.t > 0 && p.c > 0);
      });
      return { name, data };
    })
  );

  const out: Record<string, OhlcvPoint[]> = {};
  for (const result of results) {
    if (result.status === "fulfilled" && result.value.data.length > 0) {
      out[result.value.name] = result.value.data;
    }
  }

  if (Object.keys(out).length > 0) {
    klinesCache.set(cacheKey, { data: out, ts: Date.now() });
    evictKlinesCacheIfNeeded();
  }
}

export const KLINES_PREWARM_INTERVAL_MS = KLINES_TTL_SHORT_MS;

function getTopSymbolsByVolume(n: number): string[] {
  if (!priceCache || priceCache.data.length === 0) return PREWARM_SYMBOLS.slice(0, n);

  type PriceRow = { symbol: string; volume24h?: number };
  const rows = priceCache.data as PriceRow[];

  const eligible = rows.filter((r) => typeof r.volume24h === "number" && r.volume24h > 0);

  const byVolume = [...eligible].sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0));
  const volumeRank = new Map<string, number>(byVolume.map((r, i) => [r.symbol, i]));

  const byHits = [...eligible].sort(
    (a, b) => (symbolHitCounts.get(b.symbol) ?? 0) - (symbolHitCounts.get(a.symbol) ?? 0)
  );
  const hitRank = new Map<string, number>(byHits.map((r, i) => [r.symbol, i]));

  const totalSymbols = eligible.length || 1;
  const blended = eligible
    .map((r) => {
      const vr = (volumeRank.get(r.symbol) ?? totalSymbols) / totalSymbols;
      const hr = (hitRank.get(r.symbol) ?? totalSymbols) / totalSymbols;
      const hasHits = (symbolHitCounts.get(r.symbol) ?? 0) > 0;
      const score = hasHits ? 0.4 * vr + 0.6 * hr : vr;
      return { symbol: r.symbol, score };
    })
    .sort((a, b) => a.score - b.score);

  const anchors = new Set(PREWARM_SYMBOLS);
  const top = blended.map((r) => r.symbol);

  const result: string[] = [...PREWARM_SYMBOLS];
  for (const sym of top) {
    if (result.length >= n) break;
    if (!anchors.has(sym)) result.push(sym);
  }
  return result.slice(0, n);
}

export async function prewarmKlinesCache(): Promise<{ succeeded: number; failed: number; symbols: string[] }> {
  const symbols = getTopSymbolsByVolume(PREWARM_TOP_N);

  const pairs = symbols.flatMap((symbol) =>
    PREWARM_INTERVALS.map((interval) => ({ symbol, interval }))
  );

  // Process in small batches to limit concurrent CCXT object creation and avoid OOM
  const results: PromiseSettledResult<void>[] = [];
  for (let i = 0; i < pairs.length; i += PREWARM_CONCURRENCY) {
    const batch = pairs.slice(i, i + PREWARM_CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(({ symbol, interval }) => fetchKlinesForSymbol(symbol, interval, CANDLE_LIMIT_BY_INTERVAL[interval] ?? 96))
    );
    results.push(...batchResults);
  }

  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.length - succeeded;

  return { succeeded, failed, symbols };
}

type SymbolPriceEntry = {
  bybitPrice: number | null;
  binancePrice: number | null;
  mexcPrice: number | null;
  gatePrice: number | null;
  okxPrice: number | null;
  asterPrice: number | null;
  hyperPrice: number | null;
};
const priceCacheBySymbol = new Map<string, SymbolPriceEntry>();

export type SymbolFundingEntry = {
  bybitFundingRate: number | null;
  binanceFundingRate: number | null;
  gateFundingRate: number | null;
  okxFundingRate: number | null;
  mexcFundingRate: number | null;
  asterFundingRate: number | null;
  hyperFundingRate: number | null;
  bybitNextFunding: string | null;
  binanceNextFunding: string | null;
  gateNextFunding: string | null;
  okxNextFunding: string | null;
  mexcNextFunding: string | null;
  asterNextFunding: string | null;
  hyperNextFunding: string | null;
};
const fundingRateCacheBySymbol = new Map<string, SymbolFundingEntry>();

export function getFundingRateEntry(symbol: string): SymbolFundingEntry | null {
  return fundingRateCacheBySymbol.get(symbol) ?? null;
}

/** Funding settlement interval in ms per exchange. HyperLiquid settles every 1h; all others 8h. */
export const FUNDING_INTERVAL_MS: Record<string, number> = {
  bybit:   28_800_000,
  binance: 28_800_000,
  gate:    28_800_000,
  okx:     28_800_000,
  mexc:    28_800_000,
  aster:   28_800_000,
  hyper:    3_600_000,
};

/**
 * Counts how many funding settlement boundaries have passed strictly after
 * openedAt and up to (including) now for a given interval length.
 */
export function countSettledFundingIntervals(openedAtMs: number, nowMs: number, intervalMs = 28_800_000): number {
  const kFirst = Math.floor(openedAtMs / intervalMs) + 1;
  const kLast  = Math.floor(nowMs / intervalMs);
  return Math.max(0, kLast - kFirst + 1);
}

export function getFundingRateForExchange(entry: SymbolFundingEntry, exchange: string): number {
  switch (exchange) {
    case "bybit":   return entry.bybitFundingRate   ?? 0;
    case "binance": return entry.binanceFundingRate ?? 0;
    case "gate":    return entry.gateFundingRate    ?? 0;
    case "okx":     return entry.okxFundingRate     ?? 0;
    case "mexc":    return entry.mexcFundingRate    ?? 0;
    case "aster":   return entry.asterFundingRate   ?? 0;
    case "hyper":   return entry.hyperFundingRate   ?? 0;
    default:        return 0;
  }
}

// EMA of bestSpreadPct per symbol. α ≈ 0.006 → ~10-minute half-life at 5s refresh.
const SPREAD_EMA_ALPHA = 0.006;
const spreadEmaMap = new Map<string, number>();

export function getPriceCacheEntry(symbol: string): SymbolPriceEntry | null {
  return priceCacheBySymbol.get(symbol) ?? null;
}

const MIN_VOLUME_USD = 500_000;
const MAX_RESULTS = 150;

function extractBase(unifiedSymbol: string): string | null {
  const match = unifiedSymbol.match(/^([^/]+)\/USDT:USDT$/);
  return match ? match[1] : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildTickerMap(raw: Record<string, any>): Map<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = new Map<string, any>();
  for (const [sym, t] of Object.entries(raw)) {
    const base = extractBase(sym);
    if (base && (t.last ?? t.bid ?? 0) > 0) m.set(base, t);
  }
  return m;
}

// Tight timeout for price-scan fetches — fail fast so the dashboard stays responsive.
const PRICE_FETCH_TIMEOUT_MS = 8000;

/**
 * Races a promise against a hard wall-clock timeout.
 * Unlike CCXT's own timeout (which only covers connect), this terminates
 * slow responses (e.g. MEXC returning thousands of swap pairs) within ms.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

async function fetchAndCachePrices(): Promise<unknown[]> {
  const bybit   = createBybitExchange();   bybit.timeout   = PRICE_FETCH_TIMEOUT_MS;
  const binance = createBinanceExchange(); binance.timeout = PRICE_FETCH_TIMEOUT_MS;
  const gate    = createGateExchange();    gate.timeout    = PRICE_FETCH_TIMEOUT_MS;
  const okx     = createOkxExchange();     okx.timeout     = PRICE_FETCH_TIMEOUT_MS;
  const mexc    = createMexcExchange();    mexc.timeout    = PRICE_FETCH_TIMEOUT_MS;
  const aster   = createAsterExchange();   aster.timeout   = PRICE_FETCH_TIMEOUT_MS;

  const T = PRICE_FETCH_TIMEOUT_MS;

  const [
    bybitTickers, binanceTickers, gateTickers, okxTickers, mexcTickers, asterTickers,
    bybitFunding, binanceFunding, gateFunding, okxFunding, mexcFunding, asterFunding,
    bybitOIResult, binanceOIResult, gateOIResult, okxOIResult,
    hyperDataResult,
  ] = await Promise.allSettled([
    withTimeout(bybit.fetchTickers(undefined, { type: "linear" }), T, "bybit tickers"),
    withTimeout(binance.fetchTickers(undefined, { type: "future" }), T, "binance tickers"),
    withTimeout(gate.fetchTickers(undefined, { type: "swap" }), T, "gate tickers"),
    withTimeout(okx.fetchTickers(undefined, { type: "swap" }), T, "okx tickers"),
    withTimeout(mexc.fetchTickers(undefined, { type: "swap" }), T, "mexc tickers"),
    withTimeout(aster.fetchTickers(undefined, { type: "future" }), T, "aster tickers"),
    withTimeout(bybit.fetchFundingRates(), T, "bybit funding"),
    withTimeout(binance.fetchFundingRates(), T, "binance funding"),
    withTimeout(gate.fetchFundingRates(), T, "gate funding"),
    withTimeout(okx.fetchFundingRates(), T, "okx funding"),
    withTimeout(mexc.fetchFundingRates(), T, "mexc funding"),
    withTimeout(aster.fetchFundingRates(), T, "aster funding"),
    withTimeout(bybit.fetchOpenInterests(undefined, { type: "linear" }), T, "bybit OI"),
    withTimeout(binance.fetchOpenInterests(undefined, { type: "future" }), T, "binance OI"),
    withTimeout(gate.fetchOpenInterests(undefined, { type: "swap" }), T, "gate OI"),
    withTimeout(okx.fetchOpenInterests(undefined, { type: "swap" }), T, "okx OI"),
    withTimeout(fetchHyperLiquidMarketData(T), T, "hyperliquid market data"),
  ]);

  const bybitMap   = buildTickerMap(bybitTickers.status   === "fulfilled" ? bybitTickers.value   : {});
  const binanceMap = buildTickerMap(binanceTickers.status === "fulfilled" ? binanceTickers.value : {});
  const gateMap    = buildTickerMap(gateTickers.status    === "fulfilled" ? gateTickers.value    : {});
  const okxMap     = buildTickerMap(okxTickers.status     === "fulfilled" ? okxTickers.value     : {});
  const mexcMap    = buildTickerMap(mexcTickers.status    === "fulfilled" ? mexcTickers.value    : {});
  const asterMap   = buildTickerMap(asterTickers.status   === "fulfilled" ? asterTickers.value   : {});
  const hyperTickerMap = hyperDataResult.status === "fulfilled" ? hyperDataResult.value.tickerMap : new Map<string, HyperTickerEntry>();
  const hyperFundingMap = hyperDataResult.status === "fulfilled" ? hyperDataResult.value.fundingMap : new Map<string, HyperFundingEntry>();

  const bybitFundingMap  = bybitFunding.status  === "fulfilled" ? bybitFunding.value  : {};
  const binanceFundingMap = binanceFunding.status === "fulfilled" ? binanceFunding.value : {};
  const gateFundingMap   = gateFunding.status   === "fulfilled" ? gateFunding.value   : {};
  const okxFundingMap    = okxFunding.status    === "fulfilled" ? okxFunding.value    : {};
  const mexcFundingMap   = mexcFunding.status   === "fulfilled" ? mexcFunding.value   : {};
  const asterFundingMap  = asterFunding.status  === "fulfilled" ? asterFunding.value  : {};

  // Build OI maps: key = base symbol (e.g. "BTC"), value = OI in USD
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function buildOIMap(raw: Record<string, any>): Map<string, number> {
    const m = new Map<string, number>();
    for (const [sym, entry] of Object.entries(raw)) {
      const base = extractBase(sym);
      if (!base) continue;
      const usd =
        (typeof entry?.openInterestValue === "number" && entry.openInterestValue > 0)
          ? entry.openInterestValue
          : (typeof entry?.openInterestAmount === "number" && entry.openInterestAmount > 0 && typeof entry?.markPrice === "number")
            ? entry.openInterestAmount * entry.markPrice
            : 0;
      if (usd > 0) m.set(base, usd);
    }
    return m;
  }
  const bybitOIMap   = bybitOIResult.status   === "fulfilled" ? buildOIMap(bybitOIResult.value   ?? {}) : new Map<string, number>();
  const binanceOIMap = binanceOIResult.status === "fulfilled" ? buildOIMap(binanceOIResult.value ?? {}) : new Map<string, number>();
  const gateOIMap    = gateOIResult.status    === "fulfilled" ? buildOIMap(gateOIResult.value    ?? {}) : new Map<string, number>();
  const okxOIMap     = okxOIResult.status     === "fulfilled" ? buildOIMap(okxOIResult.value     ?? {}) : new Map<string, number>();

  const allBases = new Set([
    ...bybitMap.keys(), ...binanceMap.keys(), ...gateMap.keys(),
    ...okxMap.keys(), ...mexcMap.keys(), ...asterMap.keys(),
    ...hyperTickerMap.keys(),
  ]);

  // ── Pass 1: compute all spread info except depth ─────────────────────────
  // We need best-spread legs before we know which MEXC symbols need orderbooks.
  interface PassOneEntry {
    base: string;
    key: string;
    bybitT:   ReturnType<typeof bybitMap.get>;
    binanceT: ReturnType<typeof binanceMap.get>;
    gateT:    ReturnType<typeof gateMap.get>;
    okxT:     ReturnType<typeof okxMap.get>;
    mexcT:    ReturnType<typeof mexcMap.get>;
    asterT:   ReturnType<typeof asterMap.get>;
    hyperT:   HyperTickerEntry | undefined;
    bybitPriceC: number; binancePriceC: number; gatePriceC: number;
    okxPriceC: number;   mexcPriceC: number;    asterPriceC: number;
    hyperPriceC: number;
    spreadPct: number;
    bestSpreadPct: number;
    bestSpreadLeg: string | null;
    emaSpreadPct: number;
    openInterestUsd: number | null;
    totalVolume: number;
    needsMexcOb: boolean;
  }
  const passOne: PassOneEntry[] = [];

  for (const base of allBases) {
    const key = `${base}/USDT:USDT`;

    const bybitT   = bybitMap.get(base);
    const binanceT = binanceMap.get(base);
    const gateT    = gateMap.get(base);
    const okxT     = okxMap.get(base);
    const mexcT    = mexcMap.get(base);
    const asterT   = asterMap.get(base);
    const hyperT   = hyperTickerMap.get(base);

    const bybitPrice   = bybitT   ? (bybitT.last   ?? bybitT.bid   ?? 0) : 0;
    const binancePrice = binanceT ? (binanceT.last  ?? binanceT.bid ?? 0) : 0;
    const gatePrice    = gateT    ? (gateT.last     ?? gateT.bid    ?? 0) : 0;
    const okxPrice     = okxT     ? (okxT.last      ?? okxT.bid     ?? 0) : 0;
    const mexcPrice    = mexcT    ? (mexcT.last      ?? mexcT.bid    ?? 0) : 0;
    const asterPrice   = asterT   ? (asterT.last     ?? asterT.bid   ?? 0) : 0;
    const hyperPrice   = hyperT   ? hyperT.last : 0;

    const rawPriceList = [bybitPrice, binancePrice, gatePrice, okxPrice, mexcPrice, asterPrice, hyperPrice];
    const livePrices = rawPriceList.filter(p => p > 0);
    if (livePrices.length < 2) continue;

    // Median outlier filter: discard any exchange price that deviates >10% from
    // the median across all live prices (catches bad ccxt mappings / wrong contracts)
    const sorted = [...livePrices].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
    const OUTLIER_PCT = 0.10;
    const clean = (p: number) => p > 0 && Math.abs(p - median) / median <= OUTLIER_PCT ? p : 0;
    const bybitPriceC   = clean(bybitPrice);
    const binancePriceC = clean(binancePrice);
    const gatePriceC    = clean(gatePrice);
    const okxPriceC     = clean(okxPrice);
    const mexcPriceC    = clean(mexcPrice);
    const asterPriceC   = clean(asterPrice);
    const hyperPriceC   = clean(hyperPrice);

    const cleanPrices = [bybitPriceC, binancePriceC, gatePriceC, okxPriceC, mexcPriceC, asterPriceC, hyperPriceC];
    if (cleanPrices.filter(p => p > 0).length < 2) continue;

    const totalVolume =
      (bybitT?.quoteVolume ?? 0) + (binanceT?.quoteVolume ?? 0) +
      (gateT?.quoteVolume ?? 0) + (okxT?.quoteVolume ?? 0) + (mexcT?.quoteVolume ?? 0) +
      (asterT?.quoteVolume ?? 0) + (hyperT?.quoteVolume ?? 0);
    if (totalVolume < MIN_VOLUME_USD) continue;

    const spreadPct = bybitPriceC && binancePriceC
      ? ((bybitPriceC - binancePriceC) / binancePriceC) * 100
      : 0;

    const allPrices: Record<string, ExchangePrices | null> = {
      bybit:   bybitPriceC   ? { price: bybitPriceC,   bid: bybitT?.bid   ?? bybitPriceC,   ask: bybitT?.ask   ?? bybitPriceC,   fundingRate: bybitFundingMap[key]?.fundingRate   ?? 0 } : null,
      binance: binancePriceC ? { price: binancePriceC, bid: binanceT?.bid ?? binancePriceC, ask: binanceT?.ask ?? binancePriceC, fundingRate: binanceFundingMap[key]?.fundingRate ?? 0 } : null,
      gate:    gatePriceC    ? { price: gatePriceC,    bid: gateT?.bid    ?? gatePriceC,    ask: gateT?.ask    ?? gatePriceC,    fundingRate: gateFundingMap[key]?.fundingRate    ?? 0 } : null,
      okx:     okxPriceC     ? { price: okxPriceC,     bid: okxT?.bid     ?? okxPriceC,     ask: okxT?.ask     ?? okxPriceC,     fundingRate: okxFundingMap[key]?.fundingRate     ?? 0 } : null,
      mexc:    mexcPriceC    ? { price: mexcPriceC,    bid: mexcT?.bid    ?? mexcPriceC,    ask: mexcT?.ask    ?? mexcPriceC,    fundingRate: mexcFundingMap[key]?.fundingRate    ?? 0 } : null,
      aster:   asterPriceC   ? { price: asterPriceC,   bid: asterT?.bid   ?? asterPriceC,   ask: asterT?.ask   ?? asterPriceC,   fundingRate: asterFundingMap[key]?.fundingRate   ?? 0 } : null,
      hyper:   hyperPriceC   ? { price: hyperPriceC,   bid: hyperT?.bid   ?? hyperPriceC,   ask: hyperT?.ask   ?? hyperPriceC,   fundingRate: hyperFundingMap.get(base)?.fundingRate ?? 0 } : null,
    };

    const { bestSpreadPct, bestSpreadLeg } = computeBestSpread(allPrices);

    // EMA: blend current bestSpreadPct into running average (or seed on first tick)
    const prevEma = spreadEmaMap.get(base);
    const emaSpreadPct = prevEma != null
      ? SPREAD_EMA_ALPHA * bestSpreadPct + (1 - SPREAD_EMA_ALPHA) * prevEma
      : bestSpreadPct;
    spreadEmaMap.set(base, emaSpreadPct);

    // Open interest: sum from explicit OI fetches for Bybit, Binance, Gate, and OKX.
    const oiBB   = bybitOIMap.get(base)   ?? 0;
    const oiBN   = binanceOIMap.get(base) ?? 0;
    const oiGate = gateOIMap.get(base)    ?? 0;
    const oiOKX  = okxOIMap.get(base)     ?? 0;
    const oiTotal = oiBB + oiBN + oiGate + oiOKX;
    const openInterestUsd = oiTotal > 0 ? oiTotal : null;

    // Does this symbol need a MEXC orderbook fetch?
    // MEXC tickers don't include bidVolume/askVolume, so when MEXC is a leg
    // of the best spread we must fall back to a shallow orderbook.
    let needsMexcOb = false;
    if (bestSpreadLeg && mexcT) {
      const [cheapEx, expEx] = bestSpreadLeg.split("/");
      if (cheapEx === "mexc" || expEx === "mexc") {
        const mexcHasVol =
          (typeof mexcT.bidVolume === "number" && mexcT.bidVolume > 0) ||
          (typeof mexcT.askVolume === "number" && mexcT.askVolume > 0);
        if (!mexcHasVol) needsMexcOb = true;
      }
    }

    passOne.push({
      base, key,
      bybitT, binanceT, gateT, okxT, mexcT, asterT, hyperT,
      bybitPriceC, binancePriceC, gatePriceC, okxPriceC, mexcPriceC, asterPriceC, hyperPriceC,
      spreadPct, bestSpreadPct, bestSpreadLeg, emaSpreadPct,
      openInterestUsd, totalVolume, needsMexcOb,
    });
  }

  // ── MEXC orderbook batch fetch ─────────────────────────────────────────────
  // For symbols where MEXC is a spread leg but its ticker lacks bidVolume/askVolume,
  // fetch a shallow (depth-5) orderbook so we can estimate depth.
  const mexcObSymbols = passOne.filter(d => d.needsMexcOb).map(d => d.base);
  const mexcObResults = await Promise.allSettled(
    mexcObSymbols.map(base => mexc.fetchOrderBook(`${base}/USDT:USDT`, 5))
  );
  const mexcObMap = new Map<string, { bidVolume: number; askVolume: number }>();
  mexcObSymbols.forEach((base, i) => {
    const res = mexcObResults[i];
    if (res.status === "fulfilled") {
      const ob = res.value;
      const topBid = ob.bids?.[0];
      const topAsk = ob.asks?.[0];
      mexcObMap.set(base, {
        bidVolume: topBid?.[1] ?? 0,
        askVolume: topAsk?.[1] ?? 0,
      });
    }
  });

  // ── Pass 2: compute depth with OB fallback and build final spread list ─────
  const spreads = [];

  for (const d of passOne) {
    const {
      base, key,
      bybitT, binanceT, gateT, okxT, mexcT, asterT, hyperT,
      bybitPriceC, binancePriceC, gatePriceC, okxPriceC, mexcPriceC, asterPriceC, hyperPriceC,
      spreadPct, bestSpreadPct, bestSpreadLeg,
      openInterestUsd, totalVolume,
    } = d;

    // Spread depth: min(ask depth on cheaper leg, bid depth on expensive leg) in USD,
    // using the same exchange pair that forms the best spread.
    // For exchanges whose ticker lacks bidVolume/askVolume (e.g. MEXC) we fall
    // back to the shallow orderbook fetched above.
    let spreadDepthUsd: number | null = null;
    if (bestSpreadLeg) {
      const [cheapExchange, expensiveExchange] = bestSpreadLeg.split("/");
      const mexcOb = mexcObMap.get(base);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tickerMap: Record<string, any> = {
        bybit: bybitT, binance: binanceT, gate: gateT, okx: okxT, mexc: mexcT, aster: asterT, hyper: hyperT,
      };
      const priceMap: Record<string, number> = {
        bybit: bybitPriceC, binance: binancePriceC, gate: gatePriceC, okx: okxPriceC, mexc: mexcPriceC, aster: asterPriceC, hyper: hyperPriceC,
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sideDepthUsd = (exName: string, side: "bid" | "ask"): number => {
        const t: any = tickerMap[exName];
        const price  = priceMap[exName];
        if (!t || !price) return 0;
        let vol: number = side === "bid" ? (t.bidVolume ?? 0) : (t.askVolume ?? 0);
        // Fallback: use orderbook top-of-book volume when ticker doesn't supply it.
        if ((!vol || vol <= 0) && exName === "mexc" && mexcOb) {
          vol = side === "bid" ? mexcOb.bidVolume : mexcOb.askVolume;
        }
        const px = side === "bid" ? (t.bid ?? price) : (t.ask ?? price);
        return typeof vol === "number" && vol > 0 ? vol * px : 0;
      };
      const cheapAsk    = sideDepthUsd(cheapExchange,    "ask");
      const expensiveBid = sideDepthUsd(expensiveExchange, "bid");
      if (cheapAsk > 0 && expensiveBid > 0) {
        spreadDepthUsd = Math.min(cheapAsk, expensiveBid);
      }
    }

    spreads.push({
      symbol: base,
      bybitPrice:  bybitPriceC  || null,
      binancePrice: binancePriceC || null,
      spreadPct,
      bybitFundingRate:  bybitFundingMap[key]?.fundingRate    ?? null,
      binanceFundingRate: binanceFundingMap[key]?.fundingRate  ?? null,
      bybitNextFunding:  bybitFundingMap[key]?.fundingDatetime  ?? null,
      binanceNextFunding: binanceFundingMap[key]?.fundingDatetime ?? null,
      bybitBid:   bybitT?.bid   ?? null,
      bybitAsk:   bybitT?.ask   ?? null,
      binanceBid: binanceT?.bid ?? null,
      binanceAsk: binanceT?.ask ?? null,
      gatePrice:   gatePriceC   || null,
      gateFundingRate:  gateFundingMap[key]?.fundingRate   ?? null,
      gateNextFunding:  gateFundingMap[key]?.fundingDatetime  ?? null,
      gateBid:  gatePriceC ? (gateT?.bid  ?? null) : null,
      gateAsk:  gatePriceC ? (gateT?.ask  ?? null) : null,
      okxPrice:    okxPriceC    || null,
      okxFundingRate:   okxFundingMap[key]?.fundingRate    ?? null,
      okxNextFunding:   okxFundingMap[key]?.fundingDatetime   ?? null,
      okxBid:   okxPriceC ? (okxT?.bid   ?? null) : null,
      okxAsk:   okxPriceC ? (okxT?.ask   ?? null) : null,
      mexcPrice:   mexcPriceC   || null,
      mexcFundingRate:  mexcFundingMap[key]?.fundingRate   ?? null,
      mexcNextFunding:  mexcFundingMap[key]?.fundingDatetime  ?? null,
      mexcBid:  mexcPriceC ? (mexcT?.bid  ?? null) : null,
      mexcAsk:  mexcPriceC ? (mexcT?.ask  ?? null) : null,
      asterPrice:   asterPriceC   || null,
      asterFundingRate:  asterFundingMap[key]?.fundingRate   ?? null,
      asterNextFunding:  asterFundingMap[key]?.fundingDatetime  ?? null,
      asterBid:  asterPriceC ? (asterT?.bid  ?? null) : null,
      asterAsk:  asterPriceC ? (asterT?.ask  ?? null) : null,
      hyperPrice:   hyperPriceC   || null,
      hyperFundingRate:  hyperFundingMap.get(base)?.fundingRate   ?? null,
      hyperNextFunding:  hyperFundingMap.get(base)?.fundingDatetime ?? null,
      hyperBid:  hyperPriceC ? (hyperT?.bid  ?? null) : null,
      hyperAsk:  hyperPriceC ? (hyperT?.ask  ?? null) : null,
      bestSpreadPct,
      bestSpreadLeg,
      emaSpreadPct: d.emaSpreadPct,
      volume24h: totalVolume,
      openInterestUsd,
      spreadDepthUsd,
    });
  }

  priceCacheBySymbol.clear();
  fundingRateCacheBySymbol.clear();
  for (const s of spreads) {
    priceCacheBySymbol.set(s.symbol, {
      bybitPrice:   s.bybitPrice   as number | null,
      binancePrice: s.binancePrice as number | null,
      mexcPrice:    s.mexcPrice    as number | null,
      gatePrice:    s.gatePrice    as number | null,
      okxPrice:     s.okxPrice     as number | null,
      asterPrice:   s.asterPrice   as number | null,
      hyperPrice:   s.hyperPrice   as number | null,
    });
    fundingRateCacheBySymbol.set(s.symbol, {
      bybitFundingRate:   (s.bybitFundingRate   as number | null) ?? null,
      binanceFundingRate: (s.binanceFundingRate  as number | null) ?? null,
      gateFundingRate:    (s.gateFundingRate    as number | null) ?? null,
      okxFundingRate:     (s.okxFundingRate     as number | null) ?? null,
      mexcFundingRate:    (s.mexcFundingRate    as number | null) ?? null,
      asterFundingRate:   (s.asterFundingRate   as number | null) ?? null,
      hyperFundingRate:   (s.hyperFundingRate   as number | null) ?? null,
      bybitNextFunding:   (s.bybitNextFunding   as string | null) ?? null,
      binanceNextFunding: (s.binanceNextFunding  as string | null) ?? null,
      gateNextFunding:    (s.gateNextFunding    as string | null) ?? null,
      okxNextFunding:     (s.okxNextFunding     as string | null) ?? null,
      mexcNextFunding:    (s.mexcNextFunding    as string | null) ?? null,
      asterNextFunding:   (s.asterNextFunding   as string | null) ?? null,
      hyperNextFunding:   (s.hyperNextFunding   as string | null) ?? null,
    });
  }

  spreads.sort((a, b) => b.bestSpreadPct - a.bestSpreadPct);

  const top = spreads.slice(0, MAX_RESULTS);

  if (top.length > 0) {
    priceCache = { data: top, ts: Date.now() };
  }

  return top;
}

function getBybitCredentials(req: Request) {
  return {
    apiKey: (req.headers["x-bybit-api-key"] as string) || "",
    secret: (req.headers["x-bybit-api-secret"] as string) || "",
  };
}

function getBinanceCredentials(req: Request) {
  return {
    apiKey: (req.headers["x-binance-api-key"] as string) || "",
    secret: (req.headers["x-binance-api-secret"] as string) || "",
  };
}

function getOkxCredentials(req: Request) {
  return {
    apiKey: (req.headers["x-okx-api-key"] as string) || "",
    secret: (req.headers["x-okx-api-secret"] as string) || "",
    password: (req.headers["x-okx-passphrase"] as string) || "",
  };
}

function getMexcCredentials(req: Request) {
  return {
    apiKey: (req.headers["x-mexc-api-key"] as string) || "",
    secret: (req.headers["x-mexc-api-secret"] as string) || "",
  };
}

function getGateCredentials(req: Request) {
  return {
    apiKey: (req.headers["x-gate-api-key"] as string) || "",
    secret: (req.headers["x-gate-api-secret"] as string) || "",
  };
}

function getAsterCredentials(req: Request) {
  return {
    apiKey:     (req.headers["x-aster-api-key"] as string) || "",
    secret:     (req.headers["x-aster-api-secret"] as string) || "",
    passphrase: (req.headers["x-aster-signer-address"] as string) || "",
  };
}

function getHyperLiquidCredentials(req: Request) {
  return {
    apiKey: (req.headers["x-hyper-api-key"] as string) || "",
    secret: (req.headers["x-hyper-api-secret"] as string) || "",
  };
}

function getCredentialsForExchange(req: Request, exchange: string): { apiKey: string; secret: string; passphrase?: string } {
  switch (exchange) {
    case "bybit":   return getBybitCredentials(req);
    case "binance": return getBinanceCredentials(req);
    case "okx":     { const c = getOkxCredentials(req); return { apiKey: c.apiKey, secret: c.secret, passphrase: c.password }; }
    case "mexc":    return getMexcCredentials(req);
    case "gate":    return getGateCredentials(req);
    case "aster":   return getAsterCredentials(req);
    case "hyper":   return getHyperLiquidCredentials(req);
    default:        return { apiKey: "", secret: "" };
  }
}

export function createBybitExchange(apiKey = "", secret = "") {
  return new ccxt.bybit({
    apiKey,
    secret,
    options: {
      defaultType: "linear",
    },
  });
}

// Bybit hedge-mode shim.
// Some accounts use one-way mode (positionIdx=0, the default) and some use
// hedge mode (positionIdx=1 for long slot, 2 for short slot).  If the first
// attempt fails with Bybit retCode 10001 ("position idx not match position
// mode"), we retry with the correct hedge-mode positionIdx derived from
// `positionSide` — the slot we are opening OR the slot we are closing.
export async function bybitCreateOrder(
  ex: InstanceType<typeof ccxt.bybit>,
  symbol: string,
  orderSide: "buy" | "sell",
  qty: number,
  params: Record<string, unknown>,
  positionSide: "long" | "short"
): Promise<ReturnType<InstanceType<typeof ccxt.bybit>["createMarketOrder"]>> {
  try {
    return await ex.createMarketOrder(symbol, orderSide, qty, undefined, params);
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message.includes("position idx not match") || err.message.includes("10001"))
    ) {
      const positionIdx = positionSide === "long" ? 1 : 2;
      return await ex.createMarketOrder(symbol, orderSide, qty, undefined, { ...params, positionIdx });
    }
    throw err;
  }
}

export function createBinanceExchange(apiKey = "", secret = "") {
  return new ccxt.binance({
    apiKey,
    secret,
    options: {
      defaultType: "future",
    },
  });
}

export function createGateExchange(apiKey = "", secret = "") {
  return new ccxt.gateio({
    apiKey,
    secret,
    options: { defaultType: "swap" },
  });
}

export function createOkxExchange(apiKey = "", secret = "", password = "") {
  return new ccxt.okx({
    apiKey,
    secret,
    password,
    options: { defaultType: "swap" },
  });
}

export function createMexcExchange(apiKey = "", secret = "") {
  return new ccxt.mexc({
    apiKey,
    secret,
    options: { defaultType: "swap" },
  });
}

export function createAsterExchange(walletAddress = "", privateKey = "", signerAddress = "") {
  return new ccxt.aster({
    // apiKey + secret satisfy checkRequiredCredentials() which runs before signing.
    // For V3 paths the actual signing uses walletAddress/privateKey/signerAddress.
    apiKey: walletAddress,
    secret: privateKey,
    walletAddress,
    privateKey,
    options: {
      defaultType: "future",
      ...(signerAddress ? { signerAddress } : {}),
    },
  });
}

/** Extract EIP-712 signing credentials stored in a CCXT aster exchange instance. */
function getAsterCreds(ex: SupportedCcxtExchange): { walletAddress: string; privateKey: string; signerAddress: string } | null {
  if (ex.id !== "aster") return null;
  const walletAddress = (ex as any).walletAddress || ex.apiKey || "";
  const privateKey    = (ex as any).privateKey    || ex.secret  || "";
  const signerAddress = (ex as any).options?.signerAddress || "";
  if (!walletAddress || !privateKey || !signerAddress) return null;
  return { walletAddress, privateKey, signerAddress };
}

export function createHyperLiquidExchange(walletAddress = "", privateKey = "") {
  return new ccxt.hyperliquid({
    walletAddress,
    privateKey,
    options: { defaultType: "swap" },
  });
}

export type SupportedCcxtExchange =
  | ReturnType<typeof createBybitExchange>
  | ReturnType<typeof createBinanceExchange>
  | ReturnType<typeof createGateExchange>
  | ReturnType<typeof createOkxExchange>
  | ReturnType<typeof createMexcExchange>
  | ReturnType<typeof createAsterExchange>
  | ReturnType<typeof createHyperLiquidExchange>;

export function createExchangeForName(
  name: string,
  apiKey: string,
  apiSecret: string,
  extraPassphrase?: string,
): SupportedCcxtExchange {
  switch (name) {
    case "bybit":   return createBybitExchange(apiKey, apiSecret);
    case "binance": return createBinanceExchange(apiKey, apiSecret);
    case "gate":    return createGateExchange(apiKey, apiSecret);
    case "okx":     return createOkxExchange(apiKey, apiSecret, extraPassphrase ?? "");
    case "mexc":    return createMexcExchange(apiKey, apiSecret);
    case "aster":   return createAsterExchange(apiKey, apiSecret, extraPassphrase ?? "");
    case "hyper":   return createHyperLiquidExchange(apiKey, apiSecret);
    default:        throw new Error(`Unsupported exchange: ${name}`);
  }
}


const DEMO_BASE_PRICES: Record<string, number> = {
  BTC: 94800, ETH: 3480, SOL: 185, BNB: 615, XRP: 0.62, DOGE: 0.175,
  ADA: 0.48, AVAX: 38.5, DOT: 7.2, LINK: 14.8, MATIC: 0.78, UNI: 9.1,
  ATOM: 8.9, LTC: 95, BCH: 390, ETC: 26.5, FIL: 5.8, APT: 8.4,
  ARB: 0.91, OP: 2.1, SUI: 1.42, SEI: 0.52, TIA: 7.8, INJ: 24.5,
  NEAR: 7.1, ALGO: 0.21, SAND: 0.52, MANA: 0.45, AXS: 8.2, ENJ: 0.38,
  CHZ: 0.11, "1000SHIB": 0.028, PEPE: 0.0000118, WLD: 2.35, JTO: 3.1,
  PYTH: 0.52, RNDR: 7.4, FET: 2.1, AGIX: 0.68, RUNE: 5.8, STX: 1.7,
  IMX: 1.92, GRT: 0.32, AAVE: 285, MKR: 1850, SNX: 2.9, CRV: 0.58,
  LDO: 2.1, RPL: 15.2,
};

type ExchangePrices = {
  price: number;
  bid: number;
  ask: number;
  fundingRate: number;
};

function computeBestSpread(prices: Record<string, ExchangePrices | null>): { bestSpreadPct: number; bestSpreadLeg: string } {
  const entries = Object.entries(prices).filter((e): e is [string, ExchangePrices] => e[1] !== null);
  let bestAbs = 0;
  let bestLeg = "";
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [nameA, a] = entries[i];
      const [nameB, b] = entries[j];
      if (!b.price) continue;
      const pct = ((a.price - b.price) / b.price) * 100;
      if (Math.abs(pct) > bestAbs) {
        bestAbs = Math.abs(pct);
        bestLeg = pct >= 0 ? `${nameA}/${nameB}` : `${nameB}/${nameA}`;
      }
    }
  }
  return { bestSpreadPct: bestAbs, bestSpreadLeg: bestLeg };
}

function generateDemoSpreads() {
  const nextFundingOffset = 3600 * 1000 * (Math.floor(Date.now() / (3600 * 8 * 1000) + 1) * 8 - Math.floor(Date.now() / (3600 * 1000)));
  const nextFundingTime = new Date(Date.now() + nextFundingOffset).toISOString();

  return Object.entries(DEMO_BASE_PRICES).map(([symbol, basePrice]) => {
    const n = () => (Math.random() - 0.5) * 0.002;
    const bybitPrice = basePrice * (1 + n() + (Math.random() - 0.5) * 0.015);
    const binancePrice = basePrice * (1 + n() + (Math.random() - 0.5) * 0.015);
    const gatePrice = basePrice * (1 + n() + (Math.random() - 0.5) * 0.015);
    const okxPrice = basePrice * (1 + n() + (Math.random() - 0.5) * 0.015);
    const mexcPrice = basePrice * (1 + n() + (Math.random() - 0.5) * 0.015);
    const spreadPct = binancePrice ? ((bybitPrice - binancePrice) / binancePrice) * 100 : 0;
    const spread = basePrice * 0.0001;

    const hyperPrice = basePrice * (1 + n() + (Math.random() - 0.5) * 0.015);
    const hyperNextFundingTime = new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000).toISOString();

    const allPrices: Record<string, ExchangePrices | null> = {
      bybit: { price: bybitPrice, bid: bybitPrice - spread, ask: bybitPrice + spread, fundingRate: (Math.random() - 0.4) * 0.001 },
      binance: { price: binancePrice, bid: binancePrice - spread, ask: binancePrice + spread, fundingRate: (Math.random() - 0.4) * 0.001 },
      gate: { price: gatePrice, bid: gatePrice - spread, ask: gatePrice + spread, fundingRate: (Math.random() - 0.4) * 0.001 },
      okx: { price: okxPrice, bid: okxPrice - spread, ask: okxPrice + spread, fundingRate: (Math.random() - 0.4) * 0.001 },
      mexc: { price: mexcPrice, bid: mexcPrice - spread, ask: mexcPrice + spread, fundingRate: (Math.random() - 0.4) * 0.001 },
      hyper: { price: hyperPrice, bid: hyperPrice - spread, ask: hyperPrice + spread, fundingRate: (Math.random() - 0.4) * 0.0002 },
    };

    const { bestSpreadPct, bestSpreadLeg } = computeBestSpread(allPrices);

    return {
      symbol,
      bybitPrice,
      binancePrice,
      spreadPct,
      bybitFundingRate: allPrices.bybit!.fundingRate,
      binanceFundingRate: allPrices.binance!.fundingRate,
      bybitNextFunding: nextFundingTime,
      binanceNextFunding: nextFundingTime,
      bybitBid: bybitPrice - spread,
      bybitAsk: bybitPrice + spread,
      binanceBid: binancePrice - spread,
      binanceAsk: binancePrice + spread,
      gatePrice,
      gateFundingRate: allPrices.gate!.fundingRate,
      gateNextFunding: nextFundingTime,
      gateBid: gatePrice - spread,
      gateAsk: gatePrice + spread,
      okxPrice,
      okxFundingRate: allPrices.okx!.fundingRate,
      okxNextFunding: nextFundingTime,
      okxBid: okxPrice - spread,
      okxAsk: okxPrice + spread,
      mexcPrice,
      mexcFundingRate: allPrices.mexc!.fundingRate,
      mexcNextFunding: nextFundingTime,
      mexcBid: mexcPrice - spread,
      mexcAsk: mexcPrice + spread,
      hyperPrice,
      hyperFundingRate: allPrices.hyper!.fundingRate,
      hyperNextFunding: hyperNextFundingTime,
      hyperBid: hyperPrice - spread,
      hyperAsk: hyperPrice + spread,
      bestSpreadPct,
      bestSpreadLeg,
      // Demo EMA: simulate a slightly smoothed value so the column is non-empty
      emaSpreadPct: bestSpreadPct * (0.85 + Math.random() * 0.15),
      volume24h: basePrice * Math.random() * 50000000,
      openInterestUsd: basePrice * (Math.random() * 20000000 + 5000000),
      spreadDepthUsd: basePrice * (Math.random() * 200000 + 10000),
      demo: true,
    };
  }).sort((a, b) => Math.abs(b.bestSpreadPct) - Math.abs(a.bestSpreadPct));
}

function ensurePriceFetch(): Promise<unknown[]> {
  if (!priceFetchInFlight) {
    priceFetchInFlight = fetchAndCachePrices().finally(() => {
      priceFetchInFlight = null;
    });
  }
  return priceFetchInFlight;
}

export async function fetchPriceSpreads(): Promise<ReturnType<typeof generateDemoSpreads>> {
  try {
    const now = Date.now();
    const cacheAge = priceCache ? now - priceCache.ts : Infinity;

    if (cacheAge < PRICE_CACHE_TTL_MS) {
      if (!priceFetchInFlight && cacheAge > PRICE_CACHE_TTL_MS / 2) {
        ensurePriceFetch();
      }
      return priceCache!.data as ReturnType<typeof generateDemoSpreads>;
    }

    // Cache is stale — kick off a background refresh.
    ensurePriceFetch();

    // If we have stale-but-real data, serve it while the refresh runs.
    if (priceCache) {
      return priceCache.data as ReturnType<typeof generateDemoSpreads>;
    }

    // True cold start — no data at all yet, return empty.
    return [] as unknown as ReturnType<typeof generateDemoSpreads>;
  } catch {
    return [] as unknown as ReturnType<typeof generateDemoSpreads>;
  }
}

// ---------------------------------------------------------------------------
// Relay endpoint: /api/exchanges/relay-klines?exchange=bybit&symbol=BTC&interval=1h&limit=168
// Fetches OHLCV for a single exchange using direct REST (no ccxt).
// Deploy this endpoint to Cloudflare Workers or any edge region, then set
// KLINES_RELAY_URL to its public URL so the main klines endpoint routes
// blocked-exchange requests through it.
// ---------------------------------------------------------------------------
router.get("/exchanges/relay-klines", async (req: Request, res: Response) => {
  const exchange = (req.query.exchange as string)?.toLowerCase() ?? "";
  const symbol   = (req.query.symbol as string)?.toUpperCase() ?? "";
  const interval = (req.query.interval as string) ?? "1h";
  const limitRaw = parseInt(req.query.limit as string ?? "168", 10);
  const limit    = isNaN(limitRaw) ? 168 : Math.min(Math.max(limitRaw, 1), 500);

  if (!exchange || !symbol) {
    res.status(400).json({ error: "bad_request", message: "exchange and symbol are required" });
    return;
  }

  const fetcher = DIRECT_FETCHERS[exchange];
  if (!fetcher) {
    res.status(400).json({ error: "bad_request", message: `unknown exchange: ${exchange}` });
    return;
  }

  try {
    const data = await fetcher(symbol, interval, limit);
    res.json(data);
  } catch (err) {
    req.log.warn({ err, exchange, symbol }, "relay-klines fetch failed");
    res.status(502).json({ error: "fetch_failed", message: String(err) });
  }
});

router.get("/exchanges/klines", async (req: Request, res: Response) => {
  const symbol = (req.query.symbol as string)?.toUpperCase() ?? "";
  const interval = (req.query.interval as string) ?? "1h";
  const limitRaw = parseInt(req.query.limit as string ?? "168", 10);
  const limit = isNaN(limitRaw) ? 168 : Math.min(Math.max(limitRaw, 1), 500);

  if (!symbol) {
    res.status(400).json({ error: "bad_request", message: "symbol is required" });
    return;
  }

  recordKlinesHit(symbol);

  const cacheKey = `${symbol}:${interval}:${limit}`;
  const cached = klinesCache.get(cacheKey);
  const ttl = getKlinesCacheTtl(interval);
  if (cached && Date.now() - cached.ts < ttl) {
    res.json(cached.data);
    return;
  }

  const ccxtSymbol = `${symbol}/USDT:USDT`;
  const timeframeMap: Record<string, string> = {
    "1m": "1m", "5m": "5m", "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d",
  };
  const timeframe = timeframeMap[interval] ?? "1h";

  type OhlcvRow = [number, number, number, number, number, number?];

  const exchangeDefs = [
    { name: "bybit",   create: () => createBybitExchange() },
    { name: "binance", create: () => createBinanceExchange() },
    { name: "gate",    create: () => createGateExchange() },
    { name: "okx",     create: () => createOkxExchange() },
    { name: "mexc",    create: () => createMexcExchange() },
    { name: "aster",   create: () => createAsterExchange() },
    { name: "hyper",   create: () => createHyperLiquidExchange() },
  ];

  const results = await Promise.allSettled(
    exchangeDefs.map(async ({ name, create }) => {
      const data = await fetchExchangeKlines(name, symbol, interval, limit, async () => {
        const ex = create();
        const raw = await Promise.race([
          ex.fetchOHLCV(ccxtSymbol, timeframe, undefined, limit) as Promise<OhlcvRow[]>,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("klines timeout")), KLINES_TIMEOUT_MS)
          ),
        ]);
        return raw.map((row) => ({ t: row[0], o: row[1], h: row[2], l: row[3], c: row[4] })).filter((p) => p.t > 0 && p.c > 0);
      });
      return { name, data };
    })
  );

  const out: Record<string, OhlcvPoint[]> = {};
  for (const result of results) {
    if (result.status === "fulfilled" && result.value.data.length > 0) {
      out[result.value.name] = result.value.data;
    }
  }

  if (Object.keys(out).length > 0) {
    klinesCache.set(cacheKey, { data: out, ts: Date.now() });
    evictKlinesCacheIfNeeded();
  }

  res.json(out);
});

router.get("/exchanges/prices", async (req: Request, res: Response) => {
  try {
    const spreads = await fetchPriceSpreads();
    res.json(spreads);
  } catch (err) {
    req.log.error({ err }, "Error fetching exchange prices");
    res.json([]);
  }
});

router.get("/exchanges/balances", async (req: Request, res: Response) => {
  const bybitCreds = getBybitCredentials(req);
  const binanceCreds = getBinanceCredentials(req);
  const okxCreds = getOkxCredentials(req);
  const mexcCreds = getMexcCredentials(req);
  const asterCreds = getAsterCredentials(req);
  const hyperCreds = getHyperLiquidCredentials(req);

  const hasAnyCredentials =
    (bybitCreds.apiKey && bybitCreds.secret) ||
    (binanceCreds.apiKey && binanceCreds.secret) ||
    (okxCreds.apiKey && okxCreds.secret) ||
    (mexcCreds.apiKey && mexcCreds.secret) ||
    (asterCreds.apiKey && asterCreds.secret && asterCreds.passphrase) ||
    (hyperCreds.apiKey && hyperCreds.secret);

  if (!hasAnyCredentials) {
    res.status(401).json({ error: "unauthorized", message: "API credentials required" });
    return;
  }

  try {
    const fetchers: Promise<{ exchange: string; balance: unknown }>[] = [];

    if (bybitCreds.apiKey && bybitCreds.secret) {
      const bybit = createBybitExchange(bybitCreds.apiKey, bybitCreds.secret);
      fetchers.push(bybit.fetchBalance({ type: "linear" }).then((b) => ({ exchange: "bybit", balance: b })));
    }
    if (binanceCreds.apiKey && binanceCreds.secret) {
      const binance = createBinanceExchange(binanceCreds.apiKey, binanceCreds.secret);
      fetchers.push(binance.fetchBalance({ type: "future" }).then((b) => ({ exchange: "binance", balance: b })));
    }
    if (okxCreds.apiKey && okxCreds.secret) {
      const okx = createOkxExchange(okxCreds.apiKey, okxCreds.secret, okxCreds.password);
      fetchers.push(okx.fetchBalance({ type: "swap" }).then((b) => ({ exchange: "okx", balance: b })));
    }
    if (mexcCreds.apiKey && mexcCreds.secret) {
      const mexc = createMexcExchange(mexcCreds.apiKey, mexcCreds.secret);
      fetchers.push(mexc.fetchBalance({ type: "swap" }).then((b) => ({ exchange: "mexc", balance: b })));
    }
    if (asterCreds.apiKey && asterCreds.secret && asterCreds.passphrase) {
      // Use custom EIP-712 client — CCXT's V3 signing is incompatible with AsterDex's actual auth.
      fetchers.push(
        asterFetchBalance(asterCreds.apiKey, asterCreds.passphrase, asterCreds.secret).then((assets) => {
          const balanceObj: Record<string, { free: string; total: string }> = {};
          let unrealizedProfit = 0;
          for (const a of assets) {
            balanceObj[a.asset] = {
              free: a.availableBalance ?? a.balance,
              total: a.balance,
            };
            if (a.asset === "USDT") unrealizedProfit = Number(a.unrealizedProfit) || 0;
          }
          return { exchange: "aster", balance: balanceObj as Record<string, unknown>, pnl: unrealizedProfit };
        })
      );
    }
    if (hyperCreds.apiKey && hyperCreds.secret) {
      const hyper = createHyperLiquidExchange(hyperCreds.apiKey, hyperCreds.secret);
      fetchers.push(hyper.fetchBalance().then((b) => ({ exchange: "hyper", balance: b })));
    }

    const results = await Promise.allSettled(fetchers);

    const balanceMap: Record<string, { usdt: number; pnl: number }> = {};
    for (const result of results) {
      if (result.status === "rejected") {
        req.log.warn({ err: result.reason }, "Balance fetch failed for an exchange");
        continue;
      }
      const { exchange, balance, pnl: topLevelPnl } = result.value as {
        exchange: string;
        balance: Record<string, unknown>;
        pnl?: number;
      };
      // HyperLiquid uses USDC; all others use USDT.
      const currency = exchange === "hyper" ? "USDC" : "USDT";
      const bal = balance[currency] as Record<string, number | string> | undefined;
      const usdt = bal?.free ?? bal?.total ?? 0;
      let pnl = topLevelPnl ?? 0;
      if (exchange === "bybit") pnl = (balance.info as Record<string, unknown>)?.totalUnrealisedPnl as number ?? 0;
      if (exchange === "binance") pnl = (balance.info as Record<string, unknown>)?.totalUnrealizedProfit as number ?? 0;
      balanceMap[exchange] = { usdt: Number(usdt) || 0, pnl: Number(pnl) || 0 };
    }

    res.json({
      bybit: balanceMap["bybit"]?.usdt ?? 0,
      binance: balanceMap["binance"]?.usdt ?? 0,
      bybitPnl: balanceMap["bybit"]?.pnl ?? 0,
      binancePnl: balanceMap["binance"]?.pnl ?? 0,
      okx: balanceMap["okx"] != null ? balanceMap["okx"].usdt : undefined,
      okxPnl: balanceMap["okx"] != null ? balanceMap["okx"].pnl : undefined,
      mexc: balanceMap["mexc"] != null ? balanceMap["mexc"].usdt : undefined,
      mexcPnl: balanceMap["mexc"] != null ? balanceMap["mexc"].pnl : undefined,
      aster: balanceMap["aster"] != null ? balanceMap["aster"].usdt : undefined,
      asterPnl: balanceMap["aster"] != null ? balanceMap["aster"].pnl : undefined,
      hyper: balanceMap["hyper"] != null ? balanceMap["hyper"].usdt : undefined,
      hyperPnl: balanceMap["hyper"] != null ? balanceMap["hyper"].pnl : undefined,
    });
  } catch (err) {
    req.log.error({ err }, "Error fetching balances");
    res.status(500).json({ error: "internal_error", message: "Failed to fetch balances" });
  }
});

router.post("/exchanges/order", async (req: Request, res: Response) => {
  const parsed = PlaceOrderBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "bad_request", message: parsed.error.message });
    return;
  }

  const { exchange, symbol, side, usdAmount, leverage } = parsed.data;
  const bybitCreds = getBybitCredentials(req);
  const binanceCreds = getBinanceCredentials(req);

  try {
    let result;

    if (exchange === "bybit") {
      if (!bybitCreds.apiKey || !bybitCreds.secret) {
        res.status(401).json({ error: "unauthorized", message: "Bybit credentials required" });
        return;
      }
      const ex = createBybitExchange(bybitCreds.apiKey, bybitCreds.secret);

      if (leverage && leverage !== 1) {
        try {
          await ex.setLeverage(leverage, `${symbol}/USDT:USDT`);
        } catch (_) {}
      }

      const ticker = await ex.fetchTicker(`${symbol}/USDT:USDT`);
      const price = ticker.last ?? ticker.bid ?? 1;
      const qty = usdAmount / price;
      const ccxtSide = side === "long" ? "buy" : "sell";

      const order = await bybitCreateOrder(ex, `${symbol}/USDT:USDT`, ccxtSide, qty, { reduceOnly: false }, side as "long" | "short");

      result = {
        orderId: String(order.id),
        exchange: "bybit",
        symbol,
        side,
        filledQty: order.filled ?? qty,
        avgPrice: order.average ?? price,
        status: order.status ?? "closed",
      };
    } else {
      if (!binanceCreds.apiKey || !binanceCreds.secret) {
        res.status(401).json({ error: "unauthorized", message: "Binance credentials required" });
        return;
      }
      const ex = createBinanceExchange(binanceCreds.apiKey, binanceCreds.secret);

      if (leverage && leverage !== 1) {
        try {
          await ex.setLeverage(leverage, `${symbol}/USDT:USDT`);
        } catch (_) {}
      }

      const ticker = await ex.fetchTicker(`${symbol}/USDT:USDT`);
      const price = ticker.last ?? ticker.bid ?? 1;
      const qty = usdAmount / price;
      const ccxtSide = side === "long" ? "buy" : "sell";

      const order = await ex.createMarketOrder(
        `${symbol}/USDT:USDT`,
        ccxtSide,
        qty,
        undefined,
        { reduceOnly: false }
      );

      result = {
        orderId: String(order.id),
        exchange: "binance",
        symbol,
        side,
        filledQty: order.filled ?? qty,
        avgPrice: order.average ?? price,
        status: order.status ?? "closed",
      };
    }

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Error placing order");
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: "order_failed", message: msg });
  }
});

router.post("/exchanges/close-position", async (req: Request, res: Response) => {
  const parsed = ClosePositionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "bad_request", message: parsed.error.message });
    return;
  }

  const { symbol, bybitSide, binanceSide, bybitQty, binanceQty } = parsed.data;
  const body = req.body as Record<string, unknown>;
  const exchangeA = typeof body["exchangeA"] === "string" ? body["exchangeA"] : "bybit";
  const exchangeB = typeof body["exchangeB"] === "string" ? body["exchangeB"] : "binance";
  const longExchange = typeof body["longExchange"] === "string" ? body["longExchange"] : exchangeA;
  const shortExchange = typeof body["shortExchange"] === "string" ? body["shortExchange"] : exchangeB;
  const spreadAtEntry = typeof body["spreadAtEntry"] === "number" ? body["spreadAtEntry"] : 0;
  const entryTime = typeof body["entryTime"] === "string" ? body["entryTime"] : undefined;
  const quantity = typeof body["quantity"] === "number" ? body["quantity"] : 0;
  const clientRealizedPnl = typeof body["realizedPnl"] === "number" ? body["realizedPnl"] : null;
  // contractSizeB: provided for new-style bot legs where binanceQty is in base units.
  // Absent (null/undefined) for legacy legs where binanceQty is already in contracts.
  const contractSizeB = typeof body["contractSizeB"] === "number" ? body["contractSizeB"] : null;

  const credsA = getCredentialsForExchange(req, exchangeA);
  const credsB = getCredentialsForExchange(req, exchangeB);

  try {
    const exA = createExchangeForName(exchangeA, credsA.apiKey, credsA.secret, credsA.passphrase);
    const exB = createExchangeForName(exchangeB, credsB.apiKey, credsB.secret, credsB.passphrase);

    const result = await closePositionInternal({
      exA,
      exB,
      symbol,
      sideA: bybitSide as "long" | "short",
      sideB: binanceSide as "long" | "short",
      qtyA: bybitQty,
      qtyB: binanceQty,
      contractSizeB,
      spreadAtEntry,
      entryTime: entryTime ? new Date(entryTime) : new Date(),
      quantity,
      longExchange,
      shortExchange,
    });

    if (!result.bothClosed) {
      req.log.warn(
        { errorA: result.errorA, errorB: result.errorB },
        "close-position: partial failure",
      );
    }

    const realizedPnl = clientRealizedPnl ?? 0;

    if (result.bothClosed) {
      try {
        const fundingEntry = getFundingRateEntry(symbol);
        let estimatedFundingUsd: number | null = null;
        if (fundingEntry && entryTime) {
          const longRate = getFundingRateForExchange(fundingEntry, longExchange);
          const shortRate = getFundingRateForExchange(fundingEntry, shortExchange);
          const intervals = countSettledFundingIntervals(new Date(entryTime).getTime(), Date.now());
          estimatedFundingUsd = intervals * (shortRate - longRate) * quantity;
        }
        const exitSpread = result.closePriceA != null && result.closePriceB != null
          ? ((result.closePriceA - result.closePriceB) / result.closePriceB) * 100
          : undefined;
        await db.insert(closedTradesTable).values({
          symbol,
          longExchange,
          shortExchange,
          spreadAtEntry: String(spreadAtEntry),
          spreadAtExit: exitSpread != null ? String(exitSpread) : undefined,
          closeReason: "manual",
          realizedPnl: String(realizedPnl),
          quantity: String(quantity),
          openFees: "0",
          fundingPaidUsd: estimatedFundingUsd != null ? String(estimatedFundingUsd) : undefined,
          entryTime: entryTime ? new Date(entryTime) : new Date(),
          closeTime: new Date(),
        });
      } catch {
        // Non-fatal: DB logging failure should not abort position close
      }
    }

    const closeFees = result.closeFeeA + result.closeFeeB;

    res.json({
      success: result.bothClosed,
      bybitResult: result.orderIdA
        ? { orderId: result.orderIdA, exchange: "bybit", symbol, filledQty: bybitQty }
        : null,
      binanceResult: result.orderIdB
        ? { orderId: result.orderIdB, exchange: "binance", symbol, filledQty: binanceQty }
        : null,
      realizedPnl,
      closeFees,
    });
  } catch (err) {
    req.log.error({ err }, "Error closing position");
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: "close_failed", message: msg });
  }
});

router.get("/positions", requireBotSecret, async (req: Request, res: Response) => {
  const bybitCreds = getBybitCredentials(req);
  const binanceCreds = getBinanceCredentials(req);

  if (!bybitCreds.apiKey || !bybitCreds.secret || !binanceCreds.apiKey || !binanceCreds.secret) {
    res.json([]);
    return;
  }

  try {
    const bybit = createBybitExchange(bybitCreds.apiKey, bybitCreds.secret);
    const binance = createBinanceExchange(binanceCreds.apiKey, binanceCreds.secret);

    const [bybitPositions, binancePositions] = await Promise.allSettled([
      bybit.fetchPositions(undefined, { type: "linear" }),
      binance.fetchPositions(undefined, { type: "future" }),
    ]);

    // In hedge mode Bybit can have BOTH a long and short for the same symbol.
    // Store them keyed by symbol + side so we can match the correct leg.
    type BybitPos = {
      id?: unknown;
      side?: unknown;
      contracts?: number;
      entryPrice?: number;
      markPrice?: number;
      unrealizedPnl?: number;
      timestamp?: number;
      datetime?: string;
    };
    const bybitMap: Map<string, { long?: BybitPos; short?: BybitPos }> = new Map();
    if (bybitPositions.status === "fulfilled") {
      for (const pos of bybitPositions.value) {
        if (!pos.contracts || pos.contracts === 0) continue;
        const sym = pos.symbol?.split("/")[0] ?? "";
        const side = pos.side === "long" ? "long" : "short";
        const existing = bybitMap.get(sym) ?? {};
        existing[side] = pos as unknown as BybitPos;
        bybitMap.set(sym, existing);
      }
    }

    // Fetch open bot leg fees grouped by symbol so we can enrich exchange positions
    const openBotLegs = await db
      .select({
        symbol: botLegsTable.symbol,
        openFeeA: botLegsTable.openFeeA,
        openFeeB: botLegsTable.openFeeB,
      })
      .from(botLegsTable)
      .where(eq(botLegsTable.status, "open"));

    const openFeesBySymbol = new Map<string, number>();
    for (const leg of openBotLegs) {
      const prev = openFeesBySymbol.get(leg.symbol) ?? 0;
      openFeesBySymbol.set(leg.symbol, prev + Number(leg.openFeeA ?? 0) + Number(leg.openFeeB ?? 0));
    }

    const result = [];

    if (binancePositions.status === "fulfilled") {
      for (const binancePos of binancePositions.value) {
        if (!binancePos.contracts || binancePos.contracts === 0) continue;
        const sym = binancePos.symbol?.split("/")[0] ?? "";
        const binanceSide = binancePos.side === "long" ? "long" : "short";

        // Arb positions: bybit side is opposite to binance side.
        // If we can't find the exact opposite, fall back to whichever side exists.
        const expectedBybitSide = binanceSide === "long" ? "short" : "long";
        const bybitSides = bybitMap.get(sym);
        if (!bybitSides) continue;
        const bybitPos = bybitSides[expectedBybitSide] ?? bybitSides.long ?? bybitSides.short;
        if (!bybitPos) continue;

        const bybitSide = bybitPos.side === "long" ? "long" : "short";
        const bybitPnlVal = Number(bybitPos.unrealizedPnl ?? 0);
        const binancePnlVal = Number(binancePos.unrealizedPnl ?? 0);
        const bybitContracts = bybitPos.contracts ?? 0;
        const bybitEntry = bybitPos.entryPrice ?? 0;
        const bybitMark = bybitPos.markPrice ?? bybitEntry;
        const binanceMark = binancePos.markPrice ?? binancePos.entryPrice ?? 0;

        // Use exchange timestamp when available; fall back to now only if missing
        const openedAt =
          bybitPos.datetime ??
          (bybitPos.timestamp ? new Date(bybitPos.timestamp).toISOString() : null) ??
          (binancePos.timestamp ? new Date(binancePos.timestamp).toISOString() : null) ??
          new Date().toISOString();

        const openFees = openFeesBySymbol.get(sym) ?? 0;
        const rawPnl = bybitPnlVal + binancePnlVal;

        result.push({
          id: `${sym}-${String(bybitPos.id ?? "")}-${String(binancePos.id ?? "")}`,
          symbol: sym,
          bybitSide,
          binanceSide,
          bybitQty: bybitContracts,
          binanceQty: binancePos.contracts ?? 0,
          bybitEntryPrice: bybitEntry,
          binanceEntryPrice: binancePos.entryPrice ?? 0,
          bybitCurrentPrice: bybitMark,
          binanceCurrentPrice: binanceMark,
          bybitPnl: bybitPnlVal,
          binancePnl: binancePnlVal,
          totalPnl: rawPnl - openFees,
          openFees: openFees > 0 ? openFees : undefined,
          spreadAtEntry: 0,
          currentSpread: bybitMark && binanceMark
            ? ((bybitMark - binanceMark) / binanceMark) * 100
            : 0,
          usdSize: (bybitContracts * bybitMark) +
            ((binancePos.contracts ?? 0) * binanceMark),
          openedAt,
        });
      }
    }

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Error fetching positions (canonical)");
    res.json([]);
  }
});

const MIN_NOTIONAL_BY_EXCHANGE: Record<string, number> = {
  binance: 5.5,
  gate:    1.0,
  okx:     1.0,
  mexc:    1.0,
};

const FEE_RETRY_DELAY_MS = 2000;

const TAKER_FEE_RATES: Record<string, number> = {
  bybit:   0.00055,
  binance: 0.00040,
  gate:    0.00050,
  okx:     0.00050,
  mexc:    0.00050,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function sumFeesFromOrder(order: any): number {
  if (order == null) return 0;
  if (order.fee?.cost != null) {
    const cost = Number(order.fee.cost);
    if (cost > 0) return cost;
  }
  if (Array.isArray(order.fees) && order.fees.length > 0) {
    const total = (order.fees as Array<{ cost?: unknown }>).reduce(
      (s, f) => s + (Number(f.cost) || 0),
      0,
    );
    if (total > 0) return total;
  }
  return 0;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function estimateFeeFromOrderValue(ex: SupportedCcxtExchange, order: any): number {
  const cost = Number(order?.cost ?? 0) ||
    (Number(order?.filled ?? 0) * Number(order?.average ?? order?.price ?? 0));
  if (cost <= 0) return 0;
  const rate = TAKER_FEE_RATES[ex.id] ?? 0.0005;
  return cost * rate;
}

async function extractFeeFromOrder(
  ex: SupportedCcxtExchange,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  order: any,
  marketSymbol: string,
): Promise<number> {
  const inline = sumFeesFromOrder(order);
  if (inline > 0) return inline;
  await new Promise<void>((r) => setTimeout(r, FEE_RETRY_DELAY_MS));
  try {
    const fetched = await ex.fetchOrder(String(order.id), marketSymbol);
    const retried = sumFeesFromOrder(fetched);
    if (retried > 0) return retried;
    const estimated = estimateFeeFromOrderValue(ex, fetched);
    if (estimated > 0) return estimated;
  } catch (_) {}
  const estimated = estimateFeeFromOrderValue(ex, order);
  return estimated;
}

export async function placeOrderInternal(
  ex: SupportedCcxtExchange,
  symbol: string,
  side: "long" | "short",
  usdAmount: number,
  leverage: number | undefined
): Promise<{ orderId: string; exchange: string; symbol: string; side: string; filledQty: number; avgPrice: number; status: string; feeCost: number; contractSize: number }> {
  const marketSymbol = `${symbol}/USDT:USDT`;
  const exchangeName = ex.id;

  // ── AsterDex: use custom EIP-712 client instead of CCXT ──────────────────
  if (exchangeName === "aster") {
    const creds = getAsterCreds(ex);
    if (!creds) throw new Error("AsterDex: missing wallet/signer credentials");

    if (leverage && leverage !== 1) {
      try {
        await asterSetLeverage(symbol, leverage, creds.walletAddress, creds.signerAddress, creds.privateKey);
      } catch (_) {}
    }

    const ticker = await asterFetchTicker(symbol);
    const price = ticker.price || ticker.bid || 1;
    let qty = usdAmount / price;

    try {
      const stepSize = await asterFetchMarketStepSize(symbol);
      qty = roundToStepSize(qty, stepSize);
    } catch (_) {}
    if (qty <= 0) qty = usdAmount / price;

    logger.info({ exchange: "aster", symbol, side, usdAmount, price, qty }, "placeOrderInternal: placing order");

    const asterSide = side === "long" ? "BUY" : "SELL";
    const orderResult = await asterPlaceOrder(symbol, asterSide, qty, creds.walletAddress, creds.signerAddress, creds.privateKey);

    const filledQty = Number(orderResult.executedQty) || qty;
    // Prefer avgPrice from the response; fall back to cumQuote/executedQty (standard
    // Binance-style calculation) when avgPrice is absent or "0"; finally fall back to
    // the theoretical price used for sizing so the entry is never stored as 0.
    let avgPrice = price;
    const rawAvg = Number(orderResult.avgPrice ?? 0);
    if (rawAvg > 0) {
      avgPrice = rawAvg;
    } else {
      const cumQuote = Number(orderResult.cumQuote ?? 0);
      if (cumQuote > 0 && filledQty > 0) avgPrice = cumQuote / filledQty;
    }

    return {
      orderId:      String(orderResult.orderId),
      exchange:     "aster",
      symbol,
      side,
      filledQty,
      avgPrice,
      status:       orderResult.status ?? "closed",
      feeCost:      0,
      contractSize: 1,
    };
  }
  // ─────────────────────────────────────────────────────────────────────────

  if (leverage && leverage !== 1) {
    try {
      await ex.setLeverage(leverage, marketSymbol);
    } catch (_) {}
  }

  const ticker = await ex.fetchTicker(marketSymbol);
  const price = ticker.last ?? ticker.bid ?? 1;
  let qty = usdAmount / price;
  const ccxtSide = side === "long" ? "buy" : "sell";

  const minNotional = MIN_NOTIONAL_BY_EXCHANGE[exchangeName];
  let contractSize = 1;
  try {
    await ex.loadMarkets();
    const market = ex.market(marketSymbol);
    // Enforce minimum notional if required by the exchange
    if (minNotional) {
      qty = Math.max(qty, minNotional / price);
    }
    // MEXC (and some other exchanges) use TICK_SIZE precision mode and pass
    // the amount straight to the API as `vol` (number of contracts) with no
    // base-currency → contract conversion.  We must divide by contractSize
    // before calling amountToPrecision/createMarketOrder to avoid placing an
    // order that is contractSize× too large (e.g. contractSize=4 → 4× overshoot).
    contractSize = (market?.contractSize as number | null | undefined) ?? 1;
    if (contractSize > 1) {
      qty = qty / contractSize;
    }
    // Use CCXT's own amountToPrecision so it handles each exchange's
    // precision mode (TICK_SIZE vs DECIMAL_PLACES) correctly.
    const rounded = parseFloat(ex.amountToPrecision(marketSymbol, qty));
    if (rounded > 0) qty = rounded;
  } catch (_) {
    if (minNotional) qty = Math.max(qty, minNotional / price);
  }

  logger.info({ exchange: exchangeName, symbol, side, usdAmount, price, qty }, "placeOrderInternal: placing order");

  let order;
  if (ex.id === "bybit") {
    order = await bybitCreateOrder(
      ex as InstanceType<typeof ccxt.bybit>,
      marketSymbol,
      ccxtSide,
      qty,
      { reduceOnly: false },
      side,
    );
  } else if (ex.id === "okx") {
    order = await ex.createMarketOrder(marketSymbol, ccxtSide, qty, undefined, {
      tdMode: "cross",
      posSide: side === "long" ? "long" : "short",
    });
  } else {
    order = await ex.createMarketOrder(marketSymbol, ccxtSide, qty, undefined, { reduceOnly: false });
  }

  const feeCost = await extractFeeFromOrder(ex, order, marketSymbol);

  // order.filled is in contracts when contractSize > 1 (exchanges like MEXC pass qty as vol/contracts).
  // Multiply back by contractSize so callers always receive base-currency (e.g. SKR) quantities.
  // This ensures stored qty values are in base units and P&L calculations are correct.
  const filledInContracts = order.filled ?? qty;
  const filledQty = contractSize > 1 ? filledInContracts * contractSize : filledInContracts;

  return {
    orderId: String(order.id),
    exchange: exchangeName,
    symbol,
    side,
    filledQty,
    avgPrice: order.average ?? price,
    status: order.status ?? "closed",
    feeCost,
    contractSize,
  };
}

router.post("/exchanges/jump-in", async (req: Request, res: Response) => {
  const parsed = JumpInBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "bad_request", message: parsed.error.message });
    return;
  }

  const { symbol, bybitSide, binanceSide, usdAmount, bybitLeverage, binanceLeverage } = parsed.data;
  const halfSize = usdAmount / 2;

  if (halfSize < 5) {
    res.status(400).json({ success: false, error: "Order size too small. Minimum is $10 total ($5 per exchange leg)." });
    return;
  }

  const bybitCreds = getBybitCredentials(req);
  const binanceCreds = getBinanceCredentials(req);

  if (!bybitCreds.apiKey || !bybitCreds.secret || !binanceCreds.apiKey || !binanceCreds.secret) {
    res.status(401).json({ error: "unauthorized", message: "Both exchange API credentials are required" });
    return;
  }

  const bybitEx = createBybitExchange(bybitCreds.apiKey, bybitCreds.secret);
  const binanceEx = createBinanceExchange(binanceCreds.apiKey, binanceCreds.secret);

  let bybitResult: Awaited<ReturnType<typeof placeOrderInternal>> | null = null;

  try {
    bybitResult = await placeOrderInternal(bybitEx, symbol, bybitSide as "long" | "short", halfSize, bybitLeverage);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Bybit order failed";
    req.log.error({ err }, "Jump-in: Bybit leg failed");
    res.status(400).json({ success: false, error: msg });
    return;
  }

  try {
    const binanceResult = await placeOrderInternal(binanceEx, symbol, binanceSide as "long" | "short", halfSize, binanceLeverage);
    res.json({ success: true, bybitResult, binanceResult });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Binance order failed";
    req.log.error({ err }, "Jump-in: Binance leg failed, compensating Bybit");

    const compensateSide = bybitSide === "long" ? "sell" : "buy";
    try {
      await bybitCreateOrder(bybitEx, `${symbol}/USDT:USDT`, compensateSide, bybitResult.filledQty, { reduceOnly: true }, bybitSide as "long" | "short");
      req.log.info("Jump-in: Bybit compensation order placed successfully");
    } catch (compErr) {
      req.log.error({ compErr }, "Jump-in: Compensation order FAILED - manual intervention required");
    }

    res.status(400).json({
      success: false,
      bybitResult,
      compensated: true,
      error: `Binance leg failed: ${msg}. Bybit position was closed as compensation.`,
    });
  }
});

ensurePriceFetch();

export type ClosePositionInternalParams = {
  exA: SupportedCcxtExchange;
  exB: SupportedCcxtExchange;
  symbol: string;
  sideA: "long" | "short";
  sideB: "long" | "short";
  qtyA: number;
  qtyB: number;
  /** contractSizeA > 1 means qtyA is in base units and must be ÷ contractSizeA before placing.
   *  null/undefined = legacy leg where qty is already in contracts (no conversion needed). */
  contractSizeA?: number | null;
  /** contractSizeB > 1 means qtyB is in base units and must be ÷ contractSizeB before placing.
   *  null/undefined = legacy leg where qty is already in contracts (no conversion needed). */
  contractSizeB?: number | null;
  spreadAtEntry?: number;
  entryTime?: Date;
  quantity?: number;
  longExchange?: string;
  shortExchange?: string;
};

export type ClosePositionInternalResult = {
  bothClosed: boolean;
  orderIdA: string | null;
  orderIdB: string | null;
  closeFeeA: number;
  closeFeeB: number;
  closePriceA: number | null;
  closePriceB: number | null;
  errorA?: string;
  errorB?: string;
  /** @deprecated use orderIdA */ bybitOrderId: string | null;
  /** @deprecated use orderIdB */ binanceOrderId: string | null;
  /** @deprecated use errorA */ bybitError?: string;
  /** @deprecated use errorB */ binanceError?: string;
};

async function closeOnExchange(
  ex: SupportedCcxtExchange,
  symbol: string,
  positionSide: "long" | "short",
  qty: number,
  contractSize?: number,
): Promise<{ orderId: string; feeCost: number; avgPrice: number | null }> {
  const marketSymbol = `${symbol}/USDT:USDT`;
  const closeSide = positionSide === "long" ? "sell" : "buy";

  // When contractSize > 1 is provided, qty is stored in base units — convert to contracts for the exchange.
  // When contractSize is absent (null/undefined), qty is already in contracts (legacy legs), use as-is.
  let closeQty = qty;
  if (contractSize != null && contractSize > 1) {
    closeQty = qty / contractSize;
  }

  // ── AsterDex: use custom EIP-712 client ──────────────────────────────────
  if (ex.id === "aster") {
    const creds = getAsterCreds(ex);
    if (!creds) throw new Error("AsterDex: missing wallet/signer credentials for close");

    try {
      const stepSize = await asterFetchMarketStepSize(symbol);
      closeQty = roundToStepSize(closeQty, stepSize);
    } catch (_) {}
    if (closeQty <= 0) closeQty = qty;

    const orderResult = await asterClosePosition(symbol, positionSide, closeQty, creds.walletAddress, creds.signerAddress, creds.privateKey);
    // Derive fill price: prefer avgPrice, then cumQuote/executedQty, then null so
    // the bot-watcher ?? fallback can use the price-cache value instead of 0.
    let asterCloseAvgPrice: number | null = null;
    const rawCloseAvg = Number(orderResult.avgPrice ?? 0);
    if (rawCloseAvg > 0) {
      asterCloseAvgPrice = rawCloseAvg;
    } else {
      const cumQuote = Number(orderResult.cumQuote ?? 0);
      const execQty  = Number(orderResult.executedQty ?? 0);
      if (cumQuote > 0 && execQty > 0) asterCloseAvgPrice = cumQuote / execQty;
    }
    return {
      orderId:  String(orderResult.orderId),
      feeCost:  0,
      avgPrice: asterCloseAvgPrice,
    };
  }
  // ─────────────────────────────────────────────────────────────────────────

  // Apply exchange precision rounding if available
  try {
    await ex.loadMarkets();
    const rounded = parseFloat(ex.amountToPrecision(marketSymbol, closeQty));
    if (rounded > 0) closeQty = rounded;
  } catch (_) {}

  let order;
  if (ex.id === "bybit") {
    order = await bybitCreateOrder(
      ex as InstanceType<typeof ccxt.bybit>,
      marketSymbol,
      closeSide,
      closeQty,
      { reduceOnly: true },
      positionSide,
    );
  } else if (ex.id === "okx") {
    order = await ex.createMarketOrder(marketSymbol, closeSide, closeQty, undefined, {
      tdMode: "cross",
      posSide: positionSide === "long" ? "long" : "short",
      reduceOnly: true,
    });
  } else {
    order = await ex.createMarketOrder(marketSymbol, closeSide, closeQty, undefined, { reduceOnly: true });
  }
  const feeCost = await extractFeeFromOrder(ex, order, marketSymbol);
  return { orderId: String(order.id), feeCost, avgPrice: order.average ?? null };
}

export async function closePositionInternal(
  params: ClosePositionInternalParams,
): Promise<ClosePositionInternalResult> {
  const {
    exA, exB, symbol, sideA, sideB, qtyA, qtyB,
    contractSizeA, contractSizeB,
    spreadAtEntry, entryTime, quantity, longExchange, shortExchange,
  } = params;

  const [orderA, orderB] = await Promise.allSettled([
    closeOnExchange(exA, symbol, sideA, qtyA, contractSizeA ?? undefined),
    closeOnExchange(exB, symbol, sideB, qtyB, contractSizeB ?? undefined),
  ]);

  const bothClosed = orderA.status === "fulfilled" && orderB.status === "fulfilled";
  const orderIdA = orderA.status === "fulfilled" ? orderA.value.orderId : null;
  const orderIdB = orderB.status === "fulfilled" ? orderB.value.orderId : null;
  const closeFeeA = orderA.status === "fulfilled" ? orderA.value.feeCost : 0;
  const closeFeeB = orderB.status === "fulfilled" ? orderB.value.feeCost : 0;
  const closePriceA = orderA.status === "fulfilled" ? orderA.value.avgPrice : null;
  const closePriceB = orderB.status === "fulfilled" ? orderB.value.avgPrice : null;
  const errorA = orderA.status === "rejected" ? String(orderA.reason) : undefined;
  const errorB = orderB.status === "rejected" ? String(orderB.reason) : undefined;

  return {
    bothClosed,
    orderIdA,
    orderIdB,
    closeFeeA,
    closeFeeB,
    closePriceA,
    closePriceB,
    errorA,
    errorB,
    bybitOrderId: orderIdA,
    binanceOrderId: orderIdB,
    bybitError: errorA,
    binanceError: errorB,
  };
}

export default router;
