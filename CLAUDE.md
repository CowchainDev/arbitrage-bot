# Database Changes

**All schema changes MUST go through migrations.**

- Never run raw `ALTER TABLE`, `CREATE TABLE`, `DROP`, or `CREATE INDEX` directly against the DB
- Never modify existing migration files — always create a new one
- Migration naming: `NNNN_short_description.sql` (next sequential number)
- Add entry to `lib/db/migrations/meta/_journal.json` for every new migration
- Update Drizzle schema in `lib/db/src/schema/index.ts` to match
- Use `IF NOT EXISTS` / `IF EXISTS` guards for idempotency
