# ai-presenter-agent-v2

A from-scratch rebuild of the runtime half of Demostack's AI Presenter Agent: a voice avatar
(Gemini Live API) embedded in an iframe that both talks and acts (click/scroll/navigate/fill) on
a target web app via a postMessage bridge. Not in scope: agent-creation UI, real RAG
(chunking/embeddings — only a "RAG-lite" localStorage context-stuffing feature exists), the flow
builder. See `docs/project-knowledge-handoff.md` for the full origin story and what was
deliberately left out.

## Package layout

No root package.json, no workspaces — four independent directories, each with its own commands:

- `agent-client/` — React 19 + Vite, with the React Compiler (`babel-plugin-react-compiler`) wired
  into `vite.config.js`'s `@vitejs/plugin-react` babel config — autocomplete/autocorrect for
  memoization is the default going forward; don't add manual `useMemo`/`useCallback` for
  render-perf reasons unless the compiler demonstrably can't cover the case. UI elements needing a
  primitive (dialog, toast, dropdown, etc.) should default to Radix (`@radix-ui/react-*`), which
  is already how `KnowledgeModal.jsx`/`Toast.jsx` are built — this is a going-forward convention
  for new elements, not a mandate to refactor existing hand-rolled visualizations (`VolumeMeter`,
  `TranscriptLog`). Builds to a single script mounted in a shadow root. `npm test` (vitest),
  `npm run build`, `npm run watch`.
- `server/` — Node/Express (migrated off Hono). Mints short-lived Gemini Live tokens, serves
  static files for all three other packages. `npm start`. Its only hard requirement is the token
  endpoint — the real `GEMINI_API_KEY` can't reach the browser — but static-file serving is
  currently kept alongside it rather than split out (see `docs/project-knowledge-handoff.md`
  §5.3 for the alternative of shrinking it to token-only).
- `sandbox/` — host page: iframe + `bridge.js` (postMessage bridge + action library). No build step.
- `target-app/` — static 2-page mock app used as the demo target. No build step.

No lint or typecheck is configured anywhere in the repo.

## Docs map

- `docs/project-knowledge-handoff.md` — primary onboarding doc: origin story, verified-vs-unverified
  build status, decisions log, open questions.
- `docs/demostack-ai-presenter-agent.md` — build spec.
- `docs/sandbox-simulation.md` — why the iframe/same-origin simulation approach was chosen over a
  real external site.
- `docs/code-review-notes.md` — a living, severity-tagged (Blocker/High/Medium/Low) review
  checklist with checkboxes: B1–B4, H1–H5, M1–M9, L1–L12, all still open and unchecked except
  H5 points 1 & 2 (fixed by the two most recent commits, per an added editorial note — see
  memory `active-review-items` for specifics). The single most serious item per the reviewer is
  **B2**: reconnect leaks the old mic/audio pipeline and can race into two concurrent live
  sessions. Update this doc in place when an item gets fixed; don't start a second tracking doc.

## Active work area

Recent development concentrates in `agent-client/src/useLiveAgent.js` and `sandbox/bridge.js`:
DOM-state grounding (keyframe vs. delta snapshots) and Gemini Live session robustness (model
verification, session resumption, MutationObserver-based action-completion detection replacing a
fixed post-action timeout). `useLiveAgent.js` itself has zero test coverage (H2) and is called
out as the riskiest file in the repo.

## Note on origin knowledge

`docs/project-knowledge-handoff.md` §1 describes the *original* Demostack product this rebuild is
modeled on (team, data model, config UI) — it's explicitly "why decisions were made," not a
description of this repo's own code. This rebuild deliberately excludes the agent-creation UI,
template/demo-agent data model, and real RAG. §5.1 (RAG-lite knowledge modal) and §5.2 (Radix UI)
are marked IMPLEMENTED — already built, not just planned.

## Workflow notes

- This is three separate npm roots, not a workspace — `cd` into the right package before running
  npm commands.
- When touching `useLiveAgent.js` or `bridge.js`, reconcile changes against
  `docs/code-review-notes.md`'s existing items rather than creating a second tracking surface.
- Test coverage is thin and uneven: `agent-client/__tests__/` has 4 vitest files
  (`domSnapshotContext`, `knowledgeStore`, `loopGuard`, `renderIsolation`); `server/` and
  `sandbox/` have none. Follow the existing vitest pattern when adding tests to `agent-client`.
- This is an interaction-heavy feature (voice + DOM action loop) — exercise it in a real browser
  before calling a change done, not just unit tests.
