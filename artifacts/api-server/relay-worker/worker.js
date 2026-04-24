/**
 * Klines Relay — Cloudflare Worker
 *
 * Fetches OHLCV data from exchange REST APIs and returns it in the format
 * expected by the main API server: { t: number, c: number }[]
 *
 * Deploy:
 *   1. Install Wrangler: npm install -g wrangler
 *   2. wrangler deploy
 *   3. Set KLINES_RELAY_URL env var in the API server to the worker URL, e.g.
 *      KLINES_RELAY_URL=https://klines-relay.your-account.workers.dev/relay
 *
 * Query: GET /relay?exchange=bybit&symbol=BTC&interval=1h&limit=168
 * Response: [{ t: timestampMs, c: closePrice }, ...]
 */

const TIMEOUT_MS = 9000;

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms));
}

async function fetchBinance(symbol, interval, limit) {
  const intervalMap = { "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" };
  const tf = intervalMap[interval] ?? "1h";
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}USDT&interval=${tf}&limit=${Math.min(limit, 500)}`;
  const resp = await Promise.race([fetch(url), timeout(TIMEOUT_MS)]);
  if (!resp.ok) throw new Error(`Binance HTTP ${resp.status}`);
  const rows = await resp.json();
  return rows.map((r) => ({ t: r[0], c: parseFloat(r[4]) })).filter((p) => p.t > 0 && p.c > 0);
}

async function fetchBybit(symbol, interval, limit) {
  const intervalMap = { "15m": "15", "1h": "60", "4h": "240", "1d": "D" };
  const tf = intervalMap[interval] ?? "60";
  const url = `https://api.bybit.com/v5/market/kline?category=linear&symbol=${symbol}USDT&interval=${tf}&limit=${Math.min(limit, 200)}`;
  const resp = await Promise.race([fetch(url), timeout(TIMEOUT_MS)]);
  if (!resp.ok) throw new Error(`Bybit HTTP ${resp.status}`);
  const json = await resp.json();
  if (json.retCode !== 0) throw new Error(`Bybit retCode ${json.retCode}`);
  return json.result.list
    .map((r) => ({ t: parseInt(r[0], 10), c: parseFloat(r[4]) }))
    .filter((p) => p.t > 0 && p.c > 0)
    .reverse();
}

async function fetchGate(symbol, interval, limit) {
  const intervalMap = { "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" };
  const tf = intervalMap[interval] ?? "1h";
  const url = `https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${symbol}_USDT&interval=${tf}&limit=${Math.min(limit, 2000)}`;
  const resp = await Promise.race([fetch(url), timeout(TIMEOUT_MS)]);
  if (!resp.ok) throw new Error(`Gate HTTP ${resp.status}`);
  const rows = await resp.json();
  return rows.map((r) => ({ t: r.t * 1000, c: parseFloat(r.c) })).filter((p) => p.t > 0 && p.c > 0);
}

async function fetchOkx(symbol, interval, limit) {
  const intervalMap = { "15m": "15m", "1h": "1H", "4h": "4H", "1d": "1D" };
  const bar = intervalMap[interval] ?? "1H";
  const instId = `${symbol}-USDT-SWAP`;
  const OKX_MAX = 100;
  const points = [];

  let after;
  let remaining = Math.min(limit, 500);

  while (remaining > 0) {
    const batchSize = Math.min(remaining, OKX_MAX);
    let url = `https://www.okx.com/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${batchSize}`;
    if (after) url += `&after=${after}`;

    const resp = await Promise.race([fetch(url), timeout(TIMEOUT_MS)]);
    if (!resp.ok) throw new Error(`OKX HTTP ${resp.status}`);
    const json = await resp.json();
    if (!json.data || json.data.length === 0) break;

    const batch = json.data
      .map((r) => ({ t: parseInt(r[0], 10), c: parseFloat(r[4]) }))
      .filter((p) => p.t > 0 && p.c > 0);
    points.unshift(...batch);
    remaining -= batch.length;
    if (batch.length < batchSize) break;
    after = String(json.data[json.data.length - 1][0]);
  }

  return points;
}

async function fetchMexc(symbol, interval, limit) {
  const intervalMap = { "15m": "Min15", "1h": "Min60", "4h": "Hour4", "1d": "Day1" };
  const tf = intervalMap[interval] ?? "Min60";
  const msPerCandle = { "15m": 15 * 60_000, "1h": 60 * 60_000, "4h": 4 * 60 * 60_000, "1d": 24 * 60 * 60_000 }[interval] ?? 60 * 60_000;
  const end = Date.now();
  const start = end - msPerCandle * Math.min(limit, 2000);
  const url = `https://contract.mexc.com/api/v1/contract/kline/${symbol}_USDT?interval=${tf}&start=${Math.floor(start / 1000)}&end=${Math.floor(end / 1000)}`;
  const resp = await Promise.race([fetch(url), timeout(TIMEOUT_MS)]);
  if (!resp.ok) throw new Error(`MEXC HTTP ${resp.status}`);
  const json = await resp.json();
  if (!json.success || !json.data) throw new Error("MEXC response error");
  return json.data.time
    .map((t, i) => ({ t: t * 1000, c: json.data.close[i] }))
    .filter((p) => p.t > 0 && p.c > 0);
}

const FETCHERS = { binance: fetchBinance, bybit: fetchBybit, gate: fetchGate, okx: fetchOkx, mexc: fetchMexc };

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname !== "/relay") {
      return new Response("Not found", { status: 404 });
    }

    const exchange = (url.searchParams.get("exchange") ?? "").toLowerCase();
    const symbol   = (url.searchParams.get("symbol") ?? "").toUpperCase();
    const interval = url.searchParams.get("interval") ?? "1h";
    const limit    = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "168", 10) || 168, 1), 500);

    if (!exchange || !symbol) {
      return new Response(JSON.stringify({ error: "exchange and symbol are required" }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }

    const fetcher = FETCHERS[exchange];
    if (!fetcher) {
      return new Response(JSON.stringify({ error: `unknown exchange: ${exchange}` }), {
        status: 400, headers: { "Content-Type": "application/json" },
      });
    }

    try {
      const data = await fetcher(symbol, interval, limit);
      return new Response(JSON.stringify(data), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=60",
          "Access-Control-Allow-Origin": "*",
        },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 502, headers: { "Content-Type": "application/json" },
      });
    }
  },
};
