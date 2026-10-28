# ai-presenter-agent-v2

A from-scratch rebuild of the runtime half of Demostack's AI Presenter Agent: a voice avatar
(Gemini Live API) embedded in an iframe that both talks and acts (click/scroll/navigate/fill) on
a target web app via a private MessageChannel bridge (ADR 0001). Not in scope: agent-creation UI, real RAG
(chunking/embeddings — only a "RAG-lite" localStorage context-stuffing feature exists), the flow
builder. See `docs/project-knowledge-handoff.md` for the full origin story and what was
deliberately left out.

## Package layout

No root package.json, no workspaces — two npm packages and two static directories, each run
on its own:

- `agent-client/` (npm) — React 19 + Vite, with the React Compiler (`babel-plugin-react-compiler`)
  wired into `vite.config.js`'s `@vitejs/plugin-react` babel config — don't add manual
  `useMemo`/`useCallback` for render-perf reasons unless the compiler demonstrably can't cover the
  case. UI elements needing a primitive (dialog, toast, dropdown, etc.) default to Radix
  (`@radix-ui/react-*`); today that is only `KnowledgeModal.jsx`'s Dialog. Builds to a single IIFE
  script mounted in a shadow root. `npm test` (vitest), `npm run build`, `npm run watch`.
  - `liveSession.js` — the Gemini Live socket: connect, reconnect backoff, resumption, tool
    dispatch, context injection. The riskiest file; unit-tested.
  - `useLiveAgent.js` — thin React glue: wires `liveSession` and `audioIO.js` (mic capture,
    playback, barge-in) into React state; owns teardown on unmount.
  - `bridgeChannel.js` — the private `MessageChannel` to `sandbox/bridge.js`
    ([ADR 0001](docs/adr/0001-private-bridge-channel.md)); `main.jsx` opens it once per page.
  - `AgentApp.jsx` — a minimal card: one Connect/Disconnect/Retry button, a status line, an alert
    on `failed`, the transcript, and the `📄` knowledge button. The old `VolumeMeter`,
    `TranscriptLog`, `Toast.jsx` and `renderIsolation` test didn't survive the rebuild; their
    successors (volume orb, coalesced transcript, Radix toast, render-isolation test) return
    with the designed card in M7 (issue #11).
  - Pure helpers: `actionTools.js`, `domSnapshotContext.js`, `loopGuard.js`, `pcm.js`,
    `knowledgeStore.js`.
- `server/` (npm) — Node/Express. Mints short-lived Gemini Live tokens (`/api/live-token`, gated
  on same-origin, a per-IP rate limit and a page nonce) and serves the other three directories.
  Serves the nonce-templated sandbox page at `/` and `/sandbox/`, port `PORT` or 3000.
  `npm start`. Static serving could be split off (`docs/project-knowledge-handoff.md` §5.3).
- `sandbox/` (static) — host page: iframe + `bridge.js` (channel handshake, action library,
  DOM snapshots). No build step.
- `target-app/` (static) — 2-page mock app used as the demo target. No build step.

No lint or typecheck is configured yet (M5, issue #13, adds them; see
[ADR 0002](docs/adr/0002-type-checking-with-checkjs.md)).

## Docs map

- `docs/project-knowledge-handoff.md` — primary onboarding doc: origin story, verified-vs-unverified
  build status, decisions log, open questions.
- `docs/demostack-ai-presenter-agent.md` — build spec.
- `docs/sandbox-simulation.md` — why the iframe/same-origin simulation approach was chosen over a
  real external site.
- `docs/code-review-notes.md` — the living, severity-tagged review checklist (B1–B4, H1–H5,
  M1–M9, L1–L12). Done: B1–B4, H2–H5, M2–M4, L9, L12. H1 waits for the CSP in M5; the rest are
  open. Its original `file:line` references point at pre-rebuild code; each "Fixed" note names
  the current location. Update it in place; don't start a second tracking doc.
- `docs/adr/` — architecture decisions: 0001 private bridge channel, 0002 `checkJs` type
  checking, 0003 hosting on Render.
- `docs/superpowers/` — the `/build` cycle: `specs/assessment.md`, `specs/design.md` (the spec)
  and `plans/plan.md` (milestones M4–M7 and their tasks).

## Active work area

Recent work concentrates in `agent-client/src/liveSession.js` and `sandbox/bridge.js`: DOM-state
grounding (keyframe vs. delta snapshots, a debounced `MutationObserver`), the private bridge
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

- Two npm packages, not a workspace — `cd` into `agent-client/` or `server/` before running npm
  commands.
- When touching `liveSession.js`, `useLiveAgent.js` or `bridge.js`, reconcile changes against
  `docs/code-review-notes.md`'s existing items rather than creating a second tracking surface.
- Tests: `agent-client/src/__tests__/` has 7 vitest files (57 tests): `bridgeChannel`,
  `domSnapshotContext`, `knowledgeStore`, `liveSession`, `loopGuard`, `pcm` and
  `useLiveAgent.test.jsx` (Testing Library). `server/` and `sandbox/` have none yet; the bridge's
  handshake/allowlist test arrives with the M5 e2e. Follow the existing vitest pattern when adding
  tests to `agent-client`.
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
