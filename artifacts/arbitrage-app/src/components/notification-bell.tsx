import { Bell, CheckCheck, Trash2, ChevronDown, Copy, Check, X } from "lucide-react";
import { useState, useRef, useEffect, useCallback } from "react";
import { useNotifications, type NotificationEntry } from "@/contexts/notifications";
import type { BotEvent } from "@/hooks/use-notification-stream";

function eventColor(event: BotEvent): string {
  switch (event.kind) {
    case "leg_opened": return "text-emerald-400";
    case "leg_closed": return event.realizedPnl >= 0 ? "text-emerald-400" : "text-amber-400";
    case "leg_open_failed": return "text-destructive";
    case "order_too_small": return "text-amber-400";
    case "compensation_failed": return "text-destructive";
    case "force_stop": return "text-amber-400";
    case "credential_error": return "text-destructive";
    case "credential_ok": return "text-emerald-400";
  }
}

function eventDot(event: BotEvent): string {
  switch (event.kind) {
    case "leg_opened": return "bg-emerald-400";
    case "leg_closed": return event.realizedPnl >= 0 ? "bg-emerald-400" : "bg-amber-400";
    case "leg_open_failed": return "bg-destructive";
    case "order_too_small": return "bg-amber-400";
    case "compensation_failed": return "bg-destructive";
    case "force_stop": return "bg-amber-400";
    case "credential_error": return "bg-destructive";
    case "credential_ok": return "bg-emerald-400";
  }
}

function formatTitle(event: BotEvent): string {
  switch (event.kind) {
    case "leg_opened": return `${event.symbol} opened`;
    case "leg_closed": return `${event.symbol} closed`;
    case "leg_open_failed": return `${event.symbol} open failed`;
    case "order_too_small": return `${event.symbol} too small`;
    case "compensation_failed": return `${event.symbol} comp. failed`;
    case "force_stop": return `${event.symbol} force stop`;
    case "credential_error": return `${event.exchange} credentials invalid`;
    case "credential_ok": return `${event.exchange} credentials OK`;
  }
}

function formatDescription(event: BotEvent): string {
  switch (event.kind) {
    case "leg_opened":
      return `${event.exchangeA} ${event.sideA} / ${event.exchangeB} ${event.sideB} @ ${event.spreadPct.toFixed(3)}%`;
    case "leg_closed":
      return `PnL: ${event.realizedPnl >= 0 ? "+" : ""}$${event.realizedPnl.toFixed(2)} · ${event.trigger.replace(/_/g, " ")}`;
    case "leg_open_failed":
      return `${event.exchange}: ${event.message}`;
    case "order_too_small":
      return "Min $10 per order. Update bot settings.";
    case "compensation_failed":
      return `Manual action needed on ${event.exchange}`;
    case "force_stop":
      return `Total PnL: $${event.totalPnl.toFixed(2)}`;
    case "credential_error":
      return event.message;
    case "credential_ok":
      return `${event.exchange} API credentials verified successfully`;
  }
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function NotificationRow({ n, onDismiss }: { n: NotificationEntry; onDismiss: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const [copied, setCopied] = useState(false);
  const descRef = useRef<HTMLParagraphElement>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const el = descRef.current;
    if (!el) return;
    setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, []);

  useEffect(() => () => { if (copyTimerRef.current) clearTimeout(copyTimerRef.current); }, []);

  const canExpand = overflows || expanded;

  const handleCopy = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const text = formatDescription(n.event);
    navigator.clipboard.writeText(text).then(() => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      setCopied(true);
      copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [n.event]);

  const handleDismiss = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDismiss(n.id);
  }, [n.id, onDismiss]);

  return (
    <div
      className={`group px-3 py-2.5 border-b border-border/50 last:border-0 ${!n.read ? "bg-muted/30" : ""} ${canExpand ? "cursor-pointer select-none" : ""}`}
      onClick={canExpand ? () => setExpanded((v) => !v) : undefined}
      role={canExpand ? "button" : undefined}
      aria-expanded={canExpand ? expanded : undefined}
    >
      <div className="flex items-start gap-2.5">
        <div className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${eventDot(n.event)}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <span className={`text-xs font-semibold ${eventColor(n.event)}`}>{formatTitle(n.event)}</span>
            <div className="flex items-center gap-1 shrink-0">
              <span className="text-[10px] text-muted-foreground">{formatTime(n.ts)}</span>
              {canExpand && (
                <ChevronDown
                  className={`w-3 h-3 text-muted-foreground transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
                />
              )}
              <button
                onClick={handleDismiss}
                title="Dismiss"
                aria-label="Dismiss notification"
                className="opacity-100 sm:opacity-0 sm:group-hover:opacity-100 p-0.5 rounded text-muted-foreground/60 hover:text-foreground hover:bg-muted transition-all duration-150"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          </div>
          <div className="relative">
            <p
              ref={descRef}
              className={`text-[11px] text-muted-foreground mt-0.5 leading-snug break-all ${expanded ? "pr-6" : "line-clamp-2"}`}
            >
              {formatDescription(n.event)}
            </p>
            {expanded && (
              <button
                onClick={handleCopy}
                title={copied ? "Copied!" : "Copy to clipboard"}
                aria-label={copied ? "Copied!" : "Copy message to clipboard"}
                className="absolute top-0.5 right-0 p-0.5 rounded text-muted-foreground/60 hover:text-foreground hover:bg-muted transition-colors"
              >
                {copied
                  ? <Check className="w-3 h-3 text-primary" />
                  : <Copy className="w-3 h-3" />
                }
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function NotificationBell() {
  const { notifications, unreadCount, markAllRead, clearAll, dismissOne } = useNotifications();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, []);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) markAllRead();
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={toggle}
        className="relative p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        aria-label="Notifications"
      >
        <Bell className="w-4 h-4" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-destructive text-destructive-foreground text-[10px] font-bold rounded-full flex items-center justify-center leading-none">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 w-80 bg-card border border-border rounded-lg shadow-xl z-50 overflow-hidden">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <span className="text-xs font-semibold text-foreground">Notifications</span>
            <div className="flex items-center gap-1">
              <button
                onClick={markAllRead}
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                title="Mark all read"
              >
                <CheckCheck className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={clearAll}
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                title="Clear all"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="px-3 py-8 text-center text-xs text-muted-foreground">
                No notifications yet
              </div>
            ) : (
              notifications.map((n) => <NotificationRow key={n.id} n={n} onDismiss={dismissOne} />)
            )}
          </div>
        </div>
      )}
    </div>
  );
}
