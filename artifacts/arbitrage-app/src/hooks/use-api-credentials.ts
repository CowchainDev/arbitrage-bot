import { useState, useEffect } from "react";

export interface ApiCredentials {
  bybitApiKey: string;
  bybitApiSecret: string;
  binanceApiKey: string;
  binanceApiSecret: string;
}

const STORAGE_KEY = "apiCredentials";

export function useApiCredentials() {
  const [credentials, setCredentials] = useState<ApiCredentials | null>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        return JSON.parse(stored);
      } catch (e) {
        return null;
      }
    }
    return null;
  });

  const saveCredentials = (creds: ApiCredentials) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(creds));
    setCredentials(creds);
  };

  const clearCredentials = () => {
    localStorage.removeItem(STORAGE_KEY);
    setCredentials(null);
  };

  const getRequestHeaders = () => {
    if (!credentials) return undefined;
    return {
      headers: {
        "x-bybit-api-key": credentials.bybitApiKey || "",
        "x-bybit-api-secret": credentials.bybitApiSecret || "",
        "x-binance-api-key": credentials.binanceApiKey || "",
        "x-binance-api-secret": credentials.binanceApiSecret || "",
      },
    };
  };

  return {
    credentials,
    saveCredentials,
    clearCredentials,
    getRequestHeaders,
    hasCredentials: !!credentials && !!credentials.bybitApiKey && !!credentials.binanceApiKey,
  };
}