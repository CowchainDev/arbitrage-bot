import { EventEmitter } from "events";

export type BotEvent =
  | { kind: "leg_opened"; symbol: string; exchangeA: string; sideA: string; exchangeB: string; sideB: string; spreadPct: number; usdAmount: number }
  | { kind: "leg_closed"; symbol: string; legId: number; realizedPnl: number; totalFees: number; trigger: string }
  | { kind: "leg_open_failed"; symbol: string; exchange: string; message: string }
  | { kind: "order_too_small"; symbol: string }
  | { kind: "compensation_failed"; symbol: string; exchange: string }
  | { kind: "force_stop"; symbol: string; totalPnl: number }
  | { kind: "credential_error"; exchange: string; message: string };

export type NotificationWsMessage = { type: "bot_event"; event: BotEvent; ts: number };

class BotEventBus extends EventEmitter {
  emitBotEvent(event: BotEvent): void {
    this.emit("bot_event", event);
  }
  onBotEvent(listener: (event: BotEvent) => void): this {
    return this.on("bot_event", listener);
  }
  offBotEvent(listener: (event: BotEvent) => void): this {
    return this.off("bot_event", listener);
  }
}

export const botEventBus = new BotEventBus();
