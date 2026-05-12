import { format } from "date-fns";
import { CheckCircle2, X } from "lucide-react";
import type { ClosedTrade } from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatFee } from "@/lib/utils";

function formatPnl(val: number) {
  if (val < 0) return `-$${Math.abs(val).toFixed(2)}`;
  return `+$${val.toFixed(2)}`;
}

function formatDuration(entryTime: string, closeTime: string) {
  const ms = new Date(closeTime).getTime() - new Date(entryTime).getTime();
  if (ms < 0) return "—";
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function formatPrice(val: number | null | undefined) {
  if (val == null) return "—";
  return `$${val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 border-b border-border/30 last:border-0">
      <span className="text-xs text-muted-foreground shrink-0 pt-0.5">{label}</span>
      <span className="text-xs font-mono text-right">{children}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-0">
      <h3 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1 mt-4 first:mt-0">{title}</h3>
      <div className="bg-muted/20 rounded-md px-3 py-1">
        {children}
      </div>
    </div>
  );
}

interface TradeDetailModalProps {
  trade: ClosedTrade | null;
  onClose: () => void;
}

export function TradeDetailModal({ trade, onClose }: TradeDetailModalProps) {
  if (!trade) return null;

  const pnlPositive = trade.realizedPnl >= 0;
  const pnlPct =
    trade.quantity > 0
      ? (trade.realizedPnl / (trade.quantity * 2)) * 100
      : null;
  const funding = trade.fundingPaidUsd;
  const netPnl = funding != null ? trade.realizedPnl + funding : null;
  const netPnlPositive = netPnl != null ? netPnl >= 0 : null;

  const longQty =
    trade.longEntryPrice && trade.longEntryPrice > 0
      ? trade.quantity / trade.longEntryPrice
      : null;
  const shortQty =
    trade.shortEntryPrice && trade.shortEntryPrice > 0
      ? trade.quantity / trade.shortEntryPrice
      : null;

  const closeReasonLabel =
    trade.closeReason === "take_profit"
      ? "Take Profit"
      : trade.closeReason === "stop_loss"
        ? "Stop Loss"
        : trade.closeReason === "force_stop"
          ? "Force Stop"
          : trade.closeReason ?? "—";

  const closeReasonClass =
    trade.closeReason === "take_profit"
      ? "text-primary"
      : trade.closeReason === "stop_loss" || trade.closeReason === "force_stop"
        ? "text-destructive"
        : "text-foreground";

  return (
    <Dialog open={!!trade} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base font-bold font-mono">
            {trade.symbol}
            <span className="text-muted-foreground font-normal text-xs ml-2">Trade #{trade.id}</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-0 mt-1">
          <Section title="Overview">
            <Row label="Long exchange">
              <span className="text-primary capitalize">{trade.longExchange}</span>
            </Row>
            <Row label="Short exchange">
              <span className="text-destructive capitalize">{trade.shortExchange}</span>
            </Row>
            <Row label="Size (USD)">
              {trade.quantity > 0 ? `$${trade.quantity.toFixed(2)}` : "—"}
            </Row>
            <Row label="Duration">{formatDuration(trade.entryTime, trade.closeTime)}</Row>
            <Row label="Opened at">{format(new Date(trade.entryTime), "MM/dd/yyyy HH:mm:ss")}</Row>
            <Row label="Closed at">{format(new Date(trade.closeTime), "MM/dd/yyyy HH:mm:ss")}</Row>
            <Row label="Close reason">
              <span className={closeReasonClass}>{closeReasonLabel}</span>
            </Row>
            <Row label="Condition (entry threshold)">
              {trade.enterSpreadThresholdPct != null
                ? `≥${trade.enterSpreadThresholdPct.toFixed(3)}%`
                : "—"}
            </Row>
          </Section>

          <Section title="Prices">
            <Row label="Long entry price">{formatPrice(trade.longEntryPrice)}</Row>
            <Row label="Short entry price">{formatPrice(trade.shortEntryPrice)}</Row>
            <Row label="Long exit price">{formatPrice(trade.longExitPrice)}</Row>
            <Row label="Short exit price">{formatPrice(trade.shortExitPrice)}</Row>
            <Row label="Long qty bought">
              {longQty != null ? longQty.toFixed(6) : "—"}
            </Row>
            <Row label="Short qty sold">
              {shortQty != null ? shortQty.toFixed(6) : "—"}
            </Row>
          </Section>

          <Section title="Spreads">
            <Row label="Entry spread">
              {trade.spreadAtEntry !== 0
                ? `${trade.spreadAtEntry >= 0 ? "+" : ""}${trade.spreadAtEntry.toFixed(3)}%`
                : "—"}
            </Row>
            <Row label="Exit spread">
              {trade.spreadAtExit != null
                ? `${trade.spreadAtExit >= 0 ? "+" : ""}${trade.spreadAtExit.toFixed(3)}%`
                : "—"}
            </Row>
            <Row label="Funding / rate spread">
              <span className={funding != null ? (funding >= 0 ? "text-primary/80" : "text-destructive/80") : ""}>
                <span className="flex flex-col items-end gap-0.5">
                  {funding != null ? (
                    <span>{`${funding >= 0 ? "+" : ""}$${Math.abs(funding).toFixed(4)}`}</span>
                  ) : (
                    <span>—</span>
                  )}
                  {trade.fundingRateSpread != null && (
                    <span className="text-muted-foreground/60 text-[10px]">
                      {`${trade.fundingRateSpread >= 0 ? "+" : ""}${(trade.fundingRateSpread * 100).toFixed(4)}% rate spread`}
                    </span>
                  )}
                </span>
              </span>
            </Row>
          </Section>

          <Section title="Fees & PnL">
            <Row label="Open fees">
              {trade.openFees != null ? `-$${formatFee(trade.openFees)}` : "—"}
            </Row>
            <Row label="Close fees">
              {trade.closeFees != null
                ? `-$${formatFee(trade.closeFees)}`
                : trade.totalFees > 0 && trade.openFees == null
                  ? `-$${formatFee(trade.totalFees)}`
                  : "—"}
            </Row>
            <Row label="Realized PnL (excl. funding)">
              <span className={`font-semibold inline-flex items-center gap-1 ${pnlPositive ? "text-primary" : "text-destructive"}`}>
                {trade.pnlFromExchange === true && (
                  <span title="Exchange-reported"><CheckCircle2 className="w-3 h-3 text-emerald-500 shrink-0" /></span>
                )}
                {trade.pnlFromExchange === false && (
                  <span
                    className="text-muted-foreground font-normal"
                    title={
                      trade.pnlPartial
                        ? "Partial backfill — one exchange returned PnL, the other did not"
                        : "Estimated from entry/exit spread and fees"
                    }
                  >~</span>
                )}
                {formatPnl(trade.realizedPnl)}
              </span>
            </Row>
            <Row label="Net PnL (incl. funding)">
              <span className={`font-semibold ${netPnlPositive === true ? "text-primary" : netPnlPositive === false ? "text-destructive" : "text-muted-foreground"}`}>
                {netPnl != null ? formatPnl(netPnl) : "—"}
              </span>
            </Row>
            <Row label="PnL (%)">
              <span className={pnlPositive ? "text-primary" : "text-destructive"}>
                {pnlPct !== null
                  ? `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`
                  : "—"}
              </span>
            </Row>
          </Section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
