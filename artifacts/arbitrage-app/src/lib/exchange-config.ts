export interface ExchangeInfo {
  name: string;
  logoPath: string;
}

export const EXCHANGE_CONFIG: Record<string, ExchangeInfo> = {
  bybit:   { name: "Bybit",   logoPath: "/exchanges/bybit.svg" },
  binance: { name: "Binance", logoPath: "/exchanges/binance.svg" },
  gate:    { name: "Gate",    logoPath: "/exchanges/gate.svg" },
  okx:     { name: "OKX",     logoPath: "/exchanges/okx.svg" },
  mexc:    { name: "MEXC",    logoPath: "/exchanges/mexc.svg" },
};

export function getExchangeName(key: string): string {
  return EXCHANGE_CONFIG[key]?.name ?? key.toUpperCase();
}

export function getExchangeLogoPath(key: string): string {
  return EXCHANGE_CONFIG[key]?.logoPath ?? "";
}
