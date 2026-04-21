import { Link } from "wouter";
import { Settings, LayoutDashboard, Activity } from "lucide-react";
import { useApiCredentials } from "@/hooks/use-api-credentials";

export function Layout({ children }: { children: React.ReactNode }) {
  const { hasCredentials } = useApiCredentials();

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
        {!hasCredentials && (
          <div className="text-destructive font-medium bg-destructive/10 px-3 py-1 rounded text-xs">
            API Keys missing. Configuration required.
          </div>
        )}
      </header>
      <main className="flex-1 overflow-auto p-4">
        {children}
      </main>
    </div>
  );
}