import { useEffect, useRef } from "react";
import { Switch, Route, Redirect, useLocation, Router as WouterRouter } from "wouter";
import { ClerkProvider, SignIn, SignUp, Show, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Layout } from "@/components/layout";
import Dashboard from "@/pages/dashboard";
import TokenDetail from "@/pages/token-detail";
import Bots from "@/pages/bots";
import History from "@/pages/history";
import Settings from "@/pages/settings";
import NotFound from "@/pages/not-found";
import LandingPage from "@/pages/landing";
import { ConnectionStatusProvider } from "@/contexts/connection-status";
import { ThemeProvider } from "@/contexts/theme";
import { NotificationsProvider } from "@/contexts/notifications";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: "hsl(152, 80%, 45%)",
    colorForeground: "hsl(210, 20%, 92%)",
    colorMutedForeground: "hsl(215, 15%, 55%)",
    colorDanger: "hsl(354, 85%, 55%)",
    colorBackground: "hsl(220, 13%, 10%)",
    colorInput: "hsl(215, 15%, 20%)",
    colorInputForeground: "hsl(210, 20%, 92%)",
    colorNeutral: "hsl(215, 15%, 16%)",
    fontFamily: "'JetBrains Mono', Menlo, monospace",
    borderRadius: "0.375rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-[hsl(220,13%,10%)] border border-[hsl(215,15%,16%)] rounded-xl w-[440px] max-w-full overflow-hidden shadow-2xl",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-[hsl(210,20%,92%)] font-bold",
    headerSubtitle: "text-[hsl(215,15%,55%)]",
    socialButtonsBlockButtonText: "text-[hsl(210,20%,92%)]",
    formFieldLabel: "text-[hsl(210,20%,75%)]",
    footerActionLink: "text-[hsl(152,80%,45%)] hover:text-[hsl(152,80%,55%)]",
    footerActionText: "text-[hsl(215,15%,55%)]",
    dividerText: "text-[hsl(215,15%,45%)]",
    identityPreviewEditButton: "text-[hsl(152,80%,45%)]",
    formFieldSuccessText: "text-[hsl(152,80%,45%)]",
    alertText: "text-[hsl(210,20%,92%)]",
    logoBox: "flex justify-center",
    logoImage: "h-8",
    socialButtonsBlockButton: "border border-[hsl(215,15%,22%)] bg-[hsl(220,13%,13%)] hover:bg-[hsl(220,13%,16%)] transition-colors",
    formButtonPrimary: "bg-[hsl(152,80%,45%)] hover:opacity-90 text-[hsl(220,13%,7%)] font-semibold transition-opacity",
    formFieldInput: "bg-[hsl(215,15%,15%)] border border-[hsl(215,15%,22%)] text-[hsl(210,20%,92%)] focus:border-[hsl(152,80%,45%)] focus:ring-[hsl(152,80%,45%)]",
    footerAction: "border-t border-[hsl(215,15%,16%)]",
    dividerLine: "bg-[hsl(215,15%,20%)]",
    alert: "bg-[hsl(215,15%,13%)] border border-[hsl(215,15%,20%)]",
    otpCodeFieldInput: "bg-[hsl(215,15%,15%)] border border-[hsl(215,15%,22%)] text-[hsl(210,20%,92%)]",
    formFieldRow: "",
    main: "",
  },
};

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) {
        qc.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, qc]);

  return null;
}

function SignInPage() {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <SignIn
        routing="path"
        path={`${basePath}/sign-in`}
        signUpUrl={`${basePath}/sign-up`}
        fallbackRedirectUrl={basePath || "/"}
      />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <SignUp
        routing="path"
        path={`${basePath}/sign-up`}
        signInUrl={`${basePath}/sign-in`}
        fallbackRedirectUrl={basePath || "/"}
      />
    </div>
  );
}

function HomeRoute() {
  return (
    <>
      <Show when="signed-in">
        <Layout>
          <Dashboard />
        </Layout>
      </Show>
      <Show when="signed-out">
        <LandingPage />
      </Show>
    </>
  );
}

function GuardedRoute({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Show when="signed-in">
        <Layout>{children}</Layout>
      </Show>
      <Show when="signed-out">
        <Redirect to="/" />
      </Show>
    </>
  );
}

function AppRoutes() {
  return (
    <Switch>
      <Route path="/" component={HomeRoute} />
      <Route path="/sign-in/*?" component={SignInPage} />
      <Route path="/sign-up/*?" component={SignUpPage} />
      <Route path="/token/:symbol">
        {(params) => (
          <GuardedRoute>
            <TokenDetail params={params as { symbol: string }} />
          </GuardedRoute>
        )}
      </Route>
      <Route path="/bots">
        <GuardedRoute>
          <Bots />
        </GuardedRoute>
      </Route>
      <Route path="/history">
        <GuardedRoute>
          <History />
        </GuardedRoute>
      </Route>
      <Route path="/settings">
        <GuardedRoute>
          <Settings />
        </GuardedRoute>
      </Route>
      <Route>
        <Show when="signed-in">
          <Layout>
            <NotFound />
          </Layout>
        </Show>
        <Show when="signed-out">
          <Redirect to="/" />
        </Show>
      </Route>
    </Switch>
  );
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey!}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      afterSignOutUrl={basePath || "/"}
      localization={{
        signIn: {
          start: {
            title: "Welcome back",
            subtitle: "Sign in to your ARB_TERM account",
          },
        },
        signUp: {
          start: {
            title: "Create your account",
            subtitle: "Start trading with ARB_TERM today",
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <TooltipProvider>
          <ConnectionStatusProvider>
            <NotificationsProvider>
              <AppRoutes />
              <Toaster />
              <SonnerToaster position="bottom-right" richColors />
            </NotificationsProvider>
          </ConnectionStatusProvider>
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <ThemeProvider>
      <WouterRouter base={basePath}>
        <ClerkProviderWithRoutes />
      </WouterRouter>
    </ThemeProvider>
  );
}

export default App;
