#!/bin/bash
# Rebuild all composite TypeScript packages that the frontend project references
# before running the typecheck, so stale declaration files in dist/ can never
# cause a false failure.
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Building lib/db..."
(cd "$ROOT/lib/db" && npx tsc --build)

echo "Building lib/api-zod..."
(cd "$ROOT/lib/api-zod" && npx tsc --build)

echo "Building lib/api-client-react..."
(cd "$ROOT/lib/api-client-react" && npx tsc --build)

echo "Type-checking @workspace/arbitrage-app..."
pnpm --filter @workspace/arbitrage-app exec tsc --noEmit --project tsconfig.json
