import { useState, useMemo, useEffect, useRef } from "react";
import { Link } from "wouter";
import { Star, Search, TrendingUp, TrendingDown, Zap, AlertCircle, ChevronDown, ChevronUp, X, Bell, BellOff, Bot } from "lucide-react";
import { useGetExchangePrices, getGetExchangePricesQueryKey, useGetPositions, getGetPositionsQueryKey } from "@workspace/api-client-react";
import type { TokenSpread, Position, BotConfig } from "@workspace/api-client-react";
import { TokenDetailPanel } from "@/components/token-detail-panel";
import { useBots } from "@/hooks/use-bots";
import { useBotSecret } from "@/hooks/use-bot-secret";
import { useLocalPositions } from "@/hooks/use-local-positions";
import { useApiCredentials } from "@/hooks/use-api-credentials";
import { useFavourites } from "@/hooks/use-favourites";
import { useWatchedTokens } from "@/hooks/use-watched-tokens";
import { useAlertSettings } from "@/hooks/use-alert-settings";
import { useSpreadAlerts } from "@/hooks/use-spread-alerts";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { usePriceStream } from "@/hooks/use-price-stream";
import { useConnectionStatus } from "@/contexts/connection-status";
import { usePageVisibility } from "@/hooks/use-page-visibility";
import {
  BotSummaryRow,
  PositionRow,
  botLegToPosition,
  formatPrice,
  formatPct,
  formatPnlWithPct,
} from "@/components/position-rows";

type SortOption = "spread_desc" | "spread_asc" | "volume_desc" | "alpha";

const ALL_EXCHANGES_LIST = ["bybit", "binance", "gate", "okx", "mexc"] as const;
const FILTER_STORAGE_KEY = "dashboard-filters";

const DEFAULT_FILTERS = {
  sort: "spread_desc" as SortOption,
  maxSpread: "",
  minVolume: "",
  minOpenInterest: "",
  minSpreadDepth: "",
  selectedExchanges: [...ALL_EXCHANGES_LIST] as string[],
};

function loadFilters() {
  try {
    const raw = localStorage.getItem(FILTER_STORAGE_KEY);
    if (!raw) return DEFAULT_FILTERS;
    const parsed = JSON.parse(raw);
    return {
      sort: (parsed.sort as SortOption) ?? DEFAULT_FILTERS.sort,
      maxSpread: parsed.maxSpread ?? DEFAULT_FILTERS.maxSpread,
      minVolume: parsed.minVolume ?? DEFAULT_FILTERS.minVolume,
      minOpenInterest: parsed.minOpenInterest ?? DEFAULT_FILTERS.minOpenInterest,
      minSpreadDepth: parsed.minSpreadDepth ?? DEFAULT_FILTERS.minSpreadDepth,
      selectedExchanges: Array.isArray(parsed.selectedExchanges) ? parsed.selectedExchanges : DEFAULT_FILTERS.selectedExchanges,
    };
  } catch {
    return DEFAULT_FILTERS;
  }
}

function formatFunding(rate: number | null | undefined): string {
  if (rate == null) return "-";
  return (rate * 100).toFixed(4) + "%";
}

function parseVolume(v: string): number {
  const s = v.trim().replace(/,/g, "").replace(/\$/g, "");
  const m = s.match(/^(\d+(?:\.\d+)?)\s*([kmb])?$/i);
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  const suffix = (m[2] || "").toLowerCase();
  if (suffix === "k") return n * 1_000;
  if (suffix === "m") return n * 1_000_000;
  if (suffix === "b") return n * 1_000_000_000;
  return n;
}

