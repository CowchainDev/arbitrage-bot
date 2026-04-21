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

function createBybitExchange(apiKey = "", secret = "") {
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
async function bybitCreateOrder(
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

function createBinanceExchange(apiKey = "", secret = "") {
  return new ccxt.binance({
    apiKey,
    secret,
    options: {
      defaultType: "future",
    },
  });
}

function createGateExchange() {
  return new ccxt.gateio({
    options: { defaultType: "swap" },
  });
}

function createOkxExchange() {
  return new ccxt.okx({
    options: { defaultType: "swap" },
  });
}

function createMexcExchange() {
  return new ccxt.mexc({
    options: { defaultType: "swap" },
  });
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

    const bybitCloseSide = bybitSide === "long" ? "sell" : "buy";
    const binanceCloseSide = binanceSide === "long" ? "sell" : "buy";

    const [bybitOrder, binanceOrder] = await Promise.allSettled([
      bybitCreateOrder(bybit, `${symbol}/USDT:USDT`, bybitCloseSide, bybitQty, { reduceOnly: true }, bybitSide as "long" | "short"),
      binance.createMarketOrder(
        `${symbol}/USDT:USDT`,
        binanceCloseSide,
        binanceQty,
        undefined,
        { reduceOnly: true }
      ),
    ]);

    const bybitResult = bybitOrder.status === "fulfilled"
      ? {
          orderId: String(bybitOrder.value.id),
          exchange: "bybit",
          symbol,
          side: bybitCloseSide,
          filledQty: bybitOrder.value.filled ?? bybitQty,
          avgPrice: bybitOrder.value.average ?? 0,
          status: bybitOrder.value.status ?? "closed",
        }
      : null;

    const binanceResult = binanceOrder.status === "fulfilled"
      ? {
          orderId: String(binanceOrder.value.id),
          exchange: "binance",
          symbol,
          side: binanceCloseSide,
          filledQty: binanceOrder.value.filled ?? binanceQty,
          avgPrice: binanceOrder.value.average ?? 0,
          status: binanceOrder.value.status ?? "closed",
        }
      : null;

    const bothClosed = bybitOrder.status === "fulfilled" && binanceOrder.status === "fulfilled";
    const bybitError = bybitOrder.status === "rejected" ? String(bybitOrder.reason) : undefined;
    const binanceError = binanceOrder.status === "rejected" ? String(binanceOrder.reason) : undefined;

    if (!bothClosed) {
      req.log.warn({ bybitError, binanceError }, "close-position: partial failure");
    }

    const realizedPnl = clientRealizedPnl ?? 0;

    if (bothClosed) {
      try {
        await db.insert(closedTradesTable).values({
          symbol,
          longExchange,
          shortExchange,
          spreadAtEntry: String(spreadAtEntry),
          realizedPnl: String(realizedPnl),
          quantity: String(quantity),
          entryTime: entryTime ? new Date(entryTime) : new Date(),
          closeTime: new Date(),
        });
      } catch (dbErr) {
        req.log.error({ dbErr }, "close-position: failed to record trade to DB");
      }
    }

    res.json({
      success: bothClosed,
      bybitResult,
      binanceResult,
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

async function placeOrderInternal(
  ex: ReturnType<typeof createBybitExchange> | ReturnType<typeof createBinanceExchange>,
  symbol: string,
  side: "long" | "short",
  usdAmount: number,
  leverage: number | undefined
): Promise<{ orderId: string; exchange: string; symbol: string; side: string; filledQty: number; avgPrice: number; status: string }> {
  if (leverage && leverage !== 1) {
    try {
      await ex.setLeverage(leverage, `${symbol}/USDT:USDT`);
    } catch (_) {}
  }

  const ticker = await ex.fetchTicker(`${symbol}/USDT:USDT`);
  const price = ticker.last ?? ticker.bid ?? 1;
  const qty = usdAmount / price;
  const ccxtSide = side === "long" ? "buy" : "sell";
  const exchangeName = ex.id;

  const order = ex.id === "bybit"
    ? await bybitCreateOrder(ex as InstanceType<typeof ccxt.bybit>, `${symbol}/USDT:USDT`, ccxtSide, qty, { reduceOnly: false }, side)
    : await ex.createMarketOrder(`${symbol}/USDT:USDT`, ccxtSide, qty, undefined, { reduceOnly: false });

  return {
    orderId: String(order.id),
    exchange: exchangeName,
    symbol,
    side,
    filledQty: order.filled ?? qty,
    avgPrice: order.average ?? price,
    status: order.status ?? "closed",
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

export default router;
