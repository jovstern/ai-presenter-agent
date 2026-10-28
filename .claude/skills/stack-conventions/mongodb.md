# MongoDB

Local: `mongodb://localhost:27017` (Homebrew service on this machine). Hosted: MongoDB Atlas,
connection string only in `.env` (never read or printed by Claude).

- **Driver:** the official `mongodb` driver with TypeScript types per collection; Mongoose
  only if the plan names a reason (it adds a second schema layer next to Zod).
- **One client per process**, created once and reused (in Next.js, cached on `globalThis` in
  development so hot reload does not open new connections).
- **Schemas:** Zod validates every write; a collection-level `$jsonSchema` validator is added
  for data that must never be malformed.
- **Indexes are part of the code:** declared in one module and created by a script
  (`npm run db:indexes`), one for every query the app runs; unique indexes for natural keys.
  `explain()` any query on a collection that can grow.
- **Ids:** expose `ObjectId` as a string at the boundary; validate incoming ids before
  querying.
- **Model by access pattern:** embed what is read together and bounded; reference what grows
  without limit or is shared.
- **Never build a query from raw user input** (`$where`, operators in user-supplied objects):
  parse with Zod first.
- **Pagination:** range on an indexed field (`_id` or `createdAt`), not large `skip`s.
- **Tests:** a database per test run (`<app>-test-<random>`), dropped at the end. Never touch
  the app's data.
- **Seed:** `npm run db:seed`, idempotent.
