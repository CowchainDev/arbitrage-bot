/**
 * Custom AsterDex V3 client using EIP-712 signed requests.
 *
 * CCXT's built-in aster exchange uses a non-standard signing scheme that does
 * not match AsterDex's actual V3 API. This client implements the correct
 * EIP-712 typed-data signature, matching the reference Python implementation.
 *
 * Signing flow (mirrors Python reference):
 *   1. Build params dict: user, signer, nonce (µs), then business params
 *   2. URL-encode params (without signature)
 *   3. EIP-712 sign the encoded string with domain AsterSignTransaction / chainId 1666
 *   4. Append signature to params
 *   5. POST as application/x-www-form-urlencoded  (GET: as query string)
 */

import { ethers } from "ethers";

const BASE_URL = "https://fapi.asterdex.com";

const EIP712_DOMAIN = {
  name: "AsterSignTransaction",
  version: "1",
  chainId: 1666n,
  verifyingContract: "0x0000000000000000000000000000000000000000" as `0x${string}`,
};

// Not `as const` — ethers signTypedData expects a mutable Record<string, TypedDataField[]>,
// and `as const` produces a readonly tuple that TypeScript rejects at the call site.
const MESSAGE_TYPES = {
  Message: [{ name: "msg", type: "string" }],
};

function nowMicros(): number {
  return Math.trunc(Date.now() * 1_000);
}

/** Build and sign the auth param block.  Extra fields are appended AFTER user/signer/nonce. */
async function buildSignedParams(
  extra: Record<string, string | number>,
  userAddress: string,
  signerAddress: string,
  privateKey: string,
): Promise<URLSearchParams> {
  // Order matters: user, signer, nonce, then extra (must match Python urlencode order)
  const ordered: Array<[string, string]> = [
    ["user", userAddress],
    ["signer", signerAddress],
    ["nonce", String(nowMicros())],
  ];
  for (const [k, v] of Object.entries(extra)) {
    ordered.push([k, String(v)]);
  }

  // URL-encode without signature for signing
  const payload = new URLSearchParams(ordered).toString();

  // EIP-712 typed-data sign
  const wallet = new ethers.Wallet(privateKey);
  const signature = await wallet.signTypedData(EIP712_DOMAIN, MESSAGE_TYPES, { msg: payload });

  ordered.push(["signature", signature]);
  return new URLSearchParams(ordered);
}

