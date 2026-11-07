# ai-presenter-agent-v2

A from-scratch rebuild of the runtime half of Demostack's AI Presenter Agent: a voice avatar
(Gemini Live API) embedded in an iframe that both talks and acts (click/scroll/navigate/fill) on
a target web app via a private MessageChannel bridge (ADR 0001). Not in scope: agent-creation UI, real RAG
(chunking/embeddings — only a "RAG-lite" localStorage context-stuffing feature exists), the flow
builder. See `docs/project-knowledge-handoff.md` for the full origin story and what was
deliberately left out.

## Package layout

Two npm packages and two static directories, plus a thin root `package.json` (no workspaces)
that holds Prettier, Playwright (`e2e/`, `playwright.config.js`) and the cross-package scripts:

- `agent-client/` (npm) — React 19 + Vite, with the React Compiler (`babel-plugin-react-compiler`)
  run by `@rolldown/plugin-babel` with plugin-react's `reactCompilerPreset()` in `vite.config.js`
  (plugin-react 6 has no `babel` option of its own; `docs/code-review-notes.md` M10). It applies
  to the build and to vitest; `renderIsolation.test.jsx` fails if it stops running. Don't add
  manual `useMemo`/`useCallback` for render-perf reasons unless the compiler demonstrably can't
  cover the case, and keep components free of bail-outs (a one-off build with
  `reactCompilerPreset({ panicThreshold: 'all_errors' })` lists them). UI elements needing a primitive (dialog, toast, dropdown, etc.) default to Radix
  (`@radix-ui/react-*`); today that is `KnowledgeModal.jsx`'s Dialog and `FailureToast.jsx`'s Toast
  (both `1.3.1`, which share one copy of each Radix primitive). Builds to a single IIFE
  script mounted in a shadow root. `npm test` (vitest), `npm run build`, `npm run watch`,
  `npm run lint`, `npm run typecheck`, `npm run check` (lint + typecheck + test + build).
  - `liveSession.js` — the Gemini Live socket: connect, reconnect backoff, resumption, tool
    dispatch, context injection. The riskiest file; unit-tested. Each successful action's
    tool response carries the page after it as `page` (#25): the bridge's settled snapshot,
    held because a batch is running.
  - `useLiveAgent.js` — thin React glue: wires `liveSession` and `audioIO.js` (mic capture,
    playback, barge-in) into React state; owns teardown on unmount. Talk first checks for a
    secure context and AudioWorklet (`voiceSupportError()`), and opens no session without them.
    Exposes `outputLevel()` / `micLevel()`, pull-only getters over the current player and capture,
    and `failureCount`, which names each `failed` report for the toast.
  - `audioIO.js` — capture: the mic into `public/capture-worklet.js` (an AudioWorklet, loaded
    with `addModule` from `/agent-client/capture-worklet.js`, a URL `main.jsx` resolves next to
    its own script tag), which low-passes and resamples to 16 kHz Int16 off the main thread and
    posts 80 ms frames (1280 samples, buffer transferred); playback with barge-in. Vite copies
    `public/` into `dist/`; the worklet is plain JS, linted with AudioWorklet globals only and
    typechecked by its own `jsconfig.worklet.json` (+ `types/audioworklet.d.ts`). Both the
    capture and the player have `getLevel()` (0..1, `pcm.js` `levelOf`): the mic's last frame,
    and an `AnalyserNode` between the playback and the speakers. `audioContext.resume()` times
    out after 3 s (`AudioResumeTimeoutError`; Safari may hang), failing the capture.
  - `bridgeChannel.js` — the private `MessageChannel` to `sandbox/bridge.js`
    ([ADR 0001](docs/adr/0001-private-bridge-channel.md)); `main.jsx` opens it once per page.
  - `AgentApp.jsx` — the card (an `<aside aria-label="AI presenter">` landmark): one
    never-disabled primary button, Talk to the AI Presenter / Cancel (pending, while connecting) /
    End / Retry / Try again / Reload page, a status line ("Can't connect" on a fatal failure),
    the failure's reason as plain text once its toast has closed, a `role="alert"` for mic and voice-support guidance
    (keyed by the connect attempt, so a repeat is announced), the transcript, the document-icon
    knowledge button (rendered by `KnowledgeModal.jsx`) and the volume orb. It owns the
    dialog's `open` and makes the card and the toast region `inert` while the dialog is open:
    Radix's `hideOthers` sets `aria-hidden` on `document.body`'s children only, never inside
    the shadow root (M7 T6).
  - `KnowledgeModal.jsx` — the knowledge button (a 16 px document icon and the count; the Radix `Dialog.Trigger`, so closing returns
    focus to it; a controlled `Dialog.Root`, `open` from the card) and the knowledge dialog, portalled into the shadow root: Add files (a real
    `<button>` that opens the file picker and takes dropped files), the file list with "Remove
    <file name>" buttons, an empty state, a rules field with a used / limit counter
    (`aria-describedby`; a polite note near the limit, a `role="alert"` over it, the text kept
    but not saved) and `role="alert"` add errors (full storage and an unreadable file
    included, and blocked storage on add, Remove and the rules; cleared on reopen); top-anchored, with Close in a sticky footer. It reads `knowledgeStore.js` through
    `useSyncExternalStore` (no mirrored state). Its Tab wrap and open focus are its own, read
    from the shadow root: Radix's FocusScope compares `document.activeElement` (the host), so
    its trap let Tab walk out of the dialog. `shadowFocus.js` holds `focusedIn` (shared with
    `FailureToast.jsx`, which keeps its own `toastTabStops`) and `tabStops` (rendered controls
    only: `checkVisibility()`, else no `hidden` ancestor).
  - `FailureToast.jsx` — the Radix toast on `failed`, once per failure: the reason and Dismiss
    (no action: the card's button is the one Retry), plus a visually hidden line naming the
    card's button. `AgentApp.jsx` owns its `open` and holds the card's reason line while it is
    open (space kept, hidden and `aria-hidden`, so the button never moves), showing it once the
    toast closes. Its viewport sits above the card in the shadow root
    and its announcer in `main.jsx`'s portal container; it is the one live announcement of the
    reason (so the card has no alert for it). F8 reaches it; its own capture handlers walk Tab
    (Radix compares `document.activeElement`, which in a shadow root is the host) and send
    focus back to the primary button.
  - `Transcript.jsx` — the card's first row: the coalesced turns in an `aria-live="polite"`
    list that announces additions only (one node per fragment), a hidden "Presenter:" / "You:"
    prefix. From the press that starts a session it is a fixed-height box
    (`--transcript-height`), so new lines never move the card (a layout shift); a
    `ResizeObserver` scrolls it to the newest line unless the viewer scrolled up, short content
    is translated to the box's bottom (a transform, so no layout shift; the content measured
    with `Math.ceil(getBoundingClientRect().height)`, since a rounded `offsetHeight` could
    overflow by under a pixel), cut-off edges fade, and it is a Tab stop only while it overflows. `transcript.js` (pure) merges fragments
    into entries and bounds them to 20.
  - `VolumeOrb.jsx` — the decorative (`aria-hidden`) orb: while the session is open, a
    `requestAnimationFrame` loop pulls the two levels and writes `--level` / `--mic-level` on its
    node — no React state, so a frame renders nothing (spec goals #8 and #9). No loop under
    `prefers-reduced-motion` (followed live via `matchMedia`); the sources are read through
    `useEffectEvent`, so a card render never restarts the loop.
  - `styles.css` — the card's and the dialog's one stylesheet: the spec's design tokens as
    custom properties on `:host` (redefined under `prefers-color-scheme: dark`, durations zeroed
    under `prefers-reduced-motion: reduce`), and the host's own `position: fixed`, `z-index` and
    `display: block`. `main.jsx` imports it with Vite's `?inline` and puts it in the shadow root
    as one `<style>` (covered by the CSP's `style-src 'unsafe-inline'`).
  - `clientLog.js` — the client log (spec R23): `startClientLog({ nonce, scriptUrl })`, called
    once per page by `main.jsx` before the mount, listens for window `error` /
    `unhandledrejection` thrown from this bundle's own script URL, reports LCP, INP and CLS
    through `web-vitals` (only those three imported, for the bundle budget), and returns the
    reporter `main.jsx` passes to `AgentApp` as `onFailure`; `useLiveAgent` calls it from
    `onStatusChange` once per `failed` (the failures `failureCount` counts). Each report is a
    `navigator.sendBeacon` to `/api/client-log?nonce=…` with a JSON Blob; a missing or refusing
    `sendBeacon` drops it (no fetch fallback). A beacon the server rejects still logs a console
    error, so a `token` failure (the server refused the page's token request: its nonce or origin) is not sent and `disable()`s the log for
    the rest of the page; a page whose nonce expired or outlived a server restart loses its
    reports until then. Per page: a repeated error once, at most 10 errors and 20 reports. The
    report builders are pure.
    `web-vitals` is the agent-client's one runtime dependency beyond React, Radix and the
    Gemini SDK, pinned to 5.3.0: 6.x adds ~0.9 kB gzip of soft-navigation support this page
    never uses, which the 180 kB budget couldn't take.
  - Pure helpers: `actionTools.js`, `domSnapshotContext.js`, `loopGuard.js`, `pcm.js`,
    `knowledgeStore.js`, `transcript.js`.
  - `liveModel.json` — the one Live model name, imported by `liveSession.js` and by
    `server/geminiMint.js` for the token's constraint.
  - `bridgeProtocol.js` — types only: the bridge messages as JSDoc `@typedef`s. `sandbox/bridge.js`
    holds a verbatim copy of its `#region bridge protocol`; `bridgeProtocol.test.js` fails if
    they drift, so edit both together.
- `server/` (npm) — Node/Express, split in two:
  - `app.js` — `createApp({ mintToken, now, logger, production, trustProxyHops, limits })`, no `listen`, so
    tests drive it with supertest. Mints short-lived Gemini Live tokens (`/api/live-token`,
    gated on same-origin, a per-IP rate limit and a page nonce parsed with Zod), serves the
    nonce-templated sandbox page at `/` and `/sandbox/` (rate-limited per IP too, since each
    load issues a nonce; past the limit a browser gets a "Too many reloads" page and
    `Retry-After`), the other static directories gzipped (`compression`), and
    `GET /health`, and `POST /api/client-log` (the agent-client's beacons: the same gates as
    the token route through one `passesPageGate`, its own per-IP limit of 60 a minute, a
    4 kB `express.json` cap answered 413 `payload_too_large`, a Zod discriminated union
    `error` / `vital` / `connection` answered 400 `invalid_request`, then 204 and one pino
    line — `client vital` at info, `client error` and `client connection failed` at warn —
    with the parsed fields only, strings cut and passed through `redact`, which strips URL
    queries and fragments and masks token-shaped values; body-parser errors — 415
    `unsupported_media_type` for a charset or encoding it can't decode — are logged by
    type, never with the body). pino-http logs every request but `/health` (Render polls it) with a request id (`x-request-id`); helmet
    sends the CSP (see below) and the other security headers. Every JSON error is
    `{ error: { code, message } }`. A failed mint is `not_configured` (500) when Google rejects
    the key and `upstream_error` (502) otherwise, both logged at error. The central error
    handler keeps only an `expose`d client error's status and turns anything else into a 500
    without internals. An unknown page a browser asks for gets a small HTML 404 with a link
    back; `/api/*` and non-HTML callers get the JSON one.
  - `expiringMap.js` — the TTL'd, size-capped map behind the nonce and rate-limit state.
  - `geminiMint.js` — the real Gemini mint: a single-use token, 60 s to start a session,
    locked to the model in `agent-client/src/liveModel.json` with `lockAdditionalFields: []`
    ([ADR 0004](docs/adr/0004-live-token-constraints.md)).
  - `config.js` — `loadConfig(env)`: the env parsed once with Zod (`PORT` or 3000,
    `GEMINI_API_KEY` (trimmed), `NODE_ENV`, `LOG_LEVEL` or `info`, `TRUST_PROXY_HOPS` or 1 in production
    and 0 otherwise). A bad variable throws a `ConfigError` naming it, never its value, and
    every bad variable is listed at once; a
    missing or whitespace-only key is fatal only with `NODE_ENV=production` (locally and in the e2e the token
    route answers `not_configured` and the card offers Try again).
  - `index.js` — `loadConfig(process.env)` (on a `ConfigError`: the message to stderr, exit 1),
    the v1alpha `GoogleGenAI` client for the mint, `listen`, graceful SIGTERM/SIGINT shutdown
    (once, whichever signal comes first).
  **Trust proxy:** `createApp`'s `trustProxyHops` sets Express's `trust proxy` (1 in production
  for Render's TLS proxy, ADR 0003): `req.protocol` follows `X-Forwarded-Proto`, so the
  same-origin check matches the https page, and `req.ip` is the viewer, so each gets their own
  bucket in both rate limiters. Off locally, so `X-Forwarded-For` can't be spoofed there.
  `npm start`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run check` (all three).
  Static serving could be split off (`docs/project-knowledge-handoff.md` §5.3).
  **CSP** (`server/app.js`): `default-src 'self'`, `script-src 'self'` (no inline script on any
  page), `style-src 'self' 'unsafe-inline'` (runtime `<style>` from the shadow root and Radix),
  `connect-src` adds the Gemini `wss:`/`https:` origins (its `'self'` covers the client-log
  beacons), `frame-src 'self'`, `img-src 'self'
  data:`; `script-src 'self'` also covers the same-origin capture worklet (no `blob:`); the sandbox page's one inline `<script>` is the `#ds-routes` JSON data block, which
  never runs; HSTS and `upgrade-insecure-requests` only when `NODE_ENV=production`. Any change that
  adds a resource type updates the CSP in the same commit.
- `render.yaml` — the Render Blueprint (ADR 0003): one free Node web service built from the
  root (agent-client `ci --include=dev` + build, server `ci --omit=dev`), `npm --prefix server
  start`, `/health`, `NODE_ENV=production`, `GEMINI_API_KEY` set in the dashboard
  (`sync: false`), a preview per PR (`previews.generation: automatic`); Node from `.nvmrc`.
- `sandbox/` (static) — host page: iframe + `bridge.js` (channel handshake, action library,
  DOM snapshots; reads the routes from the page's `#ds-routes` block, which the server
  templates in). A successful action's result waits for the page to **settle** (no mutation,
  input or change for 100 ms, capped at 1 s; a link click first waits for the new page; all by a
  3.7 s deadline) and follows that page's snapshot on the port (#25);
  a failure answers at once; changes nobody asked for go out on a 250 ms debounce. No build step.
- `target-app/` (static) — 2-page mock app used as the demo target: `index.html` + `home.js`
  (counter), `settings.html` + `settings.js` (Save confirmation; also a Notes textarea and a
  Plan select for `fill`), `style.css`, and `routes.json` — the one route list (route name →
  page path): the server templates it into the sandbox page for `bridge.js`, and
  `actionTools.js` imports it for `navigate`'s enum. No build step.

## Commands and gates

Node 24 (`.nvmrc`; every `package.json` has `engines: { node: ">=24" }`). From the repo root
(run `npm install` there once for Prettier and Playwright, then `npx playwright install
chromium` once for the e2e):

- `npm run check` — Prettier check, then each package's `check` via `npm --prefix`. The gate
  before every commit.
- `npm run format` — Prettier write (`.prettierrc.json`; Markdown, lockfiles and `dist/` are
  ignored in `.prettierignore`).
- `npm run dev` — build agent-client, then start the server.
- `npm run e2e` — Playwright, Chromium only (`playwright.config.js`). Not part of `check`; CI runs
  both. Its `webServer` builds agent-client and runs `node server/index.js` on port 3971 with
  `GEMINI_API_KEY=e2e-dummy` and `DOTENV_CONFIG_PATH=/dev/null`, so it never loads
  `server/.env`; the token endpoint and the Live socket are stubbed in the tests. Needs no key.
- `npm run e2e:live` — the opt-in live e2e (`e2e/live.spec.js`, R12), never in `check` or CI.
  macOS only: it first runs `e2e/make-prompts.sh` (`say`, WAVs gitignored), then
  `GEMINI_LIVE_E2E=1 playwright test`, which defines only the three live projects (one fake-mic
  WAV each) and starts the server from `server/` on port 3972, so the key comes from the
  server's own env — the config never passes one. It reads the agent-client's `ds:*`
  `performance.mark`s and appends the app metrics to `.metrics/live.json` (gitignored). See
  `docs/metrics/README.md`.

Lint is ESLint 10 flat config, one `eslint.config.js` per package: `@eslint/js` recommended +
`globals`; agent-client adds `eslint-plugin-react-hooks` (the React Compiler rules) and bans
importing `useMemo`/`useCallback`/`memo`. agent-client's config also lints `sandbox/*.js` and
`target-app/*.js` as classic browser scripts, and the root Playwright suite (`e2e/`,
`playwright.config.js`) with node + browser globals (the `page.evaluate` callbacks run in the
page), so its `lint` script runs from the repo root (ESLint 10 ignores files outside the base
path).

Typecheck is `checkJs` + `strict` on plain JS with JSDoc types
([ADR 0002](docs/adr/0002-type-checking-with-checkjs.md)): `npm run typecheck` in each package
runs `tsc -p jsconfig.json` (TypeScript 7; plain `tsc` ignores `jsconfig.json`); agent-client's
also runs `tsc -p jsconfig.worklet.json` for the capture worklet (ES lib plus a small
AudioWorkletGlobalScope shim, so no DOM names leak into it or its names into `src/`).
agent-client's config also covers `sandbox/bridge.js` (`// @ts-check`); it excludes
`src/__tests__/` for now. The page nonce is no longer a window global: `main.jsx` reads it off
its own script tag's `data-ds-nonce` and passes it down as a prop. No `any`, no `@ts-ignore`; a cast or `@ts-expect-error` carries a comment saying why.

## Docs map

- `CONTEXT.md` — the glossary: bridge, channel, keyframe / delta, nonce, generation, resume
  handle, tool batch, loop guard, RAG-lite and the rest, each pointing at the file that owns it.
- `docs/project-knowledge-handoff.md` — primary onboarding doc: origin story, verified-vs-unverified
  build status, decisions log, open questions.
- `docs/demostack-ai-presenter-agent.md` — build spec.
- `docs/sandbox-simulation.md` — why the iframe/same-origin simulation approach was chosen over a
  real external site.
- `docs/code-review-notes.md` — the living, severity-tagged review checklist: B1–B4, H1–H5,
  M1–M10, L1–L12 — all done (M10 and L2–L8 in M7). Its original
  `file:line` references point at pre-rebuild code; each "Fixed" note names
  the current location. Update it in place; don't start a second tracking doc.
- `docs/adr/` — architecture decisions: 0001 private bridge channel, 0002 `checkJs` type
  checking, 0003 hosting on Render, 0004 Live token locked to the model only.
- `docs/superpowers/` — the `/build` cycle: `specs/assessment.md` (every item done or filed as
  an issue, M8 T4), `specs/design.md` (the spec and its R1–R24 checklist) and `plans/plan.md`
  (milestones M4–M8 and their tasks, the time log and the kit calibration proposal).
- `docs/metrics/` — the observer's report per milestone (`m04.md`–`m07.md`), `history.csv`
  (Lighthouse per route per milestone) and `README.md` (how the live e2e records the app
  metrics, and the current baseline).

## Active work area

Cycle 1 (M4–M8) closes with M8: the Render deploy (`render.yaml`, `server/config.js`, trust
proxy) and production observability (`/api/client-log`, `clientLog.js`). Follow-up work is
filed as GitHub issues (see `docs/superpowers/specs/assessment.md` §8). Before that the work
concentrated in `agent-client/src/liveSession.js` and `sandbox/bridge.js`: DOM-state
grounding (keyframe vs. delta snapshots, a debounced `MutationObserver`, a snapshot that arrives
during a tool batch sent inside its tool response, each action's settled snapshot before its result), the private bridge
channel, and Live session robustness (one reconnect per drop, `reconnecting`/`failed` status,
session resumption, serialized tool calls). `liveSession.js` is the riskiest file and is covered
by `liveSession.test.js`; `useLiveAgent.js` is thin glue with its own Testing Library tests.

## Note on origin knowledge

`docs/project-knowledge-handoff.md` §1 describes the *original* Demostack product this rebuild is
modeled on (team, data model, config UI) — it's explicitly "why decisions were made," not a
description of this repo's own code. This rebuild deliberately excludes the agent-creation UI,
template/demo-agent data model, and real RAG. §5.1 (RAG-lite knowledge modal) is IMPLEMENTED;
§5.2 (Radix UI) is implemented: the Dialog and the failure Toast (M7 T4).

## Workflow notes

- Every dependency in the three `package.json`s is pinned exactly (no `^`/`~`), lockfiles
  committed; add one with `npm install --save-exact`.
- Two npm packages, not a workspace — `cd` into `agent-client/` or `server/` before running
  their npm commands (`npm install` included); the root only runs `check`, `format`, `dev`,
  `e2e` and `e2e:live`.
- When touching `liveSession.js`, `useLiveAgent.js` or `bridge.js`, reconcile changes against
  `docs/code-review-notes.md`'s existing items rather than creating a second tracking surface.
- Tests: `agent-client/src/__tests__/` has 20 vitest files (414 tests): `actionTools`, `AgentApp.test.jsx` (in a real shadow root: the
  card and its toast region inert while the knowledge dialog is open, restored on close),
  `audioIO` (the secure-context check; capture releases everything once; the resume timeout;
  both `getLevel()`s against a stubbed analyser), `clientLog` (only the bundle's own errors,
  the report shapes, the nonce in the query and a JSON Blob, the per-page caps, a missing
  `sendBeacon` dropped, nothing sent once disabled or from a `token` failure on), `bridge` (runs
  `sandbox/bridge.js` against a stubbed iframe), `bridgeChannel`, `bridgeProtocol` (the typedef
  copies match), `captureWorklet` (`public/capture-worklet.js` under a stubbed worklet scope:
  frame size, 16 kHz from 48/44.1 kHz, no aliasing), `domSnapshotContext`, `knowledgeStore` (incl.
  full storage, an unreadable file, and blocked storage on reads and writes),
  `KnowledgeModal.test.jsx` (in a real shadow root: add, list, remove and focus after it, an
  oversize alert, a full-storage alert, blocked-storage alerts for Remove and the rules
  (text kept), a generic alert for an unexpected add failure, the error cleared on reopen, drop, the rules counter and over-limit alert, the picker from a button, open
  focus, the Tab wrap both ways, Escape returning focus), `liveSession`, `loopGuard`, `pcm`, `shadowFocus` (rendered Tab stops only), `renderIsolation.test.jsx` (`React.Profiler` over 50 fake
  animation frames: no commit, `--level` moved 50 times; a transcript line skips the orb; a compiler canary), `transcript` (merge, spacing, turn
  boundary, the bound of 20), `Transcript.test.jsx` (live-region attributes, a node per fragment, the reserved box, following the newest line and leaving a viewer who scrolled up, a Tab stop only when overflowing, a fractional content height not overflowing by a fraction of a pixel), `useLiveAgent.test.jsx` (Testing
  Library: the card's states and the failure toast — once per failure, reason and Dismiss only, the
  card's reason after it closes, one announcement, the keyboard walk and focus return; each
  failure reported to `onFailure` once) and
  `VolumeOrb.test.jsx` (the loop's lifecycle: active only, stopped on unmount, none under
  reduced motion; a write only when the 2-decimal level changes); `rafHarness.js` holds their fake rAF and `matchMedia`. `server/__tests__/` has 5 vitest files (117 tests), sharing `harness.js` (`setup`, the
  capturing logger, `pageNonce`): `app` (supertest against
  `createApp` with a stubbed mint and clock: the token gate's 403/400/429/500/502/200 paths, the
  mint-failure mapping and the error handler, both sandbox URLs templated and rate-limited, no
  inline scripts but the `#ds-routes` block (on every sandbox URL, `<` escaped), the CSP and other headers, `/health` (and no request log line for it), the HTML and JSON 404s, `errorPage` escaping its arguments, the nonce cap;
  behind a trusted proxy: `X-Forwarded-Proto: https` passes the origin check, `X-Forwarded-For`
  clients get their own bucket in both limiters, and with no trusted proxy it is ignored),
  `clientLog` (`POST /api/client-log`: each report type's 204 and log line with the request
  id and level, unknown keys dropped, truncation and redaction, no nonce logged, 400 for bad
  bodies and malformed or non-JSON ones, 413 over 4 kB, 415 for a charset or encoding it can't decode, 403 cross-origin and for a bad or
  expired nonce, 429 on its own limit, separate from the token route's),
  `config` (`loadConfig`: defaults, blank means unset, a missing or whitespace-only key fatal
  in production only, bad variables named without their values and all at once),
  `expiringMap` (expiry, pruning on access, the cap) and `geminiMint` (the token's
  config: single use, model-only lock with `lockAdditionalFields: []`). `e2e/` has 5 Playwright specs (36
  tests) on `e2e/fixtures.js`, whose `test` fails on any console error, page error or CSP
  violation in any frame: `bridge.spec.js` (12: `sandbox/bridge.js` on a fixture page, the test
  doing the real handshake and port transfer — the actions, the allowlist, unknown routes, the
  bridge accepting exactly `navigate`'s enum, `fill` on the Settings textarea and select (by
  text, by value, no match), a second connect and forged `window` messages ignored, snapshots, an action's settled snapshot before its result), `loop.spec.js` (4: the real
  `/` page against a fake Gemini Live via `page.routeWebSocket` — a tool batch, a dropped
  socket, one token per reconnect, the page nonce; a batch of three counter clicks, each
  response's `page` showing 1, 2, 3; ten identical counter clicks all run (the loop guard judges
  each on the page it was taken on), the counter at 10; a link click answered with the new page's keyframe), `widget.spec.js` (8, M7 T6: every card state
  through the same harness — the demo test "widget demo: Talk, Live with the orb and transcript, a
  lost connection, Retry" walks idle → pending Cancel → Live with the orb's `--level` following fake
  agent audio → a coalesced transcript → a forced close → reconnecting → the backoff run out on
  `page.clock` → Connection lost with one toast → Retry → Live; the two fatal paths from the
  keyboard — `not_configured` offers Try again, no Reload page, with its toast once per failure and
  F8 / Tab / Escape inside the shadow root, and one `connection` beacon per failure answered
  204 by the real server; a rejected nonce offers Reload page, which reloads; the
  blocked-mic guidance; at 360, 768 and 1440 px the card's placement, a keyboard walk of the
  whole card, the dialog making the card inert (Chromium's accessibility tree, over CDP) and axe in
  light and dark; and at 390 px the layout-shift check — worst CLS session window ≤ 0.05 while
  the transcript grows over six turns, the newest line in view),
  `audio.spec.js` (1: the fake mic through the real capture worklet under the CSP — 2560-byte
  `audio/pcm;rate=16000` frames at ~12.5/s, not silence, none after End) and
  `a11y.spec.js` (11: axe with zero violations, in light and dark, on `/` idle, failed with its
  toast (once its slide-in has finished) and with the knowledge dialog open — inside the shadow root —, plus the dialog from the
  keyboard only in each theme: Enter on Add files opens the file picker, Tab and Shift+Tab wrap
  inside it, Escape returns focus to the knowledge button; connected with a coalesced transcript line (the fake-Live harness in
  `e2e/fakeLive.js`, shared with `loop.spec.js` and `widget.spec.js`), and on both target-app pages). `e2e/live.spec.js` (3, opt-in, real
  Gemini: greeting, the six-step task, a forced close → recovery) runs only under
  `npm run e2e:live`. Follow the existing vitest pattern when adding unit tests.
- This is an interaction-heavy feature (voice + DOM action loop) — exercise it in a real browser
  before calling a change done, not just unit tests.

## How work happens

- `/build` runs the work (the kit: Superpowers plus `.claude/skills` and `.claude/agents`,
  same as `~/Mnt/portfolio`). In this existing repo it starts with an assessment of the code
  and of every doc (`docs/superpowers/specs/assessment.md`), then questions, then one
  approval of spec and plan, then one milestone at a time. Each milestone maps to a GitHub
  issue and ends in a PR (`Closes #N`) with code review, UI review, metrics, docs changes,
  manual checks and a demo GIF. **The user merges every PR; Claude waits for the merge.**
- **CI** (`.github/workflows/`): `ci.yml`'s job `check` runs on every PR and every push to
  `master` — Node from `.nvmrc`, `npm ci` in the root, `agent-client/` and `server/`, the root
  `npm run check`, then `npm run e2e` (deterministic only, no secrets; the Playwright report is
  uploaded on failure). `pr-demo-check.yml`'s job `demo` fails a PR whose description has no
  demo image. `master`'s branch protection (`.claude/skills/pr-demo/protect-master.sh`)
  requires both `check` and `demo`, so a red CI or a missing demo GIF blocks the merge.
- Every agent runs on Opus 5.5.
- **Docs are part of the work:** the planner keeps this file, `README.md` and `docs/` true —
  updating them in the same commit as the change that affects them, and proposing new docs
  (ADRs in `docs/adr/`, a `CONTEXT.md` glossary per `docs/agents/domain.md`) only when they
  will be read again. `docs/code-review-notes.md` stays the single review checklist.
- Superpowers preferences (they override the skills' defaults):
  - Brainstorming: questions in `AskUserQuestion` batches of up to 4, as many rounds as
    needed; architecture changes are the user's decision; one approval of spec and plan.
  - No git worktrees: work in place on the milestone branch; one commit per task.
  - Subagent-driven development runs one milestone's tasks without stopping, then the
    milestone reviews.
  - When finishing a milestone, do not show the merge/PR menu: push, open the PR, stop.
- Hard rules: never push to `master` or merge a PR; never bypass a hook or check; never skip
  or delete a failing test; ask before changing lint, build or test configuration. Secrets
  (`server/.env`) are never read or printed.

## Agent skills

### Issue tracker

Issues live as GitHub Issues on `github.com/jovstern/ai-presenter-agent`, via the `gh` CLI. See
`docs/agents/issue-tracker.md`.

### Domain docs

Single-context layout (one `CONTEXT.md` + `docs/adr/` at the repo root, created lazily by
`/domain-modeling`). See `docs/agents/domain.md`.
