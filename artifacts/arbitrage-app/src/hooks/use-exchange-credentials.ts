import { useState, useCallback } from "react";

export type SupportedExchange = "bybit" | "binance" | "gate" | "okx" | "mexc" | "aster" | "hyper";

export interface ExchangeCreds {
  apiKey: string;
  apiSecret: string;
  passphrase?: string;
}

function storageKey(exchange: SupportedExchange) {
  return `exchange_creds_${exchange}`;
}

function loadCreds(exchange: SupportedExchange): ExchangeCreds | null {
  try {
    const raw = localStorage.getItem(storageKey(exchange));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function useExchangeCredentials(exchange: SupportedExchange) {
  const [creds, setCreds] = useState<ExchangeCreds | null>(() => loadCreds(exchange));

  const save = useCallback((c: ExchangeCreds) => {
    localStorage.setItem(storageKey(exchange), JSON.stringify(c));
    setCreds(c);
  }, [exchange]);

  const remove = useCallback(() => {
    localStorage.removeItem(storageKey(exchange));
    setCreds(null);
  }, [exchange]);

  return { creds, save, remove, hasCreds: !!creds?.apiKey };
}