/** GET with auth params in query string */
async function asterGet<T>(
  path: string,
  extra: Record<string, string | number>,
  userAddress: string,
  signerAddress: string,
  privateKey: string,
): Promise<T> {
  const sp = await buildSignedParams(extra, userAddress, signerAddress, privateKey);
  const url = `${BASE_URL}${path}?${sp.toString()}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`AsterDex GET ${path} ${resp.status}: ${body}`);
  }
  return resp.json() as Promise<T>;
}

/** POST with auth params as form-encoded body */
async function asterPost<T>(
  path: string,
  extra: Record<string, string | number>,
  userAddress: string,
  signerAddress: string,
  privateKey: string,
): Promise<T> {
  const sp = await buildSignedParams(extra, userAddress, signerAddress, privateKey);
  const resp = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: sp.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`AsterDex POST ${path} ${resp.status}: ${body}`);
  }
  return resp.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Public helpers (no auth)
// ---------------------------------------------------------------------------

export interface AsterTickerResult {
  price: number;
  bid: number;
  ask: number;
}

/** Fetch best-bid/ask from public book-ticker endpoint. */
export async function asterFetchTicker(symbol: string): Promise<AsterTickerResult> {
  const sym = `${symbol}USDT`;
  const resp = await fetch(
    `${BASE_URL}/fapi/v1/ticker/bookTicker?symbol=${sym}`,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!resp.ok) throw new Error(`AsterDex ticker ${sym}: ${resp.status}`);
  const d = await resp.json() as { bidPrice: string; askPrice: string };
  const bid = Number(d.bidPrice);
  const ask = Number(d.askPrice);
  return { price: (bid + ask) / 2, bid, ask };
}

/** Load market precision info for a symbol. Returns step size (min qty increment). */
export async function asterFetchMarketStepSize(symbol: string): Promise<number> {
  const sym = `${symbol}USDT`;
  const resp = await fetch(
    `${BASE_URL}/fapi/v1/exchangeInfo`,
    { signal: AbortSignal.timeout(10_000) },
  );
  if (!resp.ok) return 1;
  const data = await resp.json() as { symbols: Array<{ symbol: string; filters: Array<{ filterType: string; stepSize?: string }> }> };
  const mkt = data.symbols.find((s) => s.symbol === sym);
  if (!mkt) return 1;
  const lotFilter = mkt.filters.find((f) => f.filterType === "LOT_SIZE");
  return lotFilter?.stepSize ? Number(lotFilter.stepSize) : 1;
}

// ---------------------------------------------------------------------------
// Authenticated helpers
// ---------------------------------------------------------------------------

export interface AsterBalanceAsset {
  asset: string;
  balance: string;
  availableBalance: string;
  unrealizedProfit?: string;
}

export async function asterFetchBalance(
  userAddress: string,
  signerAddress: string,
  privateKey: string,
): Promise<AsterBalanceAsset[]> {
  return asterGet<AsterBalanceAsset[]>(
    "/fapi/v3/balance",
    {},
    userAddress,
    signerAddress,
    privateKey,
  );
}

export interface AsterOrderResult {
  orderId: string | number;
  symbol: string;
  status: string;
  executedQty: string;
  avgPrice?: string;
  cumQuote?: string;
}

/**
 * Place a market order on AsterDex.
 * @param symbol   Base symbol e.g. "SOLV"
 * @param side     "BUY" | "SELL"
 * @param quantity Base-currency quantity (e.g. 2197 for SOLV)
 */
export async function asterPlaceOrder(
  symbol: string,
  side: "BUY" | "SELL",
  quantity: number,
  userAddress: string,
  signerAddress: string,
  privateKey: string,
): Promise<AsterOrderResult> {
  return asterPost<AsterOrderResult>(
    "/fapi/v3/order",
    {
      symbol: `${symbol}USDT`,
      side,
      type: "MARKET",
      quantity: String(quantity),
      positionSide: "BOTH",
    },
    userAddress,
    signerAddress,
    privateKey,
  );
}

/**
 * Close an existing position (reduce-only market order).
 */
export async function asterClosePosition(
  symbol: string,
  positionSide: "long" | "short",
  quantity: number,
  userAddress: string,
  signerAddress: string,
  privateKey: string,
): Promise<AsterOrderResult> {
  const side = positionSide === "long" ? "SELL" : "BUY";
  return asterPost<AsterOrderResult>(
    "/fapi/v3/order",
    {
      symbol: `${symbol}USDT`,
      side,
      type: "MARKET",
      quantity: String(quantity),
      positionSide: "BOTH",
      reduceOnly: "true",
    },
    userAddress,
    signerAddress,
    privateKey,
  );
}

/**
 * Set leverage for a symbol.
 */
export async function asterSetLeverage(
  symbol: string,
  leverage: number,
  userAddress: string,
  signerAddress: string,
  privateKey: string,
): Promise<void> {
  await asterPost(
    "/fapi/v1/leverage",
    { symbol: `${symbol}USDT`, leverage },
    userAddress,
    signerAddress,
    privateKey,
  );
}

// ---------------------------------------------------------------------------
// Round quantity to AsterDex step size
// ---------------------------------------------------------------------------

export function roundToStepSize(qty: number, stepSize: number): number {
  if (stepSize <= 0) return qty;
  const precision = Math.round(-Math.log10(stepSize));
  const factor = Math.pow(10, precision);
  return Math.floor(qty * factor) / factor;
}
