import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import app from "./app";
import { logger } from "./lib/logger";
import { fetchPriceSpreads, prewarmKlinesCache, KLINES_PREWARM_INTERVAL_MS, PREWARM_SYMBOLS, PREWARM_INTERVALS } from "./routes/exchanges";
import { startBotWatcher } from "./services/bot-watcher";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  if (request.url === "/api/ws/prices") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

let broadcastTimer: ReturnType<typeof setTimeout> | null = null;

async function broadcastPrices() {
  if (wss.clients.size === 0) {
    broadcastTimer = null;
    return;
  }
  try {
    const spreads = await fetchPriceSpreads();
    const payload = JSON.stringify(spreads);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  } catch (err) {
    logger.error({ err }, "WS broadcast: error fetching prices");
  }
  broadcastTimer = setTimeout(broadcastPrices, 1500);
}

wss.on("connection", (ws) => {
  logger.info({ clients: wss.clients.size }, "WS client connected");

  if (!broadcastTimer) {
    broadcastPrices().catch((err) => logger.error({ err }, "WS broadcast loop error"));
  }

  ws.on("close", () => {
    logger.info({ clients: wss.clients.size }, "WS client disconnected");
    if (wss.clients.size === 0 && broadcastTimer) {
      clearTimeout(broadcastTimer);
      broadcastTimer = null;
    }
  });

  ws.on("error", (err) => {
    logger.error({ err }, "WS client error");
  });
});

server.listen(port, (err?: Error) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  fetchPriceSpreads()
    .then(() => logger.info("Startup price cache warm-up complete"))
    .catch((e) => logger.warn({ err: e }, "Startup price cache warm-up failed"));

  const prewarmTotal = PREWARM_SYMBOLS.length * PREWARM_INTERVALS.length;

  prewarmKlinesCache()
    .then(({ succeeded, failed }) => {
      if (failed > 0) {
        logger.warn({ succeeded, failed, total: prewarmTotal }, "Startup klines cache pre-warm completed with failures");
      } else {
        logger.info({ succeeded, total: prewarmTotal }, "Startup klines cache pre-warm complete");
      }
    })
    .catch((e) => logger.warn({ err: e }, "Startup klines cache pre-warm failed"));

  setInterval(() => {
    prewarmKlinesCache()
      .then(({ succeeded, failed }) => {
        if (failed > 0) {
          logger.warn({ succeeded, failed }, "Scheduled klines cache pre-warm completed with failures");
        }
      })
      .catch((e) => logger.warn({ err: e }, "Scheduled klines cache pre-warm failed"));
  }, KLINES_PREWARM_INTERVAL_MS);

  startBotWatcher();
});
