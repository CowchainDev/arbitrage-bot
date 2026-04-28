import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatFee(amount: number): string {
  const abs = Math.abs(amount);
  if (abs === 0) return "0.0000";
  if (abs < 0.0001) {
    const decimals = Math.min(12, Math.max(4, Math.ceil(-Math.log10(abs)) + 1));
    return amount.toFixed(decimals);
  }
  return amount.toFixed(4);
}
