import { useState } from "react";

const STORAGE_KEY = "watchedTokens";

export interface WatchedToken {
  symbol: string;
  threshold: number;
}

function loadWatched(): WatchedToken[] {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return [];
  try {
    return JSON.parse(stored);
  } catch {
    return [];
  }
}

function saveWatched(tokens: WatchedToken[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
}

export function useWatchedTokens() {
  const [watched, setWatched] = useState<WatchedToken[]>(loadWatched);

  const isWatched = (symbol: string) => watched.some((w) => w.symbol === symbol);

  const getThreshold = (symbol: string): number => {
    const entry = watched.find((w) => w.symbol === symbol);
    return entry?.threshold ?? 0.5;
  };

  const toggleWatch = (symbol: string, threshold: number) => {
    setWatched((prev) => {
      let next: WatchedToken[];
      if (prev.some((w) => w.symbol === symbol)) {
        next = prev.filter((w) => w.symbol !== symbol);
      } else {
        next = [...prev, { symbol, threshold }];
      }
      saveWatched(next);
      return next;
    });
  };

  const updateThreshold = (symbol: string, threshold: number) => {
    setWatched((prev) => {
      const next = prev.map((w) => (w.symbol === symbol ? { ...w, threshold } : w));
      saveWatched(next);
      return next;
    });
  };

  return { watched, isWatched, getThreshold, toggleWatch, updateThreshold };
}
