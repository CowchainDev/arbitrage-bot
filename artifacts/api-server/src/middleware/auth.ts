import type { Request, Response, NextFunction } from "express";

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
