import { useEffect, useRef } from "react";
import type { TokenSpread } from "@workspace/api-client-react";
import type { WatchedToken } from "./use-watched-tokens";
import type { AlertSettings } from "./use-alert-settings";

function playAlertSound() {
  try {
    const ctx = new AudioContext();
    const frequencies = [880, 1100, 880];
    let time = ctx.currentTime;
    frequencies.forEach((freq) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, time);
      gain.gain.setValueAtTime(0.18, time);
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.18);
      osc.start(time);
      osc.stop(time + 0.18);
      time += 0.18;
    });
  } catch (err) {
    console.warn("[spread-alerts] sound playback failed:", err);
  }
}

function sendBrowserNotification(symbol: string, spread: number, threshold: number) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    new Notification(`ARB_TERM — ${symbol} alert`, {
      body: `Spread ${spread.toFixed(4)}% crossed your ${threshold.toFixed(2)}% threshold`,
      tag: `spread-alert-${symbol}`,
      silent: true,
    });
  } catch (err) {
    console.warn("[spread-alerts] browser notification failed:", err);
  }
}

export function useSpreadAlerts(
  tokens: TokenSpread[],
  watched: WatchedToken[],
  settings: AlertSettings,
) {
  const firedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (tokens.length === 0 || watched.length === 0) return;

    watched.forEach(({ symbol, threshold }) => {
      const token = tokens.find((t) => t.symbol === symbol);
      if (!token) return;

      const spread = token.bestSpreadPct != null
        ? token.bestSpreadPct
        : Math.abs(token.spreadPct);

      const key = symbol;

      if (spread >= threshold) {
        if (!firedRef.current.has(key)) {
          firedRef.current.add(key);

          if (settings.soundEnabled) {
            playAlertSound();
          }

          if (settings.browserPushEnabled) {
            sendBrowserNotification(symbol, spread, threshold);
          }
        }
      } else {
        firedRef.current.delete(key);
      }
    });
  }, [tokens, watched, settings]);
}
