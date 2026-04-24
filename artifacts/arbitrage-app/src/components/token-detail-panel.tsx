import { useState, useEffect } from "react";
import { Link } from "wouter";
import { Zap, X, XCircle, Power, LineChart } from "lucide-react";
import {
  useCreateBot,
  useUpdateBot,
  useStartBot,
  useStopBot,
  useStopAndCloseBot,
  getListBotsQueryKey,
  getGetBotLegsQueryKey,
} from "@workspace/api-client-react";
import type { TokenSpread, BotConfig } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { useBotSecret } from "@/hooks/use-bot-secret";

const EXCHANGE_LABELS: Record<string, string> = {
  bybit: "BYBIT", binance: "BINANCE", gate: "GATE", okx: "OKX", mexc: "MEXC",
};
const EXCHANGE_COLORS_TW: Record<string, string> = {
  bybit: "text-amber-400 bg-amber-400/10",
  binance: "text-violet-400 bg-violet-400/10",
  gate: "text-sky-400 bg-sky-400/10",
  okx: "text-emerald-400 bg-emerald-400/10",
  mexc: "text-rose-400 bg-rose-400/10",
};
const EXCHANGE_TEXT_COLOR: Record<string, string> = {
  bybit: "text-amber-400",
  binance: "text-violet-400",
  gate: "text-sky-400",
  okx: "text-emerald-400",
  mexc: "text-rose-400",
};

function formatPrice(price: number | null | undefined): string {
  if (price == null) return "-";
  if (price >= 1000) return price.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (price >= 1) return price.toFixed(4);
  return price.toFixed(6);
}

function formatFunding(rate: number | null | undefined): string {
  if (rate == null) return "-";
  return (rate * 100).toFixed(4) + "%";
}

function formatPct(pct: number | null | undefined): string {
  if (pct == null) return "-";
  if (!isFinite(pct)) return "-";
  return (pct >= 0 ? "+" : "") + pct.toFixed(4) + "%";
}

