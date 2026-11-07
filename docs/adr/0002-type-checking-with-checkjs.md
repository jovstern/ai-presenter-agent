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
- **`src/__tests__/` was not type-checked at first** (it is since M9 T5, below): its fakes
  stood in loosely for typed values (strings for snapshot nodes, partial sessions).
  `server/__tests__/` still isn't (the server config includes only `*.js` at its root), nor
  is `e2e/` (linted, not type-checked).
- Typing surfaced three real bugs, fixed with tests: a model-supplied `toString` tool name
  threw in `toPositionalArgs`; a token response without a token threw outside `openSession`'s
  `try` and left the status at `connecting`; `fill` on an element without `value` reported
  success.

## The unit tests (M9 T5, #21)

- `agent-client/jsconfig.tests.json` extends `jsconfig.json` with `src/__tests__/` and Node's
  types (the tests read files with `node:fs`); `npm run typecheck` runs it third. The main
  config still excludes the tests, so neither `node` nor any test type reaches `src/`.
- 767 errors, nearly all fakes and helpers without types. The fakes are now typed as what
  they stand in for (`SnapshotNode`s, `LiveSessionOptions`, `BridgeChannel` methods, the
  `FakeAudioContext`'s nodes); a test that needs a value it knows is there narrows it with
  `defined()` or `elementOf()` (`src/__tests__/defined.js`), which throw with a message
  instead of casting past `null`. The ~19 uncommented casts the tests already had went the
  same way.
- One cast is left, in `liveSdk.test.js`: a one-export stand-in for the SDK module, which the
  loader only passes on. No `@ts-expect-error`.
- `captureWorklet.test.js` imports the worklet through a non-literal specifier: the worklet is
  a classic script that `jsconfig.worklet.json` checks against its own scope, and a literal
  `import()` would pull it into the tests' program without those types.
- `@types/node` comes in transitively (the SDK's `protobufjs`, Vite), not as a direct
  dependency.
