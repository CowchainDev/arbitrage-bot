import { Link } from "wouter";
import { Settings, LayoutDashboard, Activity } from "lucide-react";
import { useApiCredentials } from "@/hooks/use-api-credentials";
import { useGetExchangeBalances, getGetExchangeBalancesQueryKey } from "@workspace/api-client-react";

function HeaderBalances() {
  const { getRequestHeaders, hasCredentials } = useApiCredentials();
  const requestHeaders = getRequestHeaders();

  const balancesQuery = useGetExchangeBalances({
    query: {
      refetchInterval: 5000,
      queryKey: getGetExchangeBalancesQueryKey(),
      enabled: hasCredentials,
    },
    request: requestHeaders ?? undefined,
  });

  if (!hasCredentials || !balancesQuery.data) {
    if (!hasCredentials) {
      return (
        <div className="text-destructive font-medium bg-destructive/10 px-3 py-1 rounded text-xs">
          API Keys missing. Configuration required.
        </div>
      );
    }
    return null;
  }

  const { bybit, binance, bybitPnl, binancePnl } = balancesQuery.data;

  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1.5 bg-card border border-amber-500/20 rounded px-2.5 py-1 text-xs">
        <div className="w-1.5 h-1.5 rounded-full bg-amber-400" />
        <span className="text-muted-foreground">BB</span>
        <span className="font-mono font-semibold">${bybit.toFixed(2)}</span>
        <span className={`font-mono ${(bybitPnl ?? 0) >= 0 ? "text-primary" : "text-destructive"}`}>
          {(bybitPnl ?? 0) >= 0 ? "+" : ""}${(bybitPnl ?? 0).toFixed(2)}
        </span>
      </div>
      <div className="flex items-center gap-1.5 bg-card border border-violet-500/20 rounded px-2.5 py-1 text-xs">
        <div className="w-1.5 h-1.5 rounded-full bg-violet-400" />
        <span className="text-muted-foreground">BN</span>
        <span className="font-mono font-semibold">${binance.toFixed(2)}</span>
        <span className={`font-mono ${(binancePnl ?? 0) >= 0 ? "text-primary" : "text-destructive"}`}>
          {(binancePnl ?? 0) >= 0 ? "+" : ""}${(binancePnl ?? 0).toFixed(2)}
        </span>
      </div>
    </div>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col font-mono text-sm">
      <header className="h-14 border-b border-border bg-card flex items-center justify-between px-4 sticky top-0 z-50">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 font-bold text-base">
            <Activity className="w-5 h-5 text-primary" />
            <span>ARB_TERM</span>
          </div>
          <nav className="flex items-center gap-2 ml-4">
            <Link href="/" className="px-3 py-1.5 rounded hover:bg-muted transition-colors flex items-center gap-2 text-muted-foreground hover:text-foreground">
              <LayoutDashboard className="w-4 h-4" />
              Dashboard
            </Link>
            <Link href="/settings" className="px-3 py-1.5 rounded hover:bg-muted transition-colors flex items-center gap-2 text-muted-foreground hover:text-foreground">
              <Settings className="w-4 h-4" />
              Settings
            </Link>
          </nav>
        </div>
        <HeaderBalances />
      </header>
      <main className="flex-1 overflow-auto p-4">
        {children}
      </main>
    </div>
  );
}
