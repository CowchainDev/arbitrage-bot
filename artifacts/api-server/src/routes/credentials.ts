import { Router, type IRouter, type Request, type Response } from "express";
import { StoreCredentialBody } from "@workspace/api-zod";
import { db } from "@workspace/db";
import { credentialsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { requireBotSecret } from "../middleware/auth";

const router: IRouter = Router();

export type SupportedExchange = "bybit" | "binance" | "gate" | "okx" | "mexc" | "aster" | "hyper";
export const SUPPORTED_EXCHANGES: SupportedExchange[] = ["bybit", "binance", "gate", "okx", "mexc", "aster", "hyper"];

router.post("/credentials", requireBotSecret, async (req: Request, res: Response) => {
  const parsed = StoreCredentialBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "bad_request", message: parsed.error.message });
    return;
  }

  const { exchange, apiKey, apiSecret } = parsed.data;
  const passphrase = (parsed.data as { passphrase?: string }).passphrase ?? null;

  try {
    await db
      .insert(credentialsTable)
      .values({ exchange, apiKey, apiSecret, passphrase, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: credentialsTable.exchange,
        set: { apiKey, apiSecret, passphrase, updatedAt: new Date() },
      });

    res.json({ exchange, stored: true });
  } catch (err) {
    req.log.error({ err }, "Failed to store credentials");
    res.status(500).json({ error: "internal_error", message: "Failed to store credentials" });
  }
});

router.get("/credentials", requireBotSecret, async (_req: Request, res: Response) => {
  try {
    const rows = await db
      .select({ exchange: credentialsTable.exchange, updatedAt: credentialsTable.updatedAt })
      .from(credentialsTable);

    res.json({ exchanges: rows.map((r) => ({ exchange: r.exchange, updatedAt: r.updatedAt })) });
  } catch {
    res.status(500).json({ error: "internal_error", message: "Failed to fetch credentials" });
  }
});

router.delete("/credentials/:exchange", requireBotSecret, async (req: Request, res: Response) => {
  const { exchange } = req.params;
  if (!SUPPORTED_EXCHANGES.includes(exchange as SupportedExchange)) {
    res.status(400).json({ error: "bad_request", message: "Unknown exchange" });
    return;
  }
  try {
    await db.delete(credentialsTable).where(eq(credentialsTable.exchange, exchange as string));
    res.json({ exchange, deleted: true });
  } catch (err) {
    req.log.error({ err }, "Failed to delete credentials");
    res.status(500).json({ error: "internal_error", message: "Failed to delete credentials" });
  }
});

export async function getStoredCredentials(exchange: SupportedExchange): Promise<{ apiKey: string; apiSecret: string; passphrase?: string | null } | null> {
  try {
    const [row] = await db
      .select({ apiKey: credentialsTable.apiKey, apiSecret: credentialsTable.apiSecret, passphrase: credentialsTable.passphrase })
      .from(credentialsTable)
      .where(eq(credentialsTable.exchange, exchange))
      .limit(1);
    return row ?? null;
  } catch {
    return null;
  }
}

export { router as credentialsRouter };
