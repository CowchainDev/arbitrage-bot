import { useState } from "react";
import { ChevronDown, ChevronUp, LineChart } from "lucide-react";
import { Link } from "wouter";
import {
  useClosePosition,
  getGetPositionsQueryKey,
} from "@workspace/api-client-react";
import type { Position, ClosePositionResult, BotLeg, BotConfig, TokenSpread } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { useQueryClient } from "@tanstack/react-query";

export function formatPrice(price: number | null | undefined): string {
  if (price == null) return "-";
  if (price >= 1000) return price.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(6);
}

export function formatPct(pct: number | null | undefined): string {
  if (pct == null) return "-";
  if (!isFinite(pct)) return "-";
  return (pct >= 0 ? "+" : "") + pct.toFixed(4) + "%";
}

export function formatPnl(pnl: number | null | undefined): string {
  if (pnl == null) return "-";
  return (pnl >= 0 ? "+" : "") + "$" + Math.abs(pnl).toFixed(4);
}

export function formatPnlWithPct(pnl: number | null | undefined, usdSize: number | null | undefined): string {
  const dollar = formatPnl(pnl);
  if (pnl == null || !usdSize || usdSize === 0) return dollar;
  const pct = (pnl / usdSize) * 100;
  return `${dollar} (${formatPct(pct)})`;
}

function getTokenPriceForExchange(token: TokenSpread | undefined, exchange: string, fallback?: number): number {
  const fb = fallback ?? 0;
  if (!token) return fb;
  switch (exchange) {
    case "bybit":   return token.bybitPrice   ?? fb;
    case "binance": return token.binancePrice ?? fb;
    case "gate":    return token.gatePrice    ?? fb;
    case "okx":     return token.okxPrice     ?? fb;
    case "mexc":    return token.mexcPrice    ?? fb;
    default:        return fb;
  }
}

export function botLegToPosition(leg: BotLeg, tokens: TokenSpread[], bot?: BotConfig): Position {
  const exchangeA = bot?.exchangeA ?? "bybit";
  const exchangeB = bot?.exchangeB ?? "binance";
  const token = tokens.find((t) => t.symbol === leg.symbol);
  const bybitCurrentPrice = getTokenPriceForExchange(token, exchangeA, leg.bybitEntry);
  const binanceCurrentPrice = getTokenPriceForExchange(token, exchangeB, leg.binanceEntry);
  const currentSpread =
    bybitCurrentPrice && binanceCurrentPrice
      ? ((bybitCurrentPrice - binanceCurrentPrice) / binanceCurrentPrice) * 100
      : 0;
  const bybitEntry = leg.bybitEntry ?? 0;
  const binanceEntry = leg.binanceEntry ?? 0;
  const bybitQty = leg.bybitQty ?? 0;
  const binanceQty = leg.binanceQty ?? 0;
  const bybitPnl =
    bybitEntry && bybitQty
      ? leg.bybitSide === "long"
        ? (bybitCurrentPrice - bybitEntry) * bybitQty
        : (bybitEntry - bybitCurrentPrice) * bybitQty
      : 0;
  const binancePnl =
    binanceEntry && binanceQty
      ? leg.binanceSide === "long"
        ? (binanceCurrentPrice - binanceEntry) * binanceQty
        : (binanceEntry - binanceCurrentPrice) * binanceQty
      : 0;
  const totalPnl = bybitPnl + binancePnl;
  const usdSize = bybitEntry * bybitQty + binanceEntry * binanceQty;
  return {
    id: `bot-leg-${leg.id}`,
    symbol: leg.symbol,
    bybitSide: leg.bybitSide,
    binanceSide: leg.binanceSide,
    bybitQty: bybitQty || undefined,
    binanceQty: binanceQty || undefined,
    bybitEntryPrice: bybitEntry || undefined,
    binanceEntryPrice: binanceEntry || undefined,
    bybitCurrentPrice: bybitCurrentPrice || undefined,
    binanceCurrentPrice: binanceCurrentPrice || undefined,
    bybitPnl,
    binancePnl,
    totalPnl,
    spreadAtEntry: leg.spreadAtEntry,
    currentSpread,
    usdSize: usdSize || undefined,
    openedAt: leg.openedAt,
  };
}

