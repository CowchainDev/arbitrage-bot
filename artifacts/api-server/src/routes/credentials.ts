import { Router, type IRouter, type Request, type Response } from "express";
import { StoreCredentialBody } from "@workspace/api-zod";
import { db } from "@workspace/db";
import { credentialsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

router.post("/credentials", async (req: Request, res: Response) => {
  const parsed = StoreCredentialBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "bad_request", message: parsed.error.message });
    return;
  }

  const { exchange, apiKey, apiSecret } = parsed.data;

  try {
    await db
      .insert(credentialsTable)
      .values({ exchange, apiKey, apiSecret, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: credentialsTable.exchange,
        set: { apiKey, apiSecret, updatedAt: new Date() },
      });

    res.json({ exchange, stored: true });
  } catch (err) {
    req.log.error({ err }, "Failed to store credentials");
    res.status(500).json({ error: "internal_error", message: "Failed to store credentials" });
  }
});

router.get("/credentials", async (_req: Request, res: Response) => {
  try {
    const rows = await db
      .select({ exchange: credentialsTable.exchange, updatedAt: credentialsTable.updatedAt })
      .from(credentialsTable);

    res.json({ exchanges: rows.map((r) => ({ exchange: r.exchange, updatedAt: r.updatedAt })) });
  } catch (err) {
    res.status(500).json({ error: "internal_error", message: "Failed to fetch credentials" });
  }
});

export async function getStoredCredentials(exchange: "bybit" | "binance"): Promise<{ apiKey: string; apiSecret: string } | null> {
  try {
    const [row] = await db
      .select({ apiKey: credentialsTable.apiKey, apiSecret: credentialsTable.apiSecret })
      .from(credentialsTable)
      .where(eq(credentialsTable.exchange, exchange))
      .limit(1);
    return row ?? null;
  } catch {
    return null;
  }
}

export { router as credentialsRouter };
