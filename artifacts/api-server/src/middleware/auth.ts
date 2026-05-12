import type { Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const auth = getAuth(req);
  const userId = auth?.sessionClaims?.userId as string | undefined || auth?.userId;
  if (!userId) {
    res.status(401).json({ error: "unauthorized", message: "Authentication required" });
    return;
  }
  (req as any).userId = userId;
  next();
}

const BOT_SECRET = process.env["BOT_SECRET"];

export function requireBotSecret(req: Request, res: Response, next: NextFunction): void {
  if (!BOT_SECRET) {
    next();
    return;
  }
  if (req.headers["x-bot-secret"] === BOT_SECRET) {
    next();
    return;
  }
  res.status(401).json({ error: "unauthorized", message: "Missing or invalid X-Bot-Secret header" });
}