export function TokenDetailPanel({
  token,
  onClose,
  bot,
  botOpenLegsCount,
}: {
  token: TokenSpread;
  onClose?: () => void;
  bot?: BotConfig;
  botOpenLegsCount: number;
}) {
  const { getBotRequestOptions } = useBotSecret();
  const botRequestOptions = getBotRequestOptions();
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

  useEffect(() => { try { localStorage.setItem("arbitrage-botExchangeA", botExchangeA); } catch {} }, [botExchangeA]);
  useEffect(() => { try { localStorage.setItem("arbitrage-botExchangeB", botExchangeB); } catch {} }, [botExchangeB]);
  useEffect(() => { try { localStorage.setItem("arbitrage-botLeverageA", botLeverageA); } catch {} }, [botLeverageA]);
  useEffect(() => { try { localStorage.setItem("arbitrage-botLeverageB", botLeverageB); } catch {} }, [botLeverageB]);

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
            <span className={`text-xs font-semibold px-2 py-0.5 rounded ${EXCHANGE_COLORS_TW.bybit}`}>
              BYBIT {token.binancePrice != null ? (token.bybitPrice > token.binancePrice ? "↑" : "↓") : ""}
            </span>
          )}
          {token.binancePrice != null && (
            <span className={`text-xs font-semibold px-2 py-0.5 rounded ${EXCHANGE_COLORS_TW.binance}`}>
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
        <div className="flex items-center gap-1 ml-2 shrink-0">
          <Link
            href={`/token/${token.symbol}`}
            className="flex items-center gap-1 px-2 py-1 rounded text-[11px] font-mono font-semibold border border-border/60 text-muted-foreground hover:text-primary hover:border-primary/40 transition-colors"
            data-testid="btn-view-chart"
          >
            <LineChart className="w-3 h-3" />
            View Chart
          </Link>
          {onClose && (
            <button onClick={onClose} className="text-muted-foreground hover:text-foreground p-1 shrink-0" data-testid="btn-close-detail">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      <div className="space-y-3">
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
                <option key={ex} value={ex} disabled={ex === botExchangeB}>{EXCHANGE_LABELS[ex]}</option>
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
                <option key={ex} value={ex} disabled={ex === botExchangeA}>{EXCHANGE_LABELS[ex]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Leverage A</label>
            <div className="flex gap-1 items-center">
              <Input value={botLeverageA} onChange={(e) => setBotLeverageA(e.target.value)} className="font-mono text-sm bg-background" data-testid="input-bot-leverage-a" />
              <span className="text-xs text-muted-foreground">x</span>
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Leverage B</label>
            <div className="flex gap-1 items-center">
              <Input value={botLeverageB} onChange={(e) => setBotLeverageB(e.target.value)} className="font-mono text-sm bg-background" data-testid="input-bot-leverage-b" />
              <span className="text-xs text-muted-foreground">x</span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Enter Spread %</label>
            <Input value={botEnterSpread} onChange={(e) => setBotEnterSpread(e.target.value)} className="font-mono text-sm bg-background" data-testid="input-bot-enter-spread" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Take Profit %</label>
            <Input value={botCloseSpread} onChange={(e) => setBotCloseSpread(e.target.value)} className="font-mono text-sm bg-background" data-testid="input-bot-close-spread" />
          </div>
          <div className="col-span-2">
            <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">
              Stop Loss % <span className="normal-case text-muted-foreground/60">(0 = disabled)</span>
            </label>
            <Input value={botStopLossSpread} onChange={(e) => setBotStopLossSpread(e.target.value)} className="font-mono text-sm bg-background" data-testid="input-bot-stop-loss-spread" placeholder="e.g. 0.8" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Order Size $</label>
            <Input value={botOrderSize} onChange={(e) => setBotOrderSize(e.target.value)} className="font-mono text-sm bg-background" data-testid="input-bot-order-size" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Max Orders</label>
            <Input value={botMaxOrders} onChange={(e) => setBotMaxOrders(e.target.value)} className="font-mono text-sm bg-background" data-testid="input-bot-max-orders" />
          </div>
          <div className="col-span-2">
            <label className="text-xs text-muted-foreground uppercase tracking-wider mb-1 block">Force Stop (loss $)</label>
            <Input value={botForceStop} onChange={(e) => setBotForceStop(e.target.value)} className="font-mono text-sm bg-background" data-testid="input-bot-force-stop" />
          </div>
        </div>

        {bot?.enabled ? (
          <div className="flex flex-col gap-1.5">
            <Button onClick={handleBotStopAndClose} disabled={botBusy} variant="destructive" className="w-full" size="sm" data-testid="btn-bot-stop-and-close">
              {botBusy ? (
                <span className="flex items-center gap-2"><span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin" />Processing…</span>
              ) : (
                <span className="flex items-center gap-2"><XCircle className="w-3.5 h-3.5" />STOP & CLOSE ALL</span>
              )}
            </Button>
            <Button onClick={handleBotStop} disabled={botBusy} variant="outline" className="w-full text-xs" size="sm" data-testid="btn-bot-stop">
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
          { label: "Spread",  bybit: (token.bybitPrice != null && token.binancePrice != null && isFinite(token.spreadPct)) ? formatPct(token.spreadPct) : "-", binance: "-" },
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

      {/* Cross-exchange spread matrix */}
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

        const bestAbs = Math.max(...pairs.map(p => Math.abs(p.spread)));

        return (
          <div className="border border-border rounded overflow-hidden">
            <div className="bg-muted text-xs px-2 py-1.5 font-semibold uppercase tracking-wider text-muted-foreground">
              All spreads
            </div>
            {pairs.map(({ exA, exB, spread }, i) => {
              const labelA = EXCHANGE_LABELS[exA] ?? exA.toUpperCase();
              const labelB = EXCHANGE_LABELS[exB] ?? exB.toUpperCase();
              const colorA = EXCHANGE_TEXT_COLOR[exA] ?? "text-muted-foreground";
              const colorB = EXCHANGE_TEXT_COLOR[exB] ?? "text-muted-foreground";
              const isBest = Math.abs(spread) === bestAbs;
              const color = Math.abs(spread) >= 1 ? "text-primary" : Math.abs(spread) >= 0.3 ? "text-amber-400" : "text-muted-foreground";
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
