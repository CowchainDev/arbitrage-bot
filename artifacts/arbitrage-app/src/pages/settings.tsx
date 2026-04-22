import { useState } from "react";
import { useForm, type ControllerRenderProps } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { KeyRound, Eye, EyeOff, CheckCircle, Trash2, ExternalLink, Bell, Volume2, VolumeX, Server, Bot } from "lucide-react";
import { useApiCredentials, type ApiCredentials } from "@/hooks/use-api-credentials";
import { useBotSecret } from "@/hooks/use-bot-secret";
import { useAlertSettings } from "@/hooks/use-alert-settings";
import { useWatchedTokens } from "@/hooks/use-watched-tokens";
import { useToast } from "@/hooks/use-toast";
import { useStoreCredential } from "@workspace/api-client-react";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

const credentialsSchema = z.object({
  bybitApiKey: z.string().min(1, "Bybit API Key is required"),
  bybitApiSecret: z.string().min(1, "Bybit API Secret is required"),
  binanceApiKey: z.string().min(1, "Binance API Key is required"),
  binanceApiSecret: z.string().min(1, "Binance API Secret is required"),
});

type CredentialsForm = z.infer<typeof credentialsSchema>;

export default function Settings() {
  const { credentials, saveCredentials, clearCredentials, hasCredentials } = useApiCredentials();
  const { botSecret, saveBotSecret } = useBotSecret();
  const [botSecretInput, setBotSecretInput] = useState(botSecret ?? "");
  const [showBotSecret, setShowBotSecret] = useState(false);
  const { settings, updateSettings, enableBrowserPush, browserPushSupported, browserPermission } = useAlertSettings();
  const { watched, updateThreshold } = useWatchedTokens();
  const { toast } = useToast();
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [requestingPush, setRequestingPush] = useState(false);
  const [serverSyncStatus, setServerSyncStatus] = useState<"idle" | "syncing" | "ok" | "error">("idle");
  const storeCredential = useStoreCredential();

  const form = useForm<CredentialsForm>({
    resolver: zodResolver(credentialsSchema),
    defaultValues: {
      bybitApiKey: credentials?.bybitApiKey ?? "",
      bybitApiSecret: credentials?.bybitApiSecret ?? "",
      binanceApiKey: credentials?.binanceApiKey ?? "",
      binanceApiSecret: credentials?.binanceApiSecret ?? "",
    },
  });

  const toggleSecret = (field: string) => {
    setShowSecrets((prev) => ({ ...prev, [field]: !prev[field] }));
  };

  const onSubmit = async (data: CredentialsForm) => {
    saveCredentials(data as ApiCredentials);

    setServerSyncStatus("syncing");
    try {
      await storeCredential.mutateAsync({ data: { exchange: "bybit", apiKey: data.bybitApiKey, apiSecret: data.bybitApiSecret } });
      await storeCredential.mutateAsync({ data: { exchange: "binance", apiKey: data.binanceApiKey, apiSecret: data.binanceApiSecret } });
      setServerSyncStatus("ok");
      toast({ title: "Credentials saved", description: "Saved to browser and synced to server for bot use." });
    } catch {
      setServerSyncStatus("error");
      toast({ title: "Credentials saved locally", description: "Browser save succeeded but server sync failed — bot automation may not work.", variant: "destructive" });
    }
  };

  const handleClear = () => {
    clearCredentials();
    form.reset({
      bybitApiKey: "",
      bybitApiSecret: "",
      binanceApiKey: "",
      binanceApiSecret: "",
    });
    toast({
      title: "Credentials cleared",
      description: "All API keys have been removed.",
    });
  };

  const SecretInput = ({
    field,
    placeholder,
    name,
  }: {
    field: ControllerRenderProps<CredentialsForm, keyof CredentialsForm>;
    placeholder: string;
    name: string;
  }) => (
    <div className="relative">
      <Input
        {...field}
        type={showSecrets[name] ? "text" : "password"}
        placeholder={placeholder}
        className="font-mono pr-10 bg-background border-border text-sm"
        data-testid={`input-${name}`}
        autoComplete="off"
      />
      <button
        type="button"
        onClick={() => toggleSecret(name)}
        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
        data-testid={`toggle-${name}`}
      >
        {showSecrets[name] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
      </button>
    </div>
  );

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-foreground">API Configuration</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Keys are saved to your browser and synced to the server for bot automation.
          </p>
        </div>
        {hasCredentials && (
          <div className="flex items-center gap-1.5 text-primary text-xs bg-primary/10 px-3 py-1.5 rounded-md">
            <CheckCircle className="w-3.5 h-3.5" />
            Connected
          </div>
        )}
      </div>

      <div className="bg-card border border-border rounded-md p-4 text-xs text-muted-foreground space-y-1">
        <div className="flex items-center gap-2 font-medium text-foreground mb-2">
          <KeyRound className="w-3.5 h-3.5" />
          Security Notice
        </div>
        <p>API keys are saved to your browser and synced to the server. Server-side storage enables the automated bot to trade on your behalf without the browser being open.</p>
        <p>Use API keys with futures trading permissions only. We recommend IP whitelisting on each exchange.</p>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
          {/* Bybit */}
          <div className="bg-card border border-border rounded-md p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-amber-400" />
                <span className="font-semibold text-sm">BYBIT</span>
                <span className="text-xs text-muted-foreground">Futures (Linear / USDT)</span>
              </div>
              <a
                href="https://www.bybit.com/user/api-management"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
              >
                Manage Keys <ExternalLink className="w-3 h-3" />
              </a>
            </div>

            <FormField
              control={form.control}
              name="bybitApiKey"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs text-muted-foreground uppercase tracking-wider">API Key</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      placeholder="Enter Bybit API Key"
                      className="font-mono bg-background border-border text-sm"
                      data-testid="input-bybitApiKey"
                      autoComplete="off"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="bybitApiSecret"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs text-muted-foreground uppercase tracking-wider">API Secret</FormLabel>
                  <FormControl>
                    <SecretInput field={field} placeholder="Enter Bybit API Secret" name="bybitApiSecret" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          {/* Binance */}
          <div className="bg-card border border-border rounded-md p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-violet-400" />
                <span className="font-semibold text-sm">BINANCE</span>
                <span className="text-xs text-muted-foreground">Futures (USDM)</span>
              </div>
              <a
                href="https://www.binance.com/en/my/settings/api-management"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"
              >
                Manage Keys <ExternalLink className="w-3 h-3" />
              </a>
            </div>

            <FormField
              control={form.control}
              name="binanceApiKey"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs text-muted-foreground uppercase tracking-wider">API Key</FormLabel>
                  <FormControl>
                    <Input
                      {...field}
                      placeholder="Enter Binance API Key"
                      className="font-mono bg-background border-border text-sm"
                      data-testid="input-binanceApiKey"
                      autoComplete="off"
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="binanceApiSecret"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs text-muted-foreground uppercase tracking-wider">API Secret</FormLabel>
                  <FormControl>
                    <SecretInput field={field} placeholder="Enter Binance API Secret" name="binanceApiSecret" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <Button
              type="submit"
              disabled={storeCredential.isPending}
              className="bg-primary text-primary-foreground hover:bg-primary/90 font-semibold"
              data-testid="button-save-credentials"
            >
              {storeCredential.isPending ? "Saving…" : "Save Credentials"}
            </Button>

            {hasCredentials && (
              <Button
                type="button"
                variant="outline"
                onClick={handleClear}
                className="text-destructive border-destructive/40 hover:bg-destructive/10"
                data-testid="button-clear-credentials"
              >
                <Trash2 className="w-4 h-4 mr-1.5" />
                Clear All
              </Button>
            )}

            {serverSyncStatus === "ok" && (
              <span className="flex items-center gap-1.5 text-xs text-primary" data-testid="server-sync-ok">
                <Server className="w-3.5 h-3.5" />
                Synced to server
              </span>
            )}
            {serverSyncStatus === "error" && (
              <span className="flex items-center gap-1.5 text-xs text-destructive" data-testid="server-sync-error">
                <Server className="w-3.5 h-3.5" />
                Server sync failed
              </span>
            )}
          </div>
        </form>
      </Form>

      {/* Bot Secret */}
      <div className="bg-card border border-border rounded-md p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Bot className="w-3.5 h-3.5 text-primary" />
          <span className="font-semibold text-sm">Bot Secret</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Optional. If you set a <code className="font-mono bg-muted px-1 rounded">BOT_SECRET</code> environment variable on your server, enter the same value here. Without it, bot controls work for anyone who can reach the server.
        </p>
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Input
              type={showBotSecret ? "text" : "password"}
              value={botSecretInput}
              onChange={(e) => setBotSecretInput(e.target.value)}
              placeholder="Enter BOT_SECRET value"
              className="font-mono pr-10 bg-background border-border text-sm"
              data-testid="input-bot-secret"
              autoComplete="off"
            />
            <button
              type="button"
              onClick={() => setShowBotSecret((v) => !v)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              tabIndex={-1}
            >
              {showBotSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          <Button
            type="button"
            onClick={() => {
              saveBotSecret(botSecretInput.trim() || null);
              toast({ title: botSecretInput.trim() ? "Bot secret saved" : "Bot secret cleared", description: botSecretInput.trim() ? "Bot mutations will include the secret header." : "Bot mutations will proceed without authentication." });
            }}
            className="bg-primary text-primary-foreground hover:bg-primary/90 font-semibold shrink-0"
            data-testid="button-save-bot-secret"
          >
            Save
          </Button>
          {botSecret && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                saveBotSecret(null);
                setBotSecretInput("");
                toast({ title: "Bot secret cleared" });
              }}
              className="text-destructive border-destructive/40 hover:bg-destructive/10 shrink-0"
              data-testid="button-clear-bot-secret"
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          )}
        </div>
        {botSecret && (
          <p className="text-xs text-primary flex items-center gap-1.5" data-testid="bot-secret-saved-indicator">
            <CheckCircle className="w-3.5 h-3.5" />
            Bot secret is configured
          </p>
        )}
      </div>

      {/* Notification Settings */}
      <div className="bg-card border border-border rounded-md p-5 space-y-4">
        <div className="flex items-center gap-2">
          <Bell className="w-3.5 h-3.5 text-primary" />
          <span className="font-semibold text-sm">Spread Alerts</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Watch a token from the dashboard by clicking the bell icon on its card. An alert fires whenever the spread crosses your configured threshold.
        </p>

        {/* Sound toggle */}
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm">
              {settings.soundEnabled
                ? <Volume2 className="w-4 h-4 text-primary" />
                : <VolumeX className="w-4 h-4 text-muted-foreground" />}
              <span className={settings.soundEnabled ? "text-foreground" : "text-muted-foreground"}>
                Sound alerts
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 ml-6">Play a chime when a watched spread crosses its threshold</p>
          </div>
          <button
            onClick={() => updateSettings({ soundEnabled: !settings.soundEnabled })}
            data-testid="toggle-sound-alerts"
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none ${
              settings.soundEnabled ? "bg-primary" : "bg-muted"
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                settings.soundEnabled ? "translate-x-4" : "translate-x-1"
              }`}
            />
          </button>
        </div>

        {/* Browser push toggle */}
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2 text-sm">
              <Bell className={`w-4 h-4 ${settings.browserPushEnabled ? "text-primary" : "text-muted-foreground"}`} />
              <span className={settings.browserPushEnabled ? "text-foreground" : "text-muted-foreground"}>
                Browser notifications
              </span>
              {!browserPushSupported && (
                <span className="text-xs text-destructive">(not supported)</span>
              )}
              {browserPushSupported && browserPermission === "denied" && (
                <span className="text-xs text-destructive">(blocked — allow in browser settings)</span>
              )}
            </div>
            <p className="text-xs text-muted-foreground mt-0.5 ml-6">Send a browser notification even when the tab is in the background</p>
          </div>
          <button
            onClick={async () => {
              if (settings.browserPushEnabled) {
                updateSettings({ browserPushEnabled: false });
                return;
              }
              if (!browserPushSupported) return;
              setRequestingPush(true);
              const granted = await enableBrowserPush();
              setRequestingPush(false);
              if (!granted) {
                toast({
                  title: "Permission denied",
                  description: "Allow notifications in your browser settings and try again.",
                  variant: "destructive",
                });
              }
            }}
            disabled={!browserPushSupported || requestingPush}
            data-testid="toggle-browser-push"
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none disabled:opacity-40 ${
              settings.browserPushEnabled ? "bg-primary" : "bg-muted"
            }`}
          >
            <span
              className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                settings.browserPushEnabled ? "translate-x-4" : "translate-x-1"
              }`}
            />
          </button>
        </div>

        {/* Watched tokens list */}
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
