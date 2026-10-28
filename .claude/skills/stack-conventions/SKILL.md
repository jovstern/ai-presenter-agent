---
name: stack-conventions
description: The house engineering rules for every project built with this kit - general principles plus one file per stack (Next.js, React + Vite, Node API, MongoDB, SQL, styling). Read before recommending an architecture, writing a plan, writing code, or reviewing code.
---

# Stack conventions

Rules, not suggestions: a plan, change or review that breaks one is wrong even if it works.
If one truly cannot apply, the plan says so with the reason; nothing silently works around it.

## Which files apply

Read this file, then every file below that matches the project's chosen stack (the spec's
"Stack" section names them):

| Stack piece | File |
|---|---|
| Next.js (App Router, full stack) | `nextjs.md` (forms: `reference/greeting-form.tsx`, `reference/actions.ts`) |
| React SPA on Vite | `react-vite.md` |
| A separate Node HTTP API (Express or Fastify) | `node-api.md` |
| MongoDB | `mongodb.md` |
| SQL (Postgres, SQLite) | `sql.md` |
| Tailwind or CSS Modules | `styling.md` |
| Look, feel and UX | `../ui-craft/SKILL.md` |
| Logging and measurement | `../metrics/SKILL.md` |

## An existing project

Its own conventions (its `CLAUDE.md`, docs and the code as written) win where they differ
from these files: new code matches the code around it. The rules here still apply where the
project is silent (accessibility, security, state, clean code). A difference worth fixing
(JavaScript → TypeScript, adding lint, a different state approach) is a proposal in the
assessment for the user to decide, then an ADR and plan tasks; never a silent rewrite or a
drive-by change inside an unrelated task.

## Choosing a stack (for the architecture step)

Pick the **simplest stack that fully fits the product**, and only stable releases:
- Content site, portfolio, app with SEO or server data → **Next.js** (one deployable, Server
  Components, no separate API).
- Highly interactive client app with no SEO needs, behind a login, or embedded → **React +
  Vite**, plus `node-api.md` only if it needs its own backend.
- A backend other clients call (mobile, third parties, several frontends) → **Node API**.
- Data: no database if content can live in files (MDX, JSON) in the repo; **Postgres** for
  relational data and anything with joins or constraints; **SQLite** for a single-instance
  app or local-first; **MongoDB** for document-shaped data that is read whole.
- Versions: the current stable major of each tool, Node active LTS. No canary, beta or RC
  unless the user asks. Check the version and docs before recommending (`npm view <pkg>
  version`, the context7 MCP, or the package's docs), never from memory.

## Principles for every stack

- **TypeScript strict.** No `any`, no `@ts-ignore`, no non-null `!` to silence the compiler.
  Data crossing a boundary (HTTP, database, env, forms) is parsed with Zod; its type is
  `z.infer` of that schema.
- **React:** the React Compiler is on, so no `useMemo`, `useCallback` or `memo`. Derive during
  render instead of storing. `useEffect` only to sync with something outside React. `useState`
  first; `useReducer` only with a written reason. Change a `key` to reset state.
- **Server data is never copied into client state.** It lives on the server (Next.js) or in
  the query cache (Vite + TanStack Query).
- **State that describes what the user is looking at lives in the URL** (filters, tabs,
  selection, page): shareable and survives a reload.
- **Separation of concerns:** data access in one layer, pure logic in `utils` with unit tests,
  components that render. One component per file, named after it.
- **Errors:** every boundary handles failure explicitly: user-facing message, real error
  logged with context, nothing swallowed.
- **Security:** secrets only on the server and in `.env*` (git-ignored, never read or printed
  by Claude); validate and authorize every write on the server; no user input in raw SQL or
  `$where`; security headers on deploy.
- **Accessibility is a requirement:** semantic HTML, keyboard for everything, visible focus,
  labels, alt text, contrast AA, reduced motion respected.
- **Dependencies:** each one needs a reason in the plan; prefer the platform and the
  framework's built-ins. No two libraries for the same job.
- **Clean code:** names that say what things are, small functions, no dead code, no
  commented-out code, no leftover logs or TODOs in a PR. Comments explain *why*, not what.
- Never disable a lint rule without a comment giving the reason. Never skip or delete a
  failing test.
