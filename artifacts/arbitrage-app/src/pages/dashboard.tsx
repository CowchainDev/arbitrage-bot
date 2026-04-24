import { useState, useMemo, useEffect, useRef } from "react";
import { Link } from "wouter";
import { Star, Search, TrendingUp, Zap, AlertCircle, ChevronDown, ChevronUp, X, Bell, BellOff, Bot, LayoutList, LayoutGrid, ChevronsUpDown } from "lucide-react";
import { useGetExchangePrices, getGetExchangePricesQueryKey, useGetPositions, getGetPositionsQueryKey } from "@workspace/api-client-react";
import type { TokenSpread, Position, BotConfig } from "@workspace/api-client-react";
import { TokenDetailPanel } from "@/components/token-detail-panel";
import { useBots } from "@/hooks/use-bots";
import { useLocalPositions } from "@/hooks/use-local-positions";
import { useApiCredentials } from "@/hooks/use-api-credentials";
import { useFavourites } from "@/hooks/use-favourites";
import { useWatchedTokens } from "@/hooks/use-watched-tokens";
import { useAlertSettings } from "@/hooks/use-alert-settings";
import { useSpreadAlerts } from "@/hooks/use-spread-alerts";
import { usePriceStream } from "@/hooks/use-price-stream";
import { useConnectionStatus } from "@/contexts/connection-status";
import { usePageVisibility } from "@/hooks/use-page-visibility";
import {
  BotSummaryRow,
  PositionRow,
  botLegToPosition,
  formatPrice,
} from "@/components/position-rows";

type SortOption =
  | "spread_desc" | "spread_asc"
  | "eff_desc"    | "eff_asc"
  | "volume_desc" | "volume_asc"
  | "oi_desc"     | "oi_asc"
  | "depth_desc"  | "depth_asc"
  | "alpha"       | "alpha_desc";

