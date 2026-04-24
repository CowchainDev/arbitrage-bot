import { useState, useMemo } from "react";
import { Link } from "wouter";
import { ArrowLeft, TrendingUp, XCircle, ChevronDown, ChevronUp } from "lucide-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  AreaChart,
  Area,
} from "recharts";
import {
  useGetExchangePrices,
  getGetExchangePricesQueryKey,
  useGetExchangeKlines,
  getGetExchangeKlinesQueryKey,
  useStopAndCloseBot,
  getGetBotLegsQueryKey,
  getListBotsQueryKey,
} from "@workspace/api-client-react";
import type { ExchangeKlinePoint, BotConfig, BotLeg, TokenSpread } from "@workspace/api-client-react";
import { TokenDetailPanel } from "@/components/token-detail-panel";
import { useBots } from "@/hooks/use-bots";
import { useBotSecret } from "@/hooks/use-bot-secret";
import { useApiCredentials } from "@/hooks/use-api-credentials";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { useQueryClient } from "@tanstack/react-query";
import {
  BotSummaryRow,
  PositionRow,
  botLegToPosition,
} from "@/components/position-rows";

type TimeRange = { label: string; interval: string; limit: number };
const TIME_RANGES: TimeRange[] = [
  { label: "15m", interval: "15m", limit: 96 },
  { label: "1h",  interval: "1h",  limit: 168 },
  { label: "4h",  interval: "4h",  limit: 90 },
  { label: "1d",  interval: "1d",  limit: 60 },
];

const EXCHANGE_LINE_COLORS: Record<string, string> = {
  bybit:   "#f59e0b",
  binance: "#a78bfa",
  gate:    "#38bdf8",
  okx:     "#34d399",
  mexc:    "#fb7185",
};

const EXCHANGE_DISPLAY: Record<string, string> = {
  bybit: "Bybit", binance: "Binance", gate: "Gate", okx: "OKX", mexc: "MEXC",
};

const EXCHANGE_SHORT: Record<string, string> = {
  bybit: "BB", binance: "BN", gate: "GT", okx: "OKX", mexc: "MX",
};

const ALL_EXCHANGES = ["bybit", "binance", "gate", "okx", "mexc"] as const;
type ExchangeName = typeof ALL_EXCHANGES[number];

function formatPriceAxis(price: number): string {
  if (price >= 100000) return `${(price / 1000).toFixed(0)}K`;
  if (price >= 10000) return `${(price / 1000).toFixed(1)}K`;
  if (price >= 1000) return price.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (price >= 1) return price.toFixed(3);
  if (price >= 0.01) return price.toFixed(5);
  return price.toFixed(7);
}

function formatPriceFull(price: number): string {
  if (price >= 1000) return price.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(6);
}

type ChartRow = { t: number } & Partial<Record<ExchangeName, number>>;

