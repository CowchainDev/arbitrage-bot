import { Link } from "wouter";
import { Activity, ArrowRight, Lock, BarChart2, Bot } from "lucide-react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-foreground font-mono flex flex-col">
      <header className="h-14 border-b border-border bg-card px-6 flex items-center justify-between">
        <div className="flex items-center gap-2 font-bold text-base">
          <Activity className="w-5 h-5 text-primary" />
          <span>ARB_TERM</span>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/sign-in">
            <button className="text-sm text-muted-foreground hover:text-foreground transition-colors px-3 py-1.5">
              Sign in
            </button>
          </Link>
          <Link href="/sign-up">
            <button className="text-sm bg-primary text-primary-foreground hover:opacity-90 transition-opacity px-4 py-1.5 rounded">
              Get started
            </button>
          </Link>
        </div>
      </header>

      <main className="flex-1 flex flex-col items-center justify-center px-6 py-20 gap-16">
        <div className="text-center max-w-2xl">
          <div className="inline-flex items-center gap-2 bg-primary/10 border border-primary/20 text-primary text-xs font-semibold px-3 py-1 rounded-full mb-6">
            <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
            Crypto Futures Arbitrage
          </div>
          <h1 className="text-4xl font-bold text-foreground mb-4 tracking-tight">
            Your personal<br />
            <span className="text-primary">arbitrage terminal</span>
          </h1>
          <p className="text-muted-foreground text-base leading-relaxed mb-8">
            Monitor funding rate spreads across 7 exchanges, automate delta-neutral
            arbitrage strategies, and track every trade with full PnL accounting.
          </p>
          <Link href="/sign-up">
            <button className="inline-flex items-center gap-2 bg-primary text-primary-foreground font-semibold px-6 py-2.5 rounded hover:opacity-90 transition-opacity">
              Create your account
              <ArrowRight className="w-4 h-4" />
            </button>
          </Link>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 w-full max-w-2xl">
          {[
            { icon: <BarChart2 className="w-5 h-5 text-primary" />, title: "Live spreads", body: "Real-time funding rate differentials across Bybit, Binance, Gate, OKX, MEXC, HyperLiquid & AsterDex." },
            { icon: <Bot className="w-5 h-5 text-primary" />, title: "Automated bots", body: "Set your entry/exit thresholds and let bots open and close delta-neutral legs automatically." },
            { icon: <Lock className="w-5 h-5 text-primary" />, title: "Your data only", body: "Each account is fully isolated — your trades, bots, and API keys are never shared." },
          ].map(({ icon, title, body }) => (
            <div key={title} className="bg-card border border-border rounded-lg p-4">
              <div className="mb-2">{icon}</div>
              <div className="font-semibold text-sm mb-1">{title}</div>
              <p className="text-muted-foreground text-xs leading-relaxed">{body}</p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
