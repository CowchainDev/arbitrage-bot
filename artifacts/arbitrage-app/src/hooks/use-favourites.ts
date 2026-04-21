import { useState, useEffect } from "react";

const STORAGE_KEY = "favouriteTokens";

export function useFavourites() {
  const [favourites, setFavourites] = useState<string[]>(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        return JSON.parse(stored);
      } catch (e) {
        return [];
      }
    }
    return [];
  });

  const toggleFavourite = (symbol: string) => {
    setFavourites((prev) => {
      const newFavs = prev.includes(symbol)
        ? prev.filter((s) => s !== symbol)
        : [...prev, symbol];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newFavs));
      return newFavs;
    });
  };

  const isFavourite = (symbol: string) => favourites.includes(symbol);

  return {
    favourites,
    toggleFavourite,
    isFavourite,
  };
}