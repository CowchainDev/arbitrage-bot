import { useState, useMemo } from "react";
import { Link } from "wouter";
import { ArrowLeft } from "lucide-react";
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
} from "@workspace/api-client-react";
import type { ExchangeKlinePoint } from "@workspace/api-client-react";
import { TokenDetailPanel } from "@/components/token-detail-panel";
import { useBots } from "@/hooks/use-bots";
import { useBotSecret } from "@/hooks/use-bot-secret";

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
