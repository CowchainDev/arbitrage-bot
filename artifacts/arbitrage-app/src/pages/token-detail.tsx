import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { Link } from "wouter";
import { ArrowLeft, TrendingUp, XCircle, ChevronDown, ChevronUp, PanelRight, PanelRightClose, History } from "lucide-react";
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
  ReferenceLine,
  ReferenceArea,
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
import type { ExchangeKlinePoint, BotConfig, BotLeg, TokenSpread, GetExchangeKlinesInterval } from "@workspace/api-client-react";
import { TokenDetailPanel } from "@/components/token-detail-panel";
import { useBots } from "@/hooks/use-bots";
import { useBotSecret } from "@/hooks/use-bot-secret";
import { usePriceStream } from "@/hooks/use-price-stream";
import { useApiCredentials } from "@/hooks/use-api-credentials";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { useQueryClient, useQuery, keepPreviousData } from "@tanstack/react-query";
import {
  BotSummaryRow,
  PositionRow,
  botLegToPosition,
} from "@/components/position-rows";

const CANDLE_LIMIT_BY_INTERVAL: Record<string, number> = {
  "15m": 96,
  "1h":  168,
  "4h":  90,
  "1d":  60,
};

type LiveTimeRange   = { label: string; interval: "live";                   limit: number; liveSeconds: number };
type CandleTimeRange = { label: string; interval: GetExchangeKlinesInterval; limit: number; liveSeconds?: never };
type TimeRange = LiveTimeRange | CandleTimeRange;
const TIME_RANGES: TimeRange[] = [
  { label: "30s", interval: "live", limit: 120,                              liveSeconds: 30  },
  { label: "1m",  interval: "live", limit: 240,                              liveSeconds: 60  },
  { label: "5m",  interval: "live", limit: 300,                              liveSeconds: 300 },
  { label: "15m", interval: "15m",  limit: CANDLE_LIMIT_BY_INTERVAL["15m"] },
  { label: "1h",  interval: "1h",   limit: CANDLE_LIMIT_BY_INTERVAL["1h"]  },
  { label: "4h",  interval: "4h",   limit: CANDLE_LIMIT_BY_INTERVAL["4h"]  },
  { label: "1d",  interval: "1d",   limit: CANDLE_LIMIT_BY_INTERVAL["1d"]  },
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

type TradeMarker = {
  t: number;
  label: "BUY" | "SELL";
  color: string;
  isEntry: boolean;
  legId: number;
  spreadAtEntry?: number;
  spreadAtExit?: number;
  realizedPnlUsd?: number;
  openedAtMs: number;
  closedAtMs?: number;
};

type TradePair = {
  legId: number;
  openedAtMs: number;
  closedAtMs: number;
};

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function TradeMarkerLabel({
  viewBox,
  marker,
}: {
  viewBox?: { x: number; y: number; width: number; height: number };
  marker: TradeMarker;
}) {
  const [hovered, setHovered] = useState(false);
  if (!viewBox) return null;
  const { x, y, height } = viewBox;

  const isClosed = marker.closedAtMs != null;
  const duration = isClosed
    ? formatDuration(marker.closedAtMs! - marker.openedAtMs)
    : null;

  const tooltipWidth = 188;
  const tooltipLineCount = isClosed ? 5 : 3;
  const tooltipHeight = 24 + tooltipLineCount * 18;
  const tooltipX = x + 6;
  const tooltipY = y + 18;

  const fmtSpread = (v?: number) =>
    v != null ? `${v.toFixed(4)}%` : "N/A";
  const fmtPnl = (v?: number) =>
    v != null
      ? `${v >= 0 ? "+" : ""}$${v.toFixed(2)}`
      : "N/A";

  return (
    <g>
      <rect
        x={x - 8}
        y={y}
        width={16}
        height={height}
        fill="transparent"
        style={{ cursor: "pointer" }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      <text
        x={x + 3}
        y={y + 12}
        fill={marker.color}
        fontSize={9}
        fontFamily="monospace"
        fontWeight="bold"
        style={{ pointerEvents: "none", userSelect: "none" }}
      >
        {marker.label}
      </text>
      {hovered && (
        <foreignObject
          x={tooltipX}
          y={tooltipY}
          width={tooltipWidth}
          height={tooltipHeight}
          style={{ overflow: "visible" }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          <div
            style={{
              background: "hsl(var(--background))",
              border: "1px solid hsl(var(--border))",
              borderRadius: 6,
              padding: "6px 10px",
              fontSize: 11,
              lineHeight: "18px",
              boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
              whiteSpace: "nowrap",
              color: "hsl(var(--foreground))",
            }}
          >
            <div
              style={{
                fontWeight: 700,
                fontFamily: "monospace",
                color: marker.color,
                marginBottom: 4,
              }}
            >
              {marker.isEntry
                ? `▲ ${marker.label} (Entry)`
                : `▼ ${marker.label} (Exit)`}
            </div>
            <div style={{ color: "hsl(var(--muted-foreground))" }}>
              Entry spread:{" "}
              <span style={{ color: "hsl(var(--foreground))", fontFamily: "monospace" }}>
                {fmtSpread(marker.spreadAtEntry)}
              </span>
            </div>
            {isClosed && (
              <div style={{ color: "hsl(var(--muted-foreground))" }}>
                Exit spread:{" "}
                <span style={{ color: "hsl(var(--foreground))", fontFamily: "monospace" }}>
                  {fmtSpread(marker.spreadAtExit)}
                </span>
              </div>
            )}
            {isClosed && (
              <div style={{ color: "hsl(var(--muted-foreground))" }}>
                Realized P&amp;L:{" "}
                <span
                  style={{
                    color:
                      marker.realizedPnlUsd != null
                        ? marker.realizedPnlUsd >= 0
                          ? "#22c55e"
                          : "#ef4444"
                        : "hsl(var(--foreground))",
                    fontFamily: "monospace",
                    fontWeight: 600,
                  }}
                >
                  {fmtPnl(marker.realizedPnlUsd)}
                </span>
              </div>
            )}
            {duration != null && (
              <div style={{ color: "hsl(var(--muted-foreground))" }}>
                Hold duration:{" "}
                <span style={{ color: "hsl(var(--foreground))", fontFamily: "monospace" }}>
                  {duration}
                </span>
              </div>
            )}
            {!isClosed && (
              <div style={{ color: "hsl(var(--muted-foreground))" }}>
                Status:{" "}
                <span style={{ color: "#22c55e", fontFamily: "monospace" }}>
                  Open
                </span>
              </div>
            )}
          </div>
        </foreignObject>
      )}
    </g>
  );
}

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

function loadAllExchangeHeaders(base: RequestInit | undefined): RequestInit {
  const baseHeaders = (base?.headers ?? {}) as Record<string, string>;
  const extra: Record<string, string> = {};
  for (const exchange of ["gate", "okx", "mexc"] as const) {
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
  return { headers: { ...baseHeaders, ...extra } };
}

function PnlSummaryBar({ legs }: { legs: BotLeg[] }) {
  const stats = useMemo(() => {
    const withPnl = legs.filter((l) => l.realizedPnlUsd != null);
    if (withPnl.length === 0) return null;
    const pnls = withPnl.map((l) => l.realizedPnlUsd!);
    const total = pnls.reduce((s, v) => s + v, 0);
    const avg = total / pnls.length;
    const best = Math.max(...pnls);
    const worst = Math.min(...pnls);
    return { total, count: legs.length, avg, best, worst };
  }, [legs]);

  if (!stats) return null;

  const fmtPnl = (v: number) =>
    `${v >= 0 ? "+" : "-"}$${Math.abs(v).toFixed(2)}`;
  const pnlColor = (v: number) =>
    v >= 0 ? "text-primary" : "text-destructive";

  const items: { label: string; value: string; color: string }[] = [
    { label: "Total P&L", value: fmtPnl(stats.total), color: pnlColor(stats.total) },
    { label: "Trades", value: String(stats.count), color: "text-foreground" },
    { label: "Avg P&L", value: fmtPnl(stats.avg), color: pnlColor(stats.avg) },
    { label: "Best", value: fmtPnl(stats.best), color: pnlColor(stats.best) },
    { label: "Worst", value: fmtPnl(stats.worst), color: pnlColor(stats.worst) },
  ];

  return (
    <div
      className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5 bg-muted/40 border-b border-border/60"
      data-testid="pnl-summary-bar"
    >
      {items.map(({ label, value, color }) => (
        <div key={label} className="flex items-baseline gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
            {label}
          </span>
          <span className={`text-xs font-semibold font-mono ${color}`}>
            {value}
          </span>
        </div>
      ))}
    </div>
  );
}

function ClosedLegsSection({
  legs,
  loading,
  highlightedLegId,
  onClearHighlight,
}: {
  legs: BotLeg[];
  loading?: boolean;
  highlightedLegId?: number | null;
  onClearHighlight?: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const rowRefs = useRef<Map<number, HTMLTableRowElement>>(new Map());

  const sortedLegs = useMemo(
    () =>
      [...legs].sort(
        (a, b) =>
          new Date(b.closedAt ?? b.openedAt).getTime() -
          new Date(a.closedAt ?? a.openedAt).getTime()
      ),
    [legs]
  );

  // Scroll to + flash the highlighted row whenever it changes
  useEffect(() => {
    if (highlightedLegId == null) return;
    // Ensure the section is expanded so the row is visible
    setExpanded(true);
    // Defer scroll until after paint so the row is in the DOM
    const raf = requestAnimationFrame(() => {
      const el = rowRefs.current.get(highlightedLegId);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [highlightedLegId]);

  if (!loading && legs.length === 0) return null;

  return (
    <div
      className="bg-card border border-border rounded-md overflow-hidden"
      data-testid="closed-legs-section"
    >
      <button
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-muted/30 transition-colors"
        data-testid="btn-toggle-closed-legs"
      >
        <div className="flex items-center gap-2 text-sm font-semibold">
          <History className="w-4 h-4 text-muted-foreground" />
          Closed Trades
          <span className="bg-muted text-muted-foreground text-xs px-1.5 py-0.5 rounded">
            {loading ? "…" : legs.length}
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
          <PnlSummaryBar legs={sortedLegs} />

          {loading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground text-xs">
              <span className="w-4 h-4 border-2 border-muted-foreground border-t-transparent rounded-full animate-spin mr-2" />
              Loading closed trades…
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs font-mono">
                <thead>
                  <tr className="border-b border-border text-muted-foreground bg-muted/20">
                    <th className="text-left px-3 py-2 font-semibold uppercase tracking-wider">
                      Side
                    </th>
                    <th className="text-right px-3 py-2 font-semibold uppercase tracking-wider">
                      Entry Spread
                    </th>
                    <th className="text-right px-3 py-2 font-semibold uppercase tracking-wider">
                      Exit Spread
                    </th>
                    <th className="text-right px-3 py-2 font-semibold uppercase tracking-wider">
                      Realized P&amp;L
                    </th>
                    <th className="text-right px-3 py-2 font-semibold uppercase tracking-wider">
                      Opened
                    </th>
                    <th className="text-right px-3 py-2 font-semibold uppercase tracking-wider">
                      Duration
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedLegs.map((leg) => {
                    const pnl = leg.realizedPnlUsd;
                    const pnlClass =
                      pnl != null
                        ? pnl >= 0
                          ? "text-primary"
                          : "text-destructive"
                        : "text-muted-foreground";
                    const isLong = leg.bybitSide === "long";
                    const durationMs =
                      leg.closedAt
                        ? new Date(leg.closedAt).getTime() -
                          new Date(leg.openedAt).getTime()
                        : null;
                    const duration =
                      durationMs != null ? formatDuration(durationMs) : "—";
                    const isHighlighted = highlightedLegId === leg.id;
                    return (
                      <tr
                        key={leg.id}
                        ref={(el) => {
                          if (el) rowRefs.current.set(leg.id, el);
                          else rowRefs.current.delete(leg.id);
                        }}
                        data-leg-id={leg.id}
                        onClick={() => isHighlighted && onClearHighlight?.()}
                        className={`border-b border-border/40 transition-colors ${
                          isHighlighted
                            ? "bg-primary/15 ring-1 ring-inset ring-primary/40"
                            : "hover:bg-muted/30"
                        }`}
                        style={isHighlighted ? { cursor: "pointer" } : undefined}
                      >
                        <td className="px-3 py-2.5">
                          <span
                            className={
                              isLong ? "text-primary" : "text-destructive"
                            }
                          >
                            {isLong ? "Long" : "Short"}
                          </span>
                          {isHighlighted && (
                            <span className="ml-1.5 text-[9px] text-primary uppercase tracking-wide font-semibold">
                              ← chart
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right text-muted-foreground">
                          {leg.spreadAtEntry != null
                            ? `+${leg.spreadAtEntry.toFixed(3)}%`
                            : "—"}
                        </td>
                        <td className="px-3 py-2.5 text-right text-muted-foreground">
                          {leg.spreadAtExit != null
                            ? `+${leg.spreadAtExit.toFixed(3)}%`
                            : "—"}
                        </td>
                        <td
                          className={`px-3 py-2.5 text-right font-semibold ${pnlClass}`}
                        >
                          {pnl != null
                            ? `${pnl >= 0 ? "+" : "-"}$${Math.abs(pnl).toFixed(2)}`
                            : "—"}
                        </td>
                        <td className="px-3 py-2.5 text-right text-muted-foreground">
                          {new Date(leg.openedAt).toLocaleString("en-US", {
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                            hour12: false,
                          })}
                        </td>
                        <td className="px-3 py-2.5 text-right text-muted-foreground">
                          {duration}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

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
  const allExchangeRequestHeaders = useMemo(
    () => loadAllExchangeHeaders(requestHeaders),
    [requestHeaders]
  );
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
                    requestHeaders={allExchangeRequestHeaders}
                    exchangeA={bot.exchangeA}
                    exchangeB={bot.exchangeB}
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
                requestHeaders={allExchangeRequestHeaders}
                exchangeA={bot.exchangeA}
                exchangeB={bot.exchangeB}
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
  const [timeRange, setTimeRange] = useState<TimeRange>(TIME_RANGES[3]); // default 15m
  const [extraBatches, setExtraBatches] = useState(0);
  const [terminalCollapsed, setTerminalCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem("arbitrage-terminalCollapsed") === "true"; } catch { return false; }
  });

  useEffect(() => {
    try { localStorage.setItem("arbitrage-terminalCollapsed", String(terminalCollapsed)); } catch {}
  }, [terminalCollapsed]);

  const isLiveMode = timeRange.interval === "live";

  // Reset extra batches whenever the user picks a new time range
  useEffect(() => {
    setExtraBatches(0);
  }, [timeRange]);

  const MAX_EXTRA_BATCHES = 9; // cap at 10× the default limit per interval
  const effectiveLimit = timeRange.limit * (1 + extraBatches);

  const { data: allTokens, isLoading: pricesLoading } = useGetExchangePrices({
    query: { queryKey: getGetExchangePricesQueryKey(), refetchInterval: isLiveMode ? 2000 : 10_000 },
  });
  const token = allTokens?.find((t) => t.symbol === symbol);
  const tokenNotFound = !pricesLoading && allTokens != null && token == null;

  // Live price stream (WebSocket) for real-time chart updates
  const { tokens: streamTokens, streamStatus } = usePriceStream();
  const streamToken = streamTokens.find((t) => t.symbol === symbol);
  // Use WebSocket data if available, otherwise polling data
  const liveToken = streamStatus === "open" && streamToken ? streamToken : token;

  // Rolling buffer for live short-timeframe chart
  const liveBufferRef = useRef<ChartRow[]>([]);
  const [liveBuffer, setLiveBuffer] = useState<ChartRow[]>([]);

  // Reset buffer when timeframe changes
  useEffect(() => {
    liveBufferRef.current = [];
    setLiveBuffer([]);
  }, [timeRange.label]);

  // Accumulate live price data into rolling buffer
  useEffect(() => {
    if (!isLiveMode || !liveToken) return;
    const now = Date.now();
    const windowMs = (timeRange.liveSeconds ?? 60) * 1000;
    const point: ChartRow = { t: now };
    const exFields: Array<[ExchangeName, keyof TokenSpread]> = [
      ["bybit",   "bybitPrice"  ],
      ["binance", "binancePrice"],
      ["gate",    "gatePrice"   ],
      ["okx",     "okxPrice"    ],
      ["mexc",    "mexcPrice"   ],
    ];
    let hasData = false;
    for (const [ex, field] of exFields) {
      const val = liveToken[field] as number | null | undefined;
      if (val != null && val > 0) {
        (point as Record<string, number>)[ex] = val;
        hasData = true;
      }
    }
    if (!hasData) return;
    const cutoff = now - windowMs;
    liveBufferRef.current = [
      ...liveBufferRef.current.filter((p) => p.t >= cutoff),
      point,
    ];
    setLiveBuffer([...liveBufferRef.current]);
  }, [liveToken, isLiveMode, timeRange.liveSeconds]);

  const klinesInterval = timeRange.interval !== "live" ? timeRange.interval : undefined;
  const klinesParams = { symbol, interval: klinesInterval, limit: effectiveLimit };
  const { data: klines, isLoading: klinesLoading, isError: klinesError, isFetching: klinesIsFetching } = useGetExchangeKlines(
    klinesParams,
    {
      query: {
        queryKey: getGetExchangeKlinesQueryKey(klinesParams),
        refetchInterval: 60_000,
        staleTime: 30_000,
        enabled: !isLiveMode,
        placeholderData: keepPreviousData,
      },
    }
  );

  const { getBotRequestOptions } = useBotSecret();
  const botRequestOptions = getBotRequestOptions();

  const { getRequestHeaders } = useApiCredentials();
  const requestHeaders = getRequestHeaders();

  const { getBotStatusForSymbol } = useBots();
  const botStatus = getBotStatusForSymbol(symbol);

  const botId = botStatus?.bot.id;
  const closedLegsQuery = useQuery<{ legs: BotLeg[] }>({
    queryKey: [`/api/bots/${botId}/legs`, "closed"],
    queryFn: async () => {
      const res = await fetch(`/api/bots/${botId}/legs?status=closed`);
      if (!res.ok) throw new Error("Failed to fetch closed legs");
      return res.json();
    },
    enabled: botId != null,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const closedLegs: BotLeg[] = closedLegsQuery.data?.legs ?? [];

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

  // Live mode: derive active exchanges from accumulated buffer
  const liveActiveExchanges = useMemo((): ExchangeName[] => {
    if (!isLiveMode) return [];
    return ALL_EXCHANGES.filter((ex) =>
      liveBuffer.some((row) => (row as Record<string, number>)[ex] != null)
    );
  }, [isLiveMode, liveBuffer]);

  // Final data sent to the chart — live buffer or klines
  const chartDataFinal = isLiveMode ? liveBuffer : chartData;
  const activeExchangesFinal = isLiveMode ? liveActiveExchanges : activeExchanges;

  const spreadData = useMemo(() => {
    return chartDataFinal.map((row) => {
      const prices = activeExchangesFinal
        .map((ex) => row[ex])
        .filter((p): p is number => p != null && p > 0);
      const spread =
        prices.length >= 2
          ? ((Math.max(...prices) - Math.min(...prices)) / Math.min(...prices)) * 100
          : 0;
      return { t: row.t, spread };
    });
  }, [chartDataFinal, activeExchangesFinal]);

  const formatXAxis = (t: number) => {
    const d = new Date(t);
    if (timeRange.interval === "live" && (timeRange.liveSeconds ?? 60) <= 60) {
      return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    }
    if (timeRange.interval === "1d") {
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    }
    if (timeRange.interval === "4h" || timeRange.interval === "1h") {
      // These span multiple days — show abbreviated weekday + time
      return d.toLocaleString("en-US", { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
    }
    if (timeRange.interval === "15m") {
      // Spans ~24h — show day + time to disambiguate yesterday vs today
      return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
    }
    return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
  };

  // BUY markers from open legs + BUY+SELL markers from closed legs
  const tradeMarkers = useMemo((): TradeMarker[] => {
    const markers: TradeMarker[] = [];

    for (const leg of botStatus?.openLegs ?? []) {
      const openedAtMs = new Date(leg.openedAt).getTime();
      const isLong = leg.bybitSide === "long";
      markers.push({
        t: openedAtMs,
        label: isLong ? "BUY" : "SELL",
        color: isLong ? "#22c55e" : "#ef4444",
        isEntry: true,
        legId: leg.id,
        spreadAtEntry: leg.spreadAtEntry,
        openedAtMs,
      });
    }

    for (const leg of closedLegs) {
      if (!leg.closedAt) continue;
      const openedAtMs = new Date(leg.openedAt).getTime();
      const closedAtMs = new Date(leg.closedAt).getTime();
      const isLong = leg.bybitSide === "long";
      const shared = {
        legId: leg.id,
        spreadAtEntry: leg.spreadAtEntry,
        spreadAtExit: leg.spreadAtExit,
        realizedPnlUsd: leg.realizedPnlUsd,
        openedAtMs,
        closedAtMs,
      };
      markers.push({
        t: openedAtMs,
        label: isLong ? "BUY" : "SELL",
        color: isLong ? "#22c55e" : "#ef4444",
        isEntry: true,
        ...shared,
      });
      markers.push({
        t: closedAtMs,
        label: isLong ? "SELL" : "BUY",
        color: isLong ? "#ef4444" : "#22c55e",
        isEntry: false,
        ...shared,
      });
    }

    return markers;
  }, [botStatus, closedLegs]);

  // Pairs for shaded bands between entry and exit
  const tradePairs = useMemo((): TradePair[] => {
    return closedLegs
      .filter((leg) => leg.closedAt != null)
      .map((leg) => ({
        legId: leg.id,
        openedAtMs: new Date(leg.openedAt).getTime(),
        closedAtMs: new Date(leg.closedAt!).getTime(),
      }));
  }, [closedLegs]);

  // Cumulative P&L over time — one point per closed leg, sorted by closedAt
  const pnlChartData = useMemo((): {
    t: number;
    pnl: number;
    legId: number;
    delta: number;
    side: "long" | "short";
    spreadAtEntry?: number;
    spreadAtExit?: number;
    durationMs: number;
  }[] => {
    const legs = closedLegs
      .filter((leg) => leg.closedAt != null && leg.realizedPnlUsd != null)
      .slice()
      .sort((a, b) => new Date(a.closedAt!).getTime() - new Date(b.closedAt!).getTime());

    let cumulative = 0;
    return legs.map((leg) => {
      const delta = leg.realizedPnlUsd!;
      cumulative += delta;
      return {
        t: new Date(leg.closedAt!).getTime(),
        pnl: cumulative,
        legId: leg.id,
        delta,
        side: leg.bybitSide === "long" ? "long" : "short",
        spreadAtEntry: leg.spreadAtEntry ?? undefined,
        spreadAtExit: leg.spreadAtExit ?? undefined,
        durationMs:
          new Date(leg.closedAt!).getTime() - new Date(leg.openedAt).getTime(),
      };
    });
  }, [closedLegs]);

  const [highlightedLegId, setHighlightedLegId] = useState<number | null>(null);
  const clearHighlight = useCallback(() => setHighlightedLegId(null), []);

  type PnlRange = "7d" | "30d" | "all";
  const [pnlRange, setPnlRange] = useState<PnlRange>("all");

  const filteredPnlChartData = useMemo(() => {
    if (pnlRange === "all") return pnlChartData;
    const cutoffMs = Date.now() - (pnlRange === "7d" ? 7 : 30) * 24 * 60 * 60 * 1000;
    const filtered = pnlChartData.filter((pt) => pt.t >= cutoffMs);
    let cumulative = 0;
    return filtered.map((pt) => {
      cumulative += pt.delta;
      return { ...pt, pnl: cumulative };
    });
  }, [pnlChartData, pnlRange]);

  // Clear highlighted leg if it falls outside the currently visible range
  useEffect(() => {
    if (highlightedLegId == null) return;
    const visible = filteredPnlChartData.some((pt) => pt.legId === highlightedLegId);
    if (!visible) setHighlightedLegId(null);
  }, [filteredPnlChartData, highlightedLegId]);

  // Extend X domain so markers that fall outside the klines window remain visible
  const chartXDomain = useMemo((): [number, number] | ["dataMin", "dataMax"] => {
    if (chartDataFinal.length === 0) return ["dataMin", "dataMax"];
    const dataMin = Math.min(...chartDataFinal.map((d) => d.t));
    const dataMax = Math.max(...chartDataFinal.map((d) => d.t));
    if (tradeMarkers.length === 0) return [dataMin, dataMax];
    const markerMin = Math.min(...tradeMarkers.map((m) => m.t));
    const markerMax = Math.max(...tradeMarkers.map((m) => m.t));
    return [Math.min(dataMin, markerMin), Math.max(dataMax, markerMax)];
  }, [chartDataFinal, tradeMarkers]);

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
        <div className={`space-y-3 ${terminalCollapsed ? "col-span-full" : "lg:col-span-2 xl:col-span-3"}`}>
          {/* Header + time range selector */}
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h2 className="text-base font-semibold">{symbol} — Price History</h2>
            <div className="flex items-center gap-2">
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
              {klinesIsFetching && !klinesLoading && !isLiveMode && (
                <span className="w-3.5 h-3.5 border-2 border-muted-foreground border-t-transparent rounded-full animate-spin ml-1 opacity-60" />
              )}
              </div>
              <button
                onClick={() => setTerminalCollapsed((v) => !v)}
                title={terminalCollapsed ? "Show terminal" : "Hide terminal"}
                aria-label={terminalCollapsed ? "Show terminal panel" : "Hide terminal panel"}
                aria-pressed={!terminalCollapsed}
                data-testid="btn-toggle-terminal"
                className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                {terminalCollapsed ? (
                  <PanelRight className="w-4 h-4" />
                ) : (
                  <PanelRightClose className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>

          {/* Price chart */}
          <div className="bg-card border border-border rounded-md p-3" data-testid="price-chart">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">
                Price (USDT perpetual)
              </div>
              {isLiveMode && (
                <div className="flex items-center gap-1.5 text-xs text-emerald-400 font-mono">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  LIVE
                </div>
              )}
            </div>
            {!isLiveMode && klinesLoading ? (
              <div className="h-64 flex items-center justify-center">
                <span className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              </div>
            ) : !isLiveMode && !klinesIsFetching && (klinesError || chartDataFinal.length === 0) ? (
              <div className="h-64 flex items-center justify-center text-muted-foreground text-sm">
                No chart data available
              </div>
            ) : isLiveMode && chartDataFinal.length === 0 ? (
              <div className="h-64 flex items-center justify-center text-muted-foreground text-sm">
                <div className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-muted-foreground border-t-transparent rounded-full animate-spin" />
                  Buffering live prices…
                </div>
              </div>
            ) : (
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartDataFinal} margin={{ top: 14, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="hsl(var(--border))"
                      strokeOpacity={0.4}
                    />
                    <XAxis
                      dataKey="t"
                      type="number"
                      scale="time"
                      domain={chartXDomain}
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
                    {activeExchangesFinal.map((ex) => (
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
                    {tradePairs.map((pair) => (
                      <ReferenceArea
                        key={`band-${pair.legId}`}
                        x1={pair.openedAtMs}
                        x2={pair.closedAtMs}
                        fill="#22c55e"
                        fillOpacity={0.06}
                        stroke="none"
                      />
                    ))}
                    {tradeMarkers.map((marker, i) => (
                      <ReferenceLine
                        key={`${marker.legId}-${marker.label}-${i}`}
                        x={marker.t}
                        stroke={marker.color}
                        strokeDasharray="4 2"
                        strokeWidth={1.5}
                        label={(props) => (
                          <TradeMarkerLabel {...props} marker={marker} />
                        )}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
            {/* Legend */}
            {activeExchangesFinal.length > 0 && (chartDataFinal.length > 0 || !isLiveMode) && (
              <div className="flex flex-wrap gap-4 mt-2 pt-2 border-t border-border/40">
                {activeExchangesFinal.map((ex) => (
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
                {tradeMarkers.some((m) => m.label === "BUY") && (
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className="w-5 h-0.5 rounded-full shrink-0" style={{ borderTop: "2px dashed #22c55e" }} />
                    <span className="font-medium text-emerald-400">BUY</span>
                  </div>
                )}
                {tradeMarkers.some((m) => m.label === "SELL") && (
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className="w-5 h-0.5 rounded-full shrink-0" style={{ borderTop: "2px dashed #ef4444" }} />
                    <span className="font-medium text-red-400">SELL</span>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Spread history chart */}
          {(isLiveMode || !klinesLoading) && spreadData.length > 0 && (
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
                      type="number"
                      scale="time"
                      domain={chartXDomain}
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

          {/* Cumulative P&L chart — shown when there are closed legs with P&L data */}
          {pnlChartData.length > 0 && (
            <div className="bg-card border border-border rounded-md p-3" data-testid="pnl-chart">
              <div className="flex items-center justify-between mb-2">
                <div className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">
                  Cumulative Realized P&amp;L (USD)
                </div>
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1" data-testid="pnl-range-selector">
                    {(["7d", "30d", "all"] as const).map((r) => (
                      <button
                        key={r}
                        onClick={() => setPnlRange(r)}
                        data-testid={`btn-pnl-range-${r}`}
                        className={`px-2 py-0.5 text-[11px] rounded font-mono transition-colors ${
                          pnlRange === r
                            ? "bg-primary text-primary-foreground"
                            : "text-muted-foreground hover:text-foreground hover:bg-muted"
                        }`}
                      >
                        {r === "all" ? "All" : r}
                      </button>
                    ))}
                  </div>
                  <div className="text-[10px] text-muted-foreground/60">
                    Click a point to highlight its trade below
                  </div>
                </div>
              </div>
              <div className="h-36" style={{ cursor: filteredPnlChartData.length > 0 ? "pointer" : "default" }}>
                {filteredPnlChartData.length === 0 ? (
                  <div className="flex items-center justify-center h-full text-xs text-muted-foreground/60">
                    No closed trades in the selected range
                  </div>
                ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={filteredPnlChartData}
                    margin={{ top: 4, right: 8, left: 0, bottom: 0 }}
                    onClick={(chartState) => {
                      if (!chartState?.activePayload?.length) return;
                      const pt = chartState.activePayload[0].payload as { legId: number };
                      if (pt?.legId != null) {
                        setHighlightedLegId((prev) =>
                          prev === pt.legId ? null : pt.legId
                        );
                      }
                    }}
                  >
                    <CartesianGrid
                      strokeDasharray="3 3"
                      stroke="hsl(var(--border))"
                      strokeOpacity={0.4}
                    />
                    <XAxis
                      dataKey="t"
                      type="number"
                      scale="time"
                      domain={["dataMin", "dataMax"]}
                      tickFormatter={(t: number) => {
                        const d = new Date(t);
                        return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
                      }}
                      tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                      tickLine={false}
                      axisLine={false}
                      minTickGap={60}
                    />
                    <YAxis
                      tickFormatter={(v: number) =>
                        `${v >= 0 ? "+" : ""}${v.toFixed(2)}`
                      }
                      tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                      tickLine={false}
                      axisLine={false}
                      width={70}
                      domain={["auto", "auto"]}
                    />
                    <ReferenceLine y={0} stroke="hsl(var(--border))" strokeWidth={1} />
                    <Tooltip
                      content={({ active, payload, label }) => {
                        if (!active || !payload?.length) return null;
                        const pt = payload[0].payload as {
                          pnl: number;
                          delta: number;
                          side: "long" | "short";
                          spreadAtEntry?: number;
                          spreadAtExit?: number;
                          durationMs: number;
                          legId: number;
                        };
                        const d = new Date(label as number);
                        const fmtSpread = (v?: number) =>
                          v != null ? `+${v.toFixed(3)}%` : "N/A";
                        const fmtPnl = (v: number) =>
                          `${v >= 0 ? "+" : ""}$${Math.abs(v).toFixed(4)}`;
                        const isHighlighted = highlightedLegId === pt.legId;
                        return (
                          <div className="bg-background border border-border rounded px-3 py-2 text-xs shadow-lg font-mono space-y-1 min-w-[180px]">
                            <div className="text-muted-foreground text-[10px] mb-1">
                              {d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                              {" "}
                              {d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
                            </div>
                            <div className="flex justify-between gap-4">
                              <span className="text-muted-foreground">Cumulative</span>
                              <span className={pt.pnl >= 0 ? "text-primary" : "text-destructive"}>
                                {fmtPnl(pt.pnl)}
                              </span>
                            </div>
                            <div className="flex justify-between gap-4">
                              <span className="text-muted-foreground">This trade</span>
                              <span className={pt.delta >= 0 ? "text-primary font-semibold" : "text-destructive font-semibold"}>
                                {fmtPnl(pt.delta)}
                              </span>
                            </div>
                            <div className="flex justify-between gap-4">
                              <span className="text-muted-foreground">Side</span>
                              <span className={pt.side === "long" ? "text-primary" : "text-destructive"}>
                                {pt.side === "long" ? "Long" : "Short"}
                              </span>
                            </div>
                            <div className="flex justify-between gap-4">
                              <span className="text-muted-foreground">Entry spread</span>
                              <span className="text-foreground">{fmtSpread(pt.spreadAtEntry)}</span>
                            </div>
                            <div className="flex justify-between gap-4">
                              <span className="text-muted-foreground">Exit spread</span>
                              <span className="text-foreground">{fmtSpread(pt.spreadAtExit)}</span>
                            </div>
                            <div className="flex justify-between gap-4">
                              <span className="text-muted-foreground">Duration</span>
                              <span className="text-foreground">{formatDuration(pt.durationMs)}</span>
                            </div>
                            <div className="border-t border-border/40 pt-1 text-[10px] text-muted-foreground/60 text-center">
                              {isHighlighted ? "Click to deselect" : "Click to highlight row ↓"}
                            </div>
                          </div>
                        );
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="pnl"
                      stroke="#22c55e"
                      strokeWidth={1.5}
                      dot={(props) => {
                        const { cx, cy, payload } = props as {
                          cx: number;
                          cy: number;
                          payload: { legId: number; delta: number };
                        };
                        const isHl = highlightedLegId === payload.legId;
                        const r = isHl ? 6 : 3;
                        const fill = payload.delta >= 0 ? "#22c55e" : "#ef4444";
                        return (
                          <circle
                            key={`dot-${payload.legId}`}
                            cx={cx}
                            cy={cy}
                            r={r}
                            fill={fill}
                            stroke={isHl ? "white" : "none"}
                            strokeWidth={isHl ? 1.5 : 0}
                          />
                        );
                      }}
                      activeDot={{ r: 6, strokeWidth: 0 }}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
                )}
              </div>
            </div>
          )}

          {/* Load more history button — only in non-live klines mode */}
          {!isLiveMode && !klinesLoading && !klinesError && chartDataFinal.length > 0 && (
            <div className="flex flex-col items-center gap-1">
              <span className="text-xs text-muted-foreground/60 font-mono">
                Loaded: {effectiveLimit} candles
              </span>
              {extraBatches < MAX_EXTRA_BATCHES && (
                <button
                  onClick={() => setExtraBatches((n) => Math.min(n + 1, MAX_EXTRA_BATCHES))}
                  disabled={klinesIsFetching}
                  data-testid="btn-load-more-history"
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded font-mono text-muted-foreground hover:text-foreground hover:bg-muted transition-colors border border-border/60 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {klinesIsFetching ? (
                    <>
                      <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
                      Loading…
                    </>
                  ) : (
                    <>
                      Load more history
                      <span className="text-muted-foreground/60">
                        (+{timeRange.limit} candles)
                      </span>
                    </>
                  )}
                </button>
              )}
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

          {/* Closed Trades — summary bar + table of closed bot legs */}
          {botId != null && (
            <ClosedLegsSection
              legs={closedLegs}
              loading={closedLegsQuery.isLoading}
              highlightedLegId={highlightedLegId}
              onClearHighlight={clearHighlight}
            />
          )}
        </div>

        {/* Trade terminal */}
        <div className={`lg:col-span-1 ${terminalCollapsed ? "hidden" : ""}`} data-testid="token-detail-terminal">
          {token ? (
            <TokenDetailPanel
              token={token}
              bot={botStatus?.bot}
              botOpenLegsCount={botStatus?.openLegsCount ?? 0}
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
