import { useState, useMemo, useEffect } from "react";
import { Link } from "wouter";
import { Star, Search, TrendingUp, TrendingDown, Zap, AlertCircle, ChevronDown, ChevronUp, X, Bell, BellOff } from "lucide-react";
import { useGetExchangePrices, getGetExchangePricesQueryKey, useGetPositions, getGetPositionsQueryKey, useJumpIn, useClosePosition } from "@workspace/api-client-react";
import type { TokenSpread, Position, ClosePositionResult, JumpInResult } from "@workspace/api-client-react";
import { useLocalPositions } from "@/hooks/use-local-positions";
import { useApiCredentials } from "@/hooks/use-api-credentials";
import { useFavourites } from "@/hooks/use-favourites";
import { useWatchedTokens } from "@/hooks/use-watched-tokens";
import { useAlertSettings } from "@/hooks/use-alert-settings";
import { useSpreadAlerts } from "@/hooks/use-spread-alerts";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
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
import { usePriceStream } from "@/hooks/use-price-stream";
import { useConnectionStatus } from "@/contexts/connection-status";

type SortOption = "spread_desc" | "spread_asc" | "volume_desc" | "alpha";

function formatPrice(price: number | null | undefined): string {
  if (price == null) return "-";
  if (price >= 1000) return price.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(6);
}

function formatPct(pct: number | null | undefined): string {
  if (pct == null) return "-";
  if (!isFinite(pct)) return "-";
  return (pct >= 0 ? "+" : "") + pct.toFixed(4) + "%";
}

function formatFunding(rate: number | null | undefined): string {
  if (rate == null) return "-";
  return (rate * 100).toFixed(4) + "%";
}

function formatPnl(pnl: number | null | undefined): string {
  if (pnl == null) return "-";
  return (pnl >= 0 ? "+" : "") + "$" + Math.abs(pnl).toFixed(4);
}

function formatPnlWithPct(pnl: number | null | undefined, usdSize: number | null | undefined): string {
  const dollar = formatPnl(pnl);
  if (pnl == null || !usdSize || usdSize === 0) return dollar;
  const pct = (pnl / usdSize) * 100;
  return `${dollar} (${formatPct(pct)})`;
}

const EXCHANGE_LABELS: Record<string, string> = {
  bybit: "BB", binance: "BN", gate: "GT", okx: "OKX", mexc: "MX",
};
const EXCHANGE_COLORS: Record<string, string> = {
  bybit: "text-amber-400", binance: "text-violet-400", gate: "text-sky-400", okx: "text-emerald-400", mexc: "text-rose-400",
};

