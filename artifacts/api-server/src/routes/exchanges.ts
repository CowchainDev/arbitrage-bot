import { Router, type IRouter, type Request, type Response } from "express";
import ccxt from "ccxt";
import {
  PlaceOrderBody,
  ClosePositionBody,
  JumpInBody,
} from "@workspace/api-zod";
import { db } from "@workspace/db";
import { closedTradesTable } from "@workspace/db";

const router: IRouter = Router();

let priceCache: { data: unknown[]; ts: number } | null = null;
let priceFetchInFlight: Promise<unknown[]> | null = null;
const PRICE_CACHE_TTL_MS = 9_000;

type KlinesCacheEntry = { data: Record<string, { t: number; c: number }[]>; ts: number };
const klinesCache = new Map<string, KlinesCacheEntry>();
const KLINES_TTL_SHORT_MS = 2 * 60 * 1000;
const KLINES_TTL_LONG_MS  = 10 * 60 * 1000;

function getKlinesCacheTtl(interval: string): number {
  return interval === "4h" || interval === "1d" ? KLINES_TTL_LONG_MS : KLINES_TTL_SHORT_MS;
}

export const PREWARM_SYMBOLS = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE"];
export const PREWARM_INTERVALS = ["15m", "1h", "4h", "1d"];
const PREWARM_LIMIT_BY_INTERVAL: Record<string, number> = {
  "15m": 96,
  "1h":  168,
  "4h":  90,
  "1d":  60,
};
const PREWARM_CONCURRENCY = 4;
const PREWARM_TOP_N = 10;
const KLINES_TIMEOUT_MS = 4000;
const RELAY_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// Direct REST fetch helpers (no ccxt) — used by the relay endpoint and as
// fallback when KLINES_RELAY_URL is configured.
// These functions return { t: ms, c: closePrice }[] sorted oldest-first.
// ---------------------------------------------------------------------------

type OhlcvPoint = { t: number; c: number };

async function fetchBinanceOhlcvDirect(symbol: string, interval: string, limit: number): Promise<OhlcvPoint[]> {
  const intervalMap: Record<string, string> = { "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" };
  const tf = intervalMap[interval] ?? "1h";
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}USDT&interval=${tf}&limit=${Math.min(limit, 500)}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`Binance HTTP ${resp.status}`);
  const rows = await resp.json() as [number, string, string, string, string, ...unknown[]][];
  return rows.map((r) => ({ t: r[0], c: parseFloat(r[4]) })).filter((p) => p.t > 0 && p.c > 0);
}

async function fetchBybitOhlcvDirect(symbol: string, interval: string, limit: number): Promise<OhlcvPoint[]> {
  const intervalMap: Record<string, string> = { "15m": "15", "1h": "60", "4h": "240", "1d": "D" };
  const tf = intervalMap[interval] ?? "60";
  const clampedLimit = Math.min(limit, 200);
  const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}USDT&interval=${tf}&limit=${clampedLimit}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`Bybit HTTP ${resp.status}`);
  type BybitResp = { retCode: number; result: { list: [string, string, string, string, string, ...unknown[]][] } };
  const json = await resp.json() as BybitResp;
  if (json.retCode !== 0) throw new Error(`Bybit retCode ${json.retCode}`);
  return json.result.list
    .map((r) => ({ t: parseInt(r[0], 10), c: parseFloat(r[4]) }))
    .filter((p) => p.t > 0 && p.c > 0)
    .reverse();
}

