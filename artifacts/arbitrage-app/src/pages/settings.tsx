import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, Eye, EyeOff, CheckCircle, Trash2, ExternalLink, Bell, Volume2, VolumeX, Server, Save, AlertTriangle } from "lucide-react";
import { useAlertSettings } from "@/hooks/use-alert-settings";
import { useWatchedTokens } from "@/hooks/use-watched-tokens";
import { useToast } from "@/hooks/use-toast";
import { useStoreCredential, useDeleteCredential, getGetCredentialStatusQueryKey } from "@workspace/api-client-react";
import { useExchangeCredentials, type SupportedExchange } from "@/hooks/use-exchange-credentials";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface ExchangeMeta {
  id: SupportedExchange;
  label: string;
  dot: string;
  marketType: string;
  keysUrl: string;
  hasPassphrase?: boolean;
}

const EXCHANGES: ExchangeMeta[] = [
  { id: "bybit", label: "BYBIT", dot: "bg-amber-400", marketType: "Futures (Linear / USDT)", keysUrl: "https://www.bybit.com/user/api-management" },
  { id: "binance", label: "BINANCE", dot: "bg-violet-400", marketType: "Futures (USDM)", keysUrl: "https://www.binance.com/en/my/settings/api-management" },
  { id: "gate", label: "GATE.IO", dot: "bg-sky-400", marketType: "Futures (USDT)", keysUrl: "https://www.gate.io/myaccount/apikey" },
  { id: "okx", label: "OKX", dot: "bg-emerald-400", marketType: "Futures (Perp)", keysUrl: "https://www.okx.com/account/my-api", hasPassphrase: true },
  { id: "mexc", label: "MEXC", dot: "bg-rose-400", marketType: "Futures (USDT)", keysUrl: "https://www.mexc.com/user/openapi" },
  { id: "aster", label: "ASTERDEX", dot: "bg-violet-500", marketType: "Futures (USDT)", keysUrl: "https://www.asterdex.com/en/account/api-management" },
];

