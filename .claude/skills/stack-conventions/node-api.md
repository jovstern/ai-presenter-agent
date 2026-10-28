# Node HTTP API (Express or Fastify)

Only when the architecture step decided the app needs its own API (see `SKILL.md`). With
Next.js, Server Components and Server Actions replace it.

## Shape

```
server/
  src/app.ts            builds the app (no listen): middleware, routes, error handler
  src/index.ts          reads config, listens, handles SIGTERM (graceful shutdown)
  src/config.ts         env parsed with Zod once at startup; the app fails fast if invalid
  src/routes/<area>.ts  thin handlers: parse input, call a service, shape the response
  src/services/<area>.ts business logic, no HTTP objects
  src/db/               the database client and repositories (see mongodb.md / sql.md)
  src/schemas/<area>.ts Zod schemas shared with the client (types via z.infer)
```

TypeScript ESM, run with `tsx` in development, compiled or run with `tsx` in production.
Its own `package.json`, tests (Vitest + Supertest against `app.ts`) and gates.

## Rules

- **Validate every input** (body, params, query, headers that matter) with Zod at the route;
  a failure is `400` with `{ error: { code, message, fields } }`. One error shape for the
  whole API.
- **One central error handler**: known errors map to status codes; unknown ones are logged
  with the request id and return `500` without internals.
- **Status codes mean what they say:** 201 + `Location` on create, 204 on delete, 404, 409 on
  conflict, 422 only if the plan chooses it over 400.
- **Logging:** `pino` (JSON) with `pino-http`: a request id on every line, method, path,
  status, duration. No `console.log`. See `../metrics/SKILL.md`.
- **Security:** `helmet`, CORS limited to the known origins, a body size limit, rate
  limiting on auth and write routes, auth checked in middleware and authorisation in the
  service.
- **Health:** `GET /health` (process up) and `GET /ready` (database reachable).
- **Pagination** with a cursor or `limit`/`offset` capped server-side; never return an
  unbounded list.
- An OpenAPI document generated from the Zod schemas if any client other than ours calls it.
