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
  wired into `vite.config.js`'s `@vitejs/plugin-react` babel config — don't add manual
  `useMemo`/`useCallback` for render-perf reasons unless the compiler demonstrably can't cover the
  case. UI elements needing a primitive (dialog, toast, dropdown, etc.) default to Radix
  (`@radix-ui/react-*`); today that is only `KnowledgeModal.jsx`'s Dialog. Builds to a single IIFE
  script mounted in a shadow root. `npm test` (vitest), `npm run build`, `npm run watch`,
  `npm run lint`, `npm run typecheck`, `npm run check` (lint + typecheck + test + build).
  - `liveSession.js` — the Gemini Live socket: connect, reconnect backoff, resumption, tool
    dispatch, context injection. The riskiest file; unit-tested.
  - `useLiveAgent.js` — thin React glue: wires `liveSession` and `audioIO.js` (mic capture,
    playback, barge-in) into React state; owns teardown on unmount.
  - `bridgeChannel.js` — the private `MessageChannel` to `sandbox/bridge.js`
    ([ADR 0001](docs/adr/0001-private-bridge-channel.md)); `main.jsx` opens it once per page.
  - `AgentApp.jsx` — a minimal card: one never-disabled Connect/Cancel/Disconnect/Retry/Reload
    page button, a status line, an alert on `failed`, the transcript, and the `📄` knowledge button. The old `VolumeMeter`,
    `TranscriptLog`, `Toast.jsx` and `renderIsolation` test didn't survive the rebuild; their
    successors (volume orb, coalesced transcript, Radix toast, render-isolation test) return
    with the designed card in M7 (issue #11).
  - Pure helpers: `actionTools.js`, `domSnapshotContext.js`, `loopGuard.js`, `pcm.js`,
    `knowledgeStore.js`.
  - `bridgeProtocol.js` — types only: the bridge messages as JSDoc `@typedef`s. `sandbox/bridge.js`
    holds a verbatim copy of its `#region bridge protocol`; `bridgeProtocol.test.js` fails if
    they drift, so edit both together.
- `server/` (npm) — Node/Express, split in two:
  - `app.js` — `createApp({ mintToken, now, logger, production, limits })`, no `listen`, so
    tests drive it with supertest. Mints short-lived Gemini Live tokens (`/api/live-token`,
    gated on same-origin, a per-IP rate limit and a page nonce parsed with Zod), serves the
    nonce-templated sandbox page at `/` and `/sandbox/`, the other static directories gzipped
    (`compression`), and `GET /health`. pino-http logs every request with a request id
    (`x-request-id`); helmet sends the CSP (see below) and the other security headers. Every
    JSON error is `{ error: { code, message } }`, and a central error handler turns anything
    unexpected into a 500 without internals.
  - `expiringMap.js` — the TTL'd, size-capped map behind the nonce and rate-limit state.
  - `index.js` — env (`GEMINI_API_KEY`, `PORT` or 3000, `NODE_ENV`, `LOG_LEVEL`), the real
    Gemini mint, `listen`, graceful SIGTERM/SIGINT shutdown.
  `npm start`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run check` (all three).
  Static serving could be split off (`docs/project-knowledge-handoff.md` §5.3).
  **CSP** (`server/app.js`): `default-src 'self'`, `script-src 'self'` (no inline script on any
  page), `style-src 'self' 'unsafe-inline'` (runtime `<style>` from the shadow root and Radix),
  `connect-src` adds the Gemini `wss:`/`https:` origins, `frame-src 'self'`, `img-src 'self'
  data:`; HSTS and `upgrade-insecure-requests` only when `NODE_ENV=production`. Any change that
  adds a resource type updates the CSP in the same commit.
- `sandbox/` (static) — host page: iframe + `bridge.js` (channel handshake, action library,
  DOM snapshots). No build step.
- `target-app/` (static) — 2-page mock app used as the demo target: `index.html` + `home.js`
  (counter), `settings.html` + `settings.js` (Save confirmation), `style.css`. No build step.

## Commands and gates

From the repo root (run `npm install` there once for Prettier and Playwright, then
`npx playwright install chromium` once for the e2e):

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
`target-app/*.js` as classic browser scripts, so its `lint` script runs from the repo
root (ESLint 10 ignores files outside the base path).

Typecheck is `checkJs` + `strict` on plain JS with JSDoc types
([ADR 0002](docs/adr/0002-type-checking-with-checkjs.md)): `npm run typecheck` in each package
runs `tsc -p jsconfig.json` (TypeScript 7; plain `tsc` ignores `jsconfig.json`).
agent-client's config also covers `sandbox/bridge.js` (`// @ts-check`); it excludes
`src/__tests__/` for now. The page nonce is no longer a window global: `main.jsx` reads it off
its own script tag's `data-ds-nonce` and passes it down as a prop. No `any`, no `@ts-ignore`; a cast or `@ts-expect-error` carries a comment saying why.

## Docs map

- `docs/project-knowledge-handoff.md` — primary onboarding doc: origin story, verified-vs-unverified
  build status, decisions log, open questions.
- `docs/demostack-ai-presenter-agent.md` — build spec.
- `docs/sandbox-simulation.md` — why the iframe/same-origin simulation approach was chosen over a
  real external site.
- `docs/code-review-notes.md` — the living, severity-tagged review checklist (B1–B4, H1–H5,
  M1–M9, L1–L12). Done: B1–B4, H1–H5, M2–M4, L9, L12; the rest are open. Its original
  `file:line` references point at pre-rebuild code; each "Fixed" note names
  the current location. Update it in place; don't start a second tracking doc.
- `docs/adr/` — architecture decisions: 0001 private bridge channel, 0002 `checkJs` type
  checking, 0003 hosting on Render.
- `docs/superpowers/` — the `/build` cycle: `specs/assessment.md`, `specs/design.md` (the spec)
  and `plans/plan.md` (milestones M4–M7 and their tasks).

## Active work area

Recent work concentrates in `agent-client/src/liveSession.js` and `sandbox/bridge.js`: DOM-state
grounding (keyframe vs. delta snapshots, a debounced `MutationObserver`, a snapshot that arrives
during a tool batch sent inside its tool response), the private bridge
channel, and Live session robustness (one reconnect per drop, `reconnecting`/`failed` status,
session resumption, serialized tool calls). `liveSession.js` is the riskiest file and is covered
by `liveSession.test.js`; `useLiveAgent.js` is thin glue with its own Testing Library tests.

## Note on origin knowledge

`docs/project-knowledge-handoff.md` §1 describes the *original* Demostack product this rebuild is
modeled on (team, data model, config UI) — it's explicitly "why decisions were made," not a
description of this repo's own code. This rebuild deliberately excludes the agent-creation UI,
template/demo-agent data model, and real RAG. §5.1 (RAG-lite knowledge modal) is IMPLEMENTED;
§5.2 (Radix UI) is implemented for the Dialog only, the toast returns in M7.

## Workflow notes

- Two npm packages, not a workspace — `cd` into `agent-client/` or `server/` before running
  their npm commands (`npm install` included); the root only runs `check`, `format`, `dev`,
  `e2e` and `e2e:live`.
- When touching `liveSession.js`, `useLiveAgent.js` or `bridge.js`, reconcile changes against
  `docs/code-review-notes.md`'s existing items rather than creating a second tracking surface.
- Tests: `agent-client/src/__tests__/` has 10 vitest files (94 tests): `actionTools`,
  `bridge` (runs `sandbox/bridge.js` against a stubbed iframe), `bridgeChannel`,
  `bridgeProtocol` (the typedef copies match), `domSnapshotContext`,
  `knowledgeStore`, `liveSession`, `loopGuard`, `pcm` and `useLiveAgent.test.jsx` (Testing
  Library). `server/__tests__/` has 2 vitest files (31 tests): `app` (supertest against
  `createApp` with a stubbed mint and clock: the token gate's 403/400/429/500/200 paths, both
  sandbox URLs templated, no inline scripts, the CSP and other headers, `/health`, the nonce cap)
  and `expiringMap` (expiry, pruning on access, the cap). `e2e/` has 3 Playwright specs (13
  tests) on `e2e/fixtures.js`, whose `test` fails on any console error, page error or CSP
  violation in any frame: `bridge.spec.js` (7: `sandbox/bridge.js` on a fixture page, the test
  doing the real handshake and port transfer — the actions, the allowlist, unknown routes, a
  second connect and forged `window` messages ignored, snapshots), `loop.spec.js` (2: the real
  `/` page against a fake Gemini Live via `page.routeWebSocket` — a tool batch, a dropped
  socket, one token per reconnect, the page nonce; and the fatal `not_configured` path) and
  `a11y.spec.js` (4: axe with zero violations on `/` idle, with the knowledge dialog open —
  inside the shadow root — and on both target-app pages). `e2e/live.spec.js` (3, opt-in, real
  Gemini: greeting, the five-step task, a forced close → recovery) runs only under
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
