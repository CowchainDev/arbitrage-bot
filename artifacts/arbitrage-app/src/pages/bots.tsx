import { useState, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Bot, Power, TrendingUp, TrendingDown, Layers, XCircle, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useBots } from "@/hooks/use-bots";
import { useApiCredentials } from "@/hooks/use-api-credentials";
import {
  useStartBot,
  useStopBot,
  useStopAndCloseBot,
  useDeleteBot,
  useGetExchangePrices,
  getGetExchangePricesQueryKey,
  getListBotsQueryKey,
  getGetBotLegsQueryKey,
} from "@workspace/api-client-react";
import type { BotConfig, BotLeg } from "@workspace/api-client-react";
import {
  AreaChart,
  Area,
  ResponsiveContainer,
  Tooltip,
  ReferenceLine,
} from "recharts";

function StatusBadge({ bot, legsCount }: { bot: BotConfig; legsCount: number }) {
  if (!bot.enabled) {
    return (
      <span className="text-xs font-semibold px-2 py-0.5 rounded bg-muted text-muted-foreground">
        STOPPED
      </span>
    );
  }
  if (legsCount > 0) {
    return (
      <span className="text-xs font-semibold px-2 py-0.5 rounded bg-amber-400/20 text-amber-400">
        IN POSITION ({legsCount} leg{legsCount !== 1 ? "s" : ""})
      </span>
    );
  }
  return (
    <span className="text-xs font-semibold px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-400">
      RUNNING
    </span>
  );
}

interface PnlPoint {
  t: number;
  pnl: number;
}