type ViewMode = "list" | "card";
const VIEW_MODE_KEY = "dashboard-view-mode";

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
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(0)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)}K`;
  return `${v.toFixed(0)}`;
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

const ROW_COLS = "grid grid-cols-[130px_82px_82px_68px_100px_100px_66px_72px_72px_66px_60px] items-center gap-0";

type SortColKey = "alpha" | "spread" | "eff" | "volume" | "oi" | "depth";

function sortColFromOption(sort: SortOption): SortColKey | null {
  if (sort === "alpha" || sort === "alpha_desc") return "alpha";
  if (sort === "spread_desc" || sort === "spread_asc") return "spread";
  if (sort === "eff_desc" || sort === "eff_asc") return "eff";
  if (sort === "volume_desc" || sort === "volume_asc") return "volume";
  if (sort === "oi_desc" || sort === "oi_asc") return "oi";
  if (sort === "depth_desc" || sort === "depth_asc") return "depth";
  return null;
}

function sortDirFromOption(sort: SortOption): "asc" | "desc" {
  return sort.endsWith("_asc") || sort === "alpha" ? "asc" : "desc";
}

function toggleSort(current: SortOption, col: SortColKey): SortOption {
  const currentCol = sortColFromOption(current);
  const currentDir = sortDirFromOption(current);
  if (currentCol === col) {
    // Toggle direction
    if (col === "alpha") return currentDir === "asc" ? "alpha_desc" : "alpha";
    if (col === "spread") return currentDir === "desc" ? "spread_asc" : "spread_desc";
    if (col === "eff")    return currentDir === "desc" ? "eff_asc"    : "eff_desc";
    if (col === "volume") return currentDir === "desc" ? "volume_asc" : "volume_desc";
    if (col === "oi")     return currentDir === "desc" ? "oi_asc"     : "oi_desc";
    if (col === "depth")  return currentDir === "desc" ? "depth_asc"  : "depth_desc";
  }
  // First click → default direction (desc for numbers, asc for alpha)
  if (col === "alpha")  return "alpha";
  if (col === "spread") return "spread_desc";
  if (col === "eff")    return "eff_desc";
  if (col === "volume") return "volume_desc";
  if (col === "oi")     return "oi_desc";
  if (col === "depth")  return "depth_desc";
  return current;
}

function SortIcon({ col, sort }: { col: SortColKey; sort: SortOption }) {
  const active = sortColFromOption(sort) === col;
  const dir = sortDirFromOption(sort);
  if (!active) return <ChevronsUpDown className="w-2.5 h-2.5 opacity-20" />;
  return dir === "desc"
    ? <ChevronDown className="w-2.5 h-2.5 text-primary" />
    : <ChevronUp className="w-2.5 h-2.5 text-primary" />;
}

function TableHeader({ sort, onSort }: { sort: SortOption; onSort: (col: SortColKey) => void }) {
  const th = (label: string, col: SortColKey | null, align: "left" | "right" = "right") => {
    const active = col !== null && sortColFromOption(sort) === col;
    return col ? (
      <button
        onClick={() => onSort(col)}
        className={`flex items-center gap-0.5 w-full text-[10px] uppercase tracking-widest font-semibold transition-colors select-none cursor-pointer ${active ? "text-primary" : "text-muted-foreground/60 hover:text-muted-foreground"} ${align === "right" ? "justify-end" : "justify-start"}`}
      >
        {align === "right" && <SortIcon col={col} sort={sort} />}
        {label}
        {align === "left" && <SortIcon col={col} sort={sort} />}
      </button>
    ) : (
      <span className={`text-[10px] uppercase tracking-widest font-semibold text-muted-foreground/60 ${align === "right" ? "text-right block" : ""}`}>{label}</span>
    );
  };

  return (
    <div className={`${ROW_COLS} px-2 py-1.5 border-b border-border/60 bg-muted/20 sticky top-0 z-10`}>
      {th("Symbol", "alpha", "left")}
      {th("Spread", "spread")}
      {th("Eff", "eff")}
      <span className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground/60 text-right">Pair</span>
      <span className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground/60 text-right">Ask</span>
      <span className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground/60 text-right">Bid</span>
      <span className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground/60 text-right">FR Δ</span>
      {th("Vol 24h", "volume")}
      {th("OI", "oi")}
      {th("Depth", "depth")}
      <span />
    </div>
  );
}

function TokenRow({
  token,
  rowIndex,
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
  rowIndex: number;
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
  const dotColor = legsCount > 0 ? "bg-amber-400" : bot?.enabled ? "bg-emerald-500" : "bg-muted-foreground/50";
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
  const spreadColor = rawSpread >= 1
    ? "text-primary font-bold"
    : rawSpread >= 0.3
    ? "text-amber-400 font-semibold"
    : "text-muted-foreground";
  const effColor = effSpread != null && effSpread >= 0.3 ? "text-primary/80" : "text-muted-foreground/50";

  // Funding rate delta between legs
  const frDelta = cheapData.funding != null && expData.funding != null
    ? (expData.funding - cheapData.funding) * 100
    : null;
  const frColor = frDelta != null
    ? frDelta > 0 ? "text-primary/70" : frDelta < 0 ? "text-destructive/70" : "text-muted-foreground/50"
    : "text-muted-foreground/50";

  const rowBg = isSelected
    ? "bg-primary/8 border-l-2 border-l-primary"
    : rowIndex % 2 === 0
    ? "bg-transparent hover:bg-muted/30"
    : "bg-muted/10 hover:bg-muted/30";

  return (
    <div
      onClick={onSelect}
      data-testid={`card-token-${token.symbol}`}
      className={`${ROW_COLS} px-2 cursor-pointer transition-colors border-b border-border/30 group select-none ${rowBg}`}
      style={{ minHeight: "34px" }}
    >
      {/* Symbol + controls */}
      <div className="flex items-center gap-1 min-w-0 py-1">
        <span className="font-mono font-semibold text-xs text-foreground truncate">{token.symbol}</span>
        <button
          onClick={onToggleFavourite}
          className="text-muted-foreground/30 hover:text-amber-400 transition-colors shrink-0 opacity-0 group-hover:opacity-100"
          data-testid={`btn-favourite-${token.symbol}`}
        >
          <Star className={`w-3 h-3 ${isFavourite ? "fill-amber-400 text-amber-400 opacity-100" : ""}`} />
        </button>
        <button
          onClick={onToggleWatch}
          className={`shrink-0 transition-colors opacity-0 group-hover:opacity-100 ${isWatched ? "text-primary opacity-100" : "text-muted-foreground/30 hover:text-primary"}`}
          data-testid={`btn-watch-${token.symbol}`}
          title={isWatched ? "Stop watching" : "Watch spread"}
        >
          {isWatched ? <Bell className="w-3 h-3 fill-primary/20" /> : <BellOff className="w-3 h-3" />}
        </button>
        {showDot && (
          <div
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`}
            title={dotTitle}
            data-testid={`bot-dot-${token.symbol}`}
          />
        )}
        {isFavourite && !showDot && (
          <Star className="w-2.5 h-2.5 fill-amber-400 text-amber-400 shrink-0" />
        )}
      </div>

      {/* Raw spread */}
      <div className={`font-mono text-xs text-right pr-3 tabular-nums ${spreadColor}`}>
        {isFinite(rawSpread) ? `+${rawSpread.toFixed(4)}%` : "-"}
      </div>

      {/* Eff spread */}
      <div className={`font-mono text-[10px] text-right pr-3 tabular-nums ${effColor}`}>
        {effSpread != null && isFinite(effSpread) ? `${effSpread >= 0 ? "+" : ""}${effSpread.toFixed(4)}%` : "-"}
      </div>

      {/* Exchange pair labels */}
      <div className="text-right pr-2">
        {cheapEx && expensiveEx ? (
          <span className="text-[10px] font-mono leading-none">
            <span className={EXCHANGE_COLORS[cheapEx] ?? "text-muted-foreground"}>{EXCHANGE_LABELS[cheapEx] ?? cheapEx.toUpperCase()}</span>
            <span className="text-muted-foreground/30">/</span>
            <span className={EXCHANGE_COLORS[expensiveEx] ?? "text-muted-foreground"}>{EXCHANGE_LABELS[expensiveEx] ?? expensiveEx.toUpperCase()}</span>
          </span>
        ) : (
          <span className="text-muted-foreground/30 text-[10px]">-/-</span>
        )}
      </div>

      {/* Ask price (cheap exchange) */}
      <div className="font-mono text-xs text-right pr-3 tabular-nums text-foreground/80">
        {cheapData.ask != null ? formatPrice(cheapData.ask) : <span className="text-muted-foreground/30">-</span>}
      </div>

      {/* Bid price (expensive exchange) */}
      <div className="font-mono text-xs text-right pr-3 tabular-nums text-foreground/80">
        {expData.bid != null ? formatPrice(expData.bid) : <span className="text-muted-foreground/30">-</span>}
      </div>

      {/* Funding rate delta */}
      <div className={`font-mono text-[10px] text-right pr-3 tabular-nums ${frColor}`}>
        {frDelta != null ? `${frDelta >= 0 ? "+" : ""}${frDelta.toFixed(4)}%` : "-"}
      </div>

      {/* Volume 24h */}
      <div className="font-mono text-[10px] text-right pr-3 tabular-nums text-muted-foreground">
        {formatUsd(token.volume24h)}
      </div>

      {/* Open Interest */}
      <div className="font-mono text-[10px] text-right pr-3 tabular-nums text-muted-foreground">
        {formatUsd(token.openInterestUsd)}
      </div>

      {/* Depth */}
      <div className="font-mono text-[10px] text-right pr-3 tabular-nums text-muted-foreground">
        {formatUsd(token.spreadDepthUsd)}
      </div>

      {/* Open ↗ */}
      <div className="text-right">
        <Link
          href={`/token/${token.symbol}`}
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
          className="text-[10px] text-muted-foreground/40 hover:text-primary border border-transparent hover:border-primary/30 rounded px-1.5 py-0.5 transition-colors font-mono shrink-0"
          data-testid={`btn-open-${token.symbol}`}
        >
          ↗
        </Link>
      </div>
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
  const dotColor = legsCount > 0 ? "bg-amber-400" : bot?.enabled ? "bg-emerald-500" : "bg-muted-foreground/40";

  const [cheapEx, expensiveEx] = (token.bestSpreadLeg ?? "").split("/");
  const cheapData  = cheapEx     ? getExchangeFields(token, cheapEx)     : { ask: undefined, bid: undefined, funding: undefined };
  const expData    = expensiveEx ? getExchangeFields(token, expensiveEx) : { ask: undefined, bid: undefined, funding: undefined };
  const rawSpread  = token.bestSpreadPct != null ? token.bestSpreadPct : Math.abs(token.spreadPct);
  const effSpread  = cheapData.ask != null && expData.bid != null && cheapData.ask > 0
    ? (expData.bid - cheapData.ask) / cheapData.ask * 100
    : null;
  const spreadColor = rawSpread >= 1
    ? "text-primary font-bold"
    : rawSpread >= 0.3
    ? "text-amber-400 font-semibold"
    : "text-muted-foreground";
  const frDelta = cheapData.funding != null && expData.funding != null
    ? (expData.funding - cheapData.funding) * 100
    : null;
  const frColor = frDelta != null
    ? frDelta > 0 ? "text-primary/70" : frDelta < 0 ? "text-destructive/70" : "text-muted-foreground/40"
    : "text-muted-foreground/40";

  const cardBorder = isSelected
    ? "border-primary bg-primary/8"
    : "border-border hover:border-border/80 bg-card";

  return (
    <div
      onClick={onSelect}
      data-testid={`card-token-${token.symbol}`}
      className={`relative rounded border ${cardBorder} p-2.5 cursor-pointer transition-colors group select-none`}
    >
      {/* Header row */}
      <div className="flex items-start justify-between mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="font-mono font-bold text-sm text-foreground truncate">{token.symbol}</span>
          {isFavourite && <Star className="w-3 h-3 fill-amber-400 text-amber-400 shrink-0" />}
          {showDot && <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} />}
        </div>
        {/* Hover controls */}
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            onClick={onToggleFavourite}
            className="text-muted-foreground/40 hover:text-amber-400 transition-colors"
            data-testid={`btn-favourite-${token.symbol}`}
          >
            <Star className={`w-3 h-3 ${isFavourite ? "fill-amber-400 text-amber-400" : ""}`} />
          </button>
          <button
            onClick={onToggleWatch}
            className={`transition-colors ${isWatched ? "text-primary" : "text-muted-foreground/40 hover:text-primary"}`}
            data-testid={`btn-watch-${token.symbol}`}
          >
            {isWatched ? <Bell className="w-3 h-3 fill-primary/20" /> : <BellOff className="w-3 h-3" />}
          </button>
          <Link
            href={`/token/${token.symbol}`}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
            className="text-muted-foreground/40 hover:text-primary transition-colors font-mono text-[10px]"
            data-testid={`btn-open-${token.symbol}`}
          >↗</Link>
        </div>
      </div>

      {/* Spread */}
      <div className="flex items-baseline gap-2 mb-1.5">
        <span className={`font-mono text-lg leading-none tabular-nums ${spreadColor}`}>
          +{isFinite(rawSpread) ? rawSpread.toFixed(2) : "0.00"}%
        </span>
        {effSpread != null && isFinite(effSpread) && (
          <span className="font-mono text-[10px] text-muted-foreground/50 tabular-nums">
            {effSpread >= 0 ? "+" : ""}{effSpread.toFixed(2)}%
          </span>
        )}
      </div>

      {/* Exchange pair + FR delta */}
      <div className="flex items-center gap-1.5 mb-2">
        {cheapEx && expensiveEx ? (
          <span className="text-[10px] font-mono">
            <span className={EXCHANGE_COLORS[cheapEx] ?? "text-muted-foreground"}>{EXCHANGE_LABELS[cheapEx] ?? cheapEx.toUpperCase()}</span>
            <span className="text-muted-foreground/30 mx-0.5">/</span>
            <span className={EXCHANGE_COLORS[expensiveEx] ?? "text-muted-foreground"}>{EXCHANGE_LABELS[expensiveEx] ?? expensiveEx.toUpperCase()}</span>
          </span>
        ) : (
          <span className="text-muted-foreground/30 text-[10px]">-/-</span>
        )}
        {frDelta != null && (
          <span className={`font-mono text-[10px] tabular-nums ml-auto ${frColor}`}>
            {frDelta >= 0 ? "+" : ""}{frDelta.toFixed(4)}%
          </span>
        )}
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-3 gap-x-2 text-[10px] font-mono text-muted-foreground/70">
        <div><span className="text-muted-foreground/40">VOL </span>{formatUsd(token.volume24h)}</div>
        <div><span className="text-muted-foreground/40">OI </span>{formatUsd(token.openInterestUsd)}</div>
        <div><span className="text-muted-foreground/40">DEP </span>{formatUsd(token.spreadDepthUsd)}</div>
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
  const { localPositions, removePosition } = useLocalPositions();
  const { setDataSource } = useConnectionStatus();
  const { getBotStatusForSymbol, allOpenLegsWithBot } = useBots();

  const ALL_EXCHANGES = ALL_EXCHANGES_LIST;

  const [_savedFilters] = useState(() => loadFilters());

  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    (localStorage.getItem(VIEW_MODE_KEY) as ViewMode) ?? "list"
  );

  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortOption>(_savedFilters.sort);
  const [favsOnly, setFavsOnly] = useState(false);
  const [maxSpread, setMaxSpread] = useState<string>(_savedFilters.maxSpread);
  const [minVolume, setMinVolume] = useState<string>(_savedFilters.minVolume);
  const [minOpenInterest, setMinOpenInterest] = useState<string>(_savedFilters.minOpenInterest);
  const [minSpreadDepth, setMinSpreadDepth] = useState<string>(_savedFilters.minSpreadDepth);
  const [selectedExchanges, setSelectedExchanges] = useState<Set<string>>(new Set(_savedFilters.selectedExchanges));

  useEffect(() => {
    try { localStorage.setItem(VIEW_MODE_KEY, viewMode); } catch {}
  }, [viewMode]);

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polledPositions, hasCredentials, positionsQuery.isLoading, positionsQuery.isError, positionsQuery.dataUpdatedAt, removePosition]);

  const botLegPositions = useMemo(
    () => allOpenLegsWithBot.map(({ leg, bot }) => botLegToPosition(leg, tokens, bot)),
    [allOpenLegsWithBot, tokens]
  );

  const positions = useMemo(() => {
    const botLegSymbols = new Set(botLegPositions.map((p) => p.symbol));
    const filteredPolled = polledPositions.filter((p) => !botLegSymbols.has(p.symbol));
    const polledSymbols = new Set(polledPositions.map((p) => p.symbol));
    const localOnly = localPositions.filter(
      (p) => !polledSymbols.has(p.symbol) && !botLegSymbols.has(p.symbol)
    );
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
    const effOf = (t: TokenSpread) => {
      const [cx, ex] = (t.bestSpreadLeg ?? "").split("/");
      const c = cx ? getExchangeFields(t, cx) : { ask: undefined, bid: undefined, funding: undefined };
      const e = ex ? getExchangeFields(t, ex)  : { ask: undefined, bid: undefined, funding: undefined };
      return c.ask != null && e.bid != null && c.ask > 0 ? (e.bid - c.ask) / c.ask * 100 : -Infinity;
    };
    switch (sort) {
      case "spread_desc":  list.sort((a, b) => Math.abs(b.bestSpreadPct ?? b.spreadPct) - Math.abs(a.bestSpreadPct ?? a.spreadPct)); break;
      case "spread_asc":   list.sort((a, b) => Math.abs(a.bestSpreadPct ?? a.spreadPct) - Math.abs(b.bestSpreadPct ?? b.spreadPct)); break;
      case "eff_desc":     list.sort((a, b) => effOf(b) - effOf(a)); break;
      case "eff_asc":      list.sort((a, b) => effOf(a) - effOf(b)); break;
      case "volume_desc":  list.sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0)); break;
      case "volume_asc":   list.sort((a, b) => (a.volume24h ?? 0) - (b.volume24h ?? 0)); break;
      case "oi_desc":      list.sort((a, b) => (b.openInterestUsd ?? 0) - (a.openInterestUsd ?? 0)); break;
      case "oi_asc":       list.sort((a, b) => (a.openInterestUsd ?? 0) - (b.openInterestUsd ?? 0)); break;
      case "depth_desc":   list.sort((a, b) => (b.spreadDepthUsd ?? 0) - (a.spreadDepthUsd ?? 0)); break;
      case "depth_asc":    list.sort((a, b) => (a.spreadDepthUsd ?? 0) - (b.spreadDepthUsd ?? 0)); break;
      case "alpha":        list.sort((a, b) => a.symbol.localeCompare(b.symbol)); break;
      case "alpha_desc":   list.sort((a, b) => b.symbol.localeCompare(a.symbol)); break;
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
    <div className="flex flex-col gap-2" style={{ height: "calc(100vh - 88px)" }}>
      {/* Banners */}
      {!hasCredentials && (
        <div className="flex items-center gap-3 bg-card border border-amber-500/20 rounded px-3 py-2 text-xs shrink-0">
          <AlertCircle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          <span className="text-muted-foreground">
            Add API keys in{" "}
            <Link href="/settings" className="text-foreground underline hover:text-primary">Settings</Link>
            {" "}to see live balances and open positions. Price spreads load without keys.
          </span>
        </div>
      )}
      {isDemoData && (
        <div className="flex items-center gap-3 bg-card border border-violet-500/20 rounded px-3 py-2 text-xs shrink-0">
          <Zap className="w-3 h-3 text-violet-400 shrink-0" />
          <span className="text-muted-foreground">
            <span className="text-violet-400 font-semibold">DEMO</span>
            {" — "}live exchange data unavailable from this server region. Deploy to a supported region for real-time spreads.
          </span>
        </div>
      )}

      {/* Open Positions */}
      {positions.length > 0 && (
        <div className="bg-card border border-border rounded overflow-hidden shrink-0">
          <button
            onClick={() => setShowPositions(!showPositions)}
            className="w-full flex items-center justify-between px-3 py-2 hover:bg-muted/30 transition-colors"
            data-testid="btn-toggle-positions"
          >
            <div className="flex items-center gap-2 text-xs font-semibold">
              <TrendingUp className="w-3.5 h-3.5 text-primary" />
              <span className="uppercase tracking-wider">Open Positions</span>
              <span className="bg-primary/20 text-primary text-[10px] px-1.5 py-0 rounded font-mono">{visiblePositionCount}</span>
              {streamStatus === "open" ? (
                <span className="flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-green-500/15 text-green-500">
                  <span className="w-1 h-1 rounded-full bg-green-500 animate-pulse" />Live
                </span>
              ) : streamStatus === "connecting" ? (
                <span className="flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-500/15 text-blue-400">
                  <span className="w-1 h-1 rounded-full bg-blue-400 animate-pulse" />Connecting
                </span>
              ) : (
                <span className="flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-yellow-500/15 text-yellow-500">
                  <span className="w-1 h-1 rounded-full bg-yellow-500" />Polling
                </span>
              )}
            </div>
            {showPositions ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
          </button>
          {showPositions && (
            <div>
              <div className="grid grid-cols-9 gap-2 px-3 py-1.5 text-[10px] text-muted-foreground uppercase tracking-wider bg-muted/30 font-semibold border-t border-border/40">
                <span>Symbol</span>
                <span>Side</span>
                <span>Size</span>
                <span>Entry Price (A/B)</span>
                <span>Price (A/B)</span>
                <span>Spread</span>
                <span>P/L</span>
                <span>Opened</span>
                <span />
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

      {/* Main layout: table + terminal */}
      <div className="flex gap-3 min-h-0 flex-1">
        {/* Token table */}
        <div className="flex flex-col min-h-0 flex-1 bg-card border border-border rounded overflow-hidden">
          {/* Toolbar */}
          <div className="flex items-center gap-1.5 px-2 py-2 border-b border-border/60 bg-muted/10 shrink-0 flex-wrap">
            {/* Search */}
            <div className="relative">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground/50" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search..."
                className="pl-6 pr-2 bg-background border border-border/60 rounded text-xs h-7 w-32 text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 font-mono"
                data-testid="input-search"
              />
            </div>

            {/* Favourites */}
            <button
              onClick={() => setFavsOnly(!favsOnly)}
              data-testid="btn-favs-only"
              className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] font-semibold border transition-all h-7 ${
                favsOnly
                  ? "bg-amber-400/10 border-amber-400/30 text-amber-400"
                  : "bg-transparent border-border/60 text-muted-foreground/60 hover:text-foreground hover:border-border"
              }`}
            >
              <Star className={`w-3 h-3 ${favsOnly ? "fill-amber-400" : ""}`} />
              FAV
            </button>

            {/* View mode toggle */}
            <div className="flex items-center rounded border border-border/60 overflow-hidden">
              <button
                onClick={() => setViewMode("list")}
                title="List view"
                className={`flex items-center justify-center w-7 h-7 transition-colors ${viewMode === "list" ? "bg-primary/20 text-primary" : "bg-transparent text-muted-foreground/40 hover:text-foreground"}`}
                data-testid="btn-view-list"
              >
                <LayoutList className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => setViewMode("card")}
                title="Card view"
                className={`flex items-center justify-center w-7 h-7 transition-colors ${viewMode === "card" ? "bg-primary/20 text-primary" : "bg-transparent text-muted-foreground/40 hover:text-foreground"}`}
                data-testid="btn-view-card"
              >
                <LayoutGrid className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Filter inputs */}
            <input
              type="text"
              value={minVolume}
              onChange={(e) => setMinVolume(e.target.value)}
              placeholder="24h Volume"
              className="bg-background border border-border/60 rounded text-[10px] px-2 h-7 text-foreground w-20 placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 font-mono"
              data-testid="select-min-volume"
              title="Min 24h volume — supports 1k, 5M, 1B"
            />
            <input
              type="text"
              value={minOpenInterest}
              onChange={(e) => setMinOpenInterest(e.target.value)}
              placeholder="Open Interest"
              className="bg-background border border-border/60 rounded text-[10px] px-2 h-7 text-foreground w-20 placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 font-mono"
              data-testid="select-min-open-interest"
              title="Min open interest — 1k, 5M, 1B"
            />
            <input
              type="text"
              value={minSpreadDepth}
              onChange={(e) => setMinSpreadDepth(e.target.value)}
              placeholder="Spread Depth"
              className="bg-background border border-border/60 rounded text-[10px] px-2 h-7 text-foreground w-24 placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 font-mono"
              data-testid="select-min-spread-depth"
              title="Min fillable depth at this spread"
            />

            {/* Exchange toggles */}
            <div className="flex items-center gap-0.5" data-testid="exchange-toggles">
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
                  className={`px-1.5 py-0 h-7 rounded text-[10px] font-semibold font-mono border transition-all ${
                    selectedExchanges.has(key)
                      ? on
                      : "text-muted-foreground/20 border-border/30 bg-transparent"
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
                className="flex items-center gap-1 px-2 h-7 rounded text-[10px] font-mono border border-border/40 text-muted-foreground/50 hover:text-foreground hover:border-foreground/30 transition-all"
                title="Reset all filters"
              >
                <X className="w-2.5 h-2.5" />
                RESET
              </button>
            )}

            {/* Status indicator */}
            <div className="ml-auto flex items-center gap-2 text-[10px] font-mono text-muted-foreground/60">
              {streamStatus === "open" ? (
                <span className="flex items-center gap-1 text-green-500">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />LIVE
                </span>
              ) : streamStatus === "connecting" ? (
                <span className="flex items-center gap-1 text-blue-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />CONN
                </span>
              ) : (
                <span className="flex items-center gap-1 text-yellow-500">
                  <span className="w-1.5 h-1.5 rounded-full bg-yellow-500" />POLL
                </span>
              )}
              <span className={isFetching ? "text-primary" : ""}>
                {isLoading ? "…" : `${filteredTokens.length} PAIRS`}
              </span>
            </div>
          </div>

          {/* Content */}
          <div className="overflow-auto flex-1 min-h-0">
            {isLoading ? (
              <div className="py-8 text-center text-muted-foreground text-xs font-mono">
                <span className="inline-block w-4 h-4 border border-primary border-t-transparent rounded-full animate-spin mr-2 align-middle" />
                Loading...
              </div>
            ) : isError ? (
              <div className="flex items-center justify-center h-32 text-destructive gap-2 text-xs font-mono">
                <AlertCircle className="w-4 h-4" />
                Failed to load prices — check connection
              </div>
            ) : viewMode === "list" ? (
              <div style={{ minWidth: "900px" }}>
                <TableHeader sort={sort} onSort={(col) => setSort(toggleSort(sort, col))} />
                {filteredTokens.map((token, idx) => {
                  const botStatus = getBotStatusForSymbol(token.symbol);
                  return (
                    <TokenRow
                      key={token.symbol}
                      token={token}
                      rowIndex={idx}
                      isSelected={selectedSymbol === token.symbol}
                      isFavourite={isFavourite(token.symbol)}
                      isWatched={isWatched(token.symbol)}
                      onSelect={() => setSelectedSymbol(selectedSymbol === token.symbol ? null : token.symbol)}
                      onToggleFavourite={(e) => { e.stopPropagation(); toggleFavourite(token.symbol); }}
                      onToggleWatch={(e) => { e.stopPropagation(); toggleWatch(token.symbol, getThreshold(token.symbol)); }}
                      bot={botStatus?.bot}
                      botOpenLegsCount={botStatus?.openLegsCount ?? 0}
                    />
                  );
                })}
                {filteredTokens.length === 0 && (
                  <div className="text-center text-muted-foreground/40 py-12 text-xs font-mono">NO TOKENS MATCH FILTERS</div>
                )}
              </div>
            ) : (
              <div className="p-2 grid gap-2 grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6">
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
                      onToggleFavourite={(e) => { e.stopPropagation(); toggleFavourite(token.symbol); }}
                      onToggleWatch={(e) => { e.stopPropagation(); toggleWatch(token.symbol, getThreshold(token.symbol)); }}
                      bot={botStatus?.bot}
                      botOpenLegsCount={botStatus?.openLegsCount ?? 0}
                    />
                  );
                })}
                {filteredTokens.length === 0 && (
                  <div className="col-span-full text-center text-muted-foreground/40 py-12 text-xs font-mono">NO TOKENS MATCH FILTERS</div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Trade terminal sidebar */}
        <div className="w-72 shrink-0 hidden lg:block">
          {selectedToken ? (
            (() => {
              const botStatus = getBotStatusForSymbol(selectedToken.symbol);
              return (
                <TokenDetailPanel
                  token={selectedToken}
                  onClose={() => setSelectedSymbol(null)}
                  bot={botStatus?.bot}
                  botOpenLegsCount={botStatus?.openLegsCount ?? 0}
                />
              );
            })()
          ) : (
            <div className="bg-card border border-border rounded p-6 flex flex-col items-center justify-center text-center gap-3 h-full min-h-[200px]">
              <Bot className="w-6 h-6 text-muted-foreground/20" />
              <div>
                <p className="text-xs font-mono font-semibold text-muted-foreground/50 uppercase tracking-wider">Select a token</p>
                <p className="text-[10px] font-mono text-muted-foreground/30 mt-1">Click any row to configure</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
