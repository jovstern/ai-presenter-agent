# 0002 — Type checking via `checkJs` + JSDoc, not a TypeScript migration

Status: accepted (2026-10-28)

## Context

The repo is plain JS/JSX. The kit's default is TypeScript strict. The bugs that matter here
cross seams:
- bridge message shapes;
- tool argument records;
- session callbacks.

## Options

1. **`tsc --noEmit` with `allowJs` + `checkJs`, JSDoc types on the seams.** No renames. Runs
   inside `npm run check`.
2. **Full migration to `.ts`/`.tsx`, strict.** Matches the kit, but means churn across every
   file in four directories.
3. **No types.**

## Decision

Option 1, chosen by the user. Typing starts at the seams:
- the bridge protocol, as one `@typedef` module;
- `actionTools`;
- the `liveSession` callbacks.

It widens from there.

## Consequences

- No `any`-style escape hatches: `@ts-expect-error` only with a reason.
- TypeScript 7 is the native port. If its JSDoc checking falls short, the task pins the
  latest 6.x and records why.
- A later full migration stays possible and is mostly mechanical once the JSDoc types exist.

## As built (M5 T2, 2026-10-29)

- **TypeScript 7.0.2**, the current `latest`. Checked before pinning: it runs
  `tsc -p jsconfig.json` and checks `@typedef`, `@callback`, `@import` and type predicates in
  JS under `checkJs` + `strict`. No 6.x pin was needed.
- One `jsconfig.json` per package (`checkJs`, `strict`, `noEmit`; `npm run typecheck`, part
  of `check`). agent-client: `jsx: react-jsx`, `types: ["vite/client"]`, `resolveJsonModule`,
  `src/globals.d.ts` for `window.__DS_NONCE__` (removed in M5 T3, when the nonce moved to a
  `data-ds-nonce` attribute for the CSP), and `../sandbox/bridge.js` included. Server:
  `types: ["node"]`, NodeNext resolution.
- The bridge protocol lives in `agent-client/src/bridgeProtocol.js`. `sandbox/bridge.js` is an
  unbundled classic script, so it carries a verbatim copy inside its IIFE (where the typedefs
  stay local); `bridgeProtocol.test.js` compares the two regions as text.
- `maxNodeModuleJsDepth: 0` in both configs: `allowJs` otherwise type-checks untyped
  third-party JS (`compression`'s dependencies, `punycode`) under our `strict`. A dependency
  without types needs its `@types` package (`@types/compression`) or fails the check.
- **`src/__tests__/` is not type-checked yet.** Its fakes stand in loosely for typed values
  (strings for snapshot nodes, partial sessions); typing them is test churn with no bug to
  find. Widening to the tests is a later task, not a looser setting.
- Typing surfaced three real bugs, fixed with tests: a model-supplied `toString` tool name
  threw in `toPositionalArgs`; a token response without a token threw outside `openSession`'s
  `try` and left the status at `connecting`; `fill` on an element without `value` reported
  success.
