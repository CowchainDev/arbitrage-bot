import { useState, useMemo, useEffect, useRef } from "react";
import { Link } from "wouter";
import { Star, Search, TrendingUp, TrendingDown, Zap, AlertCircle, ChevronDown, ChevronUp, X, Bell, BellOff, Bot, Power, XCircle } from "lucide-react";
import { useGetExchangePrices, getGetExchangePricesQueryKey, useGetPositions, getGetPositionsQueryKey, useClosePosition, useCreateBot, useStartBot, useStopBot, useStopAndCloseBot, useUpdateBot, getListBotsQueryKey, getGetBotLegsQueryKey } from "@workspace/api-client-react";
import type { TokenSpread, Position, ClosePositionResult, BotConfig, BotLeg } from "@workspace/api-client-react";
import { useBots } from "@/hooks/use-bots";
import { useBotSecret } from "@/hooks/use-bot-secret";
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
import { usePageVisibility } from "@/hooks/use-page-visibility";

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

function botLegToPosition(leg: BotLeg, tokens: TokenSpread[]): Position {
  const token = tokens.find((t) => t.symbol === leg.symbol);
  const bybitCurrentPrice = token?.bybitPrice ?? leg.bybitEntry ?? 0;
  const binanceCurrentPrice = token?.binancePrice ?? leg.binanceEntry ?? 0;
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
  const dotColor = legsCount > 0
    ? "bg-amber-400"
    : bot?.enabled
      ? "bg-emerald-500"
      : "bg-muted-foreground";
  const dotTitle = legsCount > 0
    ? `Bot: ${legsCount} leg${legsCount !== 1 ? "s" : ""} open`
    : bot?.enabled
      ? "Bot: running"
      : "Bot: stopped";

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
        <div className="flex items-start gap-1.5">
          {showDot && (
            <div
              className={`w-1.5 h-1.5 rounded-full mt-1 shrink-0 ${dotColor}`}
              title={dotTitle}
              data-testid={`bot-dot-${token.symbol}`}
            />
          )}
          <SpreadBadge spreadPct={token.spreadPct} bestSpreadPct={token.bestSpreadPct} bestSpreadLeg={token.bestSpreadLeg} />
        </div>
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
  bot,
  botOpenLegsCount,
  botRequestOptions,
}: {
  token: TokenSpread;
  onClose: () => void;
  requestHeaders: ReturnType<ReturnType<typeof useApiCredentials>["getRequestHeaders"]>;
  bot?: BotConfig;
  botOpenLegsCount: number;
  botRequestOptions?: RequestInit;
}) {
  // Bot form state — pre-filled from bot config or sensible defaults
  const [botEnterSpread, setBotEnterSpread] = useState(() => bot ? String(bot.enterSpreadPct) : "0.5");
  const [botCloseSpread, setBotCloseSpread] = useState(() => bot ? String(bot.closeSpreadPct) : "0.2");
  const [botStopLossSpread, setBotStopLossSpread] = useState(() => bot ? String(bot.stopLossSpreadPct ?? 0) : "0");
  const [botOrderSize, setBotOrderSize] = useState(() => bot ? String(bot.orderSizeUsd) : "10");
  const [botMaxOrders, setBotMaxOrders] = useState(() => bot ? String(bot.maxOrders) : "3");
  const [botForceStop, setBotForceStop] = useState(() => bot ? String(bot.forceStopUsd) : "50");
  const [botExchangeA, setBotExchangeA] = useState<string>(() => {
    if (bot?.exchangeA) return bot.exchangeA;
    try { return localStorage.getItem("arbitrage-botExchangeA") ?? "bybit"; } catch { return "bybit"; }
  });
  const [botExchangeB, setBotExchangeB] = useState<string>(() => {
    if (bot?.exchangeB) return bot.exchangeB;
    try { return localStorage.getItem("arbitrage-botExchangeB") ?? "binance"; } catch { return "binance"; }
  });
  const [botLeverageA, setBotLeverageA] = useState<string>(() => {
    if (bot?.leverageA) return String(bot.leverageA);
    try { return localStorage.getItem("arbitrage-botLeverageA") ?? "1"; } catch { return "1"; }
  });
  const [botLeverageB, setBotLeverageB] = useState<string>(() => {
    if (bot?.leverageB) return String(bot.leverageB);
    try { return localStorage.getItem("arbitrage-botLeverageB") ?? "1"; } catch { return "1"; }
  });
  const [botBusy, setBotBusy] = useState(false);

  // Sync bot form when the bot config changes (e.g., navigating to a different symbol)
  useEffect(() => {
    if (bot) {
      setBotEnterSpread(String(bot.enterSpreadPct));
      setBotCloseSpread(String(bot.closeSpreadPct));
      setBotStopLossSpread(String(bot.stopLossSpreadPct ?? 0));
      setBotOrderSize(String(bot.orderSizeUsd));
      setBotMaxOrders(String(bot.maxOrders));
      setBotForceStop(String(bot.forceStopUsd));
      if (bot.exchangeA) setBotExchangeA(bot.exchangeA);
      if (bot.exchangeB) setBotExchangeB(bot.exchangeB);
      if (bot.leverageA) setBotLeverageA(String(bot.leverageA));
      if (bot.leverageB) setBotLeverageB(String(bot.leverageB));
    } else {
      setBotEnterSpread("0.5");
      setBotCloseSpread("0.2");
      setBotOrderSize("10");
      setBotMaxOrders("3");
      setBotForceStop("50");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot?.id, token.symbol]);

  const createBotMutation = useCreateBot({ request: botRequestOptions });
  const updateBotMutation = useUpdateBot({ request: botRequestOptions });
  const startBotMutation = useStartBot({ request: botRequestOptions });
  const stopBotMutation = useStopBot({ request: botRequestOptions });
  const stopAndCloseBotMutation = useStopAndCloseBot({ request: botRequestOptions });

  useEffect(() => {
    try { localStorage.setItem("arbitrage-botExchangeA", botExchangeA); } catch {}
  }, [botExchangeA]);

  useEffect(() => {
    try { localStorage.setItem("arbitrage-botExchangeB", botExchangeB); } catch {}
  }, [botExchangeB]);

  useEffect(() => {
    try { localStorage.setItem("arbitrage-botLeverageA", botLeverageA); } catch {}
  }, [botLeverageA]);

  useEffect(() => {
    try { localStorage.setItem("arbitrage-botLeverageB", botLeverageB); } catch {}
  }, [botLeverageB]);

  const { toast } = useToast();
  const queryClient = useQueryClient();

  const handleBotStart = async () => {
    const enterSpread = Number(botEnterSpread);
    const closeSpreadVal = Number(botCloseSpread);
    const stopLossSpreadVal = Number(botStopLossSpread) || 0;
    const orderSizeVal = Number(botOrderSize);
    const maxOrdersVal = Math.max(1, Number(botMaxOrders) || 1);
    const forceStopVal = Number(botForceStop) || 0;
    if (!enterSpread || !closeSpreadVal || !orderSizeVal) {
      toast({ title: "Invalid bot config", description: "Enter spread, take profit spread, and order size are required", variant: "destructive" });
      return;
    }
    setBotBusy(true);
    try {
      let botId = bot?.id;
      if (!botId) {
        const created = await createBotMutation.mutateAsync({
          data: {
            symbol: token.symbol,
            enterSpreadPct: enterSpread,
            closeSpreadPct: closeSpreadVal,
            stopLossSpreadPct: stopLossSpreadVal,
            orderSizeUsd: orderSizeVal,
            maxOrders: maxOrdersVal,
            forceStopUsd: forceStopVal,
            bybitLeverage: Number(botLeverageA) || 1,
            binanceLeverage: Number(botLeverageB) || 1,
            exchangeA: botExchangeA,
            exchangeB: botExchangeB,
            leverageA: Number(botLeverageA) || 1,
            leverageB: Number(botLeverageB) || 1,
          } as Parameters<typeof createBotMutation.mutateAsync>[0]["data"],
        });
        botId = created.bot.id;
      } else {
        await updateBotMutation.mutateAsync({
          id: botId,
          data: {
            enterSpreadPct: enterSpread,
            closeSpreadPct: closeSpreadVal,
            stopLossSpreadPct: stopLossSpreadVal,
            orderSizeUsd: orderSizeVal,
            maxOrders: maxOrdersVal,
            forceStopUsd: forceStopVal,
          },
        });
      }
      await startBotMutation.mutateAsync({ id: botId });
      await queryClient.invalidateQueries({ queryKey: getListBotsQueryKey() });
      toast({ title: "Bot started", description: `${token.symbol} bot is now watching for opportunities` });
    } catch (err) {
      toast({ title: "Failed to start bot", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
    } finally {
      setBotBusy(false);
    }
  };

  const handleBotStop = async () => {
    if (!bot) return;
    setBotBusy(true);
    try {
      await stopBotMutation.mutateAsync({ id: bot.id });
      await queryClient.invalidateQueries({ queryKey: getListBotsQueryKey() });
      toast({ title: "Bot stopped", description: `${token.symbol} bot will no longer open new legs` });
    } catch (err) {
      toast({ title: "Failed to stop bot", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
    } finally {
      setBotBusy(false);
    }
  };

  const handleBotStopAndClose = async () => {
    if (!bot) return;
    setBotBusy(true);
    try {
      const result = await stopAndCloseBotMutation.mutateAsync({ id: bot.id });
      await queryClient.invalidateQueries({ queryKey: getListBotsQueryKey() });
      await queryClient.invalidateQueries({ queryKey: getGetBotLegsQueryKey(bot.id) });
      const desc = result.failed > 0
        ? `${result.closed} leg(s) closed, ${result.failed} failed — check exchange manually`
        : `${result.closed} leg(s) closed on both exchanges`;
      toast({ title: `${token.symbol} stopped & closed`, description: desc, variant: result.failed > 0 ? "destructive" : "default" });
    } catch (err) {
      toast({ title: "Failed to stop & close", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
    } finally {
      setBotBusy(false);
    }
  };

  return (
    <div className="bg-card border border-border rounded-md p-4 space-y-4 h-fit sticky top-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 flex-wrap">
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
          {bot ? (
            bot.enabled ? (
              botOpenLegsCount > 0 ? (
                <span className="text-xs font-semibold px-2 py-0.5 rounded bg-amber-400/20 text-amber-400" data-testid="bot-status-badge">
                  IN POSITION ({botOpenLegsCount} leg{botOpenLegsCount !== 1 ? "s" : ""})
                </span>
              ) : (
                <span className="text-xs font-semibold px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400" data-testid="bot-status-badge">
                  RUNNING
                </span>
              )
            ) : (
              <span className="text-xs font-semibold px-2 py-0.5 rounded bg-muted text-muted-foreground" data-testid="bot-status-badge">
                STOPPED
              </span>
            )
          ) : null}
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground ml-2 shrink-0" data-testid="btn-close-detail">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="space-y-3">
        {/* Exchange pair selectors */}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Exchange A</label>
            <select
              value={botExchangeA}
              onChange={(e) => setBotExchangeA(e.target.value)}
              className="w-full font-mono text-sm bg-background border border-border rounded-md px-2 h-9 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              data-testid="select-bot-exchange-a"
            >
              {["bybit", "binance", "gate", "okx", "mexc"].map((ex) => (
                <option key={ex} value={ex} disabled={ex === botExchangeB}>{ex.toUpperCase()}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Exchange B</label>
            <select
              value={botExchangeB}
              onChange={(e) => setBotExchangeB(e.target.value)}
              className="w-full font-mono text-sm bg-background border border-border rounded-md px-2 h-9 text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
              data-testid="select-bot-exchange-b"
            >
              {["bybit", "binance", "gate", "okx", "mexc"].map((ex) => (
                <option key={ex} value={ex} disabled={ex === botExchangeA}>{ex.toUpperCase()}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Leverage A</label>
            <div className="flex gap-1 items-center">
              <Input
                value={botLeverageA}
                onChange={(e) => setBotLeverageA(e.target.value)}
                className="font-mono text-sm bg-background"
                data-testid="input-bot-leverage-a"
              />
              <span className="text-xs text-muted-foreground">x</span>
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Leverage B</label>
            <div className="flex gap-1 items-center">
              <Input
                value={botLeverageB}
                onChange={(e) => setBotLeverageB(e.target.value)}
                className="font-mono text-sm bg-background"
                data-testid="input-bot-leverage-b"
              />
              <span className="text-xs text-muted-foreground">x</span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Enter Spread %</label>
            <Input
              value={botEnterSpread}
              onChange={(e) => setBotEnterSpread(e.target.value)}
              className="font-mono text-sm bg-background"
              data-testid="input-bot-enter-spread"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Take Profit %</label>
            <Input
              value={botCloseSpread}
              onChange={(e) => setBotCloseSpread(e.target.value)}
              className="font-mono text-sm bg-background"
              data-testid="input-bot-close-spread"
            />
          </div>
          <div className="col-span-2">
            <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">
              Stop Loss % <span className="normal-case text-muted-foreground/60">(0 = disabled)</span>
            </label>
            <Input
              value={botStopLossSpread}
              onChange={(e) => setBotStopLossSpread(e.target.value)}
              className="font-mono text-sm bg-background"
              data-testid="input-bot-stop-loss-spread"
              placeholder="e.g. 0.8"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Order Size $</label>
            <Input
              value={botOrderSize}
              onChange={(e) => setBotOrderSize(e.target.value)}
              className="font-mono text-sm bg-background"
              data-testid="input-bot-order-size"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Max Orders</label>
            <Input
              value={botMaxOrders}
              onChange={(e) => setBotMaxOrders(e.target.value)}
              className="font-mono text-sm bg-background"
              data-testid="input-bot-max-orders"
            />
          </div>
          <div className="col-span-2">
            <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Force Stop (loss $)</label>
            <Input
              value={botForceStop}
              onChange={(e) => setBotForceStop(e.target.value)}
              className="font-mono text-sm bg-background"
              data-testid="input-bot-force-stop"
            />
          </div>
        </div>

        {bot?.enabled ? (
          <div className="flex flex-col gap-1.5">
            <Button
              onClick={handleBotStopAndClose}
              disabled={botBusy}
              variant="destructive"
              className="w-full"
              size="sm"
              data-testid="btn-bot-stop-and-close"
            >
              {botBusy ? (
                <span className="flex items-center gap-2">
                  <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
                  Processing…
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <XCircle className="w-3.5 h-3.5" />
                  STOP & CLOSE ALL
                </span>
              )}
            </Button>
            <Button
              onClick={handleBotStop}
              disabled={botBusy}
              variant="outline"
              className="w-full text-xs"
              size="sm"
              data-testid="btn-bot-stop"
            >
              <Power className="w-3 h-3 mr-1.5" />
              Stop only (keep positions open)
            </Button>
          </div>
        ) : (
          <>
            <Button
              onClick={handleBotStart}
              disabled={botBusy || !botRequestOptions}
              className="w-full bg-primary text-primary-foreground hover:bg-primary/90 font-bold text-sm py-5 tracking-wider"
              data-testid="btn-bot-start"
            >
              {botBusy ? (
                <span className="flex items-center gap-2">
                  <span className="w-3 h-3 border border-primary-foreground border-t-transparent rounded-full animate-spin" />
                  STARTING…
                </span>
              ) : (
                <span className="flex items-center gap-2">
                  <Zap className="w-4 h-4" />
                  JUMP IN
                </span>
              )}
            </Button>
            {!botRequestOptions && (
              <p className="text-xs text-destructive text-center">
                Configure API keys in{" "}
                <Link href="/settings" className="underline hover:text-destructive/80">Settings</Link>
              </p>
            )}
          </>
        )}
      </div>

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

function BotSummaryRow({
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
  // Both exchange sides must agree for "same side" to be displayed accurately.
  const allSameSide =
    positions.every((p) => p.bybitSide === firstBybitSide) &&
    positions.every((p) => p.binanceSide === firstBinanceSide);

  // Net signed quantities per exchange: long = +qty, short = -qty.
  // Two equal-and-opposite legs yield net qty = 0, and thus net size = 0.
  const netBybitQty = positions.reduce(
    (s, p) => s + (p.bybitSide === "long" ? 1 : -1) * (p.bybitQty ?? 0),
    0
  );
  const netBinanceQty = positions.reduce(
    (s, p) => s + (p.binanceSide === "long" ? 1 : -1) * (p.binanceQty ?? 0),
    0
  );

  // Signed cost basis (notional) per exchange.
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

  // Valuation price: current market price if available, otherwise VWAP of entry prices.
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

  // Net USD size = |net qty| × valuation price; opposite legs fully cancel to 0.
  const netUsdSize = Math.abs(netBybitQty) * bybitValuation + Math.abs(netBinanceQty) * binanceValuation;

  // Avg entry = signed net cost basis / net signed qty — the true breakeven for the net position.
  // Shows "-" only when net qty is 0 (fully offset, no remaining exposure).
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
          <span className="text-amber-400">{avgBybitEntry != null ? formatPrice(avgBybitEntry) : "-"}</span>
          <span className="text-violet-400">{avgBinanceEntry != null ? formatPrice(avgBinanceEntry) : "-"}</span>
        </span>
      </span>
      <span className="font-mono leading-tight">
        <span className="flex flex-col gap-0.5">
          <span className="text-amber-400">{bybitCurrentPrice != null ? formatPrice(bybitCurrentPrice) : "-"}</span>
          <span className="text-violet-400">{binanceCurrentPrice != null ? formatPrice(binanceCurrentPrice) : "-"}</span>
        </span>
      </span>
      <span className="font-mono">{formatPct(avgSpread)}</span>
      <span className={`font-mono font-semibold ${pnlPositive ? "text-primary" : "text-destructive"}`}>
        {formatPnlWithPct(totalPnl, netUsdSize)}
      </span>
      <span className="font-mono text-muted-foreground">
        {earliestOpenedAt ? new Date(earliestOpenedAt).toLocaleTimeString() : "-"}
      </span>
      <span className="text-xs text-muted-foreground italic">Bot managed</span>
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
  const [isClosing, setIsClosing] = useState(false);
  const [closeResult, setCloseResult] = useState<ClosePositionResult | null>(null);
  const [closeError, setCloseError] = useState<string | null>(null);
  const closePosition = useClosePosition({ request: requestHeaders });
  const queryClient = useQueryClient();

  const longExchange = position.bybitSide === "long" ? "bybit" : "binance";
  const shortExchange = position.bybitSide === "short" ? "bybit" : "binance";

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
            <span className="text-amber-400">
              {position.bybitEntryPrice != null ? formatPrice(position.bybitEntryPrice) : "-"}
            </span>
            <span className="text-violet-400">
              {position.binanceEntryPrice != null ? formatPrice(position.binanceEntryPrice) : "-"}
            </span>
          </span>
        </span>
        <span className="font-mono leading-tight">
          <span className="flex flex-col gap-0.5">
            <span className="text-amber-400">
              {position.bybitCurrentPrice != null ? formatPrice(position.bybitCurrentPrice) : "-"}
            </span>
            <span className="text-violet-400">
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
          <span className="text-xs text-muted-foreground italic" data-testid={`bot-leg-managed-${position.symbol}`}>
            Bot managed
          </span>
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

      {/* Result modal — shown after API responds */}
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
              {/* Bybit leg */}
              {closeResult.bybitResult && (
                <div className="rounded-md border border-border p-3 space-y-1.5">
                  <p className="text-xs font-semibold text-amber-400 uppercase tracking-wider">Bybit</p>
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
              {/* Binance leg */}
              {closeResult.binanceResult && (
                <div className="rounded-md border border-border p-3 space-y-1.5">
                  <p className="text-xs font-semibold text-violet-400 uppercase tracking-wider">Binance</p>
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
              {/* Realized PnL */}
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

        {selectedToken && (
          <div className="lg:col-span-1">
            {(() => {
              const botStatus = getBotStatusForSymbol(selectedToken.symbol);
              return (
                <TokenDetailPanel
                  token={selectedToken}
                  onClose={() => setSelectedSymbol(null)}
                  requestHeaders={requestHeaders}
                  bot={botStatus?.bot}
                  botOpenLegsCount={botStatus?.openLegsCount ?? 0}
                  botRequestOptions={getBotRequestOptions()}
                />
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
}
