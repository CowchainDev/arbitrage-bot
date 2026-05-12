#!/bin/bash
set -e
pnpm install --frozen-lockfile
pnpm --filter db push-force
# Rebuild all composite TypeScript packages so declaration files in dist/ are
# always fresh. This prevents stale .d.ts from causing false typecheck failures.
(cd lib/db && npx tsc --build)
(cd lib/api-zod && npx tsc --build)
(cd lib/api-client-react && npx tsc --build)
