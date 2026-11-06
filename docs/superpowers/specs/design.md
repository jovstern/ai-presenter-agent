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
- ✅ R1 The sandbox works at both `/` and `/sandbox/` (A1). *(M4 T1: one handler templates `/`, `/sandbox`, `/sandbox/` and `/sandbox/index.html`; `server/__tests__/app.test.js`.)*
- ✅ R2 Re-connecting never leaves a second mic stream or `AudioContext` alive, and
      unmount releases everything (A2, M4). *(M4 T4, M6 fix wave: `useLiveAgent.js` teardown, capture released once; `useLiveAgent.test.jsx`, `audioIO.test.js`.)*
- ✅ R3 Status is one of `idle`, `connecting`, `open`, `reconnecting`, `failed`, `closed`.
      `failed` is shown only after the retries run out, together with a Retry action (A3,
      spec goal #6). *(M4 T3; M7 T4 adds the card's states and the toast; `liveSession.test.js`, `e2e/widget.spec.js`.)*
- ✅ R4 Agent ↔ bridge traffic runs on a private MessageChannel (A4, ADR 0001). *(M4 T2: `bridgeChannel.js` and `sandbox/bridge.js`; `e2e/bridge.spec.js`.)*
- ✅ R5 A bridge action that throws replies with `success:false` straight away (A5, M3). *(M4 T2: `bridge.test.js`.)*
- ✅ R6 `liveSession.js` has unit tests covering reconnect, supersede, serialisation,
      resumption and status (A6, H2). *(M4 T3: `liveSession.test.js`.)*
- ✅ R7 Docs are true (assessment §7), and the review checklist is ticked in place. *(M4 T5, then every milestone; M8 T4 brought CLAUDE.md, the README and the handoff fully up to date; `code-review-notes.md` all ticked.)*

**M5: quality baseline (new issue)**
- ✅ R8 ESLint and Prettier, with `npm run check` per package and at a thin root. *(M5 T1)*
- ✅ R9 `tsc --noEmit` with checkJs runs in `check` (ADR 0002). *(M5 T2)*
- ✅ R10 Server tests cover the token gate; the server uses pino, helmet + CSP and has
      `/health`. *(M5 T3)*
- ✅ R11 A deterministic Playwright e2e covers the bridge, nonce, a11y and console errors.
      *(M5 T4)*
- ✅ R12 An opt-in live e2e (fake-mic WAV) records the app metrics. *(M5 T5)*
- ✅ R13 CI runs `check` and the deterministic e2e on each PR, and `master` is protected.
      *(M5 T6: CI done — `.github/workflows/ci.yml` (job `check`) and `pr-demo-check.yml` (job
      `demo`). `master` protected after PR #14's first run: `check` and `demo` required, admins
      included, no force pushes.)*

**M6: hardening and tuning (issue #5)**
- ✅ R14 Every remaining M and L item is closed or deferred with a reason. *(M6 T6: every M
      item and L1, L6, L9–L12 are fixed; L2, L3, L4, L5, L7 and L8 are card items, deferred
      → M7 (its T1–T3 name them). The M4 and M5 re-review items are fixed too:
      `fatal: 'config' | 'token'`, a 10 s setup timeout, the resume handle kept on a network
      failure, the backoff reset after 5 s or the first content, `labelFor`'s order and cap,
      `errorPage` escaping.)*
- ✅ R15 Capture uses an AudioWorklet. *(M6 T3: `agent-client/public/capture-worklet.js`,
      same-origin under `script-src 'self'`; 16 kHz Int16 80 ms frames; `e2e/audio.spec.js`.)*
- ✅ R16 Knobs (snapshot cap, refresh ratio, loop threshold) are tuned from live-e2e
      numbers. *(M6 T5, `docs/metrics/m06.md`: the cap, the ratio and the loop thresholds are
      kept on the numbers; the still-attached retry is 400 ms × the attempt; a resume no
      longer resends knowledge. Task 8 of 10 meets the 80 % budget only just, and the cap and
      ratio are measured on the 8-node target app only.)*

**M7: presentable widget (new issue)**
- ✅ R17 A designed card with tokens, light and dark themes, and styles in `styles.css`.
      *(M7 T1: the tokens on `:host`, both schemes, reduced motion; M7 T6: `e2e/widget.spec.js`
      checks the placement at 360, 768 and 1440 px and runs axe on the card in both themes.)*
- ✅ R18 A rAF volume meter held in a ref, plus a Profiler render-count test (spec goals
      #8 and #9). *(M7 T2: `VolumeOrb.jsx`, levels from `getLevel()` in `audioIO.js`;
      `renderIsolation.test.jsx`.)*
- ✅ R19 A coalesced, bounded transcript with `aria-live` (M7 T3).
- ✅ R20 Connection states shown in the card, with a Radix Toast and Retry. *(M7 T4:
      `AgentApp.jsx` (Talk to the presenter / pending Cancel / End / Retry / Try again / Reload
      page) and `FailureToast.jsx` (once per failure, above the card, in the shadow root; the
      one live announcement of the reason; F8 and Tab handled inside the shadow root). M7 T6:
      `e2e/widget.spec.js` drives every state, the backoff run out to the toast included.
      M7 fix wave (the coordinator's ruling on the UI review): the toast carries the reason and
      Dismiss only, no action button — Retry lives on the card alone — and the card holds its
      reason line while the toast is open (space kept, hidden and `aria-hidden`), showing it in
      place once the toast closes, so the button doesn't move; AgentApp owns the toast's `open`. Still one live announcement (`useLiveAgent.test.jsx`).)*
- ✅ R21 The knowledge modal is polished and has a component test. *(M7 T5:
      `KnowledgeModal.jsx` reads the store through `useSyncExternalStore`, owns the knowledge
      button as its `Dialog.Trigger`, and does its own Tab wrap in the shadow root;
      `KnowledgeModal.test.jsx`, and the keyboard walk in `e2e/a11y.spec.js`. Issue #5's
      "rules polish" — the character-limit feedback — is this task's counter and alert. M7 T6:
      the card and its toast region are `inert` while the dialog is open, `AgentApp.test.jsx`
      and `e2e/widget.spec.js`.)*

**M8: deploy and close the cycle (new issue)**
- ❌ R22 Live on Render over HTTPS, with config parsed at startup. *(Open: ticked in T3 when
      live. M8 T1 built it — `server/config.js` (Zod, a missing key fatal in production),
      `trust proxy`, `render.yaml`; `server/__tests__/config.test.js`, `app.test.js`.)*
- ❌ R23 Production observability: pino logs, plus client errors and vitals sent to a
      gated `/api/client-log`. *(M8 T2: built and checked locally — `POST /api/client-log`
      with the token route's gates, its own rate limit, a Zod body and a 4 kB cap, and
      `agent-client/src/clientLog.js`; `server/__tests__/clientLog.test.js`, the
      `connection` beacon in `e2e/widget.spec.js`. Ticked once the lines show in Render's
      logs, T3.)*
- ❌ R24 The observer runs against production; the README is final; leftovers are filed
      as issues. *(Open: ticked in T3 when live. M8 T4 did the rest: the README is final but for
      its Live URL (`<!-- LIVE_URL -->`, T3 fills it), and the leftovers are issues #17–#22
      (assessment §8). The observer against production is T3's `docs/metrics/m08.md`.)*

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
  after the Live message shapes have been verified against it. *Done in M6 T4: `2.32.0`, and
  every other dependency is pinned exactly too (table below).*
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
| eslint, @eslint/js, globals | both packages | lint gate (R8): ESLint 10 flat config, recommended rules, browser/node globals — `10.13.0`, `10.0.1`, `17.13.0` |
| eslint-plugin-react-hooks | agent-client | lint gate (R8): Rules of Hooks plus the React Compiler rules (v7 `configs.flat.recommended`) — `7.1.1` |
| prettier | root | format gate (R8): one formatter for every package and the static dirs — `3.9.10` |
| typescript (7.x) | both packages | `tsc -p jsconfig.json` checkJs (R9, ADR 0002) — `7.0.2` |
| @types/react, @types/react-dom | agent-client | JSX and hook types for checkJs (R9); already in devDependencies — `19.3.0`, `19.3.0` |
| @types/node, @types/express | server | Node and Express types for checkJs (R9) — `24.19.2`, `5.0.6` |
| @types/compression | server | `compression` ships no types; without them tsc descends into its untyped JS (R9) — `1.8.1` |
| @types/supertest | server | types for the token-gate tests; added with supertest in T3 (R10) — `7.2.1` |
| pino, pino-http | server | structured logs with a request id (metrics skill, node-api.md) — `10.4.0`, `11.0.0` |
| helmet | server | security headers and CSP (H1 remainder) — `8.3.0` |
| supertest, vitest | server | token-gate tests (R10) — `7.3.1`, `5.0.5` |
| @playwright/test, @axe-core/playwright | root | e2e and a11y (R11, R12): `page.routeWebSocket` fakes Gemini Live with the real SDK socket code; axe walks the open shadow root — `1.64.1`, `4.14.0` |
| @radix-ui/react-toast | agent-client | connection toast (R20); Radix is the repo's primitive convention. Same release as `@radix-ui/react-dialog` (upgraded with it from `1.1.23`), so the shared primitives are one copy each — `1.3.1` |
| zod | server | nonce query (moved from M8 into M5 T3), env config (R22), client-log body (R23) — `4.6.7` |
| web-vitals | agent-client | real-user vitals in production (R23) — `5.3.0`: only `onLCP` / `onINP` / `onCLS` imported; 6.x adds ~0.9 kB gzip of soft-navigation support this page never uses, past the 180 kB budget |
| compression | server | gzip static responses; M4 observer measured LCP 4.26 s → 1.86 s on mobile — `1.8.2` |
| @rolldown/plugin-babel | agent-client | runs the React Compiler (M7 T2b, code-review-notes M10): `@vitejs/plugin-react` 6 compiles JSX with oxc and ignores a `babel` option, so its `reactCompilerPreset` goes through this plugin, its documented stable path. `0.2.4`, the newest in plugin-react 6.1.1's peer range (`^0.1.7 \|\| ^0.2.0`) — `0.2.4` |
| @babel/core | agent-client | the peer `@rolldown/plugin-babel` and `babel-plugin-react-compiler` run on; Babel 7, the line `babel-plugin-react-compiler` 1.0.0's `@babel/types` and eslint-plugin-react-hooks already use (deduped to one copy) — `7.29.13` |

Dependencies from before this cycle, pinned exactly in M6 T4 (code-review-notes M8):
`@google/genai` `2.32.0` (both packages, upgraded from `^2.22.0` after the Live shapes were
verified against it); agent-client `react` / `react-dom` `19.3.0`, `@radix-ui/react-dialog`
`1.1.23` (`1.3.1` since M7 T4, with the toast), `vite` `8.3.0`, `@vitejs/plugin-react` `6.1.1`, `babel-plugin-react-compiler` `1.0.0`,
`vitest` `5.0.1`, `@testing-library/react` `16.3.3`, `jsdom` `30.0.1`; server `express` `5.2.1`,
`dotenv` `17.4.2`. Every `package.json` uses exact versions; add one with
`npm install --save-exact`.

No `useReducer`, context or state library. `useLiveAgent` keeps `useState` and refs. The
knowledge store keeps `useSyncExternalStore`. `KnowledgeModal` stopped mirroring the store
into `useState` in M7 T5 (R21); its one local state for the rules is text the store refused
(over the limit), kept so nothing typed is lost.

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

Snapshot node: `{selector, tag, label, disabled, hidden, checked?, value?, options?}`. `label` is a form
control's `<label>` text; `checked` is set on checkboxes and radios only (M5 T5); `value` is set
on text inputs, textareas and selects, never on a hidden input, a password or a field whose
`autocomplete` is `cc-*`, `one-time-code`, `current-password` or `new-password`, cut to 60
characters plus `…` (M5 fix wave), so the model sees what a `fill` typed. A select's `value`
is its selected option's visible text, and its node adds `options`: the first 20 options' visible
text, each cut the same way (M6 T1). `fill` accepts only those text controls; it sets the value
through the element type's native setter and fires `input` and `change`. On a select it picks the
option whose text matches (trimmed, case-insensitive), then the one whose value does; no match
fails with `… has no option "X"; options: A, B, C` and leaves the selection as it was.

Routes: `target-app/routes.json` (`{name: path}`) is the one list. The server templates it into
the sandbox page as `<script type="application/json" id="ds-routes">` (`<` escaped), the bridge
reads that block (and throws at load without it), and `actionTools.js` imports the file as
`navigate`'s enum (M6 T1, `code-review-notes.md` M1). A node's name follows the accessible-name
order: `aria-labelledby`'s text, `aria-label`, its `<label>`, its text, (for a button-like
input) its value, its placeholder, its title — every source cut to 60 characters (M6 T6).

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
| connecting | the button pending (a spinner, still enabled) as Cancel, "Connecting…" |
| open | rings animate with output volume, "Live", End button |
| reconnecting | "Reconnecting (attempt n of 6)…", an enabled End button (hang up during the backoff; never a disabled button, which would drop focus) |
| failed | "Connection lost" ("Can't connect" for a fatal failure, which never had a connection to lose) in the text colour at medium weight (`data-status="failed"`), plus, on the same focused button: Retry after the backoff runs out; "Reload page" for `fatal: 'token'` (the page's nonce is rejected; a reload brings a new one); "Try again" for `fatal: 'config'` (no key on the server: a reload can't help, so it asks the server again, and connects once the owner has fixed it; if fixing it restarted the server, the in-memory nonce is gone and Try again turns into Reload page, which the reason warns of). A Radix toast once per failure, above the card: the reason and Dismiss only, with a visually hidden line naming the card's button ("Use the Retry button on the presenter card."); it is the one live announcement of the reason (assertive). While it is open the card holds its own reason line (its space kept, `visibility: hidden` and `aria-hidden`, so Retry never moves); once it closes (dismissed, Escape, swiped or timed out after 8 s) the card shows the reason as plain text under the headline, in that space, so the screen holds one reason and one Retry, and the reason is announced once (M7 T4; ruling of the M7 fix wave) |
| closed | back to idle |
| mic denied | inline error: "Microphone blocked — allow it in the address bar and press Talk to the presenter." |
| insecure page (plain http) | inline error: "Voice needs a secure connection (https)…"; no session is opened (M6 T3, code-review-notes L6) |

- **Transcript:** the coalesced turns (the last 20, `MAX_ENTRIES`), `aria-live="polite"`, with
  user turns visually distinct. From the press that starts a session (connecting, open,
  reconnecting), and whenever it has lines, it is a box of fixed height (`--transcript-height`,
  192 px, eight lines) above the controls, so a new line never moves the bottom-anchored card
  (CLS 0.151 at 390 px before the M7 fix wave, 0 after; `e2e/widget.spec.js` asserts ≤ 0.05).
  Empty while reserved, it says "The conversation appears here."; idle and empty it takes no
  room. The list flows top-down and the box scrolls to follow the newest line; a viewer who
  scrolls up is left there until they scroll back to the bottom. Content shorter than the box is
  drawn at its bottom, next to the controls, with a `translate` rather than layout (bottom-aligned
  in layout, each new line moved the ones above it: 0.024 at 390 px; a transform isn't a shift). Cut-off edges fade (a mask).
  It is a Tab stop only while it overflows, its focus ring on the unmasked wrapper with the
  control radius. No `text-wrap: pretty` on it: rebalancing as words stream in moved shown
  words between lines.
- **Knowledge:** an icon button with an accessible name and a count badge, opening the Radix
  dialog. Its states:
  - empty: explain the feature and the next action ("No files yet. Add product notes or a
    script, and the presenter draws on them when it talks."), under Add files;
  - Add files: a real button that opens the file picker (keyboard and pointer), and the drop
    target for dragged files;
  - each file: name, size, and a quiet Remove button (no border or fill until hovered, still
    44 × 44 px) named "Remove <file name>"; removing moves focus to the next file's Remove, else
    the previous, else Add files;
  - error: an inline `role="alert"` ("<file> wasn't added." and the store's reason), cleared
    when the dialog is opened again. The browser's own refusals are reasons too, in plain
    words: "Browser storage is full. Remove a file to make room" (`QuotaExceededError`) and
    "The file couldn't be read. Check that it still exists, then add it again"
    (`NotReadableError`). Storage blocked outright reads as empty (no files, no rules) instead of
    throwing at mount, and its writes fail in plain words: "This browser isn't letting the site
    save files" (an add or a Remove, the file staying listed and focus where it was) or "…save
    rules" (an alert under the field, the text kept in it, unsaved). An add that fails in a way
    the store didn't expect says "Something went wrong; try again" (M7 fix wave);
  - layout: the dialog is anchored by its top (8 dvh, `vh` fallback; at most 84 dvh tall), so
    an added file or an error grows it downward; Close sits in a sticky footer, reachable at
    360 px however long the content;
  - rules: a used / limit counter (`1,850 / 2,000`) the field is described by; a polite note
    once within 200 characters and again at the limit (not per keystroke); over the limit the
    text stays, unsaved, with `aria-invalid` and a `role="alert"` saying by how much;
  - focus: Add files on open; Tab and Shift+Tab wrap inside the dialog; Escape or Close
    returns focus to the knowledge button (M7 T5);
  - modal for assistive technology too: the card and the toast region behind it are `inert`
    while it is open, since Radix's `aria-hidden` on the page's other children never reaches
    into the shadow root (M7 T6). A known consequence, kept on purpose: `inert` also silences
    the card's live regions (the transcript, the status line, a toast's announcement) while
    the dialog is open, so speech the agent produces meanwhile is not announced; it is in the
    transcript once the dialog closes.
- **Layout of the card:** three columns — the orb, the primary button, the knowledge button —
  with the transcript spanning them above and the status, reason and mic lines as a caption
  under the button column, aligned with the primary button (M7 fix wave). The knowledge button
  is a 16 px inline SVG document icon (`currentColor`, `aria-hidden`) and the count, with
  `title="Knowledge files"`. The primary label never wraps (`white-space: nowrap`); at 340 px and
  below the card's padding and the two buttons' padding tighten so "Talk to the presenter" fits
  at 320 px.
- **Phone (360 px):** the card is full width at the bottom with a 16 px gutter.
- **Desktop:** a 344 px card with a 16 px offset (320 until M7 T4, where "Talk to the presenter" wrapped).
- **Keyboard:** everything is reachable, focus is visible, Escape closes the dialog and focus
  returns to the button that opened it.

## Design tokens ("quiet floating card")

The values live as custom properties on `:host` in `agent-client/src/styles.css` (M7 T1);
components use the tokens, never raw values.

- **Font:** `system-ui` stack. Scale 12 / 14 / 16 / 20; body 14 inside the widget is
  acceptable because it is a compact overlay, while transcript text is 16. Weights 400 / 500 /
  600; line height 1.5 for text, 1.2 for the dialog title.
- **Colour:** neutral greys plus one accent, indigo `#4f46e5` (dark theme `#818cf8`).
  - danger `#b3261e` / `#f87171`, never the only signal (the light red is 2.7:1 on the dark
    surface, so dark gets its own);
  - surface `#fff` / `#18181b`, raised (hover) `#f4f4f5` / `#27272a`;
  - text `#18181b` / `#f4f4f5`, muted text `#52525b` / `#a1a1aa`;
  - borders: a decorative hairline `#e4e4e7` / `#3f3f46`, control boundaries `#71717a` /
    `#a1a1aa` (≥ 3:1);
  - text on the accent `#fff` / `#18181b`; accent hover `#4338ca` / `#a5b4fc`;
  - the focus ring is the accent, 2 px with a 2 px offset;
  - AA verified (M7 T1): text 17.7 / 16.1, muted 7.7 / 6.9, danger 6.5 / 6.4, the primary
    button's label 6.3 / 5.9, the focus ring and control borders 6.3 / 6.9 and 4.8 / 6.9 (light
    / dark, on the surface); axe's colour-contrast passes in both schemes (`e2e/a11y.spec.js`, and
    `e2e/widget.spec.js` at 360, 768 and 1440 px).
- **Shape:** radius 12 for the card and 8 for controls; one shadow token (deeper in dark); 1 px
  borders. Controls are at least 44 × 44 px.
- **Spacing:** 4 / 8 / 12 / 16 / 24.
- **Motion:** 150–200 ms ease-out for state changes (the toast slides in over 200 ms and
  goes at once); the pending button's ring turns once per 900 ms (`--duration-spin`). Under
  `prefers-reduced-motion` the duration tokens are 0 and no transition or animation runs; the
  orb rings freeze to a static level, the pending ring stands still.
- **Layout:** a 16 px gutter; the card is 344 px wide, and at 400 px and below it spans the
  viewport between the gutters; the dialog is at most 360 px.
- **Layering:** the host gets `position:fixed; z-index:2147483000; display:block` (L3, L4),
  through `:host` in `styles.css`, not an inline style: the width changes at a breakpoint,
  which only a media query can say, and the only page whose styles could outrank `:host` is the
  sandbox page itself (the target app is in an iframe).

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
| `agent-client.js` | ≤ 180 kB gzip (162.15 after M6). Raised from the kit's 150 to 165 by the user at approval (2026-10-28), then to 180 on 2026-11-05 (option A of the M6 bundle breakdown, `docs/metrics/m06.md`): the Gemini SDK is 74 kB of the bundle, and M7 adds a toast, an orb and web-vitals to an IIFE build that can't code-split |
| `/api/live-token` p95, warm local, excluding the Gemini mint call | ≤ 50 ms for the gate rejections |

App metrics, from the live e2e, averaged over 5 runs:

| Metric | Budget |
|---|---|
| Connect, click → `open` | ≤ 2.5 s |
| First agent audio after `open` (greeting) | ≤ 2.0 s |
| Tool round-trip, bridge only: click / fill / scroll | ≤ 300 ms |
| Tool round-trip, bridge only: navigate | ≤ 1.5 s |
| Scripted task success (6-step task since M6 T5, with a `fill`) | ≥ 4 of 5 runs |
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