function PnlChart({ points, latestPnl }: { points: PnlPoint[]; latestPnl: number }) {
  const isPositive = latestPnl >= 0;
  const color = isPositive ? "#10b981" : "#ef4444";

  const formatted =
    latestPnl === 0
      ? "$0.00"
      : `${latestPnl >= 0 ? "+" : ""}$${latestPnl.toFixed(4)}`;

  return (
    <div className="mt-1">
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-xs text-muted-foreground">Unrealized P&L</span>
        <span
          className="text-sm font-mono font-bold"
          style={{ color }}
        >
          {formatted}
        </span>
      </div>
      <div className="h-20">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={`pnlGrad-${isPositive}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={color} stopOpacity={0.3} />
                <stop offset="95%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <ReferenceLine y={0} stroke="#555" strokeDasharray="3 3" />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const val: number = payload[0].value as number;
                return (
                  <div className="bg-background border border-border rounded px-2 py-1 text-xs font-mono">
                    {val >= 0 ? "+" : ""}${val.toFixed(4)}
                  </div>
                );
              }}
            />
            <Area
              type="monotone"
              dataKey="pnl"
              stroke={color}
              strokeWidth={1.5}
              fill={`url(#pnlGrad-${isPositive})`}
              dot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function BotCard({ bot, openLegs }: { bot: BotConfig; openLegs: BotLeg[] }) {
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { getRequestHeaders } = useApiCredentials();
  const requestOptions = getRequestHeaders() ?? undefined;

  const startMutation = useStartBot({ request: requestOptions });
  const stopMutation = useStopBot({ request: requestOptions });
  const stopAndCloseMutation = useStopAndCloseBot({ request: requestOptions });
  const deleteMutation = useDeleteBot({ request: requestOptions });

  const pricesQuery = useGetExchangePrices({
    query: { refetchInterval: 2000, queryKey: getGetExchangePricesQueryKey() },
    request: requestOptions,
  });
  const priceData = pricesQuery.data?.find((p) => p.symbol === bot.symbol);

  const pnlHistoryRef = useRef<PnlPoint[]>([]);
  const [pnlPoints, setPnlPoints] = useState<PnlPoint[]>([]);

  const computePnl = () => {
    if (!priceData) return null;
    const { bybitPrice, binancePrice } = priceData;
    if (!bybitPrice || !binancePrice) return null;
    let total = 0;
    for (const leg of openLegs) {
      const bybitPnl =
        leg.bybitSide === "long"
          ? (bybitPrice - (leg.bybitEntry ?? bybitPrice)) * (leg.bybitQty ?? 0)
          : ((leg.bybitEntry ?? bybitPrice) - bybitPrice) * (leg.bybitQty ?? 0);
      const binancePnl =
        leg.binanceSide === "long"
          ? (binancePrice - (leg.binanceEntry ?? binancePrice)) * (leg.binanceQty ?? 0)
          : ((leg.binanceEntry ?? binancePrice) - binancePrice) * (leg.binanceQty ?? 0);
      total += bybitPnl + binancePnl;
    }
    return total;
  };

  useEffect(() => {
    if (!bot.enabled || openLegs.length === 0) {
      pnlHistoryRef.current = [];
      setPnlPoints([]);
      return;
    }
    const pnl = computePnl();
    if (pnl === null) return;
    const now = Date.now();
    const updated = [...pnlHistoryRef.current, { t: now, pnl }].slice(-120);
    pnlHistoryRef.current = updated;
    setPnlPoints(updated);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [priceData?.bybitPrice, priceData?.binancePrice, openLegs.length, bot.enabled]);

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: getListBotsQueryKey() });
    await queryClient.invalidateQueries({ queryKey: getGetBotLegsQueryKey(bot.id) });
  };

  const handleStart = async () => {
    setBusy(true);
    try {
      await startMutation.mutateAsync({ id: bot.id });
      await invalidate();
      toast({ title: "Bot started", description: `${bot.symbol} bot is now running` });
    } catch (err) {
      toast({ title: "Failed to start bot", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const handleStop = async () => {
    setBusy(true);
    try {
      await stopMutation.mutateAsync({ id: bot.id });
      await invalidate();
      toast({ title: "Bot stopped", description: `${bot.symbol} bot will no longer open new legs` });
    } catch (err) {
      toast({ title: "Failed to stop bot", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const handleStopAndClose = async () => {
    setBusy(true);
    try {
      const result = await stopAndCloseMutation.mutateAsync({ id: bot.id });
      await invalidate();
      const desc = result.failed > 0
        ? `${result.closed} leg(s) closed, ${result.failed} failed — check exchange manually`
        : `${result.closed} leg(s) closed on both exchanges`;
      toast({ title: `${bot.symbol} stopped & closed`, description: desc, variant: result.failed > 0 ? "destructive" : "default" });
    } catch (err) {
      toast({ title: "Failed to stop & close", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    setBusy(true);
    try {
      await deleteMutation.mutateAsync({ id: bot.id });
      await queryClient.invalidateQueries({ queryKey: getListBotsQueryKey() });
      toast({ title: "Automation deleted", description: `${bot.symbol} bot removed` });
    } catch (err) {
      toast({ title: "Failed to delete bot", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
      setBusy(false);
    }
  };

  const latestPnl = pnlPoints.length > 0 ? pnlPoints[pnlPoints.length - 1].pnl : 0;
  const showChart = bot.enabled && openLegs.length > 0 && pnlPoints.length > 1;

  return (
    <div className="bg-card border border-border rounded-lg p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="font-bold text-base tracking-wider">{bot.symbol}</span>
        <div className="flex items-center gap-2">
          <StatusBadge bot={bot} legsCount={openLegs.length} />
          {!bot.enabled && (
            confirmDelete ? (
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="destructive"
                  className="h-6 px-2 text-xs"
                  disabled={busy}
                  onClick={handleDelete}
                >
                  Confirm
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs"
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                onClick={() => setConfirmDelete(true)}
                title="Delete automation"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </Button>
            )
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Enter spread</span>
          <span className="font-mono">{bot.enterSpreadPct}%</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Take profit</span>
          <span className="font-mono">{bot.closeSpreadPct}%</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Stop loss</span>
          <span className="font-mono">
            {bot.stopLossSpreadPct > 0 ? `${bot.stopLossSpreadPct}%` : <span className="text-muted-foreground/50">off</span>}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Order size</span>
          <span className="font-mono">${bot.orderSizeUsd}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Max orders</span>
          <span className="font-mono">{bot.maxOrders}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Force stop</span>
          <span className="font-mono">${bot.forceStopUsd}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Open legs</span>
          <span className="font-mono">{openLegs.length}</span>
        </div>
      </div>

      {showChart && (
        <PnlChart points={pnlPoints} latestPnl={latestPnl} />
      )}

      {bot.enabled && openLegs.length > 0 && !showChart && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
          Tracking P&L…
        </div>
      )}

      {bot.enabled ? (
        <div className="flex flex-col gap-1.5">
          <Button
            variant="destructive"
            size="sm"
            className="w-full"
            disabled={busy}
            onClick={handleStopAndClose}
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
          <Button
            variant="outline"
            size="sm"
            className="w-full text-xs"
            disabled={busy}
            onClick={handleStop}
          >
            <Power className="w-3 h-3 mr-1.5" />
            Stop only (keep positions open)
          </Button>
        </div>
      ) : (
        <Button
          size="sm"
          className="w-full bg-emerald-600 hover:bg-emerald-500 text-white"
          disabled={busy}
          onClick={handleStart}
        >
          {busy ? (
            <span className="flex items-center gap-2">
              <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
              Starting…
            </span>
          ) : (
            <span className="flex items-center gap-2">
              <Power className="w-3.5 h-3.5" />
              START BOT
            </span>
          )}
        </Button>
      )}
    </div>
  );
}

export default function Bots() {
  const { bots, getBotStatusForSymbol, isLoading } = useBots();

  const running = bots.filter((b) => b.enabled).length;
  const inPosition = bots.filter((b) => {
    const s = getBotStatusForSymbol(b.symbol);
    return b.enabled && (s?.openLegsCount ?? 0) > 0;
  }).length;
  const totalLegs = bots.reduce((sum, b) => {
    return sum + (getBotStatusForSymbol(b.symbol)?.openLegsCount ?? 0);
  }, 0);

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-2">
        <Bot className="w-5 h-5 text-primary" />
        <h1 className="text-lg font-bold tracking-wider">Automations</h1>
      </div>

      {bots.length > 0 && (
        <div className="grid grid-cols-3 gap-3">
          <div className="bg-card border border-border rounded-lg px-4 py-3 flex items-center gap-3">
            <Layers className="w-4 h-4 text-muted-foreground" />
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-wider">Total</div>
              <div className="font-bold text-lg">{bots.length}</div>
            </div>
          </div>
          <div className="bg-card border border-border rounded-lg px-4 py-3 flex items-center gap-3">
            <TrendingUp className="w-4 h-4 text-emerald-400" />
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-wider">Running</div>
              <div className="font-bold text-lg text-emerald-400">{running}</div>
            </div>
          </div>
          <div className="bg-card border border-border rounded-lg px-4 py-3 flex items-center gap-3">
            <TrendingDown className="w-4 h-4 text-amber-400" />
            <div>
              <div className="text-xs text-muted-foreground uppercase tracking-wider">In Position</div>
              <div className="font-bold text-lg text-amber-400">{inPosition} <span className="text-sm font-normal text-muted-foreground">({totalLegs} legs)</span></div>
            </div>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-20 text-muted-foreground gap-2">
          <span className="w-4 h-4 border border-current border-t-transparent rounded-full animate-spin" />
          Loading bots…
        </div>
      ) : bots.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground">
          <Bot className="w-10 h-10 opacity-30" />
          <p className="text-sm">No bots configured yet.</p>
          <p className="text-xs opacity-60">Open a token on the Dashboard, configure the Auto Bot section, and click START BOT.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {bots.map((bot) => {
            const status = getBotStatusForSymbol(bot.symbol);
            return (
              <BotCard
                key={bot.id}
                bot={bot}
                openLegs={status?.openLegs ?? []}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
