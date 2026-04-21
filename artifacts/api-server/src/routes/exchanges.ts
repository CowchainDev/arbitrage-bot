import { Router, type IRouter, type Request, type Response } from "express";
import ccxt from "ccxt";
import {
  PlaceOrderBody,
  ClosePositionBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

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

function createBinanceExchange(apiKey = "", secret = "") {
  return new ccxt.binance({
    apiKey,
    secret,
    options: {
      defaultType: "future",
    },
  });
}

const POPULAR_SYMBOLS = [
  "BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "AVAX", "DOT", "LINK",
  "MATIC", "UNI", "ATOM", "LTC", "BCH", "ETC", "FIL", "APT", "ARB", "OP",
  "SUI", "SEI", "TIA", "INJ", "NEAR", "ALGO", "SAND", "MANA", "AXS", "ENJ",
  "CHZ", "1000SHIB", "PEPE", "WLD", "JTO", "PYTH", "RNDR", "FET", "AGIX",
  "RUNE", "STX", "IMX", "GRT", "AAVE", "MKR", "SNX", "CRV", "LDO", "RPL",
];

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

function generateDemoSpreads() {
  const nextFundingOffset = 3600 * 1000 * (Math.floor(Date.now() / (3600 * 8 * 1000) + 1) * 8 - Math.floor(Date.now() / (3600 * 1000)));
  const nextFundingTime = new Date(Date.now() + nextFundingOffset).toISOString();

  return Object.entries(DEMO_BASE_PRICES).map(([symbol, basePrice]) => {
    const noise1 = (Math.random() - 0.5) * 0.002;
    const noise2 = (Math.random() - 0.5) * 0.002;
    const spreadBias = (Math.random() - 0.5) * 0.03;
    const bybitPrice = basePrice * (1 + noise1 + spreadBias / 2);
    const binancePrice = basePrice * (1 + noise2 - spreadBias / 2);
    const spreadPct = ((bybitPrice - binancePrice) / binancePrice) * 100;
    const bybitFundingRate = (Math.random() - 0.4) * 0.001;
    const binanceFundingRate = (Math.random() - 0.4) * 0.001;
    const spread = basePrice * 0.0001;

    return {
      symbol,
      bybitPrice,
      binancePrice,
      spreadPct,
      bybitFundingRate,
      binanceFundingRate,
      bybitNextFunding: nextFundingTime,
      binanceNextFunding: nextFundingTime,
      bybitBid: bybitPrice - spread,
      bybitAsk: bybitPrice + spread,
      binanceBid: binancePrice - spread,
      binanceAsk: binancePrice + spread,
      volume24h: basePrice * Math.random() * 50000000,
      demo: true,
    };
  }).sort((a, b) => Math.abs(b.spreadPct) - Math.abs(a.spreadPct));
}

router.get("/exchanges/prices", async (req: Request, res: Response) => {
  try {
    const bybit = createBybitExchange();
    const binance = createBinanceExchange();

    const [bybitTickers, binanceTickers, bybitFunding, binanceFunding] =
      await Promise.allSettled([
        bybit.fetchTickers(undefined, { type: "linear" }),
        binance.fetchTickers(undefined, { type: "future" }),
        bybit.fetchFundingRates(),
        binance.fetchFundingRates(),
      ]);

    const bybitTickerMap =
      bybitTickers.status === "fulfilled" ? bybitTickers.value : {};
    const binanceTickerMap =
      binanceTickers.status === "fulfilled" ? binanceTickers.value : {};
    const bybitFundingMap =
      bybitFunding.status === "fulfilled" ? bybitFunding.value : {};
    const binanceFundingMap =
      binanceFunding.status === "fulfilled" ? binanceFunding.value : {};

    const spreads = [];

    for (const symbol of POPULAR_SYMBOLS) {
      const bybitKey = `${symbol}/USDT:USDT`;
      const binanceKey = `${symbol}/USDT:USDT`;

      const bybitTicker = bybitTickerMap[bybitKey];
      const binanceTicker = binanceTickerMap[binanceKey];

      if (!bybitTicker || !binanceTicker) continue;

      const bybitPrice = bybitTicker.last ?? bybitTicker.bid ?? 0;
      const binancePrice = binanceTicker.last ?? binanceTicker.bid ?? 0;

      if (!bybitPrice || !binancePrice) continue;

      const spreadPct = ((bybitPrice - binancePrice) / binancePrice) * 100;

      const bybitFundingData = bybitFundingMap[bybitKey];
      const binanceFundingData = binanceFundingMap[binanceKey];

      spreads.push({
        symbol,
        bybitPrice,
        binancePrice,
        spreadPct,
        bybitFundingRate: bybitFundingData?.fundingRate ?? null,
        binanceFundingRate: binanceFundingData?.fundingRate ?? null,
        bybitNextFunding: bybitFundingData?.fundingDatetime ?? null,
        binanceNextFunding: binanceFundingData?.fundingDatetime ?? null,
        bybitBid: bybitTicker.bid ?? null,
        bybitAsk: bybitTicker.ask ?? null,
        binanceBid: binanceTicker.bid ?? null,
        binanceAsk: binanceTicker.ask ?? null,
        volume24h: (bybitTicker.quoteVolume ?? 0) + (binanceTicker.quoteVolume ?? 0),
      });
    }

    spreads.sort((a, b) => Math.abs(b.spreadPct) - Math.abs(a.spreadPct));

    if (spreads.length === 0) {
      req.log.warn("Live exchange data unavailable, returning demo data");
      return res.json(generateDemoSpreads());
    }

    res.json(spreads);
  } catch (err) {
    req.log.error({ err }, "Error fetching exchange prices, returning demo data");
    res.json(generateDemoSpreads());
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

      const order = await ex.createMarketOrder(
        `${symbol}/USDT:USDT`,
        ccxtSide,
        qty,
        undefined,
        { reduceOnly: false }
      );

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

router.get("/exchanges/positions", async (req: Request, res: Response) => {
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

    const bybitMap: Map<string, Record<string, unknown>> = new Map();
    if (bybitPositions.status === "fulfilled") {
      for (const pos of bybitPositions.value) {
        if (pos.contracts && pos.contracts > 0) {
          const sym = pos.symbol?.split("/")[0] ?? "";
          bybitMap.set(sym, pos as unknown as Record<string, unknown>);
        }
      }
    }

    const result = [];

    if (binancePositions.status === "fulfilled") {
      for (const binancePos of binancePositions.value) {
        if (!binancePos.contracts || binancePos.contracts === 0) continue;
        const sym = binancePos.symbol?.split("/")[0] ?? "";
        const bybitPosRaw = bybitMap.get(sym);

        if (!bybitPosRaw) continue;

        const bybitPos = bybitPosRaw as {
          id?: unknown;
          side?: unknown;
          contracts?: number;
          entryPrice?: number;
          markPrice?: number;
          unrealizedPnl?: number;
        };

        const bybitSide = bybitPos.side === "long" ? "long" : "short";
        const binanceSide = binancePos.side === "long" ? "long" : "short";

        const bybitPnlVal = Number(bybitPos.unrealizedPnl ?? 0);
        const binancePnlVal = Number(binancePos.unrealizedPnl ?? 0);
        const bybitContracts = bybitPos.contracts ?? 0;
        const bybitEntry = bybitPos.entryPrice ?? 0;
        const bybitMark = bybitPos.markPrice ?? bybitEntry;
        const binanceMark = binancePos.markPrice ?? binancePos.entryPrice ?? 0;

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
          usdSize: (bybitContracts * bybitEntry) +
            ((binancePos.contracts ?? 0) * (binancePos.entryPrice ?? 0)),
          openedAt: new Date().toISOString(),
        });
      }
    }

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Error fetching positions");
    res.json([]);
  }
});

router.post("/exchanges/close-position", async (req: Request, res: Response) => {
  const parsed = ClosePositionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "bad_request", message: parsed.error.message });
    return;
  }

  const { symbol, bybitSide, binanceSide, bybitQty, binanceQty } = parsed.data;
  const bybitCreds = getBybitCredentials(req);
  const binanceCreds = getBinanceCredentials(req);

  try {
    const bybit = createBybitExchange(bybitCreds.apiKey, bybitCreds.secret);
    const binance = createBinanceExchange(binanceCreds.apiKey, binanceCreds.secret);

    const bybitCloseSide = bybitSide === "long" ? "sell" : "buy";
    const binanceCloseSide = binanceSide === "long" ? "sell" : "buy";

    const [bybitOrder, binanceOrder] = await Promise.allSettled([
      bybit.createMarketOrder(
        `${symbol}/USDT:USDT`,
        bybitCloseSide,
        bybitQty,
        undefined,
        { reduceOnly: true }
      ),
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

    res.json({
      success: bybitOrder.status === "fulfilled" || binanceOrder.status === "fulfilled",
      bybitResult,
      binanceResult,
      realizedPnl: 0,
    });
  } catch (err) {
    req.log.error({ err }, "Error closing position");
    const msg = err instanceof Error ? err.message : "Unknown error";
    res.status(500).json({ error: "close_failed", message: msg });
  }
});

export default router;
