import { useMemo, useState } from "react";
import { formatFee } from "@/lib/utils";
import {
  useGetTrades,
  getGetTradesQueryKey,
  useGetTradesPnlChart,
  getGetTradesPnlChartQueryKey,
  useGetTradesSymbols,
} from "@workspace/api-client-react";
import type { ClosedTrade, PnlChartPoint, GetTradesParams } from "@workspace/api-client-react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { TrendingUp, BarChart2, Activity, Info, RefreshCw, Filter, X } from "lucide-react";

function StatCard({
  label,
  value,
  sub,
  positive,
}: {
  label: string;
  value: string;
  sub?: string;
  positive?: boolean | null;
}) {
  const colorClass =
    positive === true
      ? "text-primary"
      : positive === false
        ? "text-destructive"
        : "text-foreground";

  return (
    <div className="bg-card border border-border rounded-lg p-4 flex flex-col gap-1">
      <span className="text-xs text-muted-foreground uppercase tracking-wider">{label}</span>
      <span className={`text-xl font-bold font-mono ${colorClass}`}>{value}</span>
      {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  );
}

function formatPnl(val: number) {
  if (val < 0) return `-$${Math.abs(val).toFixed(2)}`;
  return `+$${val.toFixed(2)}`;
}

function formatDuration(entryTime: string, closeTime: string) {
  const ms = new Date(closeTime).getTime() - new Date(entryTime).getTime();
  if (ms < 0) return "—";
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

interface CumulativePoint {
  closeTime: string;
  cumPnl: number;
  cumNetPnl: number | null;
  pnl: number;
  symbol: string;
}

function CumulativePnlChart({ points }: { points: PnlChartPoint[] }) {
  const chartData = useMemo<CumulativePoint[]>(() => {
    return points.map((p) => ({
      closeTime: format(new Date(p.closeTime), "MM/dd HH:mm"),
      cumPnl: p.cumPnl,
      cumNetPnl: p.cumNetPnl,
      pnl: p.pnl,
      symbol: p.symbol,
    }));
  }, [points]);

  if (chartData.length === 0) {
    return (
      <div className="flex items-center justify-center h-40 text-muted-foreground text-sm">
        No trade data yet
      </div>
    );
  }

  const finalPnl = chartData[chartData.length - 1]?.cumPnl ?? 0;
  const finalNetPnl = chartData[chartData.length - 1]?.cumNetPnl;
  const hasNetPnl = chartData.some((p) => p.cumNetPnl !== null);
  const pnlColor = finalPnl >= 0 ? "hsl(var(--primary))" : "hsl(var(--destructive))";
  const netColor =
    finalNetPnl != null
      ? finalNetPnl >= 0
        ? "hsl(142 71% 45%)"
        : "hsl(var(--destructive))"
      : "hsl(142 71% 45%)";

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={chartData} margin={{ top: 4, right: 16, left: 4, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis
          dataKey="closeTime"
          tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => `$${v}`}
        />
        <Tooltip
          contentStyle={{
            background: "hsl(var(--card))",
            border: "1px solid hsl(var(--border))",
            borderRadius: "6px",
            fontSize: "12px",
            fontFamily: "monospace",
          }}
          formatter={(value: number, name: string, props: { payload?: CumulativePoint }) => {
            const symbol = props.payload?.symbol ?? "";
            if (name === "cumPnl") return [`$${value.toFixed(2)}`, `Realized PnL excl. funding (${symbol})`];
            if (name === "cumNetPnl") return [`$${value.toFixed(2)}`, `Net PnL incl. funding (${symbol})`];
            return [`$${value.toFixed(2)}`, name];
          }}
          labelStyle={{ color: "hsl(var(--muted-foreground))" }}
        />
        <Legend
          wrapperStyle={{ fontSize: "11px", paddingTop: "8px" }}
          formatter={(value) => {
            if (value === "cumPnl") return "Realized PnL (excl. funding)";
            if (value === "cumNetPnl") return "Net PnL (incl. funding)";
            return value;
          }}
        />
        <Line
          type="monotone"
          dataKey="cumPnl"
          name="cumPnl"
          stroke={pnlColor}
          strokeWidth={2}
          dot={{ r: 3, fill: pnlColor }}
          activeDot={{ r: 5 }}
        />
        {hasNetPnl && (
          <Line
            type="monotone"
            dataKey="cumNetPnl"
            name="cumNetPnl"
            stroke={netColor}
            strokeWidth={2}
            strokeDasharray="5 3"
            dot={{ r: 3, fill: netColor }}
            activeDot={{ r: 5 }}
            connectNulls={false}
          />
        )}
      </LineChart>
    </ResponsiveContainer>
  );
}

function TradeTable({ trades }: { trades: ClosedTrade[] }) {
  if (trades.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground text-sm">
        No closed trades recorded yet. Close a position to see it here.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs font-mono">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            <th className="text-left px-3 py-2 font-medium">Symbol</th>
            <th className="text-left px-3 py-2 font-medium">Long / Short</th>
            <th className="text-right px-3 py-2 font-medium">Entry Spread</th>
            <th className="text-right px-3 py-2 font-medium">Condition</th>
            <th className="text-right px-3 py-2 font-medium">Exit Spread</th>
            <th className="text-right px-3 py-2 font-medium">Close</th>
            <th className="text-right px-3 py-2 font-medium">Size (USD)</th>
            <th className="text-right px-3 py-2 font-medium">Open Fees / Close Fees</th>
            <th className="text-right px-3 py-2 font-medium">
              <span className="inline-flex items-center gap-1">
                Funding / Rate Spread
                <Info
                  className="w-3 h-3 text-muted-foreground/60 cursor-help"
                  aria-label="Net funding received (+) or paid (−) over the life of this trade, with the funding rate spread at close shown below where available. Figures for trades closed before the 8-hour interval snap fix may be continuous-ratio estimates rather than settled-interval counts."
                  role="img"
                />
              </span>
            </th>
            <th className="text-right px-3 py-2 font-medium">Realized PnL (excl. funding)</th>
            <th className="text-right px-3 py-2 font-medium">Net PnL (incl. funding)</th>
            <th className="text-right px-3 py-2 font-medium">PnL (%)</th>
            <th className="text-right px-3 py-2 font-medium">Duration</th>
            <th className="text-right px-3 py-2 font-medium">Closed At</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((trade) => {
            const pnlPositive = trade.realizedPnl >= 0;
            const pnlPct =
              trade.quantity > 0
                ? (trade.realizedPnl / (trade.quantity * 2)) * 100
                : null;
            const funding = trade.fundingPaidUsd;
            const netPnl = funding != null ? trade.realizedPnl + funding : null;
            const netPnlPositive = netPnl != null ? netPnl >= 0 : null;
            return (
              <tr
                key={trade.id}
                className="border-b border-border/40 hover:bg-muted/30 transition-colors"
              >
                <td className="px-3 py-2.5 font-semibold">{trade.symbol}</td>
                <td className="px-3 py-2.5">
                  <span className="capitalize text-primary">{trade.longExchange}</span>
                  {" / "}
                  <span className="capitalize text-destructive">{trade.shortExchange}</span>
                </td>
                <td className="px-3 py-2.5 text-right">
                  <span
                    className={
                      trade.enterSpreadThresholdPct != null &&
                      Math.abs(trade.spreadAtEntry) < trade.enterSpreadThresholdPct
                        ? "text-amber-500"
                        : undefined
                    }
                  >
                    {trade.spreadAtEntry !== 0
                      ? `${trade.spreadAtEntry >= 0 ? "+" : ""}${trade.spreadAtEntry.toFixed(3)}%`
                      : "—"}
                  </span>
                </td>
                <td
                  className={`px-3 py-2.5 text-right ${
                    trade.enterSpreadThresholdPct != null &&
                    Math.abs(trade.spreadAtEntry) < trade.enterSpreadThresholdPct
                      ? "text-amber-500"
                      : "text-muted-foreground"
                  }`}
                  title={
                    trade.enterSpreadThresholdPct != null &&
                    Math.abs(trade.spreadAtEntry) < trade.enterSpreadThresholdPct
                      ? "Entry spread was below the configured threshold"
                      : undefined
                  }
                >
                  {trade.enterSpreadThresholdPct != null
                    ? `≥${trade.enterSpreadThresholdPct.toFixed(3)}%`
                    : "—"}
                </td>
                <td className="px-3 py-2.5 text-right text-muted-foreground">
                  {trade.spreadAtExit != null
                    ? `${trade.spreadAtExit >= 0 ? "+" : ""}${trade.spreadAtExit.toFixed(3)}%`
                    : "—"}
                </td>
                <td className="px-3 py-2.5 text-right">
                  {trade.closeReason ? (
                    <span
                      title={trade.closeReason}
                      className={
                        trade.closeReason === "take_profit"
                          ? "text-primary"
                          : trade.closeReason === "stop_loss" || trade.closeReason === "force_stop"
                            ? "text-destructive"
                            : "text-muted-foreground"
                      }
                    >
                      {trade.closeReason === "take_profit"
                        ? "TP"
                        : trade.closeReason === "stop_loss"
                          ? "SL"
                          : trade.closeReason === "force_stop"
                            ? "FS"
                            : trade.closeReason}
                    </span>
                  ) : "—"}
                </td>
                <td className="px-3 py-2.5 text-right">
                  {trade.quantity > 0 ? `$${trade.quantity.toFixed(2)}` : "—"}
                </td>
                <td className="px-3 py-2.5 text-right text-muted-foreground">
                  {trade.openFees != null && trade.closeFees != null ? (
                    <span className="flex flex-col items-end gap-0.5">
                      <span title="Open fees">-${formatFee(trade.openFees)}</span>
                      <span title="Close fees" className="text-muted-foreground/60">-${formatFee(trade.closeFees)}</span>
                    </span>
                  ) : trade.totalFees > 0 ? (
                    `-$${formatFee(trade.totalFees)}`
                  ) : "—"}
                </td>
                <td
                  className={`px-3 py-2.5 text-right ${funding != null ? (funding >= 0 ? "text-primary/80" : "text-destructive/80") : "text-muted-foreground"}`}
                  title={
                    trade.fundingRateSpread != null
                      ? `Rate spread at close: ${trade.fundingRateSpread >= 0 ? "+" : ""}${(trade.fundingRateSpread * 100).toFixed(4)}% — Estimated net funding received (+) or paid (−) over the life of this trade. Older records may reflect continuous-ratio estimates rather than discrete 8-hour settled intervals.`
                      : "Estimated net funding received (+) or paid (−) over the life of this trade. Older records may reflect continuous-ratio estimates rather than discrete 8-hour settled intervals."
                  }
                >
                  {funding != null || trade.fundingRateSpread != null ? (
                    <span className="flex flex-col items-end gap-0.5">
                      {funding != null ? (
                        <span>{`${funding >= 0 ? "+" : ""}$${Math.abs(funding).toFixed(4)}`}</span>
                      ) : (
                        <span>—</span>
                      )}
                      {trade.fundingRateSpread != null && (
                        <span className="text-muted-foreground/60 text-[10px]">
                          {`${trade.fundingRateSpread >= 0 ? "+" : ""}${(trade.fundingRateSpread * 100).toFixed(4)}%`}
                        </span>
                      )}
                    </span>
                  ) : "—"}
                </td>
                <td
                  className={`px-3 py-2.5 text-right font-semibold ${pnlPositive ? "text-primary" : "text-destructive"}`}
                >
                  {formatPnl(trade.realizedPnl)}
                </td>
                <td
                  className={`px-3 py-2.5 text-right font-semibold ${netPnlPositive === true ? "text-primary" : netPnlPositive === false ? "text-destructive" : "text-muted-foreground"}`}
                  title={netPnl == null ? "Funding data unavailable for this trade; net PnL cannot be calculated" : undefined}
                >
                  {netPnl != null ? formatPnl(netPnl) : "—"}
                </td>
                <td
                  className={`px-3 py-2.5 text-right ${pnlPositive ? "text-primary" : "text-destructive"}`}
                >
                  {pnlPct !== null
                    ? `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`
                    : "—"}
                </td>
                <td className="px-3 py-2.5 text-right text-muted-foreground">
                  {formatDuration(trade.entryTime, trade.closeTime)}
                </td>
                <td className="px-3 py-2.5 text-right text-muted-foreground">
                  {format(new Date(trade.closeTime), "MM/dd HH:mm")}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function History() {
  const queryClient = useQueryClient();
  const [backfilling, setBackfilling] = useState(false);
  const [backfillResult, setBackfillResult] = useState<string | null>(null);

  const [symbolFilter, setSymbolFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const activeParams = useMemo<GetTradesParams>(() => {
    const p: GetTradesParams = {};
    if (symbolFilter) p.symbol = symbolFilter;
    if (dateFrom) p.dateFrom = new Date(dateFrom).toISOString();
    if (dateTo) {
      const end = new Date(dateTo);
      end.setHours(23, 59, 59, 999);
      p.dateTo = end.toISOString();
    }
    return p;
  }, [symbolFilter, dateFrom, dateTo]);

  const hasActiveFilter = !!(symbolFilter || dateFrom || dateTo);

  const runBackfill = async () => {
    setBackfilling(true);
    setBackfillResult(null);
    try {
      const res = await fetch("/api/admin/backfill-conditions", { method: "POST" });
      const data = await res.json() as { updated?: number; message?: string };
      if (res.ok) {
        setBackfillResult(data.updated === 0 ? "All data already filled" : `Filled ${data.updated} rows`);
        await queryClient.invalidateQueries({ queryKey: getGetTradesQueryKey() });
      } else {
        setBackfillResult(`Error: ${data.message ?? "unknown"}`);
      }
    } catch {
      setBackfillResult("Request failed");
    } finally {
      setBackfilling(false);
    }
  };

  const symbolsQuery = useGetTradesSymbols({
    query: { queryKey: ["/api/trades/symbols"], staleTime: 60000 },
  });

  const tradesQuery = useGetTrades(
    activeParams,
    {
      query: {
        queryKey: getGetTradesQueryKey(activeParams),
        refetchInterval: 30000,
      },
    },
  );

  const pnlChartQuery = useGetTradesPnlChart({
    query: {
      queryKey: getGetTradesPnlChartQueryKey(),
      refetchInterval: 30000,
    },
  });

  const availableSymbols = symbolsQuery.data?.symbols ?? [];

  const data = tradesQuery.data;
  const trades = data?.trades ?? [];
  const stats = data?.stats;
  const chartPoints = pnlChartQuery.data?.points ?? [];

  const winRate =
    stats && stats.totalTrades > 0
      ? ((stats.winningTrades / stats.totalTrades) * 100).toFixed(1)
      : null;

  const avgPnl =
    stats && stats.totalTrades > 0
      ? stats.totalPnl / stats.totalTrades
      : 0;

  const feeBreakdown =
    stats?.totalOpenFees != null && stats?.totalCloseFees != null
      ? { open: stats.totalOpenFees, close: stats.totalCloseFees }
      : null;

  const clearFilters = () => {
    setSymbolFilter("");
    setDateFrom("");
    setDateTo("");
  };

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div className="flex items-center gap-2">
        <Activity className="w-5 h-5 text-primary" />
        <h1 className="text-lg font-bold">Trade History</h1>
        {tradesQuery.isFetching && (
          <span className="text-xs text-muted-foreground animate-pulse">Refreshing…</span>
        )}
      </div>

      {tradesQuery.isError && (
        <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-4 text-sm text-destructive">
          Failed to load trade history.
        </div>
      )}

      <div className="bg-card border border-border rounded-lg px-4 py-3 flex flex-wrap items-end gap-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground mr-1">
          <Filter className="w-3.5 h-3.5" />
          <span className="font-medium">Filters</span>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Symbol</label>
          <select
            value={symbolFilter}
            onChange={(e) => setSymbolFilter(e.target.value)}
            className="h-8 px-2 text-xs rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary min-w-[110px]"
          >
            <option value="">All symbols</option>
            {availableSymbols.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">From</label>
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            max={dateTo || undefined}
            className="h-8 px-2 text-xs rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">To</label>
          <input
            type="date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            min={dateFrom || undefined}
            className="h-8 px-2 text-xs rounded-md border border-border bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>

        {hasActiveFilter && (
          <button
            onClick={clearFilters}
            className="flex items-center gap-1 h-8 px-2 text-xs text-muted-foreground hover:text-foreground border border-border rounded-md transition-colors self-end"
          >
            <X className="w-3 h-3" />
            Clear
          </button>
        )}

        {hasActiveFilter && (
          <span className="self-end text-xs text-muted-foreground ml-auto">
            Showing filtered results
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-4 gap-3">
        <StatCard
          label="Total Trades"
          value={stats ? String(stats.totalTrades) : "—"}
          sub={hasActiveFilter ? "filtered" : "all time"}
        />
        <StatCard
          label="Win Rate"
          value={winRate !== null ? `${winRate}%` : "—"}
          sub={stats ? `${stats.winningTrades} winning` : undefined}
          positive={winRate !== null ? parseFloat(winRate) >= 50 : null}
        />
        <StatCard
          label="Total PnL"
          value={stats ? formatPnl(stats.totalPnl) : "—"}
          sub="excl. funding"
          positive={stats ? stats.totalPnl >= 0 : null}
        />
        <StatCard
          label="Net PnL"
          value={stats ? formatPnl(stats.netPnl) : "—"}
          sub="incl. funding"
          positive={stats ? stats.netPnl >= 0 : null}
        />
        <StatCard
          label="Total Fees"
          value={stats && stats.totalFees > 0 ? `-$${formatFee(stats.totalFees)}` : "—"}
          sub={feeBreakdown != null
            ? `Open -$${formatFee(feeBreakdown.open)} / Close -$${formatFee(feeBreakdown.close)}`
            : undefined}
          positive={false}
        />
        <StatCard
          label="Total Funding"
          value={stats && stats.totalTrades > 0 ? formatPnl(stats.totalFunding) : "—"}
          sub="received / paid · older trades may be estimates"
          positive={stats && stats.totalTrades > 0 ? stats.totalFunding >= 0 : null}
        />
        <StatCard
          label="Best Trade"
          value={stats && stats.totalTrades > 0 ? formatPnl(stats.bestTrade) : "—"}
          positive={stats && stats.totalTrades > 0 ? stats.bestTrade >= 0 : null}
        />
        <StatCard
          label="Worst Trade"
          value={stats && stats.totalTrades > 0 ? formatPnl(stats.worstTrade) : "—"}
          positive={stats && stats.totalTrades > 0 ? stats.worstTrade >= 0 : null}
        />
        <StatCard
          label="Avg PnL"
          value={stats && stats.totalTrades > 0 ? formatPnl(avgPnl) : "—"}
          sub="per trade"
          positive={stats && stats.totalTrades > 0 ? avgPnl >= 0 : null}
        />
        <StatCard
          label="Avg Funding Rate Spread"
          value={
            stats?.avgFundingRateSpread != null
              ? `${stats.avgFundingRateSpread >= 0 ? "+" : ""}${(stats.avgFundingRateSpread * 100).toFixed(4)}%`
              : "—"
          }
          sub="avg at close across trades"
          positive={stats?.avgFundingRateSpread != null ? stats.avgFundingRateSpread > 0 : null}
        />
      </div>

      <div className="bg-card border border-border rounded-lg p-4">
        <div className="flex items-center gap-2 mb-4">
          <TrendingUp className="w-4 h-4 text-primary" />
          <h2 className="text-sm font-semibold">Cumulative PnL Equity Curve</h2>
          {pnlChartQuery.isFetching && (
            <span className="ml-auto text-xs text-muted-foreground animate-pulse">Refreshing…</span>
          )}
        </div>
        {pnlChartQuery.isLoading ? (
          <div className="flex items-center justify-center h-40 text-muted-foreground text-sm animate-pulse">
            Loading…
          </div>
        ) : pnlChartQuery.isError ? (
          <div className="flex items-center justify-center h-40 text-destructive text-sm">
            Failed to load chart data.
          </div>
        ) : (
          <CumulativePnlChart points={chartPoints} />
        )}
      </div>

      <div className="bg-card border border-border rounded-lg overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <BarChart2 className="w-4 h-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Trade Log</h2>
          {trades.length > 0 && (
            <span className="text-xs text-muted-foreground">{trades.length} entries</span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {backfillResult && (
              <span className="text-xs text-muted-foreground">{backfillResult}</span>
            )}
            <button
              onClick={runBackfill}
              disabled={backfilling}
              title="Fill in missing Condition data from bot logs"
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground border border-border rounded px-2 py-1 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3 h-3 ${backfilling ? "animate-spin" : ""}`} />
              {backfilling ? "Filling…" : "Fill missing data"}
            </button>
          </div>
        </div>
        {tradesQuery.isLoading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground text-sm animate-pulse">
            Loading…
          </div>
        ) : (
          <TradeTable trades={trades} />
        )}
      </div>
    </div>
  );
}