function ExchangeCard({ meta }: { meta: ExchangeMeta }) {
  const { creds, save, remove, hasCreds } = useExchangeCredentials(meta.id);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const storeCredential = useStoreCredential();
  const deleteCredential = useDeleteCredential();

  const [apiKey, setApiKey] = useState(creds?.apiKey ?? "");
  const [apiSecret, setApiSecret] = useState(creds?.apiSecret ?? "");
  const [passphrase, setPassphrase] = useState(creds?.passphrase ?? "");
  const [showSecret, setShowSecret] = useState(false);
  const [showPass, setShowPass] = useState(false);
  const [syncStatus, setSyncStatus] = useState<"idle" | "syncing" | "ok" | "error">("idle");
  const [confirmDelete, setConfirmDelete] = useState(false);

  const hasChanges = apiKey !== (creds?.apiKey ?? "") || apiSecret !== (creds?.apiSecret ?? "") || passphrase !== (creds?.passphrase ?? "");
  const canSave = !!apiKey && !!apiSecret && (meta.hasPassphrase ? !!passphrase : true);

  const handleSave = async () => {
    const c = { apiKey, apiSecret, ...(meta.hasPassphrase ? { passphrase } : {}) };
    save(c);
    setSyncStatus("syncing");
    try {
      await storeCredential.mutateAsync({
        data: {
          exchange: meta.id as "bybit" | "binance" | "gate" | "okx" | "mexc" | "aster",
          apiKey,
          apiSecret,
          ...(meta.hasPassphrase && passphrase ? { passphrase } : {}),
        },
      });
      setSyncStatus("ok");
      queryClient.invalidateQueries({ queryKey: getGetCredentialStatusQueryKey() });
      toast({ title: `${meta.label} credentials saved`, description: "Synced to server." });
    } catch {
      setSyncStatus("error");
      toast({ title: `${meta.label} saved locally`, description: "Server sync failed — bot may not work.", variant: "destructive" });
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    try {
      await deleteCredential.mutateAsync({ exchange: meta.id });
    } catch {
    }
    remove();
    setApiKey("");
    setApiSecret("");
    setPassphrase("");
    setSyncStatus("idle");
    setConfirmDelete(false);
    toast({ title: `${meta.label} credentials removed` });
  };

  return (
    <div className="bg-card border border-border rounded-md p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${meta.dot}`} />
          <span className="font-semibold text-sm">{meta.label}</span>
          <span className="text-xs text-muted-foreground">{meta.marketType}</span>
          {hasCreds && (
            <span className="flex items-center gap-1 text-xs text-primary bg-primary/10 px-2 py-0.5 rounded-full">
              <CheckCircle className="w-3 h-3" /> Connected
            </span>
          )}
        </div>
        <a
          href={meta.keysUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
        >
          Manage Keys <ExternalLink className="w-3 h-3" />
        </a>
      </div>

      <div className="space-y-3">
        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground uppercase tracking-wider">API Key</label>
          <Input
            value={apiKey}
            onChange={(e) => { setApiKey(e.target.value); setSyncStatus("idle"); }}
            placeholder={`Enter ${meta.label} API Key`}
            className="font-mono bg-background border-border text-sm"
            autoComplete="off"
            data-testid={`input-${meta.id}-apiKey`}
          />
        </div>

        <div className="space-y-1.5">
          <label className="text-xs text-muted-foreground uppercase tracking-wider">API Secret</label>
          <div className="relative">
            <Input
              value={apiSecret}
              onChange={(e) => { setApiSecret(e.target.value); setSyncStatus("idle"); }}
              type={showSecret ? "text" : "password"}
              placeholder={`Enter ${meta.label} API Secret`}
              className="font-mono bg-background border-border text-sm pr-10"
              autoComplete="off"
              data-testid={`input-${meta.id}-apiSecret`}
            />
            <button
              type="button"
              onClick={() => setShowSecret((v) => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              tabIndex={-1}
            >
              {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {meta.hasPassphrase && (
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground uppercase tracking-wider">Passphrase <span className="text-primary">(required)</span></label>
            <div className="relative">
              <Input
                value={passphrase}
                onChange={(e) => { setPassphrase(e.target.value); setSyncStatus("idle"); }}
                type={showPass ? "text" : "password"}
                placeholder="Enter OKX API Passphrase"
                className="font-mono bg-background border-border text-sm pr-10"
                autoComplete="off"
                data-testid={`input-${meta.id}-passphrase`}
              />
              <button
                type="button"
                onClick={() => setShowPass((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                tabIndex={-1}
              >
                {showPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 pt-1">
        <Button
          type="button"
          onClick={handleSave}
          disabled={!canSave || storeCredential.isPending}
          className="bg-primary text-primary-foreground hover:bg-primary/90 font-semibold h-8 text-sm"
          data-testid={`button-save-${meta.id}`}
        >
          <Save className="w-3.5 h-3.5 mr-1.5" />
          {storeCredential.isPending ? "Saving…" : hasChanges ? "Save" : "Save"}
        </Button>

        {hasCreds && (
          <Button
            type="button"
            variant="outline"
            onClick={handleDelete}
            disabled={deleteCredential.isPending}
            className={`h-8 text-sm ${confirmDelete ? "border-destructive text-destructive bg-destructive/10" : "text-muted-foreground"}`}
            data-testid={`button-delete-${meta.id}`}
          >
            <Trash2 className="w-3.5 h-3.5 mr-1.5" />
            {confirmDelete ? "Confirm delete?" : "Remove"}
          </Button>
        )}

        {confirmDelete && (
          <button
            type="button"
            onClick={() => setConfirmDelete(false)}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
        )}

        {syncStatus === "ok" && (
          <span className="flex items-center gap-1 text-xs text-primary ml-auto" data-testid={`sync-ok-${meta.id}`}>
            <Server className="w-3.5 h-3.5" /> Synced
          </span>
        )}
      </div>

      {syncStatus === "error" && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/60 bg-destructive/10 px-3 py-2.5" data-testid={`sync-error-${meta.id}`}>
          <AlertTriangle className="w-3.5 h-3.5 text-destructive mt-0.5 shrink-0" />
          <p className="text-xs text-destructive leading-snug">
            <span className="font-semibold">Server sync failed.</span>{" "}
            Keys were saved locally but the server could not store them — the bot will not be able to trade. Check your connection and try saving again.
          </p>
        </div>
      )}
    </div>
  );
}

export default function Settings() {
  const { settings, updateSettings, enableBrowserPush, browserPushSupported, browserPermission } = useAlertSettings();
  const { watched, updateThreshold } = useWatchedTokens();
  const { toast } = useToast();
  const [requestingPush, setRequestingPush] = useState(false);

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-foreground">API Configuration</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Add API keys for each exchange you want to trade on. Keys are saved locally and synced to the server for bot automation.
        </p>
      </div>

      <div className="bg-card border border-border rounded-md p-4 text-xs text-muted-foreground space-y-1">
        <div className="flex items-center gap-2 font-medium text-foreground mb-2">
          <KeyRound className="w-3.5 h-3.5" />
          Security Notice
        </div>
        <p>API keys are stored in your browser and synced to the server. Server-side storage enables the bot to trade on your behalf without the browser open.</p>
        <p>Use futures-only API keys with IP whitelisting enabled on each exchange.</p>
      </div>

      {EXCHANGES.map((meta) => (
        <ExchangeCard key={meta.id} meta={meta} />
      ))}

      {/* Notification Settings */}
      <div className="bg-card border border-border rounded-md p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Bell className="w-3.5 h-3.5 text-primary" />
          <span className="font-semibold text-sm">Spread Alerts</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Watch a token from the dashboard by clicking the bell icon on its card. An alert fires whenever the spread crosses your configured threshold.
        </p>

        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm">
              {settings.soundEnabled ? <Volume2 className="w-4 h-4 text-primary" /> : <VolumeX className="w-4 h-4 text-muted-foreground" />}
              <span className={settings.soundEnabled ? "text-foreground" : "text-muted-foreground"}>Sound alerts</span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 ml-6">Play a chime when a watched spread crosses its threshold</p>
          </div>
          <button
            onClick={() => updateSettings({ soundEnabled: !settings.soundEnabled })}
            data-testid="toggle-sound-alerts"
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${settings.soundEnabled ? "bg-primary" : "bg-muted"}`}
          >
            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${settings.soundEnabled ? "translate-x-4" : "translate-x-1"}`} />
          </button>
        </div>

        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm">
              <Bell className={`w-4 h-4 ${settings.browserPushEnabled ? "text-primary" : "text-muted-foreground"}`} />
              <span className={settings.browserPushEnabled ? "text-foreground" : "text-muted-foreground"}>Browser notifications</span>
              {!browserPushSupported && <span className="text-xs text-destructive">(not supported)</span>}
              {browserPushSupported && browserPermission === "denied" && <span className="text-xs text-destructive">(blocked — allow in browser settings)</span>}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 ml-6">Send a browser notification even when the tab is in the background</p>
          </div>
          <button
            onClick={async () => {
              if (settings.browserPushEnabled) { updateSettings({ browserPushEnabled: false }); return; }
              if (!browserPushSupported) return;
              setRequestingPush(true);
              const granted = await enableBrowserPush();
              setRequestingPush(false);
              if (!granted) toast({ title: "Permission denied", description: "Allow notifications in your browser settings and try again.", variant: "destructive" });
            }}
            disabled={!browserPushSupported || requestingPush}
            data-testid="toggle-browser-push"
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none disabled:opacity-40 ${settings.browserPushEnabled ? "bg-primary" : "bg-muted"}`}
          >
            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${settings.browserPushEnabled ? "translate-x-4" : "translate-x-1"}`} />
          </button>
        </div>

        {watched.length > 0 && (
          <div className="border-t border-border pt-4 space-y-2">
            <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Watched tokens</p>
            {watched.map(({ symbol, threshold }) => (
              <div key={symbol} className="flex items-center justify-between gap-3">
                <span className="text-sm font-mono font-semibold text-foreground w-24">{symbol}</span>
                <div className="flex items-center gap-2 flex-1">
                  <span className="text-xs text-muted-foreground">Alert above</span>
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={threshold}
                    onChange={(e) => updateThreshold(symbol, Number(e.target.value))}
                    className="font-mono text-xs bg-background border-border h-7 w-20"
                    data-testid={`input-threshold-${symbol}`}
                  />
                  <span className="text-xs text-muted-foreground">%</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
