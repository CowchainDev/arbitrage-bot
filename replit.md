# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Bot Watcher Architecture

A background watcher (`artifacts/api-server/src/services/bot-watcher.ts`) runs every 1500ms server-side. For each enabled bot config:
1. Reads current spread from in-memory price cache (no extra exchange calls)
2. Opens a new leg when spread ≥ `enterSpreadPct` and open leg count < `maxOrders`
3. Closes open legs when spread ≤ `closeSpreadPct` OR total PnL < -`forceStopUsd`
4. Uses server-stored credentials from the `credentials` table

Bot CRUD API: `GET/POST /bots`, `PUT/DELETE /bots/:id`, `POST /bots/:id/start`, `POST /bots/:id/stop`, `GET /bots/:id/legs`

Tables: `bot_configs` (config per token), `bot_legs` (one row per open DCA leg), `credentials` (server-side API keys)

## Funding Rate Feature (Task #164)

Funding rates are fetched alongside price data in `fetchAndCachePrices()` (exchanges.ts) and cached per-symbol in `fundingRateCacheBySymbol`. Two helpers are exported: `getFundingRateEntry(symbol)` and `getFundingRateForExchange(entry, exchange)`.

**DB schema**: both `closed_trades` and `bot_legs` tables have a nullable `fundingPaidUsd` column (added via `pnpm --filter @workspace/db push`).

**Funding formula**: `(msHeld / 28800000) × (shortRate − longRate) × usdSize`
- Positive = net funding received (short leg rate > long leg rate)
- Applied in `closeLeg()` (bot-watcher.ts) and `/exchanges/close-position` HTTP handler

**Frontend**:
- **History page**: "Funding" column shows `fundingPaidUsd` (+ = green / − = red, null = "—")
- **Open Positions rows**: per-leg funding rates, accrued funding, funding-adj P&L, and next-funding countdown
- **Dashboard FR Δ column**: delta + cheap-leg rate in tiny text + live countdown
