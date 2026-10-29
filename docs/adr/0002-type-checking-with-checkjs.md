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