async function fetchGateOhlcvDirect(symbol: string, interval: string, limit: number): Promise<OhlcvPoint[]> {
  const intervalMap: Record<string, string> = { "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" };
  const tf = intervalMap[interval] ?? "1h";
  const contract = `${symbol}_USDT`;
  const url = `https://fx.gate.io/api/v4/futures/usdt/candlesticks?contract=${contract}&interval=${tf}&limit=${Math.min(limit, 2000)}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`Gate HTTP ${resp.status}`);
  type GateCandle = { t: number; c: string };
  const rows = await resp.json() as GateCandle[];
  return rows.map((r) => ({ t: r.t * 1000, c: parseFloat(r.c) })).filter((p) => p.t > 0 && p.c > 0);
}

async function fetchOkxOhlcvDirect(symbol: string, interval: string, limit: number): Promise<OhlcvPoint[]> {
  const intervalMap: Record<string, string> = { "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D" };
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

    const batch = json.data.map((r) => ({ t: parseInt(r[0], 10), c: parseFloat(r[4]) })).filter((p) => p.t > 0 && p.c > 0);
    points.unshift(...batch);
    remaining -= batch.length;
    if (batch.length < batchSize) break;
    after = String(json.data[json.data.length - 1][0]);
  }

  return points;
}

async function fetchMexcOhlcvDirect(symbol: string, interval: string, limit: number): Promise<OhlcvPoint[]> {
  const intervalMap: Record<string, string> = { "15m": "Min15", "1h": "Min60", "4h": "Hour4", "1d": "Day1" };
  const tf = intervalMap[interval] ?? "Min60";
  const intervalMs: Record<string, number> = { "15m": 15 * 60_000, "1h": 60 * 60_000, "4h": 4 * 60 * 60_000, "1d": 24 * 60 * 60_000 };
  const msPerCandle = intervalMs[interval] ?? 60 * 60_000;
  const end = Date.now();
  const start = end - msPerCandle * Math.min(limit, 2000);
  const contract = `${symbol}_USDT`;
  const url = `https://contract.mexc.com/api/v1/contract/kline/${contract}?interval=${tf}&start=${Math.floor(start / 1000)}&end=${Math.floor(end / 1000)}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(RELAY_TIMEOUT_MS) });
  if (!resp.ok) throw new Error(`MEXC HTTP ${resp.status}`);
  type MexcResp = { success: boolean; data: { time: number[]; close: number[] } };
  const json = await resp.json() as MexcResp;
  if (!json.success || !json.data) throw new Error("MEXC response error");
  return json.data.time
    .map((t, i) => ({ t: t * 1000, c: json.data.close[i] }))
    .filter((p) => p.t > 0 && p.c > 0);
}

const DIRECT_FETCHERS: Record<string, (symbol: string, interval: string, limit: number) => Promise<OhlcvPoint[]>> = {
  binance: fetchBinanceOhlcvDirect,
  bybit:   fetchBybitOhlcvDirect,
  gate:    fetchGateOhlcvDirect,
  okx:     fetchOkxOhlcvDirect,
  mexc:    fetchMexcOhlcvDirect,
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
    return ccxtFallback();
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
    "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d",
  };
  const timeframe = timeframeMap[interval] ?? "1h";

  type OhlcvRow = [number, number, number, number, number, number?];

  const exchangeDefs = [
    { name: "bybit",   create: () => createBybitExchange() },
    { name: "binance", create: () => createBinanceExchange() },
    { name: "gate",    create: () => createGateExchange() },
    { name: "okx",     create: () => createOkxExchange() },
    { name: "mexc",    create: () => createMexcExchange() },
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
        return raw.map((row) => ({ t: row[0], c: row[4] })).filter((p) => p.t > 0 && p.c > 0);
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
  }
}

export const KLINES_PREWARM_INTERVAL_MS = KLINES_TTL_SHORT_MS;

function getTopSymbolsByVolume(n: number): string[] {
  // Always anchor with BTC/ETH/SOL, then fill the rest from live volume data
  const anchors = new Set(PREWARM_SYMBOLS);
  if (!priceCache || priceCache.data.length === 0) return PREWARM_SYMBOLS;
  type PriceRow = { symbol: string; volume24h?: number };
  const rows = priceCache.data as PriceRow[];
  const sorted = [...rows]
    .filter((r) => typeof r.volume24h === "number" && !anchors.has(r.symbol))
    .sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0));
  const extras = sorted.slice(0, Math.max(0, n - anchors.size)).map((r) => r.symbol);
  return [...PREWARM_SYMBOLS, ...extras];
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
      batch.map(({ symbol, interval }) => fetchKlinesForSymbol(symbol, interval, PREWARM_LIMIT_BY_INTERVAL[interval] ?? 96))
    );
    results.push(...batchResults);
  }

  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.length - succeeded;

  return { succeeded, failed, symbols };
}

type SymbolPriceEntry = { bybitPrice: number | null; binancePrice: number | null };
const priceCacheBySymbol = new Map<string, SymbolPriceEntry>();

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

