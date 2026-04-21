import { useState, useEffect, useRef, useCallback } from "react";
import type { TokenSpread } from "@workspace/api-client-react";

export type StreamStatus = "connecting" | "open" | "closed" | "error";

interface UsePriceStreamResult {
  tokens: TokenSpread[];
  isDemoData: boolean;
  streamStatus: StreamStatus;
  isFetching: boolean;
}

function getWsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/ws/prices`;
}

export function usePriceStream(): UsePriceStreamResult {
  const [tokens, setTokens] = useState<TokenSpread[]>([]);
  const [streamStatus, setStreamStatus] = useState<StreamStatus>("connecting");
  const [isFetching, setIsFetching] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const reconnectAttemptsRef = useRef(0);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;

    try {
      const ws = new WebSocket(getWsUrl());
      wsRef.current = ws;
      setStreamStatus("connecting");
      setIsFetching(true);

      ws.onopen = () => {
        if (!mountedRef.current) { ws.close(); return; }
        setStreamStatus("open");
        reconnectAttemptsRef.current = 0;
      };

      ws.onmessage = (event: MessageEvent) => {
        if (!mountedRef.current) return;
        try {
          const data = JSON.parse(event.data as string) as TokenSpread[];
          setTokens(data);
          setIsFetching(false);
        } catch {
        }
      };

      ws.onerror = () => {
        if (!mountedRef.current) return;
        setStreamStatus("error");
        setIsFetching(false);
      };

      ws.onclose = () => {
        if (!mountedRef.current) return;
        setStreamStatus("closed");
        setIsFetching(false);
        wsRef.current = null;

        const attempts = reconnectAttemptsRef.current;
        const delay = Math.min(1000 * Math.pow(2, attempts), 30000);
        reconnectAttemptsRef.current += 1;

        reconnectTimerRef.current = setTimeout(() => {
          if (mountedRef.current) connect();
        }, delay);
      };
    } catch {
      setStreamStatus("error");
      setIsFetching(false);
      reconnectTimerRef.current = setTimeout(() => {
        if (mountedRef.current) connect();
      }, 5000);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
      }
      if (wsRef.current) {
        wsRef.current.onclose = null;
        wsRef.current.onerror = null;
        wsRef.current.onmessage = null;
        wsRef.current.close();
      }
    };
  }, [connect]);

  const isDemoData = tokens.length > 0 && tokens[0].demo === true;

  return { tokens, isDemoData, streamStatus, isFetching };
}
