import { useState, useMemo } from "react";
import { Link } from "wouter";
import { Star, Search, TrendingUp, TrendingDown, Zap, AlertCircle, ChevronDown, ChevronUp, X } from "lucide-react";
import { useGetExchangePrices, getGetExchangePricesQueryKey, useGetPositions, getGetPositionsQueryKey, useJumpIn, useClosePosition } from "@workspace/api-client-react";
import type { TokenSpread, Position, ClosePositionResult, JumpInResult } from "@workspace/api-client-react";
import { useLocalPositions } from "@/hooks/use-local-positions";
import { useApiCredentials } from "@/hooks/use-api-credentials";
import { useFavourites } from "@/hooks/use-favourites";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useQueryClient } from "@tanstack/react-query";

type SortOption = "spread_desc" | "spread_asc" | "volume_desc" | "alpha";

function formatPrice(price: number | null | undefined): string {
  if (price == null) return "-";
  if (price >= 1000) return price.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(6);
}

function formatPct(pct: number | null | undefined): string {
  if (pct == null) return "-";
  return (pct >= 0 ? "+" : "") + pct.toFixed(4) + "%";
}

function formatFunding(rate: number | null | undefined): string {
  if (rate == null) return "-";
  return (rate * 100).toFixed(4) + "%";
}

function formatPnl(pnl: number | null | undefined): string {
  if (pnl == null) return "-";
  return (pnl >= 0 ? "+" : "") + "$" + Math.abs(pnl).toFixed(2);
}

function SpreadBadge({ spreadPct }: { spreadPct: number }) {
  const abs = Math.abs(spreadPct);
  const isPositive = spreadPct >= 0;
  let colorClass = "text-muted-foreground";
  if (abs >= 1) colorClass = isPositive ? "text-primary" : "text-destructive";
  else if (abs >= 0.3) colorClass = "text-amber-400";

  return (
    <span className={`font-mono font-semibold text-sm ${colorClass}`}>
      {formatPct(spreadPct)}
    </span>
  );
}