async function fetchAndCachePrices(): Promise<unknown[]> {
  const bybit = createBybitExchange();
  const binance = createBinanceExchange();
  const gate = createGateExchange();
  const okx = createOkxExchange();
  const mexc = createMexcExchange();

  const [
    bybitTickers, binanceTickers, gateTickers, okxTickers, mexcTickers,
    bybitFunding, binanceFunding, gateFunding, okxFunding, mexcFunding,
    bybitOIResult, binanceOIResult,
  ] = await Promise.allSettled([
    bybit.fetchTickers(undefined, { type: "linear" }),
    binance.fetchTickers(undefined, { type: "future" }),
    gate.fetchTickers(undefined, { type: "swap" }),
    okx.fetchTickers(undefined, { type: "swap" }),
    mexc.fetchTickers(undefined, { type: "swap" }),
    bybit.fetchFundingRates(),
    binance.fetchFundingRates(),
    gate.fetchFundingRates(),
    okx.fetchFundingRates(),
    mexc.fetchFundingRates(),
    bybit.fetchOpenInterests(undefined, { type: "linear" }),
    binance.fetchOpenInterests(undefined, { type: "future" }),
  ]);

  const bybitMap   = buildTickerMap(bybitTickers.status   === "fulfilled" ? bybitTickers.value   : {});
  const binanceMap = buildTickerMap(binanceTickers.status === "fulfilled" ? binanceTickers.value : {});
  const gateMap    = buildTickerMap(gateTickers.status    === "fulfilled" ? gateTickers.value    : {});
  const okxMap     = buildTickerMap(okxTickers.status     === "fulfilled" ? okxTickers.value     : {});
  const mexcMap    = buildTickerMap(mexcTickers.status    === "fulfilled" ? mexcTickers.value    : {});

  const bybitFundingMap  = bybitFunding.status  === "fulfilled" ? bybitFunding.value  : {};
  const binanceFundingMap = binanceFunding.status === "fulfilled" ? binanceFunding.value : {};
  const gateFundingMap   = gateFunding.status   === "fulfilled" ? gateFunding.value   : {};
  const okxFundingMap    = okxFunding.status    === "fulfilled" ? okxFunding.value    : {};
  const mexcFundingMap   = mexcFunding.status   === "fulfilled" ? mexcFunding.value   : {};

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

  const allBases = new Set([
    ...bybitMap.keys(), ...binanceMap.keys(), ...gateMap.keys(),
    ...okxMap.keys(), ...mexcMap.keys(),
  ]);

  const spreads = [];

  for (const base of allBases) {
    const key = `${base}/USDT:USDT`;

    const bybitT   = bybitMap.get(base);
    const binanceT = binanceMap.get(base);
    const gateT    = gateMap.get(base);
    const okxT     = okxMap.get(base);
    const mexcT    = mexcMap.get(base);

    const bybitPrice   = bybitT   ? (bybitT.last   ?? bybitT.bid   ?? 0) : 0;
    const binancePrice = binanceT ? (binanceT.last  ?? binanceT.bid ?? 0) : 0;
    const gatePrice    = gateT    ? (gateT.last     ?? gateT.bid    ?? 0) : 0;
    const okxPrice     = okxT     ? (okxT.last      ?? okxT.bid     ?? 0) : 0;
    const mexcPrice    = mexcT    ? (mexcT.last      ?? mexcT.bid    ?? 0) : 0;

    if (!bybitPrice && !binancePrice) continue;

    const rawPriceList = [bybitPrice, binancePrice, gatePrice, okxPrice, mexcPrice];
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

    const cleanPrices = [bybitPriceC, binancePriceC, gatePriceC, okxPriceC, mexcPriceC];
    if (cleanPrices.filter(p => p > 0).length < 2) continue;

    const totalVolume =
      (bybitT?.quoteVolume ?? 0) + (binanceT?.quoteVolume ?? 0) +
      (gateT?.quoteVolume ?? 0) + (okxT?.quoteVolume ?? 0) + (mexcT?.quoteVolume ?? 0);
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
    };

    const { bestSpreadPct, bestSpreadLeg } = computeBestSpread(allPrices);

    // Open interest: sum from explicit OI fetches for Bybit + Binance.
    const oiBB = bybitOIMap.get(base) ?? 0;
    const oiBN = binanceOIMap.get(base) ?? 0;
    const openInterestUsd = (oiBB + oiBN) > 0 ? (oiBB + oiBN) : null;

    // Spread depth: min(ask depth on cheaper leg, bid depth on expensive leg) in USD,
    // using the same exchange pair that forms the best spread.
    // Only set when BOTH sides provide usable bid/ask volume — null otherwise (graceful degradation).
    let spreadDepthUsd: number | null = null;
    if (bestSpreadLeg) {
      const [cheapExchange, expensiveExchange] = bestSpreadLeg.split("/");
      const tickerMap: Record<string, ReturnType<typeof bybitMap.get>> = {
        bybit: bybitT, binance: binanceT, gate: gateT, okx: okxT, mexc: mexcT,
      };
      const priceMap: Record<string, number> = {
        bybit: bybitPriceC, binance: binancePriceC, gate: gatePriceC, okx: okxPriceC, mexc: mexcPriceC,
      };
      const cheapT    = tickerMap[cheapExchange];
      const expensiveT = tickerMap[expensiveExchange];
      const cheapPx    = priceMap[cheapExchange];
      const expensivePx = priceMap[expensiveExchange];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sideDepthUsd = (t: any, price: number, side: "bid" | "ask"): number => {
        if (t == null || !price) return 0;
        const vol = side === "bid" ? (t.bidVolume ?? 0) : (t.askVolume ?? 0);
        const px  = side === "bid" ? (t.bid  ?? price)  : (t.ask ?? price);
        return typeof vol === "number" && vol > 0 ? vol * px : 0;
      };
      const cheapAsk    = sideDepthUsd(cheapT,    cheapPx,    "ask");
      const expensiveBid = sideDepthUsd(expensiveT, expensivePx, "bid");
      if (cheapAsk > 0 && expensiveBid > 0) {
        spreadDepthUsd = Math.min(cheapAsk, expensiveBid);
      }
      // If one or both sides have no volume data, spreadDepthUsd stays null
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
      bestSpreadPct,
      bestSpreadLeg,
      volume24h: totalVolume,
      openInterestUsd,
      spreadDepthUsd,
    });
  }

  priceCacheBySymbol.clear();
  for (const s of spreads) {
    priceCacheBySymbol.set(s.symbol, {
      bybitPrice: s.bybitPrice as number | null,
      binancePrice: s.binancePrice as number | null,
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

export type SupportedCcxtExchange =
  | ReturnType<typeof createBybitExchange>
  | ReturnType<typeof createBinanceExchange>
  | ReturnType<typeof createGateExchange>
  | ReturnType<typeof createOkxExchange>
  | ReturnType<typeof createMexcExchange>;

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

    const allPrices: Record<string, ExchangePrices | null> = {
      bybit: { price: bybitPrice, bid: bybitPrice - spread, ask: bybitPrice + spread, fundingRate: (Math.random() - 0.4) * 0.001 },
      binance: { price: binancePrice, bid: binancePrice - spread, ask: binancePrice + spread, fundingRate: (Math.random() - 0.4) * 0.001 },
      gate: { price: gatePrice, bid: gatePrice - spread, ask: gatePrice + spread, fundingRate: (Math.random() - 0.4) * 0.001 },
      okx: { price: okxPrice, bid: okxPrice - spread, ask: okxPrice + spread, fundingRate: (Math.random() - 0.4) * 0.001 },
      mexc: { price: mexcPrice, bid: mexcPrice - spread, ask: mexcPrice + spread, fundingRate: (Math.random() - 0.4) * 0.001 },
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
      bestSpreadPct,
      bestSpreadLeg,
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

    let spreads = await ensurePriceFetch();

    if (spreads.length === 0) {
      const demo = generateDemoSpreads();
      priceCache = { data: demo, ts: Date.now() - PRICE_CACHE_TTL_MS + 15_000 };
      return demo;
    }

    return spreads as ReturnType<typeof generateDemoSpreads>;
  } catch {
    return generateDemoSpreads();
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

  const cacheKey = `${symbol}:${interval}:${limit}`;
  const cached = klinesCache.get(cacheKey);
  const ttl = getKlinesCacheTtl(interval);
  if (cached && Date.now() - cached.ts < ttl) {
    res.json(cached.data);
    return;
  }

  const ccxtSymbol = `${symbol}/USDT:USDT`;
  const timeframeMap: Record<string, string> = {
    "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d",
  };
  const timeframe = timeframeMap[interval] ?? "1h";

  type OhlcvRow = [number, number, number, number, number, number?];

  const exchangeDefs = [
    { name: "bybit",   create: () => createBybitExchange() },
    { name: "binance", create: () => createBinanceExchange() },
    { name: "gate",    create: () => createGateExchange() },
    { name: "okx",     create: () => createOkxExchange() },
    { name: "mexc",    create: () => createMexcExchange() },
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
        return raw.map((row) => ({ t: row[0], c: row[4] })).filter((p) => p.t > 0 && p.c > 0);
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
  }

  res.json(out);
});

router.get("/exchanges/prices", async (req: Request, res: Response) => {
  try {
    const spreads = await fetchPriceSpreads();
    if (spreads.length > 0 && (spreads[0] as { demo?: boolean }).demo) {
      req.log.warn("Live exchange data unavailable, returning demo data");
    }
    res.json(spreads);
  } catch (err) {
    req.log.error({ err }, "Error fetching exchange prices, returning demo data");
    const demo = generateDemoSpreads();
    priceCache = { data: demo, ts: Date.now() - PRICE_CACHE_TTL_MS + 15_000 };
    res.json(demo);
  }
});

router.get("/exchanges/balances", async (req: Request, res: Response) => {
  const bybitCreds = getBybitCredentials(req);
  const binanceCreds = getBinanceCredentials(req);

  if (!bybitCreds.apiKey || !bybitCreds.secret || !binanceCreds.apiKey || !binanceCreds.secret) {
    res.status(401).json({ error: "unauthorized", message: "API credentials required" });
    return;
  }

  try {
    const bybit = createBybitExchange(bybitCreds.apiKey, bybitCreds.secret);
    const binance = createBinanceExchange(binanceCreds.apiKey, binanceCreds.secret);

    const [bybitBalance, binanceBalance] = await Promise.allSettled([
      bybit.fetchBalance({ type: "linear" }),
      binance.fetchBalance({ type: "future" }),
    ]);

    let bybitUsdt = 0;
    let bybitPnl = 0;
    if (bybitBalance.status === "fulfilled") {
      bybitUsdt = bybitBalance.value.USDT?.free ?? bybitBalance.value.USDT?.total ?? 0;
      bybitPnl = (bybitBalance.value.info as Record<string, unknown>)?.totalUnrealisedPnl as number ?? 0;
    }

    let binanceUsdt = 0;
    let binancePnl = 0;
    if (binanceBalance.status === "fulfilled") {
      binanceUsdt = binanceBalance.value.USDT?.free ?? binanceBalance.value.USDT?.total ?? 0;
      binancePnl = (binanceBalance.value.info as Record<string, unknown>)?.totalUnrealizedProfit as number ?? 0;
    }

    res.json({
      bybit: Number(bybitUsdt) || 0,
      binance: Number(binanceUsdt) || 0,
      bybitPnl: Number(bybitPnl) || 0,
      binancePnl: Number(binancePnl) || 0,
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
  const longExchange = typeof body["longExchange"] === "string" ? body["longExchange"] : "bybit";
  const shortExchange = typeof body["shortExchange"] === "string" ? body["shortExchange"] : "binance";
  const spreadAtEntry = typeof body["spreadAtEntry"] === "number" ? body["spreadAtEntry"] : 0;
  const entryTime = typeof body["entryTime"] === "string" ? body["entryTime"] : undefined;
  const quantity = typeof body["quantity"] === "number" ? body["quantity"] : 0;
  const clientRealizedPnl = typeof body["realizedPnl"] === "number" ? body["realizedPnl"] : null;

  const bybitCreds = getBybitCredentials(req);
  const binanceCreds = getBinanceCredentials(req);

  try {
    const bybit = createBybitExchange(bybitCreds.apiKey, bybitCreds.secret);
    const binance = createBinanceExchange(binanceCreds.apiKey, binanceCreds.secret);

    const result = await closePositionInternal({
      exA: bybit,
      exB: binance,
      symbol,
      sideA: bybitSide as "long" | "short",
      sideB: binanceSide as "long" | "short",
      qtyA: bybitQty,
      qtyB: binanceQty,
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

    res.json({
      success: result.bothClosed,
      bybitResult: result.orderIdA
        ? { orderId: result.orderIdA, exchange: "bybit", symbol, filledQty: bybitQty }
        : null,
      binanceResult: result.orderIdB
        ? { orderId: result.orderIdB, exchange: "binance", symbol, filledQty: binanceQty }
        : null,
      realizedPnl,
    });
  } catch (err) {
    req.log.error({ err }, "Error closing position");
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: "close_failed", message: msg });
  }
});

router.get("/positions", async (req: Request, res: Response) => {
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
          totalPnl: bybitPnlVal + binancePnlVal,
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
  order: { id: unknown; fee?: { cost?: unknown } | null; [key: string]: unknown },
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
): Promise<{ orderId: string; exchange: string; symbol: string; side: string; filledQty: number; avgPrice: number; status: string; feeCost: number }> {
  const marketSymbol = `${symbol}/USDT:USDT`;

  if (leverage && leverage !== 1) {
    try {
      await ex.setLeverage(leverage, marketSymbol);
    } catch (_) {}
  }

  const ticker = await ex.fetchTicker(marketSymbol);
  const price = ticker.last ?? ticker.bid ?? 1;
  let qty = usdAmount / price;
  const ccxtSide = side === "long" ? "buy" : "sell";
  const exchangeName = ex.id;

  const minNotional = MIN_NOTIONAL_BY_EXCHANGE[exchangeName];
  if (minNotional) {
    try {
      await ex.loadMarkets();
      const market = ex.market(marketSymbol);
      const decimalPlaces: number = market?.precision?.amount ?? 8;
      const stepSize = Math.pow(10, -decimalPlaces);
      const stepsNeeded = Math.max(
        Math.ceil(qty / stepSize),
        Math.ceil(minNotional / (stepSize * price)),
      );
      qty = stepsNeeded * stepSize;
    } catch (_) {
      qty = Math.max(qty, minNotional / price);
    }
  }

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

  return {
    orderId: String(order.id),
    exchange: exchangeName,
    symbol,
    side,
    filledQty: order.filled ?? qty,
    avgPrice: order.average ?? price,
    status: order.status ?? "closed",
    feeCost,
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
): Promise<{ orderId: string; feeCost: number }> {
  const marketSymbol = `${symbol}/USDT:USDT`;
  const closeSide = positionSide === "long" ? "sell" : "buy";
  let order;
  if (ex.id === "bybit") {
    order = await bybitCreateOrder(
      ex as InstanceType<typeof ccxt.bybit>,
      marketSymbol,
      closeSide,
      qty,
      { reduceOnly: true },
      positionSide,
    );
  } else if (ex.id === "okx") {
    order = await ex.createMarketOrder(marketSymbol, closeSide, qty, undefined, {
      tdMode: "cross",
      posSide: positionSide === "long" ? "long" : "short",
      reduceOnly: true,
    });
  } else {
    order = await ex.createMarketOrder(marketSymbol, closeSide, qty, undefined, { reduceOnly: true });
  }
  const feeCost = await extractFeeFromOrder(ex, order, marketSymbol);
  return { orderId: String(order.id), feeCost };
}

export async function closePositionInternal(
  params: ClosePositionInternalParams,
): Promise<ClosePositionInternalResult> {
  const {
    exA, exB, symbol, sideA, sideB, qtyA, qtyB,
    spreadAtEntry, entryTime, quantity, longExchange, shortExchange,
  } = params;

  const [orderA, orderB] = await Promise.allSettled([
    closeOnExchange(exA, symbol, sideA, qtyA),
    closeOnExchange(exB, symbol, sideB, qtyB),
  ]);

  const bothClosed = orderA.status === "fulfilled" && orderB.status === "fulfilled";
  const orderIdA = orderA.status === "fulfilled" ? orderA.value.orderId : null;
  const orderIdB = orderB.status === "fulfilled" ? orderB.value.orderId : null;
  const closeFeeA = orderA.status === "fulfilled" ? orderA.value.feeCost : 0;
  const closeFeeB = orderB.status === "fulfilled" ? orderB.value.feeCost : 0;
  const errorA = orderA.status === "rejected" ? String(orderA.reason) : undefined;
  const errorB = orderB.status === "rejected" ? String(orderB.reason) : undefined;

  if (bothClosed && spreadAtEntry !== undefined) {
    try {
      await db.insert(closedTradesTable).values({
        symbol,
        longExchange: longExchange ?? (sideA === "long" ? exA.id : exB.id),
        shortExchange: shortExchange ?? (sideA === "short" ? exA.id : exB.id),
        spreadAtEntry: String(spreadAtEntry),
        realizedPnl: "0",
        quantity: String(quantity ?? qtyA),
        entryTime: entryTime ?? new Date(),
        closeTime: new Date(),
      });
    } catch {
      // Non-fatal: DB logging failure should not abort position close
    }
  }

  return {
    bothClosed,
    orderIdA,
    orderIdB,
    closeFeeA,
    closeFeeB,
    errorA,
    errorB,
    bybitOrderId: orderIdA,
    binanceOrderId: orderIdB,
    bybitError: errorA,
    binanceError: errorB,
  };
}

export default router;
