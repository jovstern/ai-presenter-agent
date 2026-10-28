# SQL (Postgres, SQLite)

Postgres hosted (Neon through Vercel Storage on this machine) or SQLite (`better-sqlite3`) for
a single-instance app. Connection strings only in `.env` (never read or printed by Claude).

- **Access layer:** the Next.js course's way — the `postgres` package with tagged-template
  SQL (parameterised automatically) — for small apps. **Drizzle ORM** when the schema has more
  than a few tables or needs migrations and typed queries; the plan names which.
- **Migrations are code:** every schema change is a migration file in the repo, applied by a
  script (`npm run db:migrate`); never edit the schema by hand.
- **Constraints in the database:** `NOT NULL`, foreign keys, `UNIQUE`, `CHECK`. The database
  is the last line of validation; Zod is the first.
- **Indexes** for every `WHERE`, `JOIN` and `ORDER BY` the app runs on a table that can grow.
  `EXPLAIN ANALYZE` a query that might scan.
- **Never interpolate user input** into SQL: tagged templates or the ORM's parameters only.
- **Transactions** for any write touching more than one row or table.
- **No N+1:** fetch related rows with a join or one `IN (...)` query.
- **Pagination:** keyset (`WHERE created_at < $cursor ORDER BY created_at DESC LIMIT n`)
  for feeds; `LIMIT/OFFSET` only for small, bounded lists.
- **Money** as integer cents; time as `timestamptz` (UTC).
- **Tests:** their own database file or schema, created and dropped per run. Never touch the
  app's data.
- **Seed:** `npm run db:seed`, idempotent.
