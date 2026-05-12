import { useEffect, useRef, useCallback } from "react";

export type BotEvent =
  | { kind: "leg_opened"; symbol: string; exchangeA: string; sideA: string; exchangeB: string; sideB: string; spreadPct: number; usdAmount: number }
  | { kind: "leg_closed"; symbol: string; legId: number; realizedPnl: number; totalFees: number; trigger: string }
  | { kind: "leg_open_failed"; symbol: string; exchange: string; message: string }
  | { kind: "order_too_small"; symbol: string }
  | { kind: "compensation_failed"; symbol: string; exchange: string }
  | { kind: "force_stop"; symbol: string; totalPnl: number }
  | { kind: "credential_error"; exchange: string; message: string }
  | { kind: "credential_ok"; exchange: string };

export type NotificationMessage = { type: "bot_event"; event: BotEvent; ts: number };

type Handler = (msg: NotificationMessage) => void;

function getWsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/ws/notifications`;
}

export function useNotificationStream(onMessage: Handler) {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const reconnectAttemptsRef = useRef(0);
  const onMessageRef = useRef(onMessage);
  onMessageRef.current = onMessage;

  const connect = useCallback(() => {
    if (!mountedRef.current) return;
    try {
      const ws = new WebSocket(getWsUrl());
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttemptsRef.current = 0;
      };

      ws.onmessage = (event: MessageEvent) => {
        if (!mountedRef.current) return;
        try {
          const msg = JSON.parse(event.data as string) as NotificationMessage;
          if (msg.type === "bot_event") {
            onMessageRef.current(msg);
          }
        } catch { }
      };

      ws.onclose = () => {
        if (!mountedRef.current) return;
        wsRef.current = null;
        const attempts = reconnectAttemptsRef.current;
        const delay = Math.min(1000 * Math.pow(2, attempts), 30000);
        reconnectAttemptsRef.current += 1;
        reconnectTimerRef.current = setTimeout(() => {
          if (mountedRef.current) connect();
        }, delay);
      };

      ws.onerror = () => {
        reconnectTimerRef.current = setTimeout(() => {
          if (mountedRef.current) connect();
        }, 5000);
      };
    } catch { }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.onmessage = null;
        wsRef.current.close();
      }
    };
  }, [connect]);
}