function TokenCard({
  token,
  isSelected,
  isFavourite,
  onSelect,
  onToggleFavourite,
}: {
  token: TokenSpread;
  isSelected: boolean;
  isFavourite: boolean;
  onSelect: () => void;
  onToggleFavourite: (e: React.MouseEvent) => void;
}) {
  return (
    <div
      onClick={onSelect}
      data-testid={`card-token-${token.symbol}`}
      className={`bg-card border rounded p-3 cursor-pointer transition-all hover:border-primary/40 ${
        isSelected ? "border-primary/60 bg-primary/5" : "border-border"
      }`}
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
        </div>
        <SpreadBadge spreadPct={token.spreadPct} />
      </div>

      <div className="grid grid-cols-2 gap-x-2 text-xs">
        <div>
          <span className="text-amber-400/70 font-semibold">BB</span>
          <span className="ml-1 font-mono text-foreground">{formatPrice(token.bybitPrice)}</span>
        </div>
        <div>
          <span className="text-violet-400/70 font-semibold">BN</span>
          <span className="ml-1 font-mono text-foreground">{formatPrice(token.binancePrice)}</span>
        </div>
        <div className="mt-0.5 text-muted-foreground">
          FR: <span className={token.bybitFundingRate != null && token.bybitFundingRate > 0 ? "text-primary" : "text-destructive"}>
            {formatFunding(token.bybitFundingRate)}
          </span>
        </div>
        <div className="mt-0.5 text-muted-foreground">
          FR: <span className={token.binanceFundingRate != null && token.binanceFundingRate > 0 ? "text-primary" : "text-destructive"}>
            {formatFunding(token.binanceFundingRate)}
          </span>
        </div>
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
  const [bybitLeverage, setBybitLeverage] = useState("5");
  const [binanceLeverage, setBinanceLeverage] = useState("5");
  const [isJumping, setIsJumping] = useState(false);

  const { toast } = useToast();
  const queryClient = useQueryClient();

  const jumpIn = useJumpIn({ request: requestHeaders ?? undefined });

  const handleJumpIn = async () => {
    const size = Number(orderSize);
    if (!size || size <= 0) {
      toast({ title: "Invalid size", description: "Enter a valid USD amount", variant: "destructive" });
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
              bybitLeverage: Number(bybitLeverage),
              binanceLeverage: Number(binanceLeverage),
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
          <span className="text-xs text-amber-400 font-semibold bg-amber-400/10 px-2 py-0.5 rounded">
            BYBIT {token.bybitPrice > token.binancePrice ? "↑" : "↓"}
          </span>
          <span className="text-xs text-violet-400 font-semibold bg-violet-400/10 px-2 py-0.5 rounded">
            BINANCE {token.binancePrice > token.bybitPrice ? "↑" : "↓"}
          </span>
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
        <p className="text-xs text-muted-foreground mt-1">
          {Number(orderSize) > 0 && (
            <>~${(Number(orderSize) / 2).toFixed(2)} per exchange</>
          )}
        </p>
      </div>

      {/* Leverage */}
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

      {/* Active position P&L */}
      {activePosition && (
        <div className="rounded border border-primary/20 bg-primary/5 px-3 py-2 space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground uppercase tracking-wider font-semibold">Active Position</span>
            <span className={`font-mono font-bold text-base ${(activePosition.totalPnl ?? 0) >= 0 ? "text-primary" : "text-destructive"}`}>
              {formatPnl(activePosition.totalPnl)}
            </span>
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Entry spread: <span className="font-mono text-foreground">{formatPct(activePosition.spreadAtEntry)}</span></span>
            <span>Now: <span className="font-mono text-foreground">{formatPct(activePosition.currentSpread)}</span></span>
          </div>
        </div>
      )}

      {/* JUMP IN */}
      <Button
        onClick={handleJumpIn}
        disabled={isJumping || !requestHeaders}
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

      {/* Live data table */}
      <div className="border border-border rounded overflow-hidden">
        <div className="grid grid-cols-3 bg-muted text-xs px-2 py-1.5 text-muted-foreground font-semibold uppercase tracking-wider">
          <span></span>
          <span className="text-amber-400/80">BYBIT</span>
          <span className="text-violet-400/80">BINANCE</span>
        </div>
        {[
          { label: "Price", bybit: formatPrice(token.bybitPrice), binance: formatPrice(token.binancePrice) },
          { label: "Bid", bybit: formatPrice(token.bybitBid), binance: formatPrice(token.binanceBid) },
          { label: "Ask", bybit: formatPrice(token.bybitAsk), binance: formatPrice(token.binanceAsk) },
          { label: "Funding", bybit: formatFunding(token.bybitFundingRate), binance: formatFunding(token.binanceFundingRate) },
          { label: "Next Fund", bybit: token.bybitNextFunding ? new Date(token.bybitNextFunding).toLocaleTimeString() : "-", binance: token.binanceNextFunding ? new Date(token.binanceNextFunding).toLocaleTimeString() : "-" },
          { label: "Spread", bybit: formatPct(token.spreadPct), binance: "-" },
        ].map((row, i) => (
          <div
            key={row.label}
            className={`grid grid-cols-3 text-xs px-2 py-1.5 ${i % 2 === 0 ? "bg-card" : "bg-background"}`}
          >
            <span className="text-muted-foreground">{row.label}</span>
            <span className="font-mono text-foreground">{row.bybit}</span>
            <span className="font-mono text-foreground">{row.binance}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PositionRow({
  position,
  onClose,
  onCloseSuccess,
  requestHeaders,
}: {
  position: Position;
  onClose: (pos: Position) => void;
  onCloseSuccess: (symbol: string) => void;
  requestHeaders: ReturnType<ReturnType<typeof useApiCredentials>["getRequestHeaders"]>;
}) {
  const [isClosing, setIsClosing] = useState(false);
  const closePosition = useClosePosition({ request: requestHeaders });
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const handleClose = async () => {
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
      onCloseSuccess(position.symbol);
      toast({ title: "Position closed", description: `${position.symbol} position closed successfully` });
      await queryClient.invalidateQueries({ queryKey: getGetPositionsQueryKey() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Close failed";
      toast({ title: "Close failed", description: msg, variant: "destructive" });
    } finally {
      setIsClosing(false);
    }
  };

  const pnlPositive = (position.totalPnl ?? 0) >= 0;

  return (
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
        {formatPnl(position.totalPnl)}
      </span>
      <span className="font-mono text-muted-foreground">
        {position.openedAt ? new Date(position.openedAt).toLocaleTimeString() : "-"}
      </span>
      <button
        onClick={handleClose}
        disabled={isClosing}
        data-testid={`btn-close-position-${position.symbol}`}
        className="text-xs text-destructive hover:bg-destructive/10 px-2 py-1 rounded transition-colors disabled:opacity-50"
      >
        {isClosing ? "..." : "Close"}
      </button>
    </div>
  );
}

export default function Dashboard() {
  const { getRequestHeaders, hasCredentials } = useApiCredentials();
  const { isFavourite, toggleFavourite } = useFavourites();
  const requestHeaders = getRequestHeaders();
  const { localPositions, savePosition, removePosition } = useLocalPositions();

  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortOption>("spread_desc");
  const [favsOnly, setFavsOnly] = useState(false);
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [showPositions, setShowPositions] = useState(true);

  const pricesQuery = useGetExchangePrices({
    query: { refetchInterval: 3000, queryKey: getGetExchangePricesQueryKey() },
    request: requestHeaders ?? undefined,
  });

  const positionsQuery = useGetPositions({
    query: {
      refetchInterval: 3000,
      queryKey: getGetPositionsQueryKey(),
      enabled: hasCredentials,
    },
    request: requestHeaders ?? undefined,
  });

  const tokens = pricesQuery.data ?? [];
  const polledPositions = positionsQuery.data ?? [];

  const positions = useMemo(() => {
    const polledSymbols = new Set(polledPositions.map((p) => p.symbol));
    const localOnly = localPositions.filter((p) => !polledSymbols.has(p.symbol));
    return [...polledPositions, ...localOnly];
  }, [polledPositions, localPositions]);
  const isDemoData = tokens.length > 0 && tokens[0].demo === true;

  const filteredTokens = useMemo(() => {
    let list = [...tokens];
    if (favsOnly) list = list.filter((t) => isFavourite(t.symbol));
    if (search) list = list.filter((t) => t.symbol.toLowerCase().includes(search.toLowerCase()));
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
  }, [tokens, favsOnly, search, sort, isFavourite]);

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
      {hasCredentials && positions.length > 0 && (
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
                  onClose={() => {}}
                  onCloseSuccess={removePosition}
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

        <div className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          <div className={`w-1.5 h-1.5 rounded-full live-dot ${pricesQuery.isFetching ? "bg-primary" : "bg-muted-foreground"}`} />
          {pricesQuery.isLoading ? "Loading..." : `${filteredTokens.length} pairs`}
        </div>
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        <div className={`${selectedToken ? "lg:col-span-2 xl:col-span-3" : "lg:col-span-3 xl:col-span-4"}`}>
          {pricesQuery.isLoading ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
              {Array.from({ length: 12 }).map((_, i) => (
                <div key={i} className="bg-card border border-border rounded p-3 h-24 animate-pulse" />
              ))}
            </div>
          ) : pricesQuery.isError ? (
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
                  onSelect={() => setSelectedSymbol(selectedSymbol === token.symbol ? null : token.symbol)}
                  onToggleFavourite={(e) => {
                    e.stopPropagation();
                    toggleFavourite(token.symbol);
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