function formatUsd(v: number | null | undefined): string {
  if (v == null) return "-";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function getExchangeFields(token: TokenSpread, ex: string) {
  switch (ex) {
    case "bybit":   return { ask: token.bybitAsk,   bid: token.bybitBid,   funding: token.bybitFundingRate };
    case "binance": return { ask: token.binanceAsk, bid: token.binanceBid, funding: token.binanceFundingRate };
    case "gate":    return { ask: token.gateAsk,    bid: token.gateBid,    funding: token.gateFundingRate };
    case "okx":     return { ask: token.okxAsk,     bid: token.okxBid,     funding: token.okxFundingRate };
    case "mexc":    return { ask: token.mexcAsk,    bid: token.mexcBid,    funding: token.mexcFundingRate };
    default:        return { ask: undefined, bid: undefined, funding: undefined };
  }
}

const EXCHANGE_LABELS: Record<string, string> = {
  bybit: "BB", binance: "BN", gate: "GT", okx: "OKX", mexc: "MX",
};
const EXCHANGE_COLORS: Record<string, string> = {
  bybit: "text-amber-400", binance: "text-violet-400", gate: "text-sky-400", okx: "text-emerald-400", mexc: "text-rose-400",
};

function TokenCard({
  token,
  isSelected,
  isFavourite,
  isWatched,
  onSelect,
  onToggleFavourite,
  onToggleWatch,
  bot,
  botOpenLegsCount,
}: {
  token: TokenSpread;
  isSelected: boolean;
  isFavourite: boolean;
  isWatched: boolean;
  onSelect: () => void;
  onToggleFavourite: (e: React.MouseEvent) => void;
  onToggleWatch: (e: React.MouseEvent) => void;
  bot?: BotConfig;
  botOpenLegsCount?: number;
}) {
  const legsCount = botOpenLegsCount ?? 0;
  const showDot = bot != null;
  const dotColor = legsCount > 0 ? "bg-amber-400" : bot?.enabled ? "bg-emerald-500" : "bg-muted-foreground";
  const dotTitle = legsCount > 0
    ? `Bot: ${legsCount} leg${legsCount !== 1 ? "s" : ""} open`
    : bot?.enabled ? "Bot: running" : "Bot: stopped";

  const [cheapEx, expensiveEx] = (token.bestSpreadLeg ?? "").split("/");
  const cheapData  = cheapEx     ? getExchangeFields(token, cheapEx)     : { ask: undefined, bid: undefined, funding: undefined };
  const expData    = expensiveEx ? getExchangeFields(token, expensiveEx) : { ask: undefined, bid: undefined, funding: undefined };
  const rawSpread  = token.bestSpreadPct != null ? token.bestSpreadPct : Math.abs(token.spreadPct);
  const effSpread  = cheapData.ask != null && expData.bid != null && cheapData.ask > 0
    ? (expData.bid - cheapData.ask) / cheapData.ask * 100
    : null;
  const spreadColor = rawSpread >= 1 ? "text-primary" : rawSpread >= 0.3 ? "text-amber-400" : "text-muted-foreground";

  return (
    <div
      onClick={onSelect}
      data-testid={`card-token-${token.symbol}`}
      className={`bg-card border rounded p-3 cursor-pointer transition-all hover:border-primary/40 select-none ${
        isSelected ? "border-primary/60 bg-primary/5" : "border-border"
      } ${isWatched ? "border-primary/30" : ""}`}
    >
      {/* Header */}
      <div className="flex items-start justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          <span className="font-semibold text-sm">{token.symbol}</span>
          <button
            onClick={onToggleFavourite}
            className="text-muted-foreground hover:text-amber-400 transition-colors"
            data-testid={`btn-favourite-${token.symbol}`}
          >
            <Star className={`w-3.5 h-3.5 ${isFavourite ? "fill-amber-400 text-amber-400" : ""}`} />
          </button>
          <button
            onClick={onToggleWatch}
            className={`transition-colors ${isWatched ? "text-primary" : "text-muted-foreground hover:text-primary"}`}
            data-testid={`btn-watch-${token.symbol}`}
            title={isWatched ? "Stop watching" : "Watch spread"}
          >
            {isWatched ? <Bell className="w-3.5 h-3.5 fill-primary/20" /> : <BellOff className="w-3.5 h-3.5" />}
          </button>
          {showDot && (
            <div
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`}
              title={dotTitle}
              data-testid={`bot-dot-${token.symbol}`}
            />
          )}
        </div>
        <div className="text-right leading-tight">
          <div className={`font-mono font-semibold text-sm ${spreadColor}`}>
            {isFinite(rawSpread) ? `+${rawSpread.toFixed(4)}%` : "-"}
          </div>
          {effSpread != null && isFinite(effSpread) && (
            <div className={`font-mono text-[10px] ${effSpread >= 0.3 ? "text-primary/70" : "text-muted-foreground"}`}>
              eff +{effSpread.toFixed(4)}%
            </div>
          )}
          {token.bestSpreadLeg && (
            <div className="text-[10px] font-mono text-muted-foreground leading-tight">
              {token.bestSpreadLeg.split("/").map((ex, i) => (
                <span key={ex}>
                  {i > 0 && <span className="text-muted-foreground/40">/</span>}
                  <span className={EXCHANGE_COLORS[ex] ?? ""}>{EXCHANGE_LABELS[ex] ?? ex.toUpperCase()}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Two-exchange ask / bid boxes */}
      {cheapEx && expensiveEx && (
        <div className="grid grid-cols-2 gap-1 mb-1.5">
          <div className="bg-primary/5 border border-primary/10 rounded px-1.5 py-1">
            <div className={`font-semibold text-[10px] mb-0.5 ${EXCHANGE_COLORS[cheapEx] ?? ""}`}>
              {EXCHANGE_LABELS[cheapEx] ?? cheapEx.toUpperCase()} ↑ Ask
            </div>
            <div className="font-mono text-xs text-foreground">{formatPrice(cheapData.ask)}</div>
            {cheapData.funding != null && (
              <div className={`text-[10px] font-mono mt-0.5 ${cheapData.funding > 0 ? "text-primary/60" : "text-destructive/60"}`}>
                FR {formatFunding(cheapData.funding)}
              </div>
            )}
          </div>
          <div className="bg-destructive/5 border border-destructive/10 rounded px-1.5 py-1">
            <div className={`font-semibold text-[10px] mb-0.5 ${EXCHANGE_COLORS[expensiveEx] ?? ""}`}>
              {EXCHANGE_LABELS[expensiveEx] ?? expensiveEx.toUpperCase()} ↓ Bid
            </div>
            <div className="font-mono text-xs text-foreground">{formatPrice(expData.bid)}</div>
            {expData.funding != null && (
              <div className={`text-[10px] font-mono mt-0.5 ${expData.funding > 0 ? "text-primary/60" : "text-destructive/60"}`}>
                FR {formatFunding(expData.funding)}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Footer: depth · volume · Open button */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          {token.spreadDepthUsd != null && (
            <span title="Fillable depth at this spread">⬡ {formatUsd(token.spreadDepthUsd)}</span>
          )}
          {token.volume24h != null && (
            <span className="text-muted-foreground/50">{formatUsd(token.volume24h)}</span>
          )}
        </div>
        <Link
          href={`/token/${token.symbol}`}
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
          className="text-[10px] text-muted-foreground hover:text-foreground border border-border/60 hover:border-border rounded px-1.5 py-0.5 transition-colors font-medium shrink-0"
          data-testid={`btn-open-${token.symbol}`}
        >
          Open ↗
        </Link>
      </div>
    </div>
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
  const { getBotStatusForSymbol, allOpenLegs } = useBots();
  const { getBotRequestOptions } = useBotSecret();

  const ALL_EXCHANGES = ALL_EXCHANGES_LIST;

  const [_savedFilters] = useState(() => loadFilters());

  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortOption>(_savedFilters.sort);
  const [favsOnly, setFavsOnly] = useState(false);
  const [maxSpread, setMaxSpread] = useState<string>(_savedFilters.maxSpread);
  const [minVolume, setMinVolume] = useState<string>(_savedFilters.minVolume);
  const [minOpenInterest, setMinOpenInterest] = useState<string>(_savedFilters.minOpenInterest);
  const [minSpreadDepth, setMinSpreadDepth] = useState<string>(_savedFilters.minSpreadDepth);
  const [selectedExchanges, setSelectedExchanges] = useState<Set<string>>(new Set(_savedFilters.selectedExchanges));

  useEffect(() => {
    try {
      localStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify({
        sort,
        maxSpread,
        minVolume,
        minOpenInterest,
        minSpreadDepth,
        selectedExchanges: [...selectedExchanges],
      }));
    } catch {}
  }, [sort, maxSpread, minVolume, minOpenInterest, minSpreadDepth, selectedExchanges]);

  function resetFilters() {
    setSort(DEFAULT_FILTERS.sort);
    setMaxSpread(DEFAULT_FILTERS.maxSpread);
    setMinVolume(DEFAULT_FILTERS.minVolume);
    setMinOpenInterest(DEFAULT_FILTERS.minOpenInterest);
    setMinSpreadDepth(DEFAULT_FILTERS.minSpreadDepth);
    setSelectedExchanges(new Set(DEFAULT_FILTERS.selectedExchanges));
    try { localStorage.removeItem(FILTER_STORAGE_KEY); } catch {}
  }

  const filtersActive = sort !== DEFAULT_FILTERS.sort
    || maxSpread !== ""
    || minVolume !== ""
    || minOpenInterest !== ""
    || minSpreadDepth !== ""
    || selectedExchanges.size !== ALL_EXCHANGES_LIST.length
    || ALL_EXCHANGES_LIST.some((ex) => !selectedExchanges.has(ex));

  const toggleExchange = (ex: string) =>
    setSelectedExchanges((prev) => {
      const next = new Set(prev);
      if (next.has(ex)) { if (next.size > 2) next.delete(ex); }
      else next.add(ex);
      return next;
    });
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  const [showPositions, setShowPositions] = useState(true);
  const [expandedBotSymbols, setExpandedBotSymbols] = useState<Set<string>>(new Set());
  const toggleBotSymbol = (symbol: string) =>
    setExpandedBotSymbols((prev) => {
      const next = new Set(prev);
      if (next.has(symbol)) next.delete(symbol); else next.add(symbol);
      return next;
    });

  const { tokens: streamTokens, isDemoData: streamIsDemo, streamStatus, isFetching: streamFetching } = usePriceStream();
  const isPageVisible = usePageVisibility();

  const wsActive = streamTokens.length > 0 && (streamStatus === "open" || streamStatus === "connecting");

  const pricesQuery = useGetExchangePrices({
    query: {
      refetchInterval: wsActive || !isPageVisible ? false : 2000,
      queryKey: getGetExchangePricesQueryKey(),
      enabled: !wsActive,
    },
    request: requestHeaders ?? undefined,
  });

  const positionsQuery = useGetPositions({
    query: {
      refetchInterval: isPageVisible ? 2000 : false,
      queryKey: getGetPositionsQueryKey(),
      enabled: hasCredentials,
    },
    request: requestHeaders ?? undefined,
  });

  const wasHiddenRef = useRef(false);
  useEffect(() => {
    if (!isPageVisible) {
      wasHiddenRef.current = true;
      return;
    }
    if (wasHiddenRef.current) {
      wasHiddenRef.current = false;
      if (!wsActive) pricesQuery.refetch();
      if (hasCredentials) positionsQuery.refetch();
    }
  }, [isPageVisible, wsActive, hasCredentials, pricesQuery.refetch, positionsQuery.refetch]);

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

  const botLegPositions = useMemo(
    () => allOpenLegs.map((leg) => botLegToPosition(leg, tokens)),
    [allOpenLegs, tokens]
  );

  const positions = useMemo(() => {
    // Symbols with at least one bot leg — the exchange-polled row for these is
    // the exchange's aggregated total (inflated), so we hide it in favour of the
    // individual bot leg rows which already track each trade accurately.
    const botLegSymbols = new Set(botLegPositions.map((p) => p.symbol));
    const filteredPolled = polledPositions.filter((p) => !botLegSymbols.has(p.symbol));
    // Use original polledPositions (pre-filter) so local cached positions for
    // polled symbols are still suppressed, AND additionally exclude any local
    // position whose symbol is covered by bot legs.
    const polledSymbols = new Set(polledPositions.map((p) => p.symbol));
    const localOnly = localPositions.filter(
      (p) => !polledSymbols.has(p.symbol) && !botLegSymbols.has(p.symbol)
    );
    // Bot legs have distinct IDs (bot-leg-{id}); include them alongside other positions
    const existingIds = new Set([...filteredPolled.map((p) => p.id), ...localOnly.map((p) => p.id)]);
    const uniqueBotLegs = botLegPositions.filter((p) => !existingIds.has(p.id));
    return [...filteredPolled, ...localOnly, ...uniqueBotLegs];
  }, [polledPositions, localPositions, botLegPositions]);

  const localOnlySymbols = useMemo(() => {
    const polledSymbols = new Set(polledPositions.map((p) => p.symbol));
    return new Set(localPositions.filter((p) => !polledSymbols.has(p.symbol)).map((p) => p.symbol));
  }, [polledPositions, localPositions]);

  const botLegGroupsBySymbol = useMemo(() => {
    const groups = new Map<string, Position[]>();
    for (const pos of positions) {
      if (pos.id.startsWith("bot-leg-")) {
        const existing = groups.get(pos.symbol) ?? [];
        existing.push(pos);
        groups.set(pos.symbol, existing);
      }
    }
    return groups;
  }, [positions]);

  // Number of visible rows in the positions table (grouped multi-leg symbols count as 1)
  const visiblePositionCount = useMemo(() => {
    const multiLegSymbols = new Set(
      [...botLegGroupsBySymbol.entries()]
        .filter(([, legs]) => legs.length > 1)
        .map(([sym]) => sym)
    );
    const nonGrouped = positions.filter(
      (p) => !p.id.startsWith("bot-leg-") || (botLegGroupsBySymbol.get(p.symbol)?.length ?? 0) <= 1
    );
    return multiLegSymbols.size + nonGrouped.length;
  }, [positions, botLegGroupsBySymbol]);

  const filteredTokens = useMemo(() => {
    let list = [...tokens];
    if (favsOnly) list = list.filter((t) => isFavourite(t.symbol));
    if (search) list = list.filter((t) => t.symbol.toLowerCase().includes(search.toLowerCase()));
    if (maxSpread !== "") {
      const cap = parseFloat(maxSpread);
      if (!isNaN(cap)) list = list.filter((t) => Math.abs(t.bestSpreadPct ?? t.spreadPct) <= cap);
    }
    if (minVolume.trim() !== "") {
      const floor = parseVolume(minVolume);
      if (!isNaN(floor)) list = list.filter((t) => (t.volume24h ?? 0) >= floor);
    }
    if (minOpenInterest.trim() !== "") {
      const floor = parseVolume(minOpenInterest);
      if (!isNaN(floor)) list = list.filter((t) => t.openInterestUsd == null || t.openInterestUsd >= floor);
    }
    if (minSpreadDepth.trim() !== "") {
      const floor = parseVolume(minSpreadDepth);
      if (!isNaN(floor)) list = list.filter((t) => t.spreadDepthUsd == null || t.spreadDepthUsd >= floor);
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
  }, [tokens, favsOnly, search, sort, maxSpread, minVolume, minOpenInterest, minSpreadDepth, selectedExchanges, isFavourite]);

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
              <span className="bg-primary/20 text-primary text-xs px-1.5 py-0.5 rounded">{visiblePositionCount}</span>
              {streamStatus === "open" ? (
                <span className="flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded bg-green-500/15 text-green-500">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                  Live
                </span>
              ) : streamStatus === "connecting" ? (
                <span className="flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                  Connecting
                </span>
              ) : (
                <span className="flex items-center gap-1 text-xs font-medium px-1.5 py-0.5 rounded bg-yellow-500/15 text-yellow-500">
                  <span className="w-1.5 h-1.5 rounded-full bg-yellow-500" />
                  Polling
                </span>
              )}
            </div>
            {showPositions ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
          </button>

          {showPositions && (
            <div>
              <div className="grid grid-cols-9 gap-2 px-3 py-2 text-xs text-muted-foreground uppercase tracking-wider bg-muted/30 font-semibold">
                <span>Symbol</span>
                <span>Side</span>
                <span>Size</span>
                <span>Entry Price (BB/BN)</span>
                <span>Price (BB/BN)</span>
                <span>Spread</span>
                <span>P/L</span>
                <span>Opened</span>
                <span></span>
              </div>
              {(() => {
                const rendered = new Set<string>();
                return positions.map((pos) => {
                  if (pos.id.startsWith("bot-leg-")) {
                    const group = botLegGroupsBySymbol.get(pos.symbol)!;
                    if (group.length > 1) {
                      if (rendered.has(pos.symbol)) return null;
                      rendered.add(pos.symbol);
                      const isExpanded = expandedBotSymbols.has(pos.symbol);
                      return (
                        <div key={`group-${pos.symbol}`}>
                          <BotSummaryRow
                            positions={group}
                            isExpanded={isExpanded}
                            onToggle={() => toggleBotSymbol(pos.symbol)}
                          />
                          {isExpanded && group.map((legPos) => (
                            <div key={legPos.id} className="pl-4 border-l-2 border-primary/20">
                              <PositionRow
                                position={legPos}
                                onCloseSuccess={removePosition}
                                onDismiss={removePosition}
                                isLocalOnly={false}
                                requestHeaders={requestHeaders}
                              />
                            </div>
                          ))}
                        </div>
                      );
                    }
                  }
                  return (
                    <PositionRow
                      key={pos.id}
                      position={pos}
                      onCloseSuccess={removePosition}
                      onDismiss={removePosition}
                      isLocalOnly={!hasCredentials && localOnlySymbols.has(pos.symbol)}
                      requestHeaders={requestHeaders}
                    />
                  );
                });
              })()}
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

        <input
          type="text"
          value={minVolume}
          onChange={(e) => setMinVolume(e.target.value)}
          placeholder="Объем 24ч"
          className="bg-card border border-border rounded text-xs px-2.5 py-1.5 text-foreground h-8 w-28 placeholder:text-muted-foreground"
          data-testid="select-min-volume"
          title="Мин. объем торгов за 24ч — поддерживает 1k, 5M, 1B"
        />

        <input
          type="text"
          value={minOpenInterest}
          onChange={(e) => setMinOpenInterest(e.target.value)}
          placeholder="Откр. интерес"
          className="bg-card border border-border rounded text-xs px-2.5 py-1.5 text-foreground h-8 w-32 placeholder:text-muted-foreground"
          data-testid="select-min-open-interest"
          title="Мин. открытый интерес (суммарно Bybit + Binance) — 1k, 5M, 1B"
        />

        <input
          type="text"
          value={minSpreadDepth}
          onChange={(e) => setMinSpreadDepth(e.target.value)}
          placeholder="Объем спреда"
          className="bg-card border border-border rounded text-xs px-2.5 py-1.5 text-foreground h-8 w-32 placeholder:text-muted-foreground"
          data-testid="select-min-spread-depth"
          title="Мин. глубина стакана на спреде — сколько USD можно исполнить по лучшей цене — 1k, 5M, 1B"
        />

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

        {filtersActive && (
          <button
            onClick={resetFilters}
            data-testid="btn-reset-filters"
            className="flex items-center gap-1 px-2.5 py-1.5 rounded text-xs font-medium border border-border bg-card text-muted-foreground hover:text-foreground hover:border-foreground/30 transition-all"
            title="Reset all filters to defaults"
          >
            <X className="w-3 h-3" />
            Reset filters
          </button>
        )}

        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          {streamStatus === "open" ? (
            <span className="flex items-center gap-1 font-medium px-1.5 py-0.5 rounded bg-green-500/15 text-green-500">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
              Live
            </span>
          ) : streamStatus === "connecting" ? (
            <span className="flex items-center gap-1 font-medium px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
              Connecting
            </span>
          ) : (
            <span className="flex items-center gap-1 font-medium px-1.5 py-0.5 rounded bg-yellow-500/15 text-yellow-500">
              <span className="w-1.5 h-1.5 rounded-full bg-yellow-500" />
              Polling
            </span>
          )}
          <div className={`w-1.5 h-1.5 rounded-full live-dot ${isFetching ? "bg-primary" : "bg-muted-foreground"}`} />
          {isLoading ? "Loading..." : `${filteredTokens.length} pairs`}
        </div>
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        <div className="lg:col-span-2 xl:col-span-3">
          {isLoading ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-3 gap-2">
              {Array.from({ length: 12 }).map((_, i) => (
                <div key={i} className="bg-card border border-border rounded p-3 h-28 animate-pulse" />
              ))}
            </div>
          ) : isError ? (
            <div className="flex items-center justify-center h-40 text-destructive gap-2">
              <AlertCircle className="w-5 h-5" />
              Failed to load prices. Check your connection.
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-3 gap-2">
              {filteredTokens.map((token) => {
                const botStatus = getBotStatusForSymbol(token.symbol);
                return (
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
                    bot={botStatus?.bot}
                    botOpenLegsCount={botStatus?.openLegsCount ?? 0}
                  />
                );
              })}
              {filteredTokens.length === 0 && (
                <div className="col-span-full text-center text-muted-foreground py-12 text-sm">
                  No tokens match your filters.
                </div>
              )}
            </div>
          )}
        </div>

        {/* Trade terminal — always visible */}
        <div className="lg:col-span-1">
          {selectedToken ? (
            (() => {
              const botStatus = getBotStatusForSymbol(selectedToken.symbol);
              return (
                <TokenDetailPanel
                  token={selectedToken}
                  onClose={() => setSelectedSymbol(null)}
                  bot={botStatus?.bot}
                  botOpenLegsCount={botStatus?.openLegsCount ?? 0}
                  botRequestOptions={getBotRequestOptions()}
                />
              );
            })()
          ) : (
            <div className="bg-card border border-border rounded-md p-6 flex flex-col items-center justify-center text-center gap-3 sticky top-4 min-h-[200px]">
              <Zap className="w-8 h-8 text-muted-foreground/20" />
              <div>
                <p className="text-sm font-medium text-muted-foreground">Select a token to configure</p>
                <p className="text-xs text-muted-foreground/50 mt-1">Click any card to trade and JUMP IN</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
