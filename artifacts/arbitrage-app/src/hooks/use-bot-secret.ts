import { useState, useCallback } from "react";

const STORAGE_KEY = "bot_secret";

export function useBotSecret() {
  const [botSecret, setBotSecretState] = useState<string>(() => {
    try { return localStorage.getItem(STORAGE_KEY) ?? ""; } catch { return ""; }
  });

  const saveBotSecret = useCallback((secret: string | null) => {
    const val = secret ?? "";
    try {
      if (val) {
        localStorage.setItem(STORAGE_KEY, val);
      } else {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch {}
    setBotSecretState(val);
  }, []);

  const getBotRequestOptions = useCallback((): RequestInit => {
    if (!botSecret) return {};
    return { headers: { "x-bot-secret": botSecret } };
  }, [botSecret]);

  return { botSecret, saveBotSecret, getBotRequestOptions };
}
