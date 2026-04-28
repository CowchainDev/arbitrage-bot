import { useState, useEffect, useRef } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Bot, Power, TrendingUp, TrendingDown, Layers, XCircle, Trash2, LineChart, Pencil, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useBots } from "@/hooks/use-bots";
import { useApiCredentials } from "@/hooks/use-api-credentials";
import {
  useStartBot,
  useStopBot,
  useStopAndCloseBot,
  useDeleteBot,
  useUpdateBot,
  useGetExchangePrices,
  useGetBotStats,
  getGetExchangePricesQueryKey,
  getGetBotStatsQueryKey,
  getListBotsQueryKey,
  getGetBotLegsQueryKey,
} from "@workspace/api-client-react";
import type { BotConfig, BotLeg } from "@workspace/api-client-react";

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

function PnlChart({ latestPnl }: { latestPnl: number | null }) {
  if (latestPnl === null) return null;
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-xs text-muted-foreground">Unrealized P&L</span>
      <span
        className="text-[13px] font-mono font-bold"
        style={{ color: latestPnl >= 0 ? "#10b981" : "#ef4444" }}
      >
        {latestPnl === 0
          ? "$0.00"
          : `${latestPnl >= 0 ? "+" : ""}$${latestPnl.toFixed(4)}`}
      </span>
    </div>
  );
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function BotCard({ bot, openLegs }: { bot: BotConfig; openLegs: BotLeg[] }) {
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [editEnterSpread, setEditEnterSpread] = useState("");
  const [editCloseSpread, setEditCloseSpread] = useState("");
  const [editStopLoss, setEditStopLoss] = useState("");
  const [editOrderSize, setEditOrderSize] = useState("");
  const [editMaxOrders, setEditMaxOrders] = useState("");
  const [editForceStop, setEditForceStop] = useState("");

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { getRequestHeaders } = useApiCredentials();
  const requestOptions = getRequestHeaders() ?? undefined;

  const startMutation = useStartBot({ request: requestOptions });
  const stopMutation = useStopBot({ request: requestOptions });
  const stopAndCloseMutation = useStopAndCloseBot({ request: requestOptions });
  const deleteMutation = useDeleteBot({ request: requestOptions });
  const updateMutation = useUpdateBot({ request: requestOptions });

  const enterEditMode = () => {
    setEditEnterSpread(String(bot.enterSpreadPct));
    setEditCloseSpread(String(bot.closeSpreadPct));
    setEditStopLoss(String(bot.stopLossSpreadPct));
    setEditOrderSize(String(bot.orderSizeUsd));
    setEditMaxOrders(String(bot.maxOrders));
    setEditForceStop(String(bot.forceStopUsd));
    setEditError(null);
    setIsEditing(true);
  };

  const cancelEdit = () => {
    setIsEditing(false);
    setEditError(null);
  };

  const saveEdit = async () => {
    const enterSpread = Number(editEnterSpread);
    const closeSpread = Number(editCloseSpread);
    const stopLoss = Number(editStopLoss) || 0;
    const orderSize = Number(editOrderSize);
    const maxOrders = Math.max(1, Number(editMaxOrders) || 1);
    const forceStop = Number(editForceStop) || 0;
    if (!enterSpread || !closeSpread || !orderSize) {
      setEditError("Enter spread, take profit, and order size are required.");
      return;
    }
    setEditSaving(true);
    setEditError(null);
    try {
      await updateMutation.mutateAsync({
        id: bot.id,
        data: {
          enterSpreadPct: enterSpread,
          closeSpreadPct: closeSpread,
          stopLossSpreadPct: stopLoss,
          orderSizeUsd: orderSize,
          maxOrders,
          forceStopUsd: forceStop,
          exchangeA: bot.exchangeA,
          exchangeB: bot.exchangeB,
          leverageA: bot.leverageA,
          leverageB: bot.leverageB,
        },
      });
      await queryClient.invalidateQueries({ queryKey: getListBotsQueryKey() });
      setIsEditing(false);
      toast({ title: "Settings saved", description: `${bot.symbol} bot updated` });
    } catch (err) {
      setEditError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setEditSaving(false);
    }
  };

  const statsQuery = useGetBotStats(bot.id, {
    query: { refetchInterval: 2000, staleTime: 0, queryKey: getGetBotStatsQueryKey(bot.id) },
    request: requestOptions,
  });
  const stats = statsQuery.data;

  const pricesQuery = useGetExchangePrices({
    query: { refetchInterval: 2000, staleTime: 0, queryKey: getGetExchangePricesQueryKey() },
    request: requestOptions,
  });
  const priceData = pricesQuery.data?.find((p) => p.symbol === bot.symbol);

  const latestPnl = (() => {
    if (!bot.enabled || openLegs.length === 0 || !priceData) return null;
    const prices = priceData as unknown as Record<string, number | null>;
    const exaPrice = prices[`${bot.exchangeA}Price`];
    const exbPrice = prices[`${bot.exchangeB}Price`];
    if (!exaPrice || !exbPrice) return null;
    let total = 0;
    for (const leg of openLegs) {
      const pnlA =
        leg.bybitSide === "long"
          ? (exaPrice - (leg.bybitEntry ?? exaPrice)) * (leg.bybitQty ?? 0)
          : ((leg.bybitEntry ?? exaPrice) - exaPrice) * (leg.bybitQty ?? 0);
      const pnlB =
        leg.binanceSide === "long"
          ? (exbPrice - (leg.binanceEntry ?? exbPrice)) * (leg.binanceQty ?? 0)
          : ((leg.binanceEntry ?? exbPrice) - exbPrice) * (leg.binanceQty ?? 0);
      total += pnlA + pnlB;
    }
    return total;
  })();

  const prevOpenLegsCount = useRef(openLegs.length);

  useEffect(() => {
    const prev = prevOpenLegsCount.current;
    prevOpenLegsCount.current = openLegs.length;
    if (openLegs.length < prev) {
      queryClient.invalidateQueries({ queryKey: getGetBotStatsQueryKey(bot.id) });
    }
  }, [openLegs.length, queryClient, bot.id]);

  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: getListBotsQueryKey() });
    await queryClient.invalidateQueries({ queryKey: getGetBotLegsQueryKey(bot.id) });
    await queryClient.invalidateQueries({ queryKey: getGetBotStatsQueryKey(bot.id) });
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

  const showChart = latestPnl !== null;

  return (
    <div className="bg-card border border-border rounded-lg p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="font-bold text-base tracking-wider">{bot.symbol}</span>
        <div className="flex items-center gap-1.5">
          <StatusBadge bot={bot} legsCount={openLegs.length} />
          {!isEditing && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
              onClick={enterEditMode}
              title="Edit settings"
            >
              <Pencil className="w-3.5 h-3.5" />
            </Button>
          )}
          {!bot.enabled && !isEditing && (
            confirmDelete ? (
              <div className="flex items-center gap-1">
                <Button size="sm" variant="destructive" className="h-6 px-2 text-xs" disabled={busy} onClick={handleDelete}>
                  Confirm
                </Button>
                <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setConfirmDelete(false)}>
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

      {isEditing ? (
        <div className="flex flex-col gap-2">
          <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
            <div className="flex flex-col gap-1">
              <label className="text-muted-foreground">Enter spread %</label>
              <Input
                type="number"
                step="0.01"
                className="h-7 text-xs font-mono px-2"
                value={editEnterSpread}
                onChange={(e) => setEditEnterSpread(e.target.value)}
                placeholder="e.g. 0.5"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-muted-foreground">Take profit %</label>
              <Input
                type="number"
                step="0.01"
                className="h-7 text-xs font-mono px-2"
                value={editCloseSpread}
                onChange={(e) => setEditCloseSpread(e.target.value)}
                placeholder="e.g. 0.1"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-muted-foreground">Stop loss % (0=off)</label>
              <Input
                type="number"
                step="0.01"
                className="h-7 text-xs font-mono px-2"
                value={editStopLoss}
                onChange={(e) => setEditStopLoss(e.target.value)}
                placeholder="0"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-muted-foreground">Order size $</label>
              <Input
                type="number"
                step="1"
                className="h-7 text-xs font-mono px-2"
                value={editOrderSize}
                onChange={(e) => setEditOrderSize(e.target.value)}
                placeholder="e.g. 50"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-muted-foreground">Max orders</label>
              <Input
                type="number"
                step="1"
                min="1"
                className="h-7 text-xs font-mono px-2"
                value={editMaxOrders}
                onChange={(e) => setEditMaxOrders(e.target.value)}
                placeholder="e.g. 3"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-muted-foreground">Force stop $</label>
              <Input
                type="number"
                step="1"
                className="h-7 text-xs font-mono px-2"
                value={editForceStop}
                onChange={(e) => setEditForceStop(e.target.value)}
                placeholder="0"
              />
            </div>
          </div>
          {editError && <p className="text-xs text-destructive">{editError}</p>}
          <div className="flex gap-2 pt-1">
            <Button
              size="sm"
              className="flex-1 h-7 text-xs bg-emerald-600 hover:bg-emerald-500 text-white"
              disabled={editSaving}
              onClick={saveEdit}
            >
              {editSaving ? (
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
                  Saving…
                </span>
              ) : (
                <span className="flex items-center gap-1.5">
                  <Check className="w-3 h-3" />
                  Save
                </span>
              )}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="flex-1 h-7 text-xs"
              disabled={editSaving}
              onClick={cancelEdit}
            >
              <X className="w-3 h-3 mr-1" />
              Cancel
            </Button>
          </div>
        </div>
      ) : (
      <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
        <div className="flex items-center justify-between col-span-2">
          <span className="text-muted-foreground">Exchanges</span>
          <span className="text-[13px] font-mono">{capitalize(bot.exchangeA)} ↔ {capitalize(bot.exchangeB)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Leverage</span>
          <span className="text-[13px] font-mono">
            {bot.leverageA === bot.leverageB
              ? `${bot.leverageA}x`
              : `${capitalize(bot.exchangeA)} ${bot.leverageA}x / ${capitalize(bot.exchangeB)} ${bot.leverageB}x`}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Open legs</span>
          <span className="text-[13px] font-mono">{openLegs.length}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Enter spread</span>
          <span className="text-[13px] font-mono">{bot.enterSpreadPct}%</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Take profit</span>
          <span className="text-[13px] font-mono">{bot.closeSpreadPct}%</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Stop loss</span>
          <span className="text-[13px] font-mono">
            {bot.stopLossSpreadPct > 0 ? `${bot.stopLossSpreadPct}%` : <span className="text-muted-foreground/50">off</span>}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Order size</span>
          <span className="text-[13px] font-mono">${bot.orderSizeUsd}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Max orders</span>
          <span className="text-[13px] font-mono">{bot.maxOrders}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Force stop</span>
          <span className="text-[13px] font-mono">${bot.forceStopUsd}</span>
        </div>
      </div>
      )}

      <div className="border-t border-border pt-2 flex flex-col gap-1.5 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Realized P&L</span>
          {stats ? (
            <span
              className="text-[13px] font-mono font-bold"
              style={{ color: stats.totalRealizedPnlUsd >= 0 ? "#10b981" : "#ef4444" }}
            >
              {stats.totalRealizedPnlUsd >= 0 ? "+" : ""}${stats.totalRealizedPnlUsd.toFixed(2)}
            </span>
          ) : (
            <span className="text-muted-foreground/40 font-mono">—</span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Avg entry</span>
            <span className="text-[13px] font-mono">
              {stats ? `${stats.avgEntrySpread.toFixed(4)}%` : <span className="text-muted-foreground/40">—</span>}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Avg exit</span>
            <span className="text-[13px] font-mono">
              {stats ? `${stats.avgExitSpread.toFixed(4)}%` : <span className="text-muted-foreground/40">—</span>}
            </span>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Volume traded</span>
          <span className="text-[13px] font-mono">
            {stats
              ? stats.totalVolumeUsd >= 1000
                ? `$${(stats.totalVolumeUsd / 1000).toFixed(2)}k`
                : `$${stats.totalVolumeUsd.toFixed(2)}`
              : <span className="text-muted-foreground/40">—</span>}
          </span>
        </div>
        <div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Closed legs</span>
            <span className="text-[13px] font-mono">
              {stats ? stats.closedLegCount : <span className="text-muted-foreground/40">—</span>}
            </span>
          </div>
          {stats && Object.keys(stats.closedLegsByPair).length > 0 && (
            <div className="mt-1 flex flex-col gap-0.5">
              {Object.entries(stats.closedLegsByPair).map(([pair, count]) => (
                <div key={pair} className="flex items-center justify-between pl-3 text-[11px]">
                  <span className="text-muted-foreground/70">{pair}</span>
                  <span className="font-mono text-muted-foreground/70">{count}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {showChart && <PnlChart latestPnl={latestPnl} />}

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
          <Link
            href={`/token/${bot.symbol}`}
            className="inline-flex items-center justify-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mt-0.5"
          >
            <LineChart className="w-3 h-3" />
            Open Chart
          </Link>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
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
          <Link
            href={`/token/${bot.symbol}`}
            className="inline-flex items-center justify-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors mt-0.5"
          >
            <LineChart className="w-3 h-3" />
            Open Chart
          </Link>
        </div>
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
          <p className="text-xs opacity-60">Open a token on the Dashboard, configure your bot settings, and click JUMP IN.</p>
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
