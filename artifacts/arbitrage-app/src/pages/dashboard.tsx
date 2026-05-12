import { useState, useMemo, useEffect, useRef } from "react";
import { Link } from "wouter";
import { Star, Search, TrendingUp, AlertCircle, ChevronDown, ChevronUp, X, Bell, BellOff, Bot, LayoutList, LayoutGrid, ChevronsUpDown, Clock } from "lucide-react";
import { useGetExchangePrices, getGetExchangePricesQueryKey, useGetPositions, getGetPositionsQueryKey, useGetBotsStatus, getGetBotsStatusQueryKey } from "@workspace/api-client-react";
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
import { useNow } from "@/hooks/useNow";
import {
  BotSummaryRow,
  PositionRow,
  botLegToPosition,
  formatPrice,
} from "@/components/position-rows";
import { getExchangeName } from "@/lib/exchange-config";

const VALID_SORT_OPTIONS = [
  "spread_desc", "spread_asc",
  "eff_desc",    "eff_asc",
  "volume_desc", "volume_asc",
  "oi_desc",     "oi_asc",
  "depth_desc",  "depth_asc",
  "ema_desc",    "ema_asc",
  "alpha",       "alpha_desc",
  "fav",         "fav_desc",
  "fr_cheap_desc", "fr_cheap_asc",
  "fr_exp_desc",   "fr_exp_asc",
  "fr_delta_desc", "fr_delta_asc",
] as const;

type SortOption = typeof VALID_SORT_OPTIONS[number];

function isValidSortOption(value: unknown): value is SortOption {
  return typeof value === "string" && (VALID_SORT_OPTIONS as readonly string[]).includes(value);
}

type ViewMode = "list" | "card";
const VIEW_MODE_KEY = "dashboard-view-mode";

const ALL_EXCHANGES_LIST = ["bybit", "binance", "gate", "okx", "mexc", "aster", "hyper"] as const;
const FILTER_STORAGE_KEY = "dashboard-filters";