function SpreadBadge({ spreadPct, bestSpreadPct, bestSpreadLeg }: { spreadPct: number; bestSpreadPct?: number; bestSpreadLeg?: string }) {
  const raw = bestSpreadPct != null ? bestSpreadPct : Math.abs(spreadPct);
  const available = isFinite(raw);
  const value = available ? raw : null;
  let colorClass = "text-muted-foreground";
  if (value != null && value >= 1) colorClass = "text-primary";
  else if (value != null && value >= 0.3) colorClass = "text-amber-400";

  return (
    <div className="text-right">
      <span className={`font-mono font-semibold text-sm ${colorClass}`}>
        {value != null ? `+${value.toFixed(4)}%` : "-"}
      </span>
      {bestSpreadLeg && (
        <div className="text-[10px] text-muted-foreground font-mono leading-tight">
          {bestSpreadLeg.split("/").map((ex, i) => (
            <span key={ex}>
              {i > 0 && <span className="text-muted-foreground/50">/</span>}
              <span className={EXCHANGE_COLORS[ex] ?? ""}>{EXCHANGE_LABELS[ex] ?? ex.toUpperCase()}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function TokenCard({
  token,
  isSelected,
  isFavourite,
  isWatched,
  onSelect,
  onToggleFavourite,
  onToggleWatch,
}: {
  token: TokenSpread;
  isSelected: boolean;
  isFavourite: boolean;
  isWatched: boolean;
  onSelect: () => void;
  onToggleFavourite: (e: React.MouseEvent) => void;
  onToggleWatch: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      onClick={onSelect}
      data-testid={`card-token-${token.symbol}`}
      className={`bg-card border rounded p-3 cursor-pointer transition-all hover:border-primary/40 ${
        isSelected ? "border-primary/60 bg-primary/5" : "border-border"
      } ${isWatched ? "border-primary/30" : ""}`}
    >
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <span className="font-semibold text-sm">{token.symbol}</span>
          <button
            onClick={onToggleFavourite}
            className="text-muted-foreground hover:text-amber-400 transition-colors"
            data-testid={`btn-favourite-${token.symbol}`}
          >
            <Star
              className={`w-3.5 h-3.5 ${isFavourite ? "fill-amber-400 text-amber-400" : ""}`}
            />
          </button>
          <button
            onClick={onToggleWatch}
            className={`transition-colors ${isWatched ? "text-primary" : "text-muted-foreground hover:text-primary"}`}
            data-testid={`btn-watch-${token.symbol}`}
            title={isWatched ? "Stop watching" : "Watch spread"}
          >
            {isWatched
              ? <Bell className="w-3.5 h-3.5 fill-primary/20" />
              : <BellOff className="w-3.5 h-3.5" />}
          </button>
        </div>
        <SpreadBadge spreadPct={token.spreadPct} bestSpreadPct={token.bestSpreadPct} bestSpreadLeg={token.bestSpreadLeg} />
      </div>

      <div className="space-y-0.5 text-xs">
        {(([
          token.bybitPrice != null   ? ["BB",  token.bybitPrice,   "text-amber-400"]   : null,
          token.binancePrice != null ? ["BN",  token.binancePrice, "text-violet-400"]  : null,
          token.gatePrice != null    ? ["GT",  token.gatePrice,    "text-sky-400"]     : null,
          token.okxPrice != null     ? ["OKX", token.okxPrice,     "text-emerald-400"] : null,
          token.mexcPrice != null    ? ["MX",  token.mexcPrice,    "text-rose-400"]    : null,
        ]).filter((x): x is [string, number, string] => x !== null)).map(([label, price, color]) => (
          <div key={label} className="flex items-center justify-between">
            <span className={`font-semibold w-8 ${color}`}>{label}</span>
            <span className="font-mono text-foreground">{formatPrice(price)}</span>
          </div>
        ))}
        {(token.bybitFundingRate != null || token.binanceFundingRate != null) && (
          <div className="flex items-center justify-between mt-0.5 pt-0.5 border-t border-border/50 text-muted-foreground">
            <span>FR {token.bybitFundingRate != null ? "BB" : ""}{token.bybitFundingRate != null && token.binanceFundingRate != null ? "/BN" : token.binanceFundingRate != null ? "BN" : ""}</span>
            <span className="font-mono">
              {token.bybitFundingRate != null && (
                <span className={token.bybitFundingRate > 0 ? "text-primary" : "text-destructive"}>{formatFunding(token.bybitFundingRate)}</span>
              )}
              {token.bybitFundingRate != null && token.binanceFundingRate != null && (
                <span className="text-muted-foreground/50 mx-0.5">/</span>
              )}
              {token.binanceFundingRate != null && (
                <span className={token.binanceFundingRate > 0 ? "text-primary" : "text-destructive"}>{formatFunding(token.binanceFundingRate)}</span>
              )}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function TokenDetailPanel({
  token,
  onClose,
  requestHeaders,
  activePosition,
  onJumpInSuccess,
}: {
  token: TokenSpread;
  onClose: () => void;
  requestHeaders: ReturnType<ReturnType<typeof useApiCredentials>["getRequestHeaders"]>;
  activePosition?: Position;
  onJumpInSuccess: (position: Position) => void;
}) {
  const [bybitSide, setBybitSide] = useState<"long" | "short">("long");
  const [openSpread, setOpenSpread] = useState("0.5");
  const [closeSpread, setCloseSpread] = useState("0.2");
  const [orderSize, setOrderSize] = useState("10");
  const [bybitLeverage, setBybitLeverage] = useState<string>(() => {
    try { return localStorage.getItem("arbitrage-bybitLeverage") ?? "1"; } catch { return "1"; }
  });
  const [binanceLeverage, setBinanceLeverage] = useState<string>(() => {
    try { return localStorage.getItem("arbitrage-binanceLeverage") ?? "1"; } catch { return "1"; }
  });
  const [useLeverage, setUseLeverage] = useState<boolean>(() => {
    try { return localStorage.getItem("arbitrage-useLeverage") === "true"; } catch { return false; }
  });
  const [isJumping, setIsJumping] = useState(false);

  useEffect(() => {
    try { localStorage.setItem("arbitrage-useLeverage", String(useLeverage)); } catch {}
  }, [useLeverage]);

  useEffect(() => {
    try { localStorage.setItem("arbitrage-bybitLeverage", bybitLeverage); } catch {}
  }, [bybitLeverage]);

  useEffect(() => {
    try { localStorage.setItem("arbitrage-binanceLeverage", binanceLeverage); } catch {}
  }, [binanceLeverage]);

  const { toast } = useToast();
  const queryClient = useQueryClient();

  const jumpIn = useJumpIn({ request: requestHeaders ?? undefined });

  const MIN_ORDER_USD = 10;

  const handleJumpIn = async () => {
    const size = Number(orderSize);
    if (!size || size <= 0) {
      toast({ title: "Invalid size", description: "Enter a valid USD amount", variant: "destructive" });
      return;
    }
    if (size < MIN_ORDER_USD) {
      toast({ title: "Order too small", description: `Minimum order is $${MIN_ORDER_USD} total ($5 per exchange)`, variant: "destructive" });
      return;
    }
    if (!requestHeaders) {
      toast({ title: "API Keys required", description: "Configure your API keys in Settings", variant: "destructive" });
      return;
    }

    setIsJumping(true);
    const halfSize = size / 2;
    const computedBinanceSide = bybitSide === "long" ? "short" : "long";

    try {
      const jumpResult = await new Promise<JumpInResult>((resolve, reject) =>
        jumpIn.mutate(
          {
            data: {
              symbol: token.symbol,
              bybitSide,
              binanceSide: computedBinanceSide,
              usdAmount: size,
              bybitLeverage: useLeverage ? Number(bybitLeverage) : 1,
              binanceLeverage: useLeverage ? Number(binanceLeverage) : 1,
            },
          },
          {
            onSuccess: (data) => {
              if (!data.success) {
                reject(new Error(data.error ?? (data.compensated ? "Binance leg failed (Bybit position was closed)" : "Order failed")));
              } else {
                resolve(data);
              }
            },
            onError: reject,
          }
        )
      );

      const bybitEntry = jumpResult.bybitResult?.avgPrice ?? 0;
      const binanceEntry = jumpResult.binanceResult?.avgPrice ?? 0;
      const bybitQty = jumpResult.bybitResult?.filledQty ?? halfSize / Math.max(bybitEntry, 1);
      const binanceQty = jumpResult.binanceResult?.filledQty ?? halfSize / Math.max(binanceEntry, 1);
      const spreadAtEntry = bybitEntry && binanceEntry
        ? ((bybitEntry - binanceEntry) / binanceEntry) * 100
        : token.spreadPct;

      onJumpInSuccess({
        id: `local-${token.symbol}-${Date.now()}`,
        symbol: token.symbol,
        bybitSide,
        binanceSide: computedBinanceSide,
        bybitQty,
        binanceQty,
        bybitEntryPrice: bybitEntry,
        binanceEntryPrice: binanceEntry,
        bybitCurrentPrice: bybitEntry,
        binanceCurrentPrice: binanceEntry,
        bybitPnl: 0,
        binancePnl: 0,
        totalPnl: 0,
        spreadAtEntry,
        currentSpread: spreadAtEntry,
        usdSize: size,
        openedAt: new Date().toISOString(),
      });

      toast({
        title: "Position opened",
        description: `${bybitSide.toUpperCase()} $${halfSize} on Bybit, ${computedBinanceSide.toUpperCase()} $${halfSize} on Binance`,
      });

      await queryClient.invalidateQueries({ queryKey: getGetPositionsQueryKey() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Order failed";
      toast({ title: "Order failed", description: msg, variant: "destructive" });
    } finally {
      setIsJumping(false);
    }
  };

  const binanceSide = bybitSide === "long" ? "short" : "long";

  return (
    <div className="bg-card border border-border rounded-md p-4 space-y-4 h-fit sticky top-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-bold text-base">{token.symbol}</span>
          {token.bybitPrice != null && (
            <span className="text-xs text-amber-400 font-semibold bg-amber-400/10 px-2 py-0.5 rounded">
              BYBIT {token.binancePrice != null ? (token.bybitPrice > token.binancePrice ? "↑" : "↓") : ""}
            </span>
          )}
          {token.binancePrice != null && (
            <span className="text-xs text-violet-400 font-semibold bg-violet-400/10 px-2 py-0.5 rounded">
              BINANCE {token.bybitPrice != null ? (token.binancePrice > token.bybitPrice ? "↑" : "↓") : ""}
            </span>
          )}
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground" data-testid="btn-close-detail">
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Side selector */}
      <div>
        <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1.5 block">Side (Bybit)</label>
        <div className="flex gap-2">
          <button
            onClick={() => setBybitSide("long")}
            data-testid="btn-side-long"
            className={`flex-1 py-1.5 rounded text-xs font-bold transition-all ${
              bybitSide === "long"
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-muted-foreground hover:text-foreground"
            }`}
          >
            LONG
          </button>
          <button
            onClick={() => setBybitSide("short")}
            data-testid="btn-side-short"
            className={`flex-1 py-1.5 rounded text-xs font-bold transition-all ${
              bybitSide === "short"
                ? "bg-destructive text-destructive-foreground"
                : "bg-secondary text-muted-foreground hover:text-foreground"
            }`}
          >
            SHORT
          </button>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Bybit: <span className={bybitSide === "long" ? "text-primary" : "text-destructive"}>{bybitSide.toUpperCase()}</span>
          {" / "}
          Binance: <span className={binanceSide === "long" ? "text-primary" : "text-destructive"}>{binanceSide.toUpperCase()}</span>
        </p>
      </div>

      {/* Spread settings */}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Open Spread %</label>
          <Input
            value={openSpread}
            onChange={(e) => setOpenSpread(e.target.value)}
            className="font-mono text-sm bg-background"
            data-testid="input-open-spread"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Close Spread %</label>
          <Input
            value={closeSpread}
            onChange={(e) => setCloseSpread(e.target.value)}
            className="font-mono text-sm bg-background"
            data-testid="input-close-spread"
          />
        </div>
      </div>

      {/* Order size */}
      <div>
        <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Order Size (USD)</label>
        <Input
          value={orderSize}
          onChange={(e) => setOrderSize(e.target.value)}
          className="font-mono text-sm bg-background"
          data-testid="input-order-size"
        />
        <p className="text-xs mt-1">
          {Number(orderSize) > 0 && Number(orderSize) < MIN_ORDER_USD ? (
            <span className="text-destructive">Min $10 total ($5 per exchange)</span>
          ) : Number(orderSize) >= MIN_ORDER_USD ? (
            <span className="text-muted-foreground">~${(Number(orderSize) / 2).toFixed(2)} per exchange</span>
          ) : (
            <span className="text-muted-foreground">Min $10 total ($5 per exchange)</span>
          )}
        </p>
      </div>

      {/* Leverage */}
      <div className="space-y-2">
        <label className="flex items-center gap-2 cursor-pointer w-fit">
          <input
            type="checkbox"
            checked={useLeverage}
            onChange={(e) => {
              setUseLeverage(e.target.checked);
              if (!e.target.checked) {
                setBybitLeverage("1");
                setBinanceLeverage("1");
              }
            }}
            className="w-3.5 h-3.5 accent-primary cursor-pointer"
            data-testid="checkbox-use-leverage"
          />
          <span className="text-xs text-muted-foreground uppercase tracking-wider">Use leverage</span>
        </label>
        {useLeverage && (
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Bybit Leverage</label>
              <div className="flex gap-1">
                <Input
                  value={bybitLeverage}
                  onChange={(e) => setBybitLeverage(e.target.value)}
                  className="font-mono text-sm bg-background"
                  data-testid="input-bybit-leverage"
                />
                <span className="flex items-center text-xs text-muted-foreground px-1">x</span>
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Binance Leverage</label>
              <div className="flex gap-1">
                <Input
                  value={binanceLeverage}
                  onChange={(e) => setBinanceLeverage(e.target.value)}
                  className="font-mono text-sm bg-background"
                  data-testid="input-binance-leverage"
                />
                <span className="flex items-center text-xs text-muted-foreground px-1">x</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Active position P&L */}
      {activePosition && (
        <div className="rounded border border-primary/20 bg-primary/5 px-3 py-2 space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground uppercase tracking-wider font-semibold">Active Position</span>
            <span className={`font-mono font-bold text-base ${(activePosition.totalPnl ?? 0) >= 0 ? "text-primary" : "text-destructive"}`}>
              {formatPnlWithPct(activePosition.totalPnl, activePosition.usdSize)}
            </span>
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Entry spread: <span className="font-mono text-foreground">{formatPct(activePosition.spreadAtEntry)}</span></span>
            <span>Now: <span className="font-mono text-foreground">{formatPct(activePosition.currentSpread)}</span></span>
          </div>
        </div>
      )}

      {/* Leverage summary */}
      {(() => {
        const effBybit = useLeverage ? (Number(bybitLeverage) || 1) : 1;
        const effBinance = useLeverage ? (Number(binanceLeverage) || 1) : 1;
        return useLeverage ? (
          <p className="text-xs text-center text-amber-400 font-mono" data-testid="leverage-summary">
            Leverage: Bybit {effBybit}x / Binance {effBinance}x
          </p>
        ) : (
          <p className="text-xs text-center text-muted-foreground" data-testid="leverage-summary">
            No leverage (1x)
          </p>
        );
      })()}

      {/* JUMP IN */}
      {(!token.bybitPrice || !token.binancePrice) && (
        <p className="text-xs text-muted-foreground text-center py-1">
          <span className="text-amber-400">Trading unavailable</span> — not listed on both Bybit &amp; Binance
        </p>
      )}
      <Button
        onClick={handleJumpIn}
        disabled={isJumping || !requestHeaders || !token.bybitPrice || !token.binancePrice}
        className="w-full bg-primary text-primary-foreground hover:bg-primary/90 font-bold text-sm py-5 tracking-wider"
        data-testid="button-jump-in"
      >
        {isJumping ? (
          <span className="flex items-center gap-2">
            <span className="w-3 h-3 border border-primary-foreground border-t-transparent rounded-full animate-spin" />
            OPENING...
          </span>
        ) : (
          <span className="flex items-center gap-2">
            <Zap className="w-4 h-4" />
            JUMP IN
          </span>
        )}
      </Button>

      {!requestHeaders && (
        <p className="text-xs text-destructive text-center">
          Configure API keys in{" "}
          <Link href="/settings" className="underline hover:text-destructive/80">Settings</Link>
        </p>
      )}

      {/* All-exchange price matrix */}
      <div className="border border-border rounded overflow-hidden">
        <div className="grid grid-cols-3 bg-muted text-xs px-2 py-1.5 font-semibold uppercase tracking-wider">
          <span className="text-muted-foreground"></span>
          <span className="text-amber-400/80">BYBIT</span>
          <span className="text-violet-400/80">BINANCE</span>
        </div>
        {[
          { label: "Price",   bybit: formatPrice(token.bybitPrice),   binance: formatPrice(token.binancePrice) },
          { label: "Bid",     bybit: formatPrice(token.bybitBid),     binance: formatPrice(token.binanceBid) },
          { label: "Ask",     bybit: formatPrice(token.bybitAsk),     binance: formatPrice(token.binanceAsk) },
          { label: "Funding", bybit: formatFunding(token.bybitFundingRate), binance: formatFunding(token.binanceFundingRate) },
          { label: "Next FR", bybit: token.bybitNextFunding ? new Date(token.bybitNextFunding).toLocaleTimeString() : "-", binance: token.binanceNextFunding ? new Date(token.binanceNextFunding).toLocaleTimeString() : "-" },
          { label: "Spread",  bybit: (token.bybitPrice != null && token.binancePrice != null && isFinite(token.spreadPct)) ? formatPct(token.spreadPct) : "-",      binance: "-" },
        ].map((row, i) => (
          <div key={row.label} className={`grid grid-cols-3 text-xs px-2 py-1.5 ${i % 2 === 0 ? "bg-card" : "bg-background"}`}>
            <span className="text-muted-foreground">{row.label}</span>
            <span className="font-mono text-foreground">{row.bybit}</span>
            <span className="font-mono text-foreground">{row.binance}</span>
          </div>
        ))}
      </div>

      {/* Read-only exchange prices */}
      {(token.gatePrice != null || token.okxPrice != null || token.mexcPrice != null) && (
        <div className="border border-border rounded overflow-hidden">
          <div className="bg-muted text-xs px-2 py-1.5 font-semibold uppercase tracking-wider text-muted-foreground">
            Read-only exchanges
          </div>
          <div className="grid grid-cols-4 text-xs px-2 py-1 bg-muted/50 text-muted-foreground font-semibold">
            <span></span>
            <span className="text-sky-400/80">GATE</span>
            <span className="text-emerald-400/80">OKX</span>
            <span className="text-rose-400/80">MEXC</span>
          </div>
          {[
            { label: "Price",   gate: formatPrice(token.gatePrice),   okx: formatPrice(token.okxPrice),   mexc: formatPrice(token.mexcPrice) },
            { label: "Bid",     gate: formatPrice(token.gateBid),     okx: formatPrice(token.okxBid),     mexc: formatPrice(token.mexcBid) },
            { label: "Ask",     gate: formatPrice(token.gateAsk),     okx: formatPrice(token.okxAsk),     mexc: formatPrice(token.mexcAsk) },
            { label: "Funding", gate: formatFunding(token.gateFundingRate), okx: formatFunding(token.okxFundingRate), mexc: formatFunding(token.mexcFundingRate) },
          ].map((row, i) => (
            <div key={row.label} className={`grid grid-cols-4 text-xs px-2 py-1.5 ${i % 2 === 0 ? "bg-card" : "bg-background"}`}>
              <span className="text-muted-foreground">{row.label}</span>
              <span className="font-mono text-foreground">{row.gate}</span>
              <span className="font-mono text-foreground">{row.okx}</span>
              <span className="font-mono text-foreground">{row.mexc}</span>
            </div>
          ))}
        </div>
      )}

      {/* Cross-exchange spreads */}
      {(() => {
        const allExchanges = [
          { key: "bybit",   price: token.bybitPrice   ?? null },
          { key: "binance", price: token.binancePrice ?? null },
          { key: "gate",    price: token.gatePrice    ?? null },
          { key: "okx",     price: token.okxPrice     ?? null },
          { key: "mexc",    price: token.mexcPrice    ?? null },
        ].filter((e): e is { key: string; price: number } => e.price != null && e.price !== 0);

        if (allExchanges.length < 2) return null;

        const pairs: { exA: string; exB: string; spread: number }[] = [];
        for (let a = 0; a < allExchanges.length; a++) {
          for (let b = a + 1; b < allExchanges.length; b++) {
            const pA = allExchanges[a].price;
            const pB = allExchanges[b].price;
            const spread = ((pA - pB) / pB) * 100;
            pairs.push({ exA: allExchanges[a].key, exB: allExchanges[b].key, spread });
          }
        }
        pairs.sort((a, b) => Math.abs(b.spread) - Math.abs(a.spread));

        return (
          <div className="border border-border rounded overflow-hidden">
            <div className="bg-muted/30 px-2 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Cross Spreads
            </div>
            {pairs.map(({ exA, exB, spread }, i) => {
              const isBest = i === 0;
              const color = Math.abs(spread) >= 1 ? (spread >= 0 ? "text-primary" : "text-destructive") : Math.abs(spread) >= 0.3 ? "text-amber-400" : "text-muted-foreground";
              const labelA = EXCHANGE_LABELS[exA] ?? exA.toUpperCase();
              const labelB = EXCHANGE_LABELS[exB] ?? exB.toUpperCase();
              const colorA = EXCHANGE_COLORS[exA] ?? "";
              const colorB = EXCHANGE_COLORS[exB] ?? "";
              return (
                <div key={`${exA}-${exB}`} className={`grid grid-cols-3 text-xs px-2 py-1.5 items-center ${i % 2 === 0 ? "bg-card" : "bg-background"} ${isBest ? "ring-1 ring-inset ring-primary/30" : ""}`}>
                  <span className="font-semibold flex items-center gap-1">
                    <span className={colorA}>{labelA}</span>
                    <span className="text-muted-foreground/50">/</span>
                    <span className={colorB}>{labelB}</span>
                    {isBest && (
                      <span className="ml-1 px-1 py-px rounded text-[9px] font-bold bg-primary/20 text-primary leading-none">BEST</span>
                    )}
                  </span>
                  <span className={`font-mono font-semibold ${color}`}>{formatPct(spread)}</span>
                  <span className="text-muted-foreground font-mono text-[10px]">
                    {Math.abs(spread) >= 1 ? "HIGH" : Math.abs(spread) >= 0.3 ? "MED" : "LOW"}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })()}
    </div>
  );
}

function PositionRow({
  position,
  onCloseSuccess,
  onDismiss,
  isLocalOnly,
  requestHeaders,
}: {
  position: Position;
  onCloseSuccess: (symbol: string) => void;
  onDismiss?: (symbol: string) => void;
  isLocalOnly?: boolean;
  requestHeaders: ReturnType<ReturnType<typeof useApiCredentials>["getRequestHeaders"]>;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const closePosition = useClosePosition({ request: requestHeaders });
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const handleConfirmClose = async () => {
    setIsClosing(true);
    try {
      await new Promise<void>((resolve, reject) =>
        closePosition.mutate(
          {
            data: {
              positionId: position.id,
              symbol: position.symbol,
              bybitSide: position.bybitSide as "long" | "short",
              binanceSide: position.binanceSide as "long" | "short",
              bybitQty: position.bybitQty ?? 0,
              binanceQty: position.binanceQty ?? 0,
            },
          },
          {
            onSuccess: (data: ClosePositionResult) => {
              if (!data.success) {
                reject(new Error("Close failed on one or both exchanges"));
              } else {
                resolve();
              }
            },
            onError: reject,
          }
        )
      );
      setConfirmOpen(false);
      onCloseSuccess(position.symbol);
      toast({ title: "Position closed", description: `${position.symbol} position closed successfully` });
      await queryClient.invalidateQueries({ queryKey: getGetPositionsQueryKey() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Close failed";
      setConfirmOpen(false);
      toast({ title: "Close failed", description: msg, variant: "destructive" });
    } finally {
      setIsClosing(false);
    }
  };

  const pnlPositive = (position.totalPnl ?? 0) >= 0;

  return (
    <>
      <div
        data-testid={`position-row-${position.symbol}`}
        className={`grid grid-cols-7 gap-2 px-3 py-2.5 text-xs border-b border-border/50 hover:bg-muted/30 transition-colors items-center`}
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
        ) : (
          <button
            onClick={() => setConfirmOpen(true)}
            data-testid={`btn-close-position-${position.symbol}`}
            className="text-xs text-destructive hover:bg-destructive/10 px-2 py-1 rounded transition-colors"
          >
            Close
          </button>
        )}
      </div>

      <Dialog open={confirmOpen} onOpenChange={(open) => { if (!isClosing) setConfirmOpen(open); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Close position?</DialogTitle>
            <DialogDescription>
              This will close your <span className="font-semibold text-foreground">{position.symbol}</span> position on both exchanges.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm py-2">
            <span className="text-muted-foreground">Symbol</span>
            <span className="font-semibold">{position.symbol}</span>
            <span className="text-muted-foreground">Sides</span>
            <span>
              <span className={position.bybitSide === "long" ? "text-primary" : "text-destructive"}>
                {position.bybitSide?.toUpperCase()}
              </span>
              {" / "}
              <span className={position.binanceSide === "long" ? "text-primary" : "text-destructive"}>
                {position.binanceSide?.toUpperCase()}
              </span>
            </span>
            <span className="text-muted-foreground">Size</span>
            <span className="font-mono">${(position.usdSize ?? 0).toFixed(2)}</span>
            <span className="text-muted-foreground">Unrealised P/L</span>
            <span className={`font-mono font-semibold ${pnlPositive ? "text-primary" : "text-destructive"}`}>
              {formatPnlWithPct(position.totalPnl, position.usdSize)}
            </span>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={isClosing}
              data-testid="btn-cancel-close"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirmClose}
              disabled={isClosing}
              data-testid="btn-confirm-close"
            >
              {isClosing ? "Closing..." : "Confirm Close"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function Dashboard() {
  const { getRequestHeaders, hasCredentials } = useApiCredentials();
  const { isFavourite, toggleFavourite } = useFavourites();
  const { watched, isWatched, getThreshold, toggleWatch } = useWatchedTokens();
  const { settings } = useAlertSettings();
  const requestHeaders = getRequestHeaders();
  const { localPositions, savePosition, removePosition } = useLocalPositions();
  const { setDataSource } = useConnectionStatus();

  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortOption>("spread_desc");
  const [favsOnly, setFavsOnly] = useState(false);
  const [maxSpread, setMaxSpread] = useState<string>("");
  const ALL_EXCHANGES = ["bybit", "binance", "gate", "okx", "mexc"] as const;
  const [selectedExchanges, setSelectedExchanges] = useState<Set<string>>(new Set(ALL_EXCHANGES));
  const toggleExchange = (ex: string) =>
    setSelectedExchanges((prev) => {
      const next = new Set(prev);
      if (next.has(ex)) { if (next.size > 2) next.delete(ex); }
      else next.add(ex);
      return next;
    });
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [showPositions, setShowPositions] = useState(true);

  const { tokens: streamTokens, isDemoData: streamIsDemo, streamStatus, isFetching: streamFetching } = usePriceStream();

  const wsActive = streamTokens.length > 0 && (streamStatus === "open" || streamStatus === "connecting");

  const pricesQuery = useGetExchangePrices({
    query: {
      refetchInterval: wsActive ? false : 8000,
      queryKey: getGetExchangePricesQueryKey(),
      enabled: !wsActive,
    },
    request: requestHeaders ?? undefined,
  });

  const positionsQuery = useGetPositions({
    query: {
      refetchInterval: 5000,
      queryKey: getGetPositionsQueryKey(),
      enabled: hasCredentials,
    },
    request: requestHeaders ?? undefined,
  });

  const tokens: TokenSpread[] = wsActive && streamTokens.length > 0
    ? streamTokens
    : (pricesQuery.data ?? []);
  const isDemoData = wsActive ? streamIsDemo : (tokens.length > 0 && tokens[0].demo === true);
  const isFetching = wsActive ? streamFetching : pricesQuery.isFetching;
  const isLoading = wsActive ? (streamTokens.length === 0 && streamStatus === "connecting") : pricesQuery.isLoading;
  const isError = !wsActive && pricesQuery.isError;

  useEffect(() => {
    if (tokens.length === 0) return;
    setDataSource(isDemoData ? "demo" : "live");
  }, [isDemoData, tokens.length, setDataSource]);

  useSpreadAlerts(tokens, watched, settings);

  const polledPositions = positionsQuery.data ?? [];

  useEffect(() => {
    if (!hasCredentials) return;
    if (positionsQuery.isLoading || positionsQuery.isError) return;
    if (!positionsQuery.dataUpdatedAt) return;
    const polledSymbols = new Set(polledPositions.map((p) => p.symbol));
    for (const lp of localPositions) {
      if (!polledSymbols.has(lp.symbol)) {
        removePosition(lp.symbol);
      }
    }
  // localPositions intentionally omitted — including it would cause a remove→update→effect loop
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polledPositions, hasCredentials, positionsQuery.isLoading, positionsQuery.isError, positionsQuery.dataUpdatedAt, removePosition]);

  const positions = useMemo(() => {
    const polledSymbols = new Set(polledPositions.map((p) => p.symbol));
    const localOnly = localPositions.filter((p) => !polledSymbols.has(p.symbol));
    return [...polledPositions, ...localOnly];
  }, [polledPositions, localPositions]);

  const localOnlySymbols = useMemo(() => {
    const polledSymbols = new Set(polledPositions.map((p) => p.symbol));
    return new Set(localPositions.filter((p) => !polledSymbols.has(p.symbol)).map((p) => p.symbol));
  }, [polledPositions, localPositions]);

  const filteredTokens = useMemo(() => {
    let list = [...tokens];
    if (favsOnly) list = list.filter((t) => isFavourite(t.symbol));
    if (search) list = list.filter((t) => t.symbol.toLowerCase().includes(search.toLowerCase()));
    if (maxSpread !== "") {
      const cap = parseFloat(maxSpread);
      if (!isNaN(cap)) list = list.filter((t) => Math.abs(t.bestSpreadPct ?? t.spreadPct) <= cap);
    }
    if (selectedExchanges.size < ALL_EXCHANGES.length) {
      list = list.filter((t) => {
        const leg = t.bestSpreadLeg;
        if (leg) {
          const [a, b] = leg.split("/");
          return selectedExchanges.has(a) && selectedExchanges.has(b);
        }
        return selectedExchanges.has("bybit") && selectedExchanges.has("binance");
      });
    }
    switch (sort) {
      case "spread_desc":
        list.sort((a, b) => Math.abs(b.spreadPct) - Math.abs(a.spreadPct));
        break;
      case "spread_asc":
        list.sort((a, b) => Math.abs(a.spreadPct) - Math.abs(b.spreadPct));
        break;
      case "volume_desc":
        list.sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0));
        break;
      case "alpha":
        list.sort((a, b) => a.symbol.localeCompare(b.symbol));
        break;
    }
    if (!favsOnly) {
      list.sort((a, b) => {
        const af = isFavourite(a.symbol) ? 0 : 1;
        const bf = isFavourite(b.symbol) ? 0 : 1;
        return af - bf;
      });
    }
    return list;
  }, [tokens, favsOnly, search, sort, maxSpread, selectedExchanges, isFavourite]);

  const selectedToken = tokens.find((t) => t.symbol === selectedSymbol) ?? null;

  return (
    <div className="space-y-3">
      {/* No credentials banner */}
      {!hasCredentials && (
        <div className="flex items-center gap-3 bg-card border border-amber-500/20 rounded px-4 py-3 text-sm">
          <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
          <span className="text-muted-foreground">
            Add your API keys in{" "}
            <Link href="/settings" className="text-foreground underline hover:text-primary">Settings</Link>
            {" "}to see live balances and open positions. Price spreads load without keys.
          </span>
        </div>
      )}

      {/* Demo data banner */}
      {isDemoData && (
        <div className="flex items-center gap-3 bg-card border border-violet-500/20 rounded px-4 py-2 text-xs">
          <Zap className="w-3.5 h-3.5 text-violet-400 shrink-0" />
          <span className="text-muted-foreground">
            <span className="text-violet-400 font-semibold">DEMO MODE</span>
            {" — "}Live exchange data unavailable from this server region. Deploy the backend to a supported region for real-time spreads. Prices shown are simulated.
          </span>
        </div>
      )}

      {/* Open Positions */}
      {positions.length > 0 && (
        <div className="bg-card border border-border rounded-md overflow-hidden">
          <button
            onClick={() => setShowPositions(!showPositions)}
            className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-muted/30 transition-colors"
            data-testid="btn-toggle-positions"
          >
            <div className="flex items-center gap-2 text-sm font-semibold">
              <TrendingUp className="w-4 h-4 text-primary" />
              Open Positions
              <span className="bg-primary/20 text-primary text-xs px-1.5 py-0.5 rounded">{positions.length}</span>
            </div>
            {showPositions ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
          </button>

          {showPositions && (
            <div>
              <div className="grid grid-cols-7 gap-2 px-3 py-2 text-xs text-muted-foreground uppercase tracking-wider bg-muted/30 font-semibold">
                <span>Symbol</span>
                <span>Side</span>
                <span>Size</span>
                <span>Spread</span>
                <span>P/L</span>
                <span>Opened</span>
                <span></span>
              </div>
              {positions.map((pos) => (
                <PositionRow
                  key={pos.id}
                  position={pos}
                  onCloseSuccess={removePosition}
                  onDismiss={removePosition}
                  isLocalOnly={!hasCredentials && localOnlySymbols.has(pos.symbol)}
                  requestHeaders={requestHeaders}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-40 max-w-72">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tokens..."
            className="pl-8 bg-card border-border text-sm h-8"
            data-testid="input-search"
          />
        </div>

        <button
          onClick={() => setFavsOnly(!favsOnly)}
          data-testid="btn-favs-only"
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium border transition-all ${
            favsOnly
              ? "bg-amber-400/10 border-amber-400/30 text-amber-400"
              : "bg-card border-border text-muted-foreground hover:text-foreground"
          }`}
        >
          <Star className={`w-3.5 h-3.5 ${favsOnly ? "fill-amber-400" : ""}`} />
          Favourites
        </button>

        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as SortOption)}
          className="bg-card border border-border rounded text-xs px-2.5 py-1.5 text-foreground h-8 cursor-pointer"
          data-testid="select-sort"
        >
          <option value="spread_desc">Highest Spread</option>
          <option value="spread_asc">Lowest Spread</option>
          <option value="volume_desc">Highest Volume</option>
          <option value="alpha">Alphabetical</option>
        </select>

        <select
          value={maxSpread}
          onChange={(e) => setMaxSpread(e.target.value)}
          className="bg-card border border-border rounded text-xs px-2.5 py-1.5 text-foreground h-8 cursor-pointer"
          data-testid="select-max-spread"
        >
          <option value="">Max spread: all</option>
          <option value="0.5">Max spread: 0.5%</option>
          <option value="1">Max spread: 1%</option>
          <option value="2">Max spread: 2%</option>
          <option value="5">Max spread: 5%</option>
        </select>

        <div className="flex items-center gap-1" data-testid="exchange-toggles">
          {([
            { key: "bybit",   label: "BB",  on: "text-amber-400 border-amber-400/40 bg-amber-400/10" },
            { key: "binance", label: "BN",  on: "text-violet-400 border-violet-400/40 bg-violet-400/10" },
            { key: "gate",    label: "GT",  on: "text-sky-400 border-sky-400/40 bg-sky-400/10" },
            { key: "okx",     label: "OKX", on: "text-emerald-400 border-emerald-400/40 bg-emerald-400/10" },
            { key: "mexc",    label: "MX",  on: "text-rose-400 border-rose-400/40 bg-rose-400/10" },
          ] as const).map(({ key, label, on }) => (
            <button
              key={key}
              onClick={() => toggleExchange(key)}
              title={selectedExchanges.has(key) ? `Hide ${label}` : `Show ${label}`}
              className={`px-2 py-1 rounded text-[11px] font-semibold font-mono border transition-all ${
                selectedExchanges.has(key)
                  ? on
                  : "text-muted-foreground/40 border-border bg-card opacity-50"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          <div className={`w-1.5 h-1.5 rounded-full live-dot ${isFetching ? "bg-primary" : "bg-muted-foreground"}`} />
          {isLoading ? "Loading..." : `${filteredTokens.length} pairs`}
        </div>
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        <div className={`${selectedToken ? "lg:col-span-2 xl:col-span-3" : "lg:col-span-3 xl:col-span-4"}`}>
          {isLoading ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
              {Array.from({ length: 12 }).map((_, i) => (
                <div key={i} className="bg-card border border-border rounded p-3 h-24 animate-pulse" />
              ))}
            </div>
          ) : isError ? (
            <div className="flex items-center justify-center h-40 text-destructive gap-2">
              <AlertCircle className="w-5 h-5" />
              Failed to load prices. Check your connection.
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
              {filteredTokens.map((token) => (
                <TokenCard
                  key={token.symbol}
                  token={token}
                  isSelected={selectedSymbol === token.symbol}
                  isFavourite={isFavourite(token.symbol)}
                  isWatched={isWatched(token.symbol)}
                  onSelect={() => setSelectedSymbol(selectedSymbol === token.symbol ? null : token.symbol)}
                  onToggleFavourite={(e) => {
                    e.stopPropagation();
                    toggleFavourite(token.symbol);
                  }}
                  onToggleWatch={(e) => {
                    e.stopPropagation();
                    toggleWatch(token.symbol, getThreshold(token.symbol));
                  }}
                />
              ))}
              {filteredTokens.length === 0 && (
                <div className="col-span-full text-center text-muted-foreground py-12 text-sm">
                  No tokens match your filters.
                </div>
              )}
            </div>
          )}
        </div>

        {selectedToken && (
          <div className="lg:col-span-1">
            <TokenDetailPanel
              token={selectedToken}
              onClose={() => setSelectedSymbol(null)}
              requestHeaders={requestHeaders}
              activePosition={positions.find((p) => p.symbol === selectedToken.symbol)}
              onJumpInSuccess={savePosition}
            />
          </div>
        )}
      </div>
    </div>
  );
}
