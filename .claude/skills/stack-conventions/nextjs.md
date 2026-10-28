# Next.js (App Router)

These follow the official Next.js Learn course (`nextjs.org/learn/dashboard-app`). They are
rules, not suggestions: a plan, change or review that breaks one is wrong even if it works.
If one truly cannot apply, say so in the plan with the reason; do not silently work around it.

**Next.js is newer than your training data.** Before using a Next.js API, config option or
file convention, read the matching guide in `node_modules/next/dist/docs/` (see `AGENTS.md`).
When `next build` or `next dev` prints an error with named fixes, apply the fix it names.

## Stack

Next.js App Router, TypeScript strict, React with the React Compiler, the chosen styling
(`styling.md`), `next/font`, `next/image`, Zod. Theme(s) as the spec decides; every colour
pair is checked for contrast in each theme. Radix (`radix-ui`) for interactive primitives (dialog,
popover, dropdown, select, tabs, tooltip, toast). `@heroicons/react` for icons.
`use-debounce` for search input. Nothing else without a reason in the plan.

## Structure (as in the course)

```
app/
  lib/data.ts          all database reads (one async function per query)
  lib/actions.ts       all Server Actions ('use server'), with their Zod schemas and State types
  lib/definitions.ts   TypeScript types for the data
  lib/utils.ts         pure helpers (formatting, pagination math)
  lib/db.ts            the database client, created once
  ui/<area>/*.tsx      components, kebab-case file names (invoices/table.tsx, search.tsx)
  ui/skeletons.tsx     loading skeletons
  <route>/page.tsx, layout.tsx, loading.tsx, error.tsx, not-found.tsx
```

Route groups `(name)` scope a `loading.tsx` to one page. Tests sit next to the file
(`*.test.ts[x]`, Vitest); browser tests in `e2e/` (Playwright).

## Reading data

- **Query the database directly from Server Components** through `app/lib/data.ts`. Do not
  build an API to read your own data: "Since Server Components run on the server, you can
  query the database directly without an additional API layer."
- **No `useEffect` + `fetch`, no `useState` for server data, no client data library.** Pages
  and server components are `async` and `await` the data function.
- **Avoid waterfalls:** start independent queries together with `Promise.all`.
- **Stream:** move each slow fetch down into the component that needs it, wrap it in
  `<Suspense fallback={<...Skeleton />}>`, and group components that should appear together
  in one wrapper. A page-level `loading.tsx` gives the instant shell.
- With Cache Components on, uncached data must sit inside `<Suspense>`; follow the fix the
  build error names. Cache only what is shared and safe to cache (`'use cache'`).
- Data functions wrap the query in try/catch, log the real error (structured, see `../metrics/SKILL.md`), and throw a short message.
- **An external API** instead of a database: the same rules, with `app/lib/api.ts` in place of
  `data.ts`; the browser never calls it; check `res.ok`, a 404 → `null` → `notFound()`.

## Search, filters, pagination, tabs, selection

**State that describes what the user is looking at lives in the URL**, not in React state:
bookmarkable, shareable, and readable on the server.
- The page reads `searchParams` (a Promise: `await props.searchParams`) and passes `query`
  and `page` to a server component that fetches.
