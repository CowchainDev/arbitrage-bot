import { createContext, useContext, useState, useCallback, useRef, useMemo, type ReactNode } from "react";
import { toast } from "sonner";
import { useNotificationStream, type BotEvent, type NotificationMessage } from "@/hooks/use-notification-stream";

export type NotificationEntry = {
  id: string;
  ts: number;
  event: BotEvent;
  read: boolean;
};

type NotificationsContextValue = {
  notifications: NotificationEntry[];
  unreadCount: number;
  markAllRead: () => void;
  clearAll: () => void;
  failingExchanges: Set<string>;
};

const NotificationsContext = createContext<NotificationsContextValue | null>(null);

const MAX_HISTORY = 50;

function formatToast(event: BotEvent): { title: string; description?: string; variant: "success" | "error" | "warning" | "info" } {
  switch (event.kind) {
    case "leg_opened":
      return {
        title: `${event.symbol} position opened`,
        description: `${event.exchangeA} ${event.sideA} / ${event.exchangeB} ${event.sideB} @ ${event.spreadPct.toFixed(3)}% spread`,
        variant: "success",
      };
    case "leg_closed":
      return {
        title: `${event.symbol} position closed`,
        description: `PnL: ${event.realizedPnl >= 0 ? "+" : ""}$${event.realizedPnl.toFixed(2)} · ${event.trigger.replace(/_/g, " ")}`,
        variant: event.realizedPnl >= 0 ? "success" : "warning",
      };
    case "leg_open_failed":
      return {
        title: `${event.symbol} open failed (${event.exchange})`,
        description: event.message.slice(0, 80),
        variant: "error",
      };
    case "order_too_small":
      return {
        title: `${event.symbol}: order too small`,
        description: "Minimum is $10. Raise order size in bot settings.",
        variant: "warning",
      };
    case "compensation_failed":
      return {
        title: `${event.symbol}: compensation FAILED`,
        description: `Manual intervention required on ${event.exchange}`,
        variant: "error",
      };
    case "force_stop":
      return {
        title: `${event.symbol}: force stop triggered`,
        description: `Total PnL: $${event.totalPnl.toFixed(2)}`,
        variant: "warning",
      };
    case "credential_error":
      return {
        title: `${event.exchange} credentials invalid`,
        description: event.message,
        variant: "error",
      };
  }
}

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<NotificationEntry[]>([]);
  const [failingExchanges, setFailingExchanges] = useState<Set<string>>(new Set());
  const idCounter = useRef(0);

  const handleMessage = useCallback((msg: NotificationMessage) => {
    const { event, ts } = msg;
    const id = String(++idCounter.current);
    const entry: NotificationEntry = { id, ts, event, read: false };
    setNotifications((prev) => [entry, ...prev].slice(0, MAX_HISTORY));

    if (event.kind === "credential_error") {
      setFailingExchanges((prev) => {
        const next = new Set(prev);
        next.add(event.exchange);
        return next;
      });
    } else if (event.kind === "leg_opened") {
      setFailingExchanges((prev) => {
        if (!prev.has(event.exchangeA) && !prev.has(event.exchangeB)) return prev;
        const next = new Set(prev);
        next.delete(event.exchangeA);
        next.delete(event.exchangeB);
        return next;
      });
    }

    const { title, description, variant } = formatToast(event);
    if (variant === "success") toast.success(title, { description });
    else if (variant === "error") toast.error(title, { description });
    else if (variant === "warning") toast.warning(title, { description });
    else toast.info(title, { description });
  }, []);

  useNotificationStream(handleMessage);

  const unreadCount = notifications.filter((n) => !n.read).length;

  const markAllRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }, []);

  const clearAll = useCallback(() => {
    setNotifications([]);
  }, []);

  const value = useMemo(
    () => ({ notifications, unreadCount, markAllRead, clearAll, failingExchanges }),
    [notifications, unreadCount, markAllRead, clearAll, failingExchanges],
  );

  return (
    <NotificationsContext.Provider value={value}>
      {children}
    </NotificationsContext.Provider>
  );
}

export function useNotifications() {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error("useNotifications must be used within NotificationsProvider");
  return ctx;
}
