import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Bot, Power, TrendingUp, TrendingDown, Layers } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useBots } from "@/hooks/use-bots";
import { useApiCredentials } from "@/hooks/use-api-credentials";
import {
  useStartBot,
  useStopBot,
  getListBotsQueryKey,
} from "@workspace/api-client-react";
import type { BotConfig } from "@workspace/api-client-react";

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

function BotCard({ bot, legsCount }: { bot: BotConfig; legsCount: number }) {
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { getRequestHeaders } = useApiCredentials();
  const requestOptions = getRequestHeaders() ?? undefined;

  const startMutation = useStartBot({ request: requestOptions });
  const stopMutation = useStopBot({ request: requestOptions });

  const handleStart = async () => {
    setBusy(true);
    try {
      await startMutation.mutateAsync({ id: bot.id });
      await queryClient.invalidateQueries({ queryKey: getListBotsQueryKey() });
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
      await queryClient.invalidateQueries({ queryKey: getListBotsQueryKey() });
      toast({ title: "Bot stopped", description: `${bot.symbol} bot will no longer open new legs` });
    } catch (err) {
      toast({ title: "Failed to stop bot", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-card border border-border rounded-lg p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="font-bold text-base tracking-wider">{bot.symbol}</span>
        <StatusBadge bot={bot} legsCount={legsCount} />
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Enter spread</span>
          <span className="font-mono">{bot.enterSpreadPct}%</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-muted-foreground">Close spread</span>
          <span className="font-mono">{bot.closeSpreadPct}%</span>
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
          <span className="font-mono">{legsCount}</span>
        </div>
      </div>

      {bot.enabled ? (
        <Button
          variant="destructive"
          size="sm"
          className="w-full"
          disabled={busy}
          onClick={handleStop}
        >
          {busy ? (
            <span className="flex items-center gap-2">
              <span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />
              Stopping…
            </span>
          ) : (
            <span className="flex items-center gap-2">
              <Power className="w-3.5 h-3.5" />
              STOP BOT
            </span>
          )}
        </Button>
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
        <h1 className="text-lg font-bold tracking-wider">Bots</h1>
      </div>

      {/* Summary strip */}
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
                legsCount={status?.openLegsCount ?? 0}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
