import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { KeyRound, Eye, EyeOff, CheckCircle, Trash2, ExternalLink } from "lucide-react";
import { useApiCredentials, type ApiCredentials } from "@/hooks/use-api-credentials";
import { useToast } from "@/hooks/use-toast";
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
  const { toast } = useToast();
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});

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

  const onSubmit = (data: CredentialsForm) => {
    saveCredentials(data as ApiCredentials);
    toast({
      title: "Credentials saved",
      description: "Your API keys have been saved to your browser.",
    });
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
    field: Parameters<typeof FormControl>[0]["children"] extends never ? never : React.ComponentProps<typeof FormControl>["children"] extends never ? never : { value: string; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void; name: string };
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
            Keys are stored locally in your browser. Never transmitted to third parties.
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
        <p>API keys are stored only in your browser&apos;s localStorage. They are sent directly to exchange APIs via the backend proxy and never persisted server-side.</p>
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
                    <SecretInput field={field as unknown as { value: string; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void; name: string }} placeholder="Enter Bybit API Secret" name="bybitApiSecret" />
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
                    <SecretInput field={field as unknown as { value: string; onChange: (e: React.ChangeEvent<HTMLInputElement>) => void; name: string }} placeholder="Enter Binance API Secret" name="binanceApiSecret" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <div className="flex items-center gap-3">
            <Button
              type="submit"
              className="bg-primary text-primary-foreground hover:bg-primary/90 font-semibold"
              data-testid="button-save-credentials"
            >
              Save Credentials
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
          </div>
        </form>
      </Form>
    </div>
  );
}