export function BotSummaryRow({
  positions,
  isExpanded,
  onToggle,
}: {
  positions: Position[];
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const symbol = positions[0].symbol;
  const totalPnl = positions.reduce((s, p) => s + (p.totalPnl ?? 0), 0);
  const pnlPositive = totalPnl >= 0;

  const firstBybitSide = positions[0].bybitSide;
  const firstBinanceSide = positions[0].binanceSide;
  const allSameSide =
    positions.every((p) => p.bybitSide === firstBybitSide) &&
    positions.every((p) => p.binanceSide === firstBinanceSide);

  const netBybitQty = positions.reduce(
    (s, p) => s + (p.bybitSide === "long" ? 1 : -1) * (p.bybitQty ?? 0),
    0
  );
  const netBinanceQty = positions.reduce(
    (s, p) => s + (p.binanceSide === "long" ? 1 : -1) * (p.binanceQty ?? 0),
    0
  );

  const signedBybitNotional = positions.reduce(
    (s, p) => s + (p.bybitSide === "long" ? 1 : -1) * (p.bybitEntryPrice ?? 0) * (p.bybitQty ?? 0),
    0
  );
  const signedBinanceNotional = positions.reduce(
    (s, p) => s + (p.binanceSide === "long" ? 1 : -1) * (p.binanceEntryPrice ?? 0) * (p.binanceQty ?? 0),
    0
  );

  const bybitCurrentPrice = positions[positions.length - 1].bybitCurrentPrice;
  const binanceCurrentPrice = positions[positions.length - 1].binanceCurrentPrice;

  const totalBybitQty = positions.reduce((s, p) => s + (p.bybitQty ?? 0), 0);
  const bybitEntryVwap = totalBybitQty > 0
    ? positions.reduce((s, p) => s + (p.bybitEntryPrice ?? 0) * (p.bybitQty ?? 0), 0) / totalBybitQty
    : 0;
  const totalBinanceQty = positions.reduce((s, p) => s + (p.binanceQty ?? 0), 0);
  const binanceEntryVwap = totalBinanceQty > 0
    ? positions.reduce((s, p) => s + (p.binanceEntryPrice ?? 0) * (p.binanceQty ?? 0), 0) / totalBinanceQty
    : 0;

  const bybitValuation = bybitCurrentPrice ?? bybitEntryVwap;
  const binanceValuation = binanceCurrentPrice ?? binanceEntryVwap;

  const netUsdSize = Math.abs(netBybitQty) * bybitValuation + Math.abs(netBinanceQty) * binanceValuation;

  const avgBybitEntry = netBybitQty !== 0 ? signedBybitNotional / netBybitQty : undefined;
  const avgBinanceEntry = netBinanceQty !== 0 ? signedBinanceNotional / netBinanceQty : undefined;
  const avgSpread = positions.reduce((s, p) => s + p.currentSpread, 0) / positions.length;

  const earliestOpenedAt = positions
    .map((p) => p.openedAt)
    .filter(Boolean)
    .sort()[0];

  return (
    <div
      data-testid={`position-summary-${symbol}`}
      className="grid grid-cols-9 gap-2 px-3 py-2.5 text-xs border-b border-border/50 bg-muted/20 hover:bg-muted/40 transition-colors items-center cursor-pointer"
      onClick={onToggle}
    >
      <span className="font-semibold flex items-center gap-1 min-w-0">
        {isExpanded ? <ChevronUp className="w-3 h-3 text-muted-foreground shrink-0" /> : <ChevronDown className="w-3 h-3 text-muted-foreground shrink-0" />}
        <span className="truncate">{symbol}</span>
        <span className="text-[10px] text-muted-foreground bg-muted px-1 rounded shrink-0">{positions.length}</span>
      </span>
      <span>
        {allSameSide ? (
          <>
            <span className={firstBybitSide === "long" ? "text-primary" : "text-destructive"}>
              {firstBybitSide?.toUpperCase()}
            </span>
            {" / "}
            <span className={positions[0].binanceSide === "long" ? "text-primary" : "text-destructive"}>
              {positions[0].binanceSide?.toUpperCase()}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">Mixed</span>
        )}
      </span>
      <span className="font-mono font-semibold">${netUsdSize.toFixed(2)}</span>
      <span className="font-mono leading-tight">
        <span className="flex flex-col gap-0.5">
          <span className={firstBybitSide === "long" ? "text-primary" : "text-destructive"}>{avgBybitEntry != null ? formatPrice(avgBybitEntry) : "-"}</span>
          <span className={positions[0].binanceSide === "long" ? "text-primary" : "text-destructive"}>{avgBinanceEntry != null ? formatPrice(avgBinanceEntry) : "-"}</span>
        </span>
      </span>
      <span className="font-mono leading-tight">
        <span className="flex flex-col gap-0.5">
          <span className={firstBybitSide === "long" ? "text-primary" : "text-destructive"}>{bybitCurrentPrice != null ? formatPrice(bybitCurrentPrice) : "-"}</span>
          <span className={positions[0].binanceSide === "long" ? "text-primary" : "text-destructive"}>{binanceCurrentPrice != null ? formatPrice(binanceCurrentPrice) : "-"}</span>
        </span>
      </span>
      <span className="font-mono">{formatPct(avgSpread)}</span>
      <span className={`font-mono font-semibold ${pnlPositive ? "text-primary" : "text-destructive"}`}>
        {formatPnlWithPct(totalPnl, netUsdSize)}
      </span>
      <span className="font-mono text-muted-foreground">
        {earliestOpenedAt ? new Date(earliestOpenedAt).toLocaleTimeString() : "-"}
      </span>
      <Link
        href={`/token/${symbol}`}
        onClick={(e) => e.stopPropagation()}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <LineChart className="w-3 h-3" />
        View Chart
      </Link>
    </div>
  );
}

export function PositionRow({
  position,
  onCloseSuccess,
  onDismiss,
  isLocalOnly,
  requestHeaders,
  exchangeA,
  exchangeB,
}: {
  position: Position;
  onCloseSuccess: (symbol: string) => void;
  onDismiss?: (symbol: string) => void;
  isLocalOnly?: boolean;
  requestHeaders: RequestInit | undefined;
  exchangeA?: string;
  exchangeB?: string;
}) {
  const [isClosing, setIsClosing] = useState(false);
  const [closeResult, setCloseResult] = useState<ClosePositionResult | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);
  const closePosition = useClosePosition({ request: requestHeaders });
  const queryClient = useQueryClient();

  const exA = exchangeA ?? "bybit";
  const exB = exchangeB ?? "binance";
  const longExchange = position.bybitSide === "long" ? exA : exB;
  const shortExchange = position.bybitSide === "short" ? exA : exB;

  const handleClose = async () => {
    if (isClosing) return;
    setIsClosing(true);
    setCloseResult(null);
    setCloseError(null);
    try {
      const result = await new Promise<ClosePositionResult>((resolve, reject) =>
        closePosition.mutate(
          {
            data: {
              positionId: position.id,
              symbol: position.symbol,
              bybitSide: position.bybitSide as "long" | "short",
              binanceSide: position.binanceSide as "long" | "short",
              bybitQty: position.bybitQty ?? 0,
              binanceQty: position.binanceQty ?? 0,
              longExchange,
              shortExchange,
              spreadAtEntry: position.spreadAtEntry ?? 0,
              entryTime: position.openedAt ?? new Date().toISOString(),
              quantity: position.usdSize ?? 0,
              realizedPnl: position.totalPnl ?? 0,
              // @ts-expect-error - extra fields for exchange routing not yet in generated schema
              exchangeA: exA,
              exchangeB: exB,
            },
          },
          { onSuccess: resolve, onError: reject }
        )
      );
      setCloseResult(result);
      if (result.success) {
        onCloseSuccess(position.symbol);
        await queryClient.invalidateQueries({ queryKey: getGetPositionsQueryKey() });
      }
    } catch (err) {
      setCloseError(err instanceof Error ? err.message : "Close failed");
    } finally {
      setIsClosing(false);
    }
  };

  const pnlPositive = (position.totalPnl ?? 0) >= 0;

  return (
    <>
      <div
        data-testid={`position-row-${position.symbol}`}
        className={`grid grid-cols-9 gap-2 px-3 py-2.5 text-xs border-b border-border/50 hover:bg-muted/30 transition-colors items-center`}
      >
        <span className="font-semibold">{position.symbol}</span>
        <span>
          <span className={position.bybitSide === "long" ? "text-primary" : "text-destructive"}>
            {position.bybitSide?.toUpperCase()}
          </span>
          {" / "}
          <span className={position.binanceSide === "long" ? "text-primary" : "text-destructive"}>
            {position.binanceSide?.toUpperCase()}
          </span>
        </span>
        <span className="font-mono">${(position.usdSize ?? 0).toFixed(2)}</span>
        <span className="font-mono leading-tight">
          <span className="flex flex-col gap-0.5">
            <span className={position.bybitSide === "long" ? "text-primary" : "text-destructive"}>
              {position.bybitEntryPrice != null ? formatPrice(position.bybitEntryPrice) : "-"}
            </span>
            <span className={position.binanceSide === "long" ? "text-primary" : "text-destructive"}>
              {position.binanceEntryPrice != null ? formatPrice(position.binanceEntryPrice) : "-"}
            </span>
          </span>
        </span>
        <span className="font-mono leading-tight">
          <span className="flex flex-col gap-0.5">
            <span className={position.bybitSide === "long" ? "text-primary" : "text-destructive"}>
              {position.bybitCurrentPrice != null ? formatPrice(position.bybitCurrentPrice) : "-"}
            </span>
            <span className={position.binanceSide === "long" ? "text-primary" : "text-destructive"}>
              {position.binanceCurrentPrice != null ? formatPrice(position.binanceCurrentPrice) : "-"}
            </span>
          </span>
        </span>
        <span className="font-mono">{formatPct(position.currentSpread)}</span>
        <span className={`font-mono font-semibold ${pnlPositive ? "text-primary" : "text-destructive"}`}>
          {formatPnlWithPct(position.totalPnl, position.usdSize)}
        </span>
        <span className="font-mono text-muted-foreground">
          {position.openedAt ? new Date(position.openedAt).toLocaleTimeString() : "-"}
        </span>
        {isLocalOnly ? (
          <button
            onClick={() => onDismiss?.(position.symbol)}
            data-testid={`btn-dismiss-position-${position.symbol}`}
            className="text-xs text-muted-foreground hover:bg-muted/50 px-2 py-1 rounded transition-colors"
          >
            Dismiss
          </button>
        ) : position.id.startsWith("bot-leg-") ? (
          <Link
            href={`/token/${position.symbol}`}
            data-testid={`bot-leg-managed-${position.symbol}`}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <LineChart className="w-3 h-3" />
            View Chart
          </Link>
        ) : (
          <button
            onClick={handleClose}
            disabled={isClosing}
            data-testid={`btn-close-position-${position.symbol}`}
            className="text-xs text-destructive hover:bg-destructive/10 px-2 py-1 rounded transition-colors disabled:opacity-50"
          >
            {isClosing ? "Closing…" : "Close"}
          </button>
        )}
      </div>

      <Dialog open={closeResult != null || closeError != null} onOpenChange={(open) => { if (!open) { setCloseResult(null); setCloseError(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className={closeError || (closeResult && !closeResult.success) ? "text-destructive" : "text-primary"}>
              {closeError ? "Close Failed" : closeResult?.success ? "Position Closed" : "Close Partially Failed"}
            </DialogTitle>
            <DialogDescription>
              {position.symbol} · {closeError ? closeError : "Order results from both exchanges"}
            </DialogDescription>
          </DialogHeader>

          {closeResult && (
            <div className="space-y-3 py-1">
              {closeResult.bybitResult && (
                <div className="rounded-md border border-border p-3 space-y-1.5">
                  <p className="text-xs font-semibold text-amber-400 uppercase tracking-wider">{exA}</p>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                    <span className="text-muted-foreground">Side</span>
                    <span className={closeResult.bybitResult.side === "Buy" ? "text-primary font-semibold" : "text-destructive font-semibold"}>{closeResult.bybitResult.side}</span>
                    <span className="text-muted-foreground">Avg Price</span>
                    <span className="font-mono">{closeResult.bybitResult.avgPrice != null ? formatPrice(closeResult.bybitResult.avgPrice) : "—"}</span>
                    <span className="text-muted-foreground">Filled Qty</span>
                    <span className="font-mono">{closeResult.bybitResult.filledQty ?? "—"}</span>
                    <span className="text-muted-foreground">Status</span>
                    <span className="font-mono">{closeResult.bybitResult.status}</span>
                  </div>
                </div>
              )}
              {closeResult.binanceResult && (
                <div className="rounded-md border border-border p-3 space-y-1.5">
                  <p className="text-xs font-semibold text-violet-400 uppercase tracking-wider">{exB}</p>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                    <span className="text-muted-foreground">Side</span>
                    <span className={closeResult.binanceResult.side === "BUY" || closeResult.binanceResult.side === "Buy" ? "text-primary font-semibold" : "text-destructive font-semibold"}>{closeResult.binanceResult.side}</span>
                    <span className="text-muted-foreground">Avg Price</span>
                    <span className="font-mono">{closeResult.binanceResult.avgPrice != null ? formatPrice(closeResult.binanceResult.avgPrice) : "—"}</span>
                    <span className="text-muted-foreground">Filled Qty</span>
                    <span className="font-mono">{closeResult.binanceResult.filledQty ?? "—"}</span>
                    <span className="text-muted-foreground">Status</span>
                    <span className="font-mono">{closeResult.binanceResult.status}</span>
                  </div>
                </div>
              )}
              {closeResult.realizedPnl != null && (
                <div className="flex items-center justify-between px-1 pt-1">
                  <span className="text-sm text-muted-foreground">Realized P/L</span>
                  <span className={`font-mono font-bold text-base ${closeResult.realizedPnl >= 0 ? "text-primary" : "text-destructive"}`}>
                    {closeResult.realizedPnl >= 0 ? "+" : ""}${closeResult.realizedPnl.toFixed(4)}
                  </span>
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button onClick={() => { setCloseResult(null); setCloseError(null); }} data-testid="btn-close-result-ok">
              OK
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
