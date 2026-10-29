# Spec — cycle 1: finish the closed loop, add the quality baseline, harden, polish, deploy

Read with `assessment.md` (current state and findings A1–A9) and ADRs 0001–0003.

## Goal and audience

**Audience:**
- the author, as a portfolio piece;
- anyone opening the demo URL;
- a reviewer reading the repo.

**One thing they must be able to do:** open a public HTTPS link, press Talk, ask the agent to
do something ("increment the counter, then turn on notifications and save"), and watch it
say what it is doing while it does it, recovering cleanly if the connection drops.

**Success looks like:**
- the loop works on the deployed URL;
- every gate is green in CI;
- `code-review-notes.md` is fully ticked or deferred with reasons;
- the docs describe the code as it is.

## Requirements checklist

**M4: finish the closed loop (issue #4, PR #9)**
- [ ] R1 The sandbox works at both `/` and `/sandbox/` (A1).
- [ ] R2 Re-connecting never leaves a second mic stream or `AudioContext` alive, and
      unmount releases everything (A2, M4).
- [ ] R3 Status is one of `idle`, `connecting`, `open`, `reconnecting`, `failed`, `closed`.
      `failed` is shown only after the retries run out, together with a Retry action (A3,
      spec goal #6).
- [ ] R4 Agent ↔ bridge traffic runs on a private MessageChannel (A4, ADR 0001).
- [ ] R5 A bridge action that throws replies with `success:false` straight away (A5, M3).
- [ ] R6 `liveSession.js` has unit tests covering reconnect, supersede, serialisation,
      resumption and status (A6, H2).
- [ ] R7 Docs are true (assessment §7), and the review checklist is ticked in place.

**M5: quality baseline (new issue)**
- [ ] R8 ESLint and Prettier, with `npm run check` per package and at a thin root.
- [ ] R9 `tsc --noEmit` with checkJs runs in `check` (ADR 0002).
- [x] R10 Server tests cover the token gate; the server uses pino, helmet + CSP and has
      `/health`. *(M5 T3)*
- [ ] R11 A deterministic Playwright e2e covers the bridge, nonce, a11y and console errors.
- [ ] R12 An opt-in live e2e (fake-mic WAV) records the app metrics.
- [ ] R13 CI runs `check` and the deterministic e2e on each PR, and `master` is protected.

**M6: hardening and tuning (issue #5)**
- [ ] R14 Every remaining M and L item is closed or deferred with a reason.
- [ ] R15 Capture uses an AudioWorklet.
- [ ] R16 Knobs (snapshot cap, refresh ratio, loop threshold) are tuned from live-e2e
      numbers.

**M7: presentable widget (new issue)**
- [ ] R17 A designed card with tokens, light and dark themes, and styles in `styles.css`.
- [ ] R18 A rAF volume meter held in a ref, plus a Profiler render-count test (spec goals
      #8 and #9).
- [ ] R19 A coalesced, bounded transcript with `aria-live`.
- [ ] R20 Connection states shown in the card, with a Radix Toast and Retry.
- [ ] R21 The knowledge modal is polished and has a component test.

**M8: deploy and close the cycle (new issue)**
- [ ] R22 Live on Render over HTTPS, with config parsed at startup.
- [ ] R23 Production observability: pino logs, plus client errors and vitals sent to a
      gated `/api/client-log`.
- [ ] R24 The observer runs against production; the README is final; leftovers are filed
      as issues.

## Assumptions (decided, not asked)

- The server stays one Express app. It is split into `app.js` (testable, no `listen`) and
  `index.js` (config + listen) — a scaled-down `node-api.md`, not the full
  routes/services tree. **Recorded deviation (M5 T3):** one route does real work, so there is
  no `routes/` / `services/` / `schemas/` tree and no `config.ts`; `app.js` keeps the route,
  its Zod query schema and the central error handler together, and `expiringMap.js` is the
  one extracted module. Kept from `node-api.md`: Zod at the route, one error shape
  `{ error: { code, message } }`, a central error handler, pino + pino-http with a request id,
  helmet, `/health`, graceful SIGTERM shutdown, supertest tests against `app.js`. Not taken:
  `/ready` (no database), CORS config (same-origin only), a body size limit (no route reads a
  body), `tsx`/TypeScript (JS + checkJs, ADR 0002). The client contract changed with the error
  shape: `liveSession.js` reads `error.message`, and `error.code === 'not_configured'` replaces
  the old `retryable: false` flag.
- There is no ADR back-fill: the handoff's §4 decisions log stays the record for earlier
  decisions. New decisions go in `docs/adr/`.
- A thin root `package.json` holds only the `check` / `e2e` / `dev` scripts that call into
  each package with `--prefix`. It has no workspaces. Its dev dependencies are Prettier,
  `@playwright/test` and `@axe-core/playwright`, and `e2e/` lives at the root. CLAUDE.md is
  updated to match.
- The CSP is set in M5 and kept current by every later task that adds a resource type.
- The live e2e costs Gemini usage and needs the key. It runs only when `GEMINI_LIVE_E2E=1`,
  at the end of a milestone, never in CI.
- `@google/genai` is pinned to an exact version (2.31.0 or whatever is current when M6 runs),
  after the Live message shapes have been verified against it.
- Tests stay in `src/__tests__/` (the repo's own pattern).

## Stack

The project's own conventions apply, plus these kit stack files:
- `react-vite.md`, for the React rules only: there is no TanStack Query, because the app
  fetches no server data other than the token;
- `node-api.md`, scaled down as described above;
- `styling.md`, plain CSS imported as `?inline` into the shadow root;
- `../ui-craft`;
- `../metrics`.

Language: JS with checkJs (ADR 0002).

**Dependencies added this cycle, each with its reason:**

| Package | Where | Why |
|---|---|---|
| eslint, @eslint/js, globals | both packages | lint gate (R8): ESLint 10 flat config, recommended rules, browser/node globals |
| eslint-plugin-react-hooks | agent-client | lint gate (R8): Rules of Hooks plus the React Compiler rules (v7 `configs.flat.recommended`) |
| prettier | root | format gate (R8): one formatter for every package and the static dirs |
| typescript (7.x) | both packages | `tsc -p jsconfig.json` checkJs (R9, ADR 0002) |
| @types/react, @types/react-dom | agent-client | JSX and hook types for checkJs (R9); already in devDependencies |
| @types/node, @types/express | server | Node and Express types for checkJs (R9) |
| @types/compression | server | `compression` ships no types; without them tsc descends into its untyped JS (R9) |
| @types/supertest | server | types for the token-gate tests; added with supertest in T3 (R10) — `^7.2.1` |
| pino, pino-http | server | structured logs with a request id (metrics skill, node-api.md) — `^10.4.0`, `^11.0.0` |
| helmet | server | security headers and CSP (H1 remainder) — `^8.3.0` |
| supertest, vitest | server | token-gate tests (R10) — `^7.3.1`, `^5.0.5` |
| @playwright/test, @axe-core/playwright | root | e2e and a11y (R11, R12) |
| @radix-ui/react-toast | agent-client | connection toast (R20); Radix is the repo's primitive convention |
| zod | server | nonce query (moved from M8 into M5 T3), env config (R22), client-log body (R23) — `^4.6.7` |
| web-vitals | agent-client | real-user vitals in production (R23) |
| compression | server | gzip static responses; M4 observer measured LCP 4.26 s → 1.86 s on mobile |

No `useReducer`, context or state library. `useLiveAgent` keeps `useState` and refs. The
knowledge store keeps `useSyncExternalStore`. `KnowledgeModal` stops mirroring the store
into `useState` in M7 (R21).

## Data model: the bridge protocol (ADR 0001)

Handshake: the agent-client posts `{type:'ds-bridge-connect'}` to `window` with `[port]`, at
mount. The bridge accepts the first one only. After that, everything travels on the port:

| Direction | Message |
|---|---|
| agent → bridge | `{type:'action', id, action:'click'\|'scroll'\|'fill'\|'navigate', args:string[]}` |
| agent → bridge | `{type:'request-snapshot'}` |
| bridge → agent | `{type:'action-result', id, success, error?}` |
| bridge → agent | `{type:'snapshot', full, changed, removed}` |
| bridge → agent | `{type:'navigated'}` (sent before the load snapshot) |

Snapshot node: `{selector, tag, label, disabled, hidden}`.

Local storage stays as it is in `knowledgeStore.js`.

## Screens

There is one surface: the agent card, in the shadow root, fixed bottom-right. Its states
come from `status`.

| | |
|---|---|
| **Job** | let the viewer talk to the agent and see it is alive and what it heard and said |
| **Primary action** | Talk / End, a single button |
| **What you see first** | the orb (volume rings) and the status line |

| State | Card shows |
|---|---|
| idle | orb at rest, "Talk to the presenter" button |
| connecting | pending button, "Connecting…" |
| open | rings animate with output volume, "Live", End button |
| reconnecting | "Reconnecting (attempt n of 6)…", an enabled End button (hang up during the backoff; never a disabled button, which would drop focus) |
| failed | "Connection lost" plus a Retry button (or "Reload page" when the failure is fatal), and a Radix toast once |
| closed | back to idle |
| mic denied | inline error: "Microphone blocked — allow it in the address bar and press Talk." |

- **Transcript:** the last 3 coalesced turns, `aria-live="polite"`, with user turns visually
  distinct.
- **Knowledge:** an icon button with an accessible name and a count badge, opening the Radix
  dialog. Its states:
  - empty: explain the feature and the next action;
  - error: an inline `role="alert"`;
  - a rules character counter.
- **Phone (360 px):** the card is full width at the bottom with a 16 px gutter.
- **Desktop:** a 320 px card with a 16 px offset.
- **Keyboard:** everything is reachable, focus is visible, Escape closes the dialog and focus
  returns to the button that opened it.

## Design tokens ("quiet floating card")

- **Font:** `system-ui` stack. Scale 12 / 14 / 16 / 20; body 14 inside the widget is
  acceptable because it is a compact overlay, while transcript text is 16.
- **Colour:** neutral greys plus one accent, indigo `#4f46e5` (dark theme `#818cf8`).
  - danger `#b3261e`, never the only signal;
  - surface `#fff` / `#18181b`;
  - text `#18181b` / `#f4f4f5`;
  - AA verified.
- **Shape:** radius 12 for the card and 8 for controls; one shadow token; 1 px borders.
- **Spacing:** 4 / 8 / 12 / 16 / 24.
- **Motion:** 150–200 ms ease-out for state changes. The orb rings freeze to a static level
  under `prefers-reduced-motion`.
- **Layering:** the host gets `position:fixed; z-index:2147483000; display:block` (L3, L4).

## Budgets

The kit defaults apply on `/`.

| Metric | Budget |
|---|---|
| Lighthouse (mobile) | ≥ 95 / 100 / 100 / 100 |
| LCP | ≤ 2.0 s |
| CLS | ≤ 0.05 |
| TBT | ≤ 150 ms |
| axe violations | 0 |
| Console errors in e2e | 0 |
| `agent-client.js` | ≤ 165 kB gzip (148.6 today). Raised from the kit's 150 by the user at approval (2026-10-28): M7 adds a toast, an orb and web-vitals to an IIFE build that can't code-split |
| `/api/live-token` p95, warm local, excluding the Gemini mint call | ≤ 50 ms for the gate rejections |

App metrics, from the live e2e, averaged over 5 runs:

| Metric | Budget |
|---|---|
| Connect, click → `open` | ≤ 2.5 s |
| First agent audio after `open` (greeting) | ≤ 2.0 s |
| Tool round-trip, bridge only: click / fill / scroll | ≤ 300 ms |
| Tool round-trip, bridge only: navigate | ≤ 1.5 s |
| Scripted task success (5-step task) | ≥ 4 of 5 runs |
| Reconnect recovery (forced close → `open`) | ≤ 3 s |
| Keyframe payload | ≤ 4 kB of JSON |

## Observability in production

- **Server:** pino JSON to stdout, so it appears in Render's logs. Each line carries a
  request id, route, status and duration. The token mint is logged with its outcome (never
  the token).
- **Client:** `window.onerror` / `unhandledrejection`, connection failures, and web-vitals
  (LCP / CLS / INP) are sent with `navigator.sendBeacon` to `/api/client-log`. That endpoint
  is same-origin, nonce and rate-limit gated, and its body is validated with Zod and
  size-capped before being logged with pino.

## Docs this cycle changes

| Doc | Changes |
|---|---|
| CLAUDE.md | package layout, the riskiest file, tests, gate commands, root scripts |
| README.md | run and test steps, the live URL, metrics, demo GIFs |
| project-knowledge-handoff.md | §3 status, §4 new decisions linking to the ADRs, §5.2 Toast made true |
| demostack-ai-presenter-agent.md | §4 diagrams for the channel, goals #8 and #9 |
| sandbox-simulation.md | §4 channel; L12 typo |
| code-review-notes.md | ticked in place every milestone |
| New | `CONTEXT.md` glossary (M5); `docs/metrics/` (each milestone) |

## Out of scope

- The agent-creation UI, the template data model, real RAG and the flow builder.
- Pointing at a real external site.
- A full TypeScript migration.
- A custom domain.
- Paid Render plans.

## Time estimate

About **9.3 h** of agent time and **1.6 h** of the user's time across M4–M8. Best / likely /
worst wall-clock work time: 8.5 / 10.9 / 15 h, not counting the gaps while PRs wait to be
merged.

Assumptions behind it: the per-task calibration in the kit, and the live API behaving as it
did in PR #9's manual run.

Biggest risks:
1. The live e2e: whether fake-mic audio is good enough for Gemini's VAD, and how flaky a
   live model is.
2. Live API message shapes changing in the SDK upgrade.
3. TS 7 checkJs maturity.
4. The bundle-size budget once the toast and meter land.
