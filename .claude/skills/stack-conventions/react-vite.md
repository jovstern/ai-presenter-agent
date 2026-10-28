# React + Vite (SPA)

These are rules, not suggestions. A plan, change or review that breaks one is wrong even if
it works. If a rule truly cannot apply, stop and ask the user; do not work around it.

## Stack

- **Build:** Vite. **Language:** TypeScript, strict (see `tsconfig.json`).
- **UI:** latest React with the React Compiler enabled in `vite.config.ts`.
- **Styling:** as chosen, see `styling.md`.
- **Primitives:** Radix (`radix-ui`) for anything interactive that has accessibility
  behavior: dialog, popover, dropdown, select, tabs, tooltip, toast, switch, checkbox.
  Never hand-roll these.
- **Server data:** TanStack Query. **Forms:** TanStack Form + Zod.
- **Backend (only if the project has one):** see `node-api.md`.

## React

- **No manual memoization.** Do not import `useMemo`, `useCallback` or `memo`. The compiler
  does this, and lint fails the import.
- **`useEffect` is only for syncing with something outside React** (a subscription, a
  browser API, a third-party widget). Never use it to fetch, to derive state, or to react to
  a prop change.
- **Derived values are computed during render**, not stored in state.
- Pick the primitive that matches the job:
  - non-urgent update → `useTransition` / `useDeferredValue`
  - optimistic UI → `useOptimistic` (or TanStack Query's optimistic update for server data)
  - reading a promise or context conditionally → `use`, inside `Suspense`
  - loading states → `Suspense`; failures → an error boundary
  - ids for labels and aria → `useId`
  - refs → pass `ref` as a normal prop (no `forwardRef`)
  - resetting a component's state → change its `key`
- One component per file, named export, file named after the component.

## Data

- Every fetch and mutation goes through TanStack Query (`useQuery`, `useSuspenseQuery`,
  `useMutation`). No `fetch` inside an effect or event handler that bypasses it.
- Query keys and fetch functions live together in the feature folder as `queryOptions(...)`
  factories. Invalidate from the mutation's `onSuccess`.
- Parse every server response with a Zod schema before it reaches a component.
- Never copy server data into Zustand or `useState`.

## Forms

- Every form uses TanStack Form with a Zod schema as the validator. Follow
  `src/features/greeting/GreetingForm.tsx` (the starter): label tied to input, error shown with
  `role="alert"`, `aria-invalid` and `aria-describedby` set.

## Client state

Choose the smallest that works, in this order:

1. `useState` / `useReducer` in the component.
2. Lifted state or context, for one subtree.
3. Zustand, only when distant parts of the app share state. One small store per concern,
   read through selectors.

## TypeScript

- No `any`. No `@ts-ignore`. `@ts-expect-error` only with a written reason.
- No non-null `!` to silence the compiler; narrow instead.
- Types for data that crosses a boundary are inferred from its Zod schema (`z.infer`).

## Structure

- `src/features/<feature>/` holds a feature's components, hooks, queries and tests together.
- `src/lib/` holds cross-feature helpers. `src/components/` holds shared UI only.
- Tests sit next to the file they test as `*.test.tsx`. Browser tests live in `e2e/`.

## Never

- Disable a lint rule inline without a comment giving the reason.
- Add a dependency that duplicates one above (another form, fetching, state or UI library).
- Skip or delete a failing test to get a green run.