function OpenPositionsSection({
  bot,
  openLegs,
  tokens,
  botRequestOptions,
  requestHeaders,
}: {
  bot: BotConfig;
  openLegs: BotLeg[];
  tokens: TokenSpread[];
  botRequestOptions?: RequestInit;
  requestHeaders: RequestInit | undefined;
}) {
  const [expanded, setExpanded] = useState(true);
  const [expandedBotSymbols, setExpandedBotSymbols] = useState<Set<string>>(new Set([bot.symbol]));
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const stopAndClose = useStopAndCloseBot({ request: botRequestOptions });

  const positions = useMemo(
    () => openLegs.map((leg) => botLegToPosition(leg, tokens, bot)),
    [openLegs, tokens, bot]
  );

  const exchALabel = EXCHANGE_SHORT[bot.exchangeA] ?? bot.exchangeA.toUpperCase();
  const exchBLabel = EXCHANGE_SHORT[bot.exchangeB] ?? bot.exchangeB.toUpperCase();

  const symbol = bot.symbol;

  const toggleBotSymbol = (sym: string) =>
    setExpandedBotSymbols((prev) => {
      const next = new Set(prev);
      if (next.has(sym)) next.delete(sym); else next.add(sym);
      return next;
    });

  const handleStopAndClose = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await stopAndClose.mutateAsync({ id: bot.id });
      await queryClient.invalidateQueries({ queryKey: getListBotsQueryKey() });
      await queryClient.invalidateQueries({ queryKey: getGetBotLegsQueryKey(bot.id) });
      const desc =
        result.failed > 0
          ? `${result.closed} leg(s) closed, ${result.failed} failed — check exchange manually`
          : `${result.closed} leg(s) closed on both exchanges`;
      toast({
        title: `${symbol} stopped & closed`,
        description: desc,
        variant: result.failed > 0 ? "destructive" : "default",
      });
    } catch (err) {
      toast({
        title: "Failed to stop & close",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  const isExpanded = expandedBotSymbols.has(symbol);

  return (
    <div
      className="bg-card border border-border rounded-md overflow-hidden"
      data-testid="open-positions-section"
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-muted/30 transition-colors"
        data-testid="btn-toggle-open-positions"
      >
        <div className="flex items-center gap-2 text-sm font-semibold">
          <TrendingUp className="w-4 h-4 text-primary" />
          Open Positions
          <span className="bg-primary/20 text-primary text-xs px-1.5 py-0.5 rounded">
            {positions.length}
          </span>
        </div>
        {expanded ? (
          <ChevronUp className="w-4 h-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="w-4 h-4 text-muted-foreground" />
        )}
      </button>

      {expanded && (
        <div>
          {/* Table header — matches the 9-column grid used by BotSummaryRow / PositionRow */}
          <div className="grid grid-cols-9 gap-2 px-3 py-2 text-xs text-muted-foreground uppercase tracking-wider bg-muted/30 font-semibold">
            <span>Symbol</span>
            <span>Side</span>
            <span>Size</span>
            <span>Entry Price ({exchALabel}/{exchBLabel})</span>
            <span>Price ({exchALabel}/{exchBLabel})</span>
            <span>Spread</span>
            <span>P/L</span>
            <span>Opened</span>
            <span></span>
          </div>

          {positions.length > 1 ? (
            <div>
              <BotSummaryRow
                positions={positions}
                isExpanded={isExpanded}
                onToggle={() => toggleBotSymbol(symbol)}
              />
              {isExpanded && positions.map((pos) => (
                <div key={pos.id} className="pl-4 border-l-2 border-primary/20">
                  <PositionRow
                    position={pos}
                    onCloseSuccess={() => {}}
                    isLocalOnly={false}
                    requestHeaders={requestHeaders}
                  />
                </div>
              ))}
            </div>
          ) : (
            positions.map((pos) => (
              <PositionRow
                key={pos.id}
                position={pos}
                onCloseSuccess={() => {}}
                isLocalOnly={false}
                requestHeaders={requestHeaders}
              />
            ))
          )}

          {/* STOP & CLOSE ALL footer */}
          {bot.enabled && (
            <div className="px-4 py-3 border-t border-border/40">
              <Button
                onClick={handleStopAndClose}
                disabled={busy}
                variant="destructive"
                size="sm"
                className="w-full"
                data-testid="btn-stop-close-all"
              >
                {busy ? (
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
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function TokenDetail({ params }: { params: { symbol: string } }) {
  const symbol = params.symbol.toUpperCase();
  const [timeRange, setTimeRange] = useState<TimeRange>(TIME_RANGES[1]);

  const { data: allTokens, isLoading: pricesLoading } = useGetExchangePrices({
    query: { queryKey: getGetExchangePricesQueryKey(), refetchInterval: 10_000 },
  });
  const token = allTokens?.find((t) => t.symbol === symbol);
  const tokenNotFound = !pricesLoading && allTokens != null && token == null;

  const klinesParams = { symbol, interval: timeRange.interval, limit: timeRange.limit };
  const { data: klines, isLoading: klinesLoading, isError: klinesError } = useGetExchangeKlines(
    klinesParams,
    { query: { queryKey: getGetExchangeKlinesQueryKey(klinesParams), refetchInterval: 60_000, staleTime: 30_000 } }
  );

  const { getBotRequestOptions } = useBotSecret();
  const botRequestOptions = getBotRequestOptions();

  const { getRequestHeaders } = useApiCredentials();
  const requestHeaders = getRequestHeaders();

  const { getBotStatusForSymbol } = useBots();
  const botStatus = getBotStatusForSymbol(symbol);

  const activeExchanges = useMemo((): ExchangeName[] => {
    if (!klines) return [];
    return ALL_EXCHANGES.filter((ex) => (klines[ex]?.length ?? 0) > 0);
  }, [klines]);

  const chartData = useMemo((): ChartRow[] => {
    if (!klines || activeExchanges.length === 0) return [];

    const tsMap = new Map<number, ChartRow>();
    for (const ex of activeExchanges) {
      const points: ExchangeKlinePoint[] = klines[ex] ?? [];
      for (const pt of points) {
        const existing = tsMap.get(pt.t) ?? ({ t: pt.t } as ChartRow);
        (existing as Record<string, number>)[ex] = pt.c;
        tsMap.set(pt.t, existing);
      }
    }

    return Array.from(tsMap.values()).sort((a, b) => a.t - b.t);
  }, [klines, activeExchanges]);

  const spreadData = useMemo(() => {
    return chartData.map((row) => {
      const prices = activeExchanges
        .map((ex) => row[ex])
        .filter((p): p is number => p != null && p > 0);
      const spread =
        prices.length >= 2
          ? ((Math.max(...prices) - Math.min(...prices)) / Math.min(...prices)) * 100
          : 0;
      return { t: row.t, spread };
    });
  }, [chartData, activeExchanges]);

  const formatXAxis = (t: number) => {
    const d = new Date(t);
    if (timeRange.interval === "1d") {
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    }
    if (timeRange.interval === "4h") {
      return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit" });
    }
    return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  };

  const hasOpenLegs = (botStatus?.openLegs.length ?? 0) > 0;

  return (
    <div className="p-4 space-y-4 max-w-full">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2">
        <Link
          href="/"
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          data-testid="btn-back-to-dashboard"
        >
          <ArrowLeft className="w-4 h-4" />
          Dashboard
        </Link>
        <span className="text-muted-foreground">/</span>
        <span className="text-sm font-semibold">{symbol}</span>
      </div>

      {/* Main grid: chart area + terminal */}
      <div className="grid grid-cols-1 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {/* Charts */}
        <div className="lg:col-span-2 xl:col-span-3 space-y-3">
          {/* Header + time range selector */}
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="text-base font-semibold">{symbol} — Price History</h2>
            <div className="flex items-center gap-1" data-testid="time-range-selector">
              {TIME_RANGES.map((tr) => (
                <button
                  key={tr.label}
                  onClick={() => setTimeRange(tr)}
                  data-testid={`btn-range-${tr.label}`}
                  className={`px-2.5 py-1 text-xs rounded font-mono transition-colors ${
                    timeRange.label === tr.label
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted"
                  }`}
                >
                  {tr.label}
                </button>
              ))}
            </div>
          </div>

          {/* Price chart */}
          <div className="bg-card border border-border rounded-md p-3" data-testid="price-chart">
            <div className="text-xs text-muted-foreground mb-2 uppercase tracking-wider font-semibold">
              Price (USDT perpetual)
            </div>
            {klinesLoading ? (
              <div className="h-64 flex items-center justify-center">
                <span className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              </div>
            ) : klinesError || chartData.length === 0 ? (
              <div className="h-64 flex items-center justify-center text-muted-foreground text-sm">
                No chart data available
              </div>
            ) : (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="hsl(var(--border))"
                      strokeOpacity={0.4}
                    />
                    <XAxis
                      dataKey="t"
                      tickFormatter={formatXAxis}
                      tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                      tickLine={false}
                      axisLine={false}
                      minTickGap={50}
                    />
                    <YAxis
                      tickFormatter={formatPriceAxis}
                      tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                      tickLine={false}
                      axisLine={false}
                      width={70}
                      domain={["auto", "auto"]}
                    />
                    <Tooltip
                      content={({ active, payload, label }) => {
                        if (!active || !payload?.length) return null;
                        return (
                          <div className="bg-background border border-border rounded px-2.5 py-1.5 text-xs space-y-1 shadow-lg">
                            <div className="text-muted-foreground font-mono mb-1">
                              {formatXAxis(label as number)}
                            </div>
                            {payload.map((p) => (
                              <div key={p.dataKey} className="flex items-center gap-2">
                                <span
                                  className="w-2 h-2 rounded-full shrink-0"
                                  style={{ background: p.color }}
                                />
                                <span className="font-medium" style={{ color: p.color }}>
                                  {EXCHANGE_DISPLAY[p.dataKey as string] ?? p.dataKey}
                                </span>
                                <span className="font-mono text-foreground ml-auto pl-4">
                                  {formatPriceFull(p.value as number)}
                                </span>
                              </div>
                            ))}
                          </div>
                        );
                      }}
                    />
                    {activeExchanges.map((ex) => (
                      <Line
                        key={ex}
                        type="monotone"
                        dataKey={ex}
                        stroke={EXCHANGE_LINE_COLORS[ex] ?? "#888"}
                        strokeWidth={1.5}
                        dot={false}
                        isAnimationActive={false}
                        connectNulls
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
            {/* Legend */}
            {!klinesLoading && activeExchanges.length > 0 && (
              <div className="flex flex-wrap gap-4 mt-2 pt-2 border-t border-border/40">
                {activeExchanges.map((ex) => (
                  <div key={ex} className="flex items-center gap-1.5 text-xs">
                    <span
                      className="w-5 h-0.5 rounded-full shrink-0"
                      style={{ background: EXCHANGE_LINE_COLORS[ex] }}
                    />
                    <span className="font-medium" style={{ color: EXCHANGE_LINE_COLORS[ex] }}>
                      {EXCHANGE_DISPLAY[ex] ?? ex.toUpperCase()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Spread history chart */}
          {!klinesLoading && spreadData.length > 0 && (
            <div className="bg-card border border-border rounded-md p-3" data-testid="spread-chart">
              <div className="text-xs text-muted-foreground mb-2 uppercase tracking-wider font-semibold">
                Best Spread % — (max − min) / min across all exchanges
              </div>
              <div className="h-36">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={spreadData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="spreadGradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="hsl(var(--border))"
                      strokeOpacity={0.4}
                    />
                    <XAxis
                      dataKey="t"
                      tickFormatter={formatXAxis}
                      tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                      tickLine={false}
                      axisLine={false}
                      minTickGap={50}
                    />
                    <YAxis
                      tickFormatter={(v: number) => `+${v.toFixed(3)}%`}
                      tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                      tickLine={false}
                      axisLine={false}
                      width={70}
                    />
                    <Tooltip
                      content={({ active, payload, label }) => {
                        if (!active || !payload?.length) return null;
                        const val = payload[0].value as number;
                        return (
                          <div className="bg-background border border-border rounded px-2.5 py-1.5 text-xs shadow-lg font-mono">
                            <div className="text-muted-foreground mb-0.5">
                              {formatXAxis(label as number)}
                            </div>
                            <span
                              className={
                                val >= 0.5
                                  ? "text-primary"
                                  : val >= 0.1
                                  ? "text-amber-400"
                                  : "text-muted-foreground"
                              }
                            >
                              +{val.toFixed(4)}%
                            </span>
                          </div>
                        );
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="spread"
                      stroke="hsl(var(--primary))"
                      strokeWidth={1.5}
                      fill="url(#spreadGradient)"
                      dot={false}
                      isAnimationActive={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Open Positions — shown when there are bot legs for this token */}
          {hasOpenLegs && botStatus && (
            <OpenPositionsSection
              bot={botStatus.bot}
              openLegs={botStatus.openLegs}
              tokens={allTokens ?? []}
              botRequestOptions={botRequestOptions}
              requestHeaders={requestHeaders}
            />
          )}
        </div>

        {/* Trade terminal */}
        <div className="lg:col-span-1" data-testid="token-detail-terminal">
          {token ? (
            <TokenDetailPanel
              token={token}
              bot={botStatus?.bot}
              botOpenLegsCount={botStatus?.openLegsCount ?? 0}
              botRequestOptions={botRequestOptions}
            />
          ) : tokenNotFound ? (
            <div className="bg-card border border-border rounded-md p-6 flex flex-col items-center justify-center text-center gap-2 min-h-[200px]">
              <p className="text-sm font-semibold text-foreground">{symbol} not found</p>
              <p className="text-xs text-muted-foreground">
                This token is not currently listed on any connected exchange.
              </p>
              <Link href="/" className="mt-2 text-xs text-primary hover:underline">
                Back to Dashboard
              </Link>
            </div>
          ) : (
            <div className="bg-card border border-border rounded-md p-6 flex flex-col items-center justify-center text-center gap-3 min-h-[200px]">
              <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-muted-foreground">Loading {symbol}…</p>
            </div>
          )}
        </div>
      </div>

      {/* Footer: back link */}
      <div className="pt-2">
        <Link
          href="/"
          className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
        >
          <ArrowLeft className="w-3 h-3" />
          Back to all tokens
        </Link>
      </div>
    </div>
  );
}
