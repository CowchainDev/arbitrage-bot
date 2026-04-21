import { useState, useCallback } from "react";
import type { Position } from "@workspace/api-client-react";

const STORAGE_KEY = "arb_local_positions";

function loadFromStorage(): Position[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Position[]) : [];
  } catch {
    return [];
  }
}

function saveToStorage(positions: Position[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(positions));
  } catch {
    // ignore storage errors
  }
}

export function useLocalPositions() {
  const [localPositions, setLocalPositions] = useState<Position[]>(loadFromStorage);

  const savePosition = useCallback((position: Position) => {
    setLocalPositions((prev) => {
      const filtered = prev.filter((p) => p.symbol !== position.symbol);
      const next = [...filtered, position];
      saveToStorage(next);
      return next;
    });
  }, []);

  const removePosition = useCallback((symbol: string) => {
    setLocalPositions((prev) => {
      const next = prev.filter((p) => p.symbol !== symbol);
      saveToStorage(next);
      return next;
    });
  }, []);

  return { localPositions, savePosition, removePosition };
}