- The client control uses `useSearchParams`, `usePathname` and `useRouter().replace` with
  `URLSearchParams`. The course's uncontrolled input (`defaultValue`) is fine only if nothing
  else changes the query. If a link or button elsewhere does (a "Clear" link, back/forward),
  make the input controlled with `useState` and adjust it during render when the URL's
  value changes (React's "adjusting state when a prop changes"; no `useEffect`), so it
  keeps the user's typing and focus.
- Debounce typing with `useDebouncedCallback` from `use-debounce` (300 ms). A new search
  resets `page` to 1.
- Give the results' `<Suspense>` a `key={query + currentPage}` so the skeleton shows on change.

## Writing data and forms

- **Server Actions, not API endpoints,** for every write from this app's UI. They live in
  `app/lib/actions.ts` (`'use server'`).
- **Forms post to the action:** `<form action={formAction}>` with `name` attributes, read with
  `formData.get(...)`. Pass ids with `action.bind(null, id)`, never hidden inputs.
- **Validate on the server with Zod `safeParse`** (`z.coerce` for numbers). On failure, return
  `{ errors: z.flattenError(error).fieldErrors, message }`.
- **`useActionState(action, initialState)`** in the client form for errors and `isPending`.
  Show errors in a `<div id="<field>-error" aria-live="polite" aria-atomic="true">` that the
  input references with `aria-describedby`. Follow `.claude/skills/stack-conventions/reference/greeting-form.tsx` and `reference/actions.ts` (copies kept here, because the starter's example page is deleted once real work starts). Native
  `required`, `type`, `min` attributes are welcome as a first line.
- **After a write:** database call inside `try/catch` returning `{ message }` on failure;
  then `revalidatePath(...)` (or `updateTag` for tagged cache), then `redirect(...)` **outside**
  the try/catch.
- Delete = a small form whose action is the bound delete action.
- **A control that saves as soon as it changes** (a status select, a checkbox, a toggle) does
  not use a `<form action>`: React resets the form after the action, which snaps the control
  back. Use the bound action with `useActionState`, show the new value with `useOptimistic`,
  and call both inside `startTransition` from `onChange`, building a `FormData` by hand.
  A failed save falls back to the saved value and shows the returned message in an
  `aria-live` region. This is the approved pattern, not a deviation to flag.
- Optimistic UI only when the wait is noticeable: `useOptimistic` around the action.

## When an API (Route Handler) is right

Only when something **outside this app's UI** calls it: the assignment explicitly asks for an
HTTP/REST API, a webhook, a mobile client, a third party. Even then:
- the Route Handler validates with Zod and calls the **same** `app/lib/data.ts` and write
  functions the Server Actions use;
- **this app's own pages still read in Server Components and write with Server Actions.** An
  assignment that requires an API does not require the UI to go through it. If the
  assignment's wording really says the UI must call the API, quote that sentence in the plan.

## Client components and state

- Server Components by default. `'use client'` only on the smallest leaf that needs state,
  event handlers or browser-only hooks (`usePathname` for active links, the search input,
  the form with `useActionState`).
- **`useState` for local UI state.** Do not use `useReducer` unless several values change
  together through many different events and `useState` would make that error-prone; the
  plan must say why, and lint requires a disable comment with that reason.
- Before adding any state, check: can it be derived during render? Can it live in the URL?
  Is it server data (then read it on the server)?
- No manual memoization: no `useMemo`, `useCallback`, `memo` (the compiler does it; lint
  fails the import). `useEffect` only to sync with something outside React.
- Context or Zustand only for client state shared across distant components; TanStack Query
  only for client polling, infinite scroll or background refetch. Both need a reason in
  the plan. TanStack Form only for forms `useActionState` cannot handle (dynamic field
  arrays, multi-step wizards with client-side cross-field validation).

## Navigation, errors, metadata, auth

- `<Link>` for every internal link (prefetching); active link with `usePathname` + `clsx`.
- `error.tsx` (a client component) per route segment that fetches. Use the prop the installed
  docs name: from Next.js 16.3 that is `retry` (re-fetches), not the course's `reset`; `notFound()` +
  `not-found.tsx` when a record by id is missing.
- Root `metadata` with `title: { template: '%s | <app>', default: '<app>' }`; each page
  sets its own `title`.
- Auth, if needed: Auth.js (`next-auth@beta`) as in the course (`auth.config.ts`, `auth.ts`
  with Credentials + bcrypt, `proxy.ts` to protect routes, login form with `useActionState`,
  sign-out in a server form action). Read the installed docs first: names may have changed.

## TypeScript and code

No `any`, no `@ts-ignore`, no non-null `!` to silence the compiler. Types come from
`definitions.ts` or `z.infer`. Secrets only on the server; only `NEXT_PUBLIC_*` reaches the
browser. Never disable a lint rule without a comment giving the reason. Never skip or delete
a failing test.