const DEFAULT_FILTERS = {
  sort: "spread_desc" as SortOption,
  maxSpread: "",
  minSpread: "",
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
      sort: isValidSortOption(parsed.sort) ? parsed.sort : DEFAULT_FILTERS.sort,
      maxSpread: parsed.maxSpread ?? DEFAULT_FILTERS.maxSpread,
      minSpread: parsed.minSpread ?? DEFAULT_FILTERS.minSpread,
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

function getExchangeFields(token: TokenSpread, ex: string): { ask: number | undefined; bid: number | undefined; funding: number | undefined; nextFunding: string | undefined } {
  switch (ex) {
    case "bybit":   return { ask: token.bybitAsk,   bid: token.bybitBid,   funding: token.bybitFundingRate,   nextFunding: token.bybitNextFunding };
    case "binance": return { ask: token.binanceAsk, bid: token.binanceBid, funding: token.binanceFundingRate, nextFunding: token.binanceNextFunding };
    case "gate":    return { ask: token.gateAsk,    bid: token.gateBid,    funding: token.gateFundingRate,    nextFunding: token.gateNextFunding };
    case "okx":     return { ask: token.okxAsk,     bid: token.okxBid,     funding: token.okxFundingRate,     nextFunding: token.okxNextFunding };
    case "mexc":    return { ask: token.mexcAsk,    bid: token.mexcBid,    funding: token.mexcFundingRate,    nextFunding: token.mexcNextFunding };
    case "aster":   return { ask: token.asterAsk,   bid: token.asterBid,   funding: token.asterFundingRate,   nextFunding: token.asterNextFunding };
    case "hyper":   return { ask: token.hyperAsk ?? undefined,   bid: token.hyperBid ?? undefined,   funding: token.hyperFundingRate ?? undefined,   nextFunding: token.hyperNextFunding ?? undefined };
    default:        return { ask: undefined, bid: undefined, funding: undefined, nextFunding: undefined };
  }
}

function useFundingCountdown(nextFundingA: string | undefined | null, nextFundingB: string | undefined | null): string {
  const now = useNow(1000);
  const msA = nextFundingA ? new Date(nextFundingA).getTime() - now : null;
  const msB = nextFundingB ? new Date(nextFundingB).getTime() - now : null;
  const ms = [msA, msB].filter((m): m is number => m != null && m > 0).sort((a, b) => a - b)[0] ?? null;
  if (ms == null) return "";
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}


const ROW_COLS = "grid grid-cols-[24px_120px_82px_72px_72px_130px_90px_90px_62px_62px_62px_62px_70px_70px_64px_28px] items-center gap-0";

type SortColKey = "alpha" | "spread" | "eff" | "volume" | "oi" | "depth" | "ema" | "fav" | "fr_cheap" | "fr_exp" | "fr_delta";

function sortColFromOption(sort: SortOption): SortColKey | null {
  if (sort === "alpha" || sort === "alpha_desc") return "alpha";
  if (sort === "spread_desc" || sort === "spread_asc") return "spread";
  if (sort === "eff_desc" || sort === "eff_asc") return "eff";
  if (sort === "volume_desc" || sort === "volume_asc") return "volume";
  if (sort === "oi_desc" || sort === "oi_asc") return "oi";
  if (sort === "depth_desc" || sort === "depth_asc") return "depth";
  if (sort === "ema_desc" || sort === "ema_asc") return "ema";
  if (sort === "fav" || sort === "fav_desc") return "fav";
  if (sort === "fr_cheap_desc" || sort === "fr_cheap_asc") return "fr_cheap";
  if (sort === "fr_exp_desc" || sort === "fr_exp_asc") return "fr_exp";
  if (sort === "fr_delta_desc" || sort === "fr_delta_asc") return "fr_delta";
  return null;
}

function sortDirFromOption(sort: SortOption): "asc" | "desc" {
  if (sort === "fav") return "asc";
  return sort.endsWith("_asc") || sort === "alpha" ? "asc" : "desc";
}

function toggleSort(current: SortOption, col: SortColKey): SortOption {
  const currentCol = sortColFromOption(current);
  const currentDir = sortDirFromOption(current);
  if (currentCol === col) {
    // Toggle direction
    if (col === "alpha")  return currentDir === "asc" ? "alpha_desc" : "alpha";
    if (col === "spread") return currentDir === "desc" ? "spread_asc" : "spread_desc";
    if (col === "eff")    return currentDir === "desc" ? "eff_asc"    : "eff_desc";
    if (col === "volume") return currentDir === "desc" ? "volume_asc" : "volume_desc";
    if (col === "oi")     return currentDir === "desc" ? "oi_asc"     : "oi_desc";
    if (col === "depth")  return currentDir === "desc" ? "depth_asc"  : "depth_desc";
    if (col === "ema")    return currentDir === "desc" ? "ema_asc"    : "ema_desc";
    if (col === "fav")      return currentDir === "asc"  ? "fav_desc"      : "fav";
    if (col === "fr_cheap") return currentDir === "desc" ? "fr_cheap_asc"  : "fr_cheap_desc";
    if (col === "fr_exp")   return currentDir === "desc" ? "fr_exp_asc"    : "fr_exp_desc";
    if (col === "fr_delta") return currentDir === "desc" ? "fr_delta_asc"  : "fr_delta_desc";
  }
  // First click → default direction (desc for numbers, asc for alpha/fav)
  if (col === "alpha")    return "alpha";
  if (col === "spread")   return "spread_desc";
  if (col === "eff")      return "eff_desc";
  if (col === "volume")   return "volume_desc";
  if (col === "oi")       return "oi_desc";
  if (col === "depth")    return "depth_desc";
  if (col === "ema")      return "ema_desc";
  if (col === "fav")      return "fav";
  if (col === "fr_cheap") return "fr_cheap_desc";
  if (col === "fr_exp")   return "fr_exp_desc";
  if (col === "fr_delta") return "fr_delta_desc";
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
      <button
        onClick={() => onSort("fav")}
        className={`flex items-center justify-center gap-0.5 cursor-pointer select-none transition-colors ${sortColFromOption(sort) === "fav" ? "text-primary" : "text-muted-foreground/40 hover:text-muted-foreground"}`}
        title="Sort by favourites"
      >
        <Star className="w-3 h-3" />
        <SortIcon col="fav" sort={sort} />
      </button>
      {th("Symbol", "alpha", "left")}
      {th("Spread", "spread")}
      {th("EMA", "ema")}
      {th("Eff", "eff")}
      <span className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground/60 text-right">Pair</span>
      <span className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground/60 text-right">Ask</span>
      <span className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground/60 text-right">Bid</span>
      {th("FR Δ", "fr_delta")}
      {th("FR ↓", "fr_cheap")}
      {th("FR ↑", "fr_exp")}
      <span className="text-[10px] uppercase tracking-widest font-semibold text-muted-foreground/60 text-right">Next FR</span>
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

  // bestSpreadLeg is "expensive/cheap" from the backend (higher-price exchange first)
  const [expensiveEx, cheapEx] = (token.bestSpreadLeg ?? "").split("/");
  const cheapData  = cheapEx     ? getExchangeFields(token, cheapEx)     : { ask: undefined, bid: undefined, funding: undefined, nextFunding: undefined };
  const expData    = expensiveEx ? getExchangeFields(token, expensiveEx) : { ask: undefined, bid: undefined, funding: undefined, nextFunding: undefined };
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
  const frCountdown = useFundingCountdown(cheapData.nextFunding, null);

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
      {/* Favourite star */}
      <button
        onClick={onToggleFavourite}
        className={`flex items-center justify-center transition-colors shrink-0 ${isFavourite ? "text-amber-400" : "text-muted-foreground/30 opacity-0 group-hover:opacity-100 hover:text-amber-400"}`}
        data-testid={`btn-favourite-${token.symbol}`}
      >
        <Star className={`w-3 h-3 ${isFavourite ? "fill-amber-400" : ""}`} />
      </button>
      {/* Symbol + controls */}
      <div className="flex items-center gap-1 min-w-0 py-1">
        <span className="font-mono font-semibold text-xs text-foreground truncate">{token.symbol}</span>
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
      </div>

      {/* Raw spread */}
      <div className={`font-mono text-xs text-right pr-3 tabular-nums ${spreadColor}`}>
        {isFinite(rawSpread) ? `+${rawSpread.toFixed(4)}%` : "-"}
      </div>

      {/* EMA spread */}
      {(() => {
        const ema = token.emaSpreadPct;
        const emaColor = ema == null ? "text-muted-foreground/30"
          : ema >= 1   ? "text-primary/70 font-semibold"
          : ema >= 0.3 ? "text-amber-400/70"
          : "text-muted-foreground/40";
        return (
          <div className={`font-mono text-[10px] text-right pr-3 tabular-nums ${emaColor}`} title="10-min EMA of spread">
            {ema != null && isFinite(ema) ? `+${ema.toFixed(4)}%` : "-"}
          </div>
        );
      })()}

      {/* Eff spread */}
      <div className={`font-mono text-[10px] text-right pr-3 tabular-nums ${effColor}`}>
        {effSpread != null && isFinite(effSpread) ? `${effSpread >= 0 ? "+" : ""}${effSpread.toFixed(4)}%` : "-"}
      </div>

      {/* Exchange pair labels */}
      <div className="text-right pr-2">
        {cheapEx && expensiveEx ? (
          <span className="text-[10px] font-mono leading-none">
            <span className="text-muted-foreground">{getExchangeName(cheapEx)}</span>
            <span className="text-muted-foreground/30">/</span>
            <span className="text-muted-foreground">{getExchangeName(expensiveEx)}</span>
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
      <div className={`font-mono text-[10px] text-right pr-2 tabular-nums ${frColor}`}>
        {frDelta != null ? `${frDelta >= 0 ? "+" : ""}${frDelta.toFixed(4)}%` : <span className="text-muted-foreground/30">-</span>}
      </div>

      {/* FR Cheap (cheap-side funding rate) */}
      {(() => {
        const rate = cheapData.funding;
        const color = rate == null ? "text-muted-foreground/30"
          : rate > 0 ? "text-primary/70"
          : rate < 0 ? "text-destructive/70"
          : "text-muted-foreground/50";
        return (
          <div className={`font-mono text-[10px] text-right pr-2 tabular-nums ${color}`}>
            {rate != null ? `${rate >= 0 ? "+" : ""}${(rate * 100).toFixed(4)}%` : <span className="text-muted-foreground/30">-</span>}
          </div>
        );
      })()}

      {/* FR Exp (expensive-side funding rate) */}
      {(() => {
        const rate = expData.funding;
        const color = rate == null ? "text-muted-foreground/30"
          : rate > 0 ? "text-primary/70"
          : rate < 0 ? "text-destructive/70"
          : "text-muted-foreground/50";
        return (
          <div className={`font-mono text-[10px] text-right pr-2 tabular-nums ${color}`}>
            {rate != null ? `${rate >= 0 ? "+" : ""}${(rate * 100).toFixed(4)}%` : <span className="text-muted-foreground/30">-</span>}
          </div>
        );
      })()}

      {/* Next FR countdown (cheap-side exchange) */}
      <div className="font-mono text-[10px] text-right pr-2 tabular-nums text-muted-foreground/60">
        {frCountdown || <span className="text-muted-foreground/30">-</span>}
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
  sort,
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
  sort?: SortOption;
}) {
  const legsCount = botOpenLegsCount ?? 0;
  const showDot = bot != null;
  const dotColor = legsCount > 0 ? "bg-amber-400" : bot?.enabled ? "bg-emerald-500" : "bg-muted-foreground/40";

  // bestSpreadLeg is "expensive/cheap" from the backend (higher-price exchange first)
  const [expensiveEx, cheapEx] = (token.bestSpreadLeg ?? "").split("/");
  const cheapData  = cheapEx     ? getExchangeFields(token, cheapEx)     : { ask: undefined, bid: undefined, funding: undefined, nextFunding: undefined };
  const expData    = expensiveEx ? getExchangeFields(token, expensiveEx) : { ask: undefined, bid: undefined, funding: undefined, nextFunding: undefined };
  const rawSpread  = token.bestSpreadPct != null ? token.bestSpreadPct : Math.abs(token.spreadPct);
  const effSpread  = cheapData.ask != null && expData.bid != null && cheapData.ask > 0
    ? (expData.bid - cheapData.ask) / cheapData.ask * 100
    : null;
  const spreadColor = rawSpread >= 1
    ? "text-primary font-bold"
    : rawSpread >= 0.3
    ? "text-amber-400 font-semibold"
    : "text-muted-foreground";
  const frCountdown = useFundingCountdown(cheapData.nextFunding, expData.nextFunding);

  const ema = token.emaSpreadPct;
  const emaColor = ema == null
    ? "text-muted-foreground/30"
    : ema >= 1   ? "text-primary/70 font-semibold"
    : ema >= 0.3 ? "text-amber-400/70"
    : "text-muted-foreground/50";

  const sortCol = sort ? sortColFromOption(sort) : null;
  const frCheapActive = sortCol === "fr_cheap";
  const frExpActive = sortCol === "fr_exp";
  const emaActive = sortCol === "ema";
  const volActive = sortCol === "volume";
  const oiActive = sortCol === "oi";
  const depActive = sortCol === "depth";

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

      {/* Exchange pair */}
      <div className="flex items-center gap-1.5 mb-1.5">
        {cheapEx && expensiveEx ? (
          <span className="text-[10px] font-mono">
            <span className="text-muted-foreground">{getExchangeName(cheapEx)}</span>
            <span className="text-muted-foreground/30 mx-0.5">/</span>
            <span className="text-muted-foreground">{getExchangeName(expensiveEx)}</span>
          </span>
        ) : (
          <span className="text-muted-foreground/30 text-[10px]">-/-</span>
        )}
      </div>

      {/* FR row: FR ↓, FR ↑, Next FR */}
      <div className="grid grid-cols-3 gap-x-2 text-[10px] font-mono mb-2">
        {/* FR ↓ cheap-side */}
        {(() => {
          const rate = cheapData.funding;
          const color = rate == null
            ? "text-muted-foreground/30"
            : rate > 0 ? "text-primary/70"
            : rate < 0 ? "text-destructive/70"
            : "text-muted-foreground/50";
          return (
            <div className={frCheapActive ? "rounded px-0.5 -mx-0.5 bg-primary/10" : ""}>
              <span className={frCheapActive ? "text-primary font-semibold" : "text-muted-foreground/40"}>FR ↓ </span>
              <span className={`tabular-nums ${frCheapActive ? "text-primary font-semibold" : color}`}>
                {rate != null ? `${rate >= 0 ? "+" : ""}${(rate * 100).toFixed(4)}%` : "-"}
              </span>
            </div>
          );
        })()}
        {/* FR ↑ expensive-side */}
        {(() => {
          const rate = expData.funding;
          const color = rate == null
            ? "text-muted-foreground/30"
            : rate > 0 ? "text-primary/70"
            : rate < 0 ? "text-destructive/70"
            : "text-muted-foreground/50";
          return (
            <div className={frExpActive ? "rounded px-0.5 -mx-0.5 bg-primary/10" : ""}>
              <span className={frExpActive ? "text-primary font-semibold" : "text-muted-foreground/40"}>FR ↑ </span>
              <span className={`tabular-nums ${frExpActive ? "text-primary font-semibold" : color}`}>
                {rate != null ? `${rate >= 0 ? "+" : ""}${(rate * 100).toFixed(4)}%` : "-"}
              </span>
            </div>
          );
        })()}
        {/* Next FR countdown */}
        <div>
          <span className="text-muted-foreground/40">Next FR </span>
          <span className="tabular-nums text-muted-foreground/60">
            {frCountdown || "-"}
          </span>
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-3 gap-x-2 text-[10px] font-mono text-muted-foreground/70">
        <div className={volActive ? "rounded px-0.5 -mx-0.5 bg-primary/10" : ""}>
          <span className={volActive ? "text-primary font-semibold" : "text-muted-foreground/40"}>VOL </span>
          <span className={volActive ? "text-primary font-semibold tabular-nums" : "tabular-nums"}>{formatUsd(token.volume24h)}</span>
        </div>
        <div className={oiActive ? "rounded px-0.5 -mx-0.5 bg-primary/10" : ""}>
          <span className={oiActive ? "text-primary font-semibold" : "text-muted-foreground/40"}>OI </span>
          <span className={oiActive ? "text-primary font-semibold tabular-nums" : "tabular-nums"}>{formatUsd(token.openInterestUsd)}</span>
        </div>
        <div className={depActive ? "rounded px-0.5 -mx-0.5 bg-primary/10" : ""}>
          <span className={depActive ? "text-primary font-semibold" : "text-muted-foreground/40"}>DEP </span>
          <span className={depActive ? "text-primary font-semibold tabular-nums" : "tabular-nums"}>{formatUsd(token.spreadDepthUsd)}</span>
        </div>
      </div>

      {/* EMA spread */}
      <div className={`mt-1 text-[10px] font-mono${emaActive ? " rounded px-0.5 -mx-0.5 bg-primary/10" : ""}`}>
        <span className={emaActive ? "text-primary font-semibold" : "text-muted-foreground/40"}>EMA </span>
        <span className={emaActive ? "text-primary font-semibold tabular-nums" : emaColor} title="10-min EMA of spread">
          {ema != null && isFinite(ema) ? `${ema >= 0 ? "+" : ""}${ema.toFixed(4)}%` : "-"}
        </span>
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
  const { bots, getBotStatusForSymbol, allOpenLegsWithBot } = useBots();

  const botsStatusQuery = useGetBotsStatus({
    query: {
      queryKey: getGetBotsStatusQueryKey(),
      refetchInterval: (query) => (query.state.data?.warming ? 1000 : false),
      staleTime: 500,
    },
  });
  const isBotsWarming = botsStatusQuery.data?.warming ?? false;

  const ALL_EXCHANGES = ALL_EXCHANGES_LIST;

  const [_savedFilters] = useState(() => loadFilters());

  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    (localStorage.getItem(VIEW_MODE_KEY) as ViewMode) ?? "list"
  );

  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortOption>(_savedFilters.sort);
  const [favsOnly, setFavsOnly] = useState(false);
  const [maxSpread, setMaxSpread] = useState<string>(_savedFilters.maxSpread);
  const [minSpread, setMinSpread] = useState<string>(_savedFilters.minSpread);
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
        minSpread,
        minVolume,
        minOpenInterest,
        minSpreadDepth,
        selectedExchanges: [...selectedExchanges],
      }));
    } catch {}
  }, [sort, maxSpread, minSpread, minVolume, minOpenInterest, minSpreadDepth, selectedExchanges]);

  function resetFilters() {
    setSort(DEFAULT_FILTERS.sort);
    setMaxSpread(DEFAULT_FILTERS.maxSpread);
    setMinSpread(DEFAULT_FILTERS.minSpread);
    setMinVolume(DEFAULT_FILTERS.minVolume);
    setMinOpenInterest(DEFAULT_FILTERS.minOpenInterest);
    setMinSpreadDepth(DEFAULT_FILTERS.minSpreadDepth);
    setSelectedExchanges(new Set(DEFAULT_FILTERS.selectedExchanges));
    try { localStorage.removeItem(FILTER_STORAGE_KEY); } catch {}
  }

  const filtersActive = sort !== DEFAULT_FILTERS.sort
    || maxSpread !== ""
    || minSpread !== ""
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

  const { tokens: streamTokens, streamStatus, isFetching: streamFetching } = usePriceStream();
  const { isVisible: isPageVisible, absenceSeconds } = usePageVisibility();

  const STALE_THRESHOLD_SECONDS = 5 * 60;
  const [staleBannerSeconds, setStaleBannerSeconds] = useState<number | null>(null);

  useEffect(() => {
    if (absenceSeconds !== null && absenceSeconds >= STALE_THRESHOLD_SECONDS) {
      setStaleBannerSeconds(absenceSeconds);
    }
  }, [absenceSeconds]);

  useEffect(() => {
    if (staleBannerSeconds === null) return;
    const timer = setTimeout(() => setStaleBannerSeconds(null), 10000);
    return () => clearTimeout(timer);
  }, [staleBannerSeconds]);

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
  const isFetching = wsActive ? streamFetching : pricesQuery.isFetching;
  const isLoading = wsActive ? (streamTokens.length === 0 && streamStatus === "connecting") : pricesQuery.isLoading;
  const isError = !wsActive && pricesQuery.isError;
  // Backend returned [] (cold start — real data not ready yet)
  const isAwaitingPrices = !isLoading && !isError && tokens.length === 0;

  useEffect(() => {
    if (tokens.length === 0) return;
    setDataSource("live");
  }, [tokens.length, setDataSource]);

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

  const botExchangeByPositionId = useMemo(
    () => new Map(allOpenLegsWithBot.map(({ leg, bot }) => [
      `bot-leg-${leg.id}`,
      { exchangeA: bot.exchangeA, exchangeB: bot.exchangeB },
    ])),
    [allOpenLegsWithBot]
  );

  const allExchangeRequestHeaders = useMemo(() => {
    const base = requestHeaders?.headers ?? {};
    const extra: Record<string, string> = {};
    for (const exchange of ["gate", "okx", "mexc", "aster", "hyper"] as const) {
      try {
        const raw = localStorage.getItem(`exchange_creds_${exchange}`);
        if (raw) {
          const creds = JSON.parse(raw) as { apiKey?: string; apiSecret?: string; passphrase?: string };
          if (creds.apiKey) {
            extra[`x-${exchange}-api-key`] = creds.apiKey;
            extra[`x-${exchange}-api-secret`] = creds.apiSecret ?? "";
            if (exchange === "okx" && creds.passphrase) {
              extra["x-okx-passphrase"] = creds.passphrase;
            }
          }
        }
      } catch {}
    }
    return { headers: { ...base, ...extra } };
  }, [requestHeaders]);

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

  const totalUnrealizedPnl = useMemo(() => {
    if (allOpenLegsWithBot.length === 0 || tokens.length === 0) return null;
    let total = 0;
    let hasAny = false;
    for (const { leg, bot } of allOpenLegsWithBot) {
      if (!bot.enabled) continue;
      const tokenData = tokens.find((t) => t.symbol === bot.symbol);
      if (!tokenData) continue;
      const prices = tokenData as unknown as Record<string, number | null>;
      const exaPrice = prices[`${bot.exchangeA}Price`];
      const exbPrice = prices[`${bot.exchangeB}Price`];
      if (!exaPrice || !exbPrice) continue;
      const pnlA =
        leg.bybitSide === "long"
          ? (exaPrice - (leg.bybitEntry ?? exaPrice)) * (leg.bybitQty ?? 0)
          : ((leg.bybitEntry ?? exaPrice) - exaPrice) * (leg.bybitQty ?? 0);
      const pnlB =
        leg.binanceSide === "long"
          ? (exbPrice - (leg.binanceEntry ?? exbPrice)) * (leg.binanceQty ?? 0)
          : ((leg.binanceEntry ?? exbPrice) - exbPrice) * (leg.binanceQty ?? 0);
      total += pnlA + pnlB;
      hasAny = true;
    }
    return hasAny ? total : null;
  }, [allOpenLegsWithBot, tokens]);

  const filteredTokens = useMemo(() => {
    let list = [...tokens];
    if (favsOnly) list = list.filter((t) => isFavourite(t.symbol));
    if (search) list = list.filter((t) => t.symbol.toLowerCase().includes(search.toLowerCase()));
    if (maxSpread !== "") {
      const cap = parseFloat(maxSpread);
      if (!isNaN(cap)) list = list.filter((t) => Math.abs(t.bestSpreadPct ?? t.spreadPct) <= cap);
    }
    if (minSpread.trim() !== "") {
      const floor = parseFloat(minSpread);
      if (!isNaN(floor)) list = list.filter((t) => Math.abs(t.bestSpreadPct ?? t.spreadPct) >= floor);
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
      // bestSpreadLeg is "expensive/cheap" from the backend
      const [ex, cx] = (t.bestSpreadLeg ?? "").split("/");
      const c = cx ? getExchangeFields(t, cx) : { ask: undefined, bid: undefined, funding: undefined };
      const e = ex ? getExchangeFields(t, ex)  : { ask: undefined, bid: undefined, funding: undefined };
      return c.ask != null && e.bid != null && c.ask > 0 ? (e.bid - c.ask) / c.ask * 100 : -Infinity;
    };
    const frCheapOf = (t: TokenSpread) => {
      const [, cx] = (t.bestSpreadLeg ?? "").split("/");
      const c = cx ? getExchangeFields(t, cx) : { ask: undefined, bid: undefined, funding: undefined };
      return c.funding ?? -Infinity;
    };
    const frExpOf = (t: TokenSpread) => {
      const [ex] = (t.bestSpreadLeg ?? "").split("/");
      const e = ex ? getExchangeFields(t, ex) : { ask: undefined, bid: undefined, funding: undefined };
      return e.funding ?? -Infinity;
    };
    const frDeltaOf = (t: TokenSpread) => {
      const [ex, cx] = (t.bestSpreadLeg ?? "").split("/");
      const c = cx ? getExchangeFields(t, cx) : { ask: undefined, bid: undefined, funding: undefined };
      const e = ex ? getExchangeFields(t, ex)  : { ask: undefined, bid: undefined, funding: undefined };
      return c.funding != null && e.funding != null ? (e.funding - c.funding) : -Infinity;
    };
    const alphaCmp = (a: TokenSpread, b: TokenSpread) => a.symbol.localeCompare(b.symbol);
    const favGroup = (t: TokenSpread) => (isFavourite(t.symbol) ? 0 : 1);

    let primaryCmp: (a: TokenSpread, b: TokenSpread) => number;
    switch (sort) {
      case "spread_desc":  primaryCmp = (a, b) => Math.abs(b.bestSpreadPct ?? b.spreadPct) - Math.abs(a.bestSpreadPct ?? a.spreadPct); break;
      case "spread_asc":   primaryCmp = (a, b) => Math.abs(a.bestSpreadPct ?? a.spreadPct) - Math.abs(b.bestSpreadPct ?? b.spreadPct); break;
      case "eff_desc":     primaryCmp = (a, b) => effOf(b) - effOf(a); break;
      case "eff_asc":      primaryCmp = (a, b) => effOf(a) - effOf(b); break;
      case "volume_desc":  primaryCmp = (a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0); break;
      case "volume_asc":   primaryCmp = (a, b) => (a.volume24h ?? 0) - (b.volume24h ?? 0); break;
      case "oi_desc":      primaryCmp = (a, b) => (b.openInterestUsd ?? 0) - (a.openInterestUsd ?? 0); break;
      case "oi_asc":       primaryCmp = (a, b) => (a.openInterestUsd ?? 0) - (b.openInterestUsd ?? 0); break;
      case "depth_desc":   primaryCmp = (a, b) => (b.spreadDepthUsd ?? 0) - (a.spreadDepthUsd ?? 0); break;
      case "depth_asc":    primaryCmp = (a, b) => (a.spreadDepthUsd ?? 0) - (b.spreadDepthUsd ?? 0); break;
      case "ema_desc":     primaryCmp = (a, b) => (b.emaSpreadPct ?? -Infinity) - (a.emaSpreadPct ?? -Infinity); break;
      case "ema_asc":      primaryCmp = (a, b) => (a.emaSpreadPct ?? Infinity) - (b.emaSpreadPct ?? Infinity); break;
      case "alpha":          primaryCmp = alphaCmp; break;
      case "alpha_desc":     primaryCmp = (a, b) => b.symbol.localeCompare(a.symbol); break;
      case "fav":            primaryCmp = alphaCmp; break;
      case "fav_desc":       primaryCmp = alphaCmp; break;
      case "fr_cheap_desc":  primaryCmp = (a, b) => frCheapOf(b) - frCheapOf(a); break;
      case "fr_cheap_asc":   primaryCmp = (a, b) => frCheapOf(a) - frCheapOf(b); break;
      case "fr_exp_desc":    primaryCmp = (a, b) => frExpOf(b) - frExpOf(a); break;
      case "fr_exp_asc":     primaryCmp = (a, b) => frExpOf(a) - frExpOf(b); break;
      case "fr_delta_desc":  primaryCmp = (a, b) => frDeltaOf(b) - frDeltaOf(a); break;
      case "fr_delta_asc":   primaryCmp = (a, b) => frDeltaOf(a) - frDeltaOf(b); break;
      default:               primaryCmp = () => 0;
    }

    if (sort === "fav" || sort === "fav_desc") {
      // Fav sort: group by fav status (starred first for "fav", non-starred first for "fav_desc"), then alpha within each group
      list.sort((a, b) => {
        const groupDiff = sort === "fav"
          ? favGroup(a) - favGroup(b)
          : favGroup(b) - favGroup(a);
        return groupDiff || alphaCmp(a, b);
      });
    } else if (!favsOnly) {
      // All other sorts: starred group first, then non-starred group; primary sort respected within each group
      list.sort((a, b) => (favGroup(a) - favGroup(b)) || primaryCmp(a, b));
    } else {
      list.sort(primaryCmp);
    }
    return list;
  }, [tokens, favsOnly, search, sort, maxSpread, minSpread, minVolume, minOpenInterest, minSpreadDepth, selectedExchanges, isFavourite]);

  const selectedToken = tokens.find((t) => t.symbol === selectedSymbol) ?? null;

  return (
    <div className="flex flex-col gap-2" style={{ height: "calc(100vh - 88px)" }}>
      {/* Banners */}
      {staleBannerSeconds !== null && (
        <div className="flex items-center gap-3 bg-card border border-amber-500/30 rounded px-3 py-2 text-xs shrink-0">
          <Clock className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          <span className="text-muted-foreground flex-1">
            Prices were paused for{" "}
            <span className="text-amber-400 font-semibold">
              {staleBannerSeconds >= 60
                ? `${Math.round(staleBannerSeconds / 60)} min`
                : `${staleBannerSeconds}s`}
            </span>
            {" — "}refreshed on return. Market conditions may have changed significantly.
          </span>
          <button
            onClick={() => setStaleBannerSeconds(null)}
            className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
            aria-label="Dismiss"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
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
      {isAwaitingPrices && (
        <div className="flex items-center gap-3 bg-card border border-border rounded px-3 py-2 text-xs shrink-0">
          <span className="inline-block w-3 h-3 border border-primary border-t-transparent rounded-full animate-spin shrink-0" />
          <span className="text-muted-foreground">Fetching live prices from exchanges…</span>
        </div>
      )}
      {isBotsWarming && bots.length > 0 && (
        <div className="flex items-center gap-3 bg-card border border-blue-500/25 rounded px-3 py-2 text-xs shrink-0" data-testid="banner-bots-warming">
          <span className="inline-block w-3 h-3 border border-blue-400 border-t-transparent rounded-full animate-spin shrink-0" />
          <span className="text-muted-foreground">
            Bots initializing — loading credentials and verifying API keys…
          </span>
        </div>
      )}

      {/* Open Positions */}
      {(positions.length > 0 || !hasCredentials) && (
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
            <div className="flex items-center gap-2">
              {totalUnrealizedPnl !== null && (
                <span className="flex items-center gap-1" title="Total unrealized P&L across all open bot legs">
                  <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground/60">Unrealized</span>
                  <span className={`text-xs font-mono font-semibold ${totalUnrealizedPnl >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {totalUnrealizedPnl >= 0 ? "+" : ""}{totalUnrealizedPnl.toFixed(2)} USDT
                  </span>
                </span>
              )}
              {showPositions ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
            </div>
          </button>
          {showPositions && !hasCredentials && positions.length === 0 && (
            <div className="px-4 py-5 text-center text-xs text-muted-foreground border-t border-border/40">
              No credentials —{" "}
              <Link href="/settings" className="underline hover:text-primary">add API keys in Settings</Link>
              {" "}to see live positions.
            </div>
          )}
          {showPositions && (hasCredentials || positions.length > 0) && (
            <div>
              <div className="grid grid-cols-11 gap-2 px-3 py-1.5 text-[10px] text-muted-foreground uppercase tracking-wider bg-muted/30 font-semibold border-t border-border/40">
                <span>Symbol</span>
                <span>Side</span>
                <span>Size</span>
                <span>Entry Price (A/B)</span>
                <span>Price (A/B)</span>
                <span>Spread</span>
                <span>Open Fees</span>
                <span>P/L</span>
                <span>Fund. P&L</span>
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
                            token={tokens.find((t) => t.symbol === pos.symbol)}
                            exchangeA={botExchangeByPositionId.get(group[0]?.id)?.exchangeA}
                            exchangeB={botExchangeByPositionId.get(group[0]?.id)?.exchangeB}
                          />
                          {isExpanded && group.map((legPos) => {
                            const exchInfo = botExchangeByPositionId.get(legPos.id);
                            return (
                              <div key={legPos.id} className="pl-4 border-l-2 border-primary/20">
                                <PositionRow
                                  position={legPos}
                                  onCloseSuccess={removePosition}
                                  onDismiss={removePosition}
                                  isLocalOnly={false}
                                  requestHeaders={allExchangeRequestHeaders}
                                  exchangeA={exchInfo?.exchangeA}
                                  exchangeB={exchInfo?.exchangeB}
                                  token={tokens.find((t) => t.symbol === legPos.symbol)}
                                />
                              </div>
                            );
                          })}
                        </div>
                      );
                    }
                  }
                  {
                    const exchInfo = botExchangeByPositionId.get(pos.id);
                    return (
                      <PositionRow
                        key={pos.id}
                        position={pos}
                        onCloseSuccess={removePosition}
                        onDismiss={removePosition}
                        isLocalOnly={!hasCredentials && localOnlySymbols.has(pos.symbol)}
                        requestHeaders={allExchangeRequestHeaders}
                        exchangeA={exchInfo?.exchangeA}
                        exchangeB={exchInfo?.exchangeB}
                        token={tokens.find((t) => t.symbol === pos.symbol)}
                      />
                    );
                  }
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
              type="number"
              step="0.01"
              min="0"
              value={minSpread}
              onChange={(e) => setMinSpread(e.target.value)}
              placeholder="Min spread %"
              className="bg-background border border-border/60 rounded text-[10px] px-2 h-7 text-foreground w-24 placeholder:text-muted-foreground/40 focus:outline-none focus:border-primary/50 font-mono"
              data-testid="select-min-spread"
              title="Min spread % — only show tokens above this spread"
            />
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
              {(["bybit", "binance", "gate", "okx", "mexc", "aster", "hyper"] as const).map((key) => {
                const name = getExchangeName(key);
                return (
                  <button
                    key={key}
                    onClick={() => toggleExchange(key)}
                    title={selectedExchanges.has(key) ? `Hide ${name}` : `Show ${name}`}
                    className={`flex items-center gap-1 px-1.5 py-0 h-7 rounded text-[10px] font-semibold font-mono border transition-all ${
                      selectedExchanges.has(key)
                        ? "text-foreground border-primary/40 bg-primary/10"
                        : "text-muted-foreground/30 border-border/30 bg-transparent"
                    }`}
                  >
                    {name}
                  </button>
                );
              })}
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
                {filteredTokens.length === 0 && tokens.length > 0 && (
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
                      sort={sort}
                    />
                  );
                })}
                {filteredTokens.length === 0 && tokens.length > 0 && (
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
