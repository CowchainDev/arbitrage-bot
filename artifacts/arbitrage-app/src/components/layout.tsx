import { Link, useLocation } from "wouter";
import { Settings, LayoutDashboard, Activity, History, Bot, Sun, Moon } from "lucide-react";
import { useApiCredentials } from "@/hooks/use-api-credentials";
import { useGetExchangeBalances, getGetExchangeBalancesQueryKey } from "@workspace/api-client-react";
import { useConnectionStatus } from "@/contexts/connection-status";
import { useBots } from "@/hooks/use-bots";
import { useTheme } from "@/contexts/theme";

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

function ConnectionBadge() {
  const { dataSource } = useConnectionStatus();
  if (!dataSource) return null;
  return dataSource === "live" ? (
    <div className="flex items-center gap-1.5 bg-primary/10 border border-primary/30 rounded px-2 py-0.5 text-xs font-semibold text-primary">
      <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
      LIVE
    </div>
  ) : (
    <div className="flex items-center gap-1.5 bg-violet-500/10 border border-violet-500/30 rounded px-2 py-0.5 text-xs font-semibold text-violet-400">
      <div className="w-1.5 h-1.5 rounded-full bg-violet-400" />
      DEMO
    </div>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const [location] = useLocation();
  const active = href === "/" ? location === "/" : location.startsWith(href);
  return (
    <Link
      href={href}
      className={`px-3 py-1.5 rounded transition-colors flex items-center gap-2 ${
        active ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
      }`}
    >
      {children}
    </Link>
  );
}

function BotsNavItem() {
  const { bots } = useBots();
  const running = bots.filter((b) => b.enabled).length;
  return (
    <NavLink href="/bots">
      <Bot className="w-4 h-4" />
      Automations
      {running > 0 && (
        <span className="ml-0.5 bg-emerald-500/20 text-emerald-400 text-xs font-bold px-1.5 py-0 rounded-full leading-5">
          {running}
        </span>
      )}
    </NavLink>
  );
}

function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  return (
    <button
      onClick={toggleTheme}
      className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
    >
      {theme === "dark" ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
    </button>
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
            <NavLink href="/">
              <LayoutDashboard className="w-4 h-4" />
              Dashboard
            </NavLink>
            <BotsNavItem />
            <NavLink href="/history">
              <History className="w-4 h-4" />
              History
            </NavLink>
            <NavLink href="/settings">
              <Settings className="w-4 h-4" />
              Settings
            </NavLink>
          </nav>
          <ConnectionBadge />
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <HeaderBalances />
        </div>
      </header>
      <main className="flex-1 overflow-auto p-4">
        {children}
      </main>
    </div>
  );
}
