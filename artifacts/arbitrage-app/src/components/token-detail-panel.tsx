import { useState, useEffect } from "react";
import { Link } from "wouter";
import { Zap, X, XCircle, Power, LineChart, AlertTriangle } from "lucide-react";
import {
  useCreateBot,
  useUpdateBot,
  useStartBot,
  useStopBot,
  useStopAndCloseBot,
  useGetCredentialStatus,
  getListBotsQueryKey,
  getGetBotLegsQueryKey,
} from "@workspace/api-client-react";
import type { TokenSpread, BotConfig } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { useBotSecret } from "@/hooks/use-bot-secret";
import { getExchangeName } from "@/lib/exchange-config";

function getExchangeTokenData(token: TokenSpread, exchange: string) {
  switch (exchange) {
    case "bybit":   return { price: token.bybitPrice,   bid: token.bybitBid,   ask: token.bybitAsk,   fundingRate: token.bybitFundingRate,   nextFunding: token.bybitNextFunding   ?? null };
    case "binance": return { price: token.binancePrice, bid: token.binanceBid, ask: token.binanceAsk, fundingRate: token.binanceFundingRate, nextFunding: token.binanceNextFunding ?? null };
    case "gate":    return { price: token.gatePrice,    bid: token.gateBid,    ask: token.gateAsk,    fundingRate: token.gateFundingRate,    nextFunding: null };
    case "okx":     return { price: token.okxPrice,     bid: token.okxBid,     ask: token.okxAsk,     fundingRate: token.okxFundingRate,     nextFunding: null };
    case "mexc":    return { price: token.mexcPrice,    bid: token.mexcBid,    ask: token.mexcAsk,    fundingRate: token.mexcFundingRate,    nextFunding: null };
    case "aster":   return { price: token.asterPrice,   bid: token.asterBid,   ask: token.asterAsk,   fundingRate: token.asterFundingRate,   nextFunding: null };
    default:        return { price: null, bid: null, ask: null, fundingRate: null, nextFunding: null };
  }
}

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

  // Check which exchanges have credentials synced to the server
  const { data: credentialStatus, isLoading: credStatusLoading } = useGetCredentialStatus({ request: botRequestOptions });
  const serverSyncedExchanges = new Set(credentialStatus?.exchanges.map((e) => e.exchange) ?? []);
  const [botEnterSpread, setBotEnterSpread] = useState(() => {
    if (bot) return String(bot.enterSpreadPct);
    try { return localStorage.getItem("arbitrage-botEnterSpread") ?? "0.5"; } catch { return "0.5"; }
  });
  const [botCloseSpread, setBotCloseSpread] = useState(() => {
    if (bot) return String(bot.closeSpreadPct);
    try { return localStorage.getItem("arbitrage-botCloseSpread") ?? "0.2"; } catch { return "0.2"; }
  });
  const [botStopLossSpread, setBotStopLossSpread] = useState(() => bot ? String(bot.stopLossSpreadPct ?? 0) : "0");
  const [botOrderSize, setBotOrderSize] = useState(() => {
    if (bot) return String(bot.orderSizeUsd);
    try { return localStorage.getItem("arbitrage-botOrderSize") ?? "10"; } catch { return "10"; }
  });
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
      try { setBotEnterSpread(localStorage.getItem("arbitrage-botEnterSpread") ?? "0.5"); } catch { setBotEnterSpread("0.5"); }
      try { setBotCloseSpread(localStorage.getItem("arbitrage-botCloseSpread") ?? "0.2"); } catch { setBotCloseSpread("0.2"); }
      try { setBotOrderSize(localStorage.getItem("arbitrage-botOrderSize") ?? "10"); } catch { setBotOrderSize("10"); }
      setBotMaxOrders("3");
      setBotForceStop("50");
      if (token.bestSpreadLeg) {
        const parts = token.bestSpreadLeg.split("/");
        if (parts.length === 2) {
          setBotExchangeA(parts[0]);
          setBotExchangeB(parts[1]);
        }
      }
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
  useEffect(() => { try { localStorage.setItem("arbitrage-botEnterSpread", botEnterSpread); } catch {} }, [botEnterSpread]);
  useEffect(() => { try { localStorage.setItem("arbitrage-botCloseSpread", botCloseSpread); } catch {} }, [botCloseSpread]);
  useEffect(() => { try { localStorage.setItem("arbitrage-botOrderSize", botOrderSize); } catch {} }, [botOrderSize]);

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
            exchangeA: botExchangeA,
            exchangeB: botExchangeB,
            leverageA: Number(botLeverageA) || 1,
            leverageB: Number(botLeverageB) || 1,
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
          {(() => {
            const dA = getExchangeTokenData(token, botExchangeA);
            const dB = getExchangeTokenData(token, botExchangeB);
            return (
              <>
                {dA.price != null && (
                  <span className="text-xs font-semibold px-2 py-0.5 rounded bg-muted text-muted-foreground">
                    {getExchangeName(botExchangeA)}{dB.price != null ? (dA.price > dB.price ? " ↑" : " ↓") : ""}
                  </span>
                )}
                {dB.price != null && (
                  <span className="text-xs font-semibold px-2 py-0.5 rounded bg-muted text-muted-foreground">
                    {getExchangeName(botExchangeB)}{dA.price != null ? (dB.price > dA.price ? " ↑" : " ↓") : ""}
                  </span>
                )}
              </>
            );
          })()}
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
              {["bybit", "binance", "gate", "okx", "mexc", "aster"].map((ex) => (
                <option key={ex} value={ex} disabled={ex === botExchangeB}>{getExchangeName(ex)}</option>
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
              {["bybit", "binance", "gate", "okx", "mexc", "aster"].map((ex) => (
                <option key={ex} value={ex} disabled={ex === botExchangeA}>{getExchangeName(ex)}</option>
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
            {(() => {
              const credStatusKnown = !credStatusLoading && credentialStatus !== undefined;
              const missingServerCreds = credStatusKnown
                ? [botExchangeA, botExchangeB].filter((ex) => !serverSyncedExchanges.has(ex))
                : [];
              const missingLabels = missingServerCreds.map((ex) => getExchangeName(ex));
              const credsMissing = missingServerCreds.length > 0;
              return (
                <>
                  {credsMissing && (
                    <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2.5" data-testid="credentials-warning-banner">
                      <AlertTriangle className="w-3.5 h-3.5 text-destructive mt-0.5 shrink-0" />
                      <p className="text-xs text-destructive leading-snug">
                        <span className="font-semibold">{missingLabels.join(" & ")} credentials not synced to server.</span>{" "}
                        Go to{" "}
                        <Link href="/settings" className="underline hover:text-destructive/80 font-semibold">Settings</Link>
                        {" "}and re-save your API keys so the bot can trade on your behalf.
                      </p>
                    </div>
                  )}
                  <Button
                    onClick={handleBotStart}
                    disabled={botBusy || credsMissing}
                    className="w-full bg-primary text-primary-foreground hover:bg-primary/90 font-bold text-sm py-5 tracking-wider"
                    data-testid="btn-bot-start"
                    title={credsMissing ? `Credentials not synced: ${missingLabels.join(", ")}` : undefined}
                  >
                    {botBusy ? (
                      <span className="flex items-center gap-2">
                        <span className="w-3 h-3 border border-primary-foreground border-t-transparent rounded-full animate-spin" />
                        STARTING…
                      </span>
                    ) : credsMissing ? (
                      <span className="flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4" />
                        CREDENTIALS NOT SYNCED
                      </span>
                    ) : (
                      <span className="flex items-center gap-2">
                        <Zap className="w-4 h-4" />
                        JUMP IN
                      </span>
                    )}
                  </Button>
                </>
              );
            })()}
          </>
        )}
      </div>

      {/* Selected exchange pair price matrix — updates when Exchange A / B dropdowns change */}
      {(() => {
        const exAData = getExchangeTokenData(token, botExchangeA);
        const exBData = getExchangeTokenData(token, botExchangeB);
        const labelA = getExchangeName(botExchangeA);
        const labelB = getExchangeName(botExchangeB);
        const spreadVal =
          exAData.price != null && exBData.price != null && exBData.price !== 0
            ? ((exAData.price - exBData.price) / exBData.price) * 100
            : null;
        const rows = [
          { label: "Price",   a: formatPrice(exAData.price),   b: formatPrice(exBData.price) },
          { label: "Bid",     a: formatPrice(exAData.bid),     b: formatPrice(exBData.bid) },
          { label: "Ask",     a: formatPrice(exAData.ask),     b: formatPrice(exBData.ask) },
          { label: "Funding", a: formatFunding(exAData.fundingRate), b: formatFunding(exBData.fundingRate) },
          { label: "Next FR", a: exAData.nextFunding ? new Date(exAData.nextFunding).toLocaleTimeString() : "-", b: exBData.nextFunding ? new Date(exBData.nextFunding).toLocaleTimeString() : "-" },
          { label: "Spread",  a: spreadVal != null && isFinite(spreadVal) ? formatPct(spreadVal) : "-", b: "-" },
        ];
        return (
          <div className="border border-border rounded overflow-hidden">
            <div className="grid grid-cols-3 bg-muted text-xs px-2 py-1.5 font-semibold uppercase tracking-wider">
              <span className="text-muted-foreground"></span>
              <span className="text-muted-foreground">{labelA}</span>
              <span className="text-muted-foreground">{labelB}</span>
            </div>
            {rows.map((row, i) => (
              <div key={row.label} className={`grid grid-cols-3 text-xs px-2 py-1.5 ${i % 2 === 0 ? "bg-card" : "bg-background"}`}>
                <span className="text-muted-foreground">{row.label}</span>
                <span className="font-mono text-foreground">{row.a}</span>
                <span className="font-mono text-foreground">{row.b}</span>
              </div>
            ))}
          </div>
        );
      })()}

      {/* Other exchanges — shows exchanges not selected as A or B */}
      {(() => {
        const others = (["bybit", "binance", "gate", "okx", "mexc", "aster"] as const).filter((ex) => ex !== botExchangeA && ex !== botExchangeB);
        const othersWithData = others.filter((ex) => {
          const d = getExchangeTokenData(token, ex);
          return d.price != null;
        });
        if (othersWithData.length === 0) return null;
        const colCount = othersWithData.length + 1;
        return (
          <div className="border border-border rounded overflow-hidden">
            <div className="bg-muted text-xs px-2 py-1.5 font-semibold uppercase tracking-wider text-muted-foreground">
              Other exchanges
            </div>
            <div
              className="text-xs px-2 py-1 bg-muted/50 text-muted-foreground font-semibold"
              style={{ display: "grid", gridTemplateColumns: `repeat(${colCount}, minmax(0,1fr))` }}
            >
              <span></span>
              {othersWithData.map((ex) => (
                <span key={ex} className="text-muted-foreground">{getExchangeName(ex)}</span>
              ))}
            </div>
            {(["Price", "Bid", "Ask", "Funding"] as const).map((field, i) => (
              <div
                key={field}
                className={`text-xs px-2 py-1.5 ${i % 2 === 0 ? "bg-card" : "bg-background"}`}
                style={{ display: "grid", gridTemplateColumns: `repeat(${colCount}, minmax(0,1fr))` }}
              >
                <span className="text-muted-foreground">{field}</span>
                {othersWithData.map((ex) => {
                  const d = getExchangeTokenData(token, ex);
                  const val = field === "Price" ? formatPrice(d.price)
                    : field === "Bid" ? formatPrice(d.bid)
                    : field === "Ask" ? formatPrice(d.ask)
                    : formatFunding(d.fundingRate);
                  return <span key={ex} className="font-mono text-foreground">{val}</span>;
                })}
              </div>
            ))}
          </div>
        );
      })()}

      {/* Cross-exchange spread matrix */}
      {(() => {
        const allExchanges = [
          { key: "bybit",   price: token.bybitPrice   ?? null },
          { key: "binance", price: token.binancePrice ?? null },
          { key: "gate",    price: token.gatePrice    ?? null },
          { key: "okx",     price: token.okxPrice     ?? null },
          { key: "mexc",    price: token.mexcPrice    ?? null },
          { key: "aster",   price: token.asterPrice   ?? null },
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
              const labelA = getExchangeName(exA);
              const labelB = getExchangeName(exB);
              const isBest = Math.abs(spread) === bestAbs;
              const color = Math.abs(spread) >= 1 ? "text-primary" : Math.abs(spread) >= 0.3 ? "text-amber-400" : "text-muted-foreground";
              return (
                <div key={`${exA}-${exB}`} className={`grid text-xs px-2 py-1.5 items-center ${i % 2 === 0 ? "bg-card" : "bg-background"} ${isBest ? "ring-1 ring-inset ring-primary/30" : ""}`} style={{ gridTemplateColumns: "minmax(0,1fr) auto auto" }}>
                  <span className="font-semibold flex items-center gap-1 min-w-0 overflow-hidden">
                    <span className="text-muted-foreground shrink-0">{labelA}</span>
                    <span className="text-muted-foreground/50 shrink-0">/</span>
                    <span className="text-muted-foreground shrink-0">{labelB}</span>
                    {isBest && (
                      <span className="ml-1 px-1 py-px rounded text-[9px] font-bold bg-primary/20 text-primary leading-none shrink-0">BEST</span>
                    )}
                  </span>
                  <span className={`font-mono font-semibold pl-2 ${color}`}>{formatPct(spread)}</span>
                  <span className="text-muted-foreground font-mono text-[10px] pl-2">
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
