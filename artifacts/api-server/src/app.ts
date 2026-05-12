import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import router from "./routes";
import { logger } from "./lib/logger";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";

const app: Express = express();

const ALLOWED_ORIGIN = process.env["ALLOWED_ORIGIN"];

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

app.use(
  cors({
    origin: ALLOWED_ORIGIN ?? true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Bot-Secret",
      "X-Bybit-Api-Key",
      "X-Bybit-Api-Secret",
      "X-Binance-Api-Key",
      "X-Binance-Api-Secret",
      "X-Gate-Api-Key",
      "X-Gate-Api-Secret",
      "X-Okx-Api-Key",
      "X-Okx-Api-Secret",
      "X-Okx-Passphrase",
      "X-Mexc-Api-Key",
      "X-Mexc-Api-Secret",
      "X-Aster-Wallet-Address",
      "X-Aster-Private-Key",
      "X-Aster-Signer-Address",
      "X-Hyperliquid-Wallet-Address",
      "X-Hyperliquid-Private-Key",
    ],
  }),
);

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true, limit: "100kb" }));

app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env.CLERK_PUBLISHABLE_KEY,
    ),
  })),
);

app.get("/health", (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.use("/api", router);

export default app;
