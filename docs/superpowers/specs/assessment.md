# Assessment — ai-presenter-agent v2 (2026-10-28)

Written at the start of the first `/build` cycle on this repo, from the code on
`m4-closed-loop` (PR #9, with `master` merged in), every doc in `docs/`, issues #1–#5,
PRs #6–#10, and a run of what exists.

## 1. Product and where it stands

A voice avatar (Gemini Live) mounted in a shadow root on a sandbox page. It talks and acts
(click / scroll / fill / navigate) on a same-origin iframe target app through a
`postMessage` bridge. It also has a "RAG-lite" knowledge modal (files + strict rules in
`localStorage`, stuffed into the session as context). Scope is the runtime only (see
`docs/project-knowledge-handoff.md` §2).

| Milestone | Issue | PR | State |
|---|---|---|---|
| M1 Server + voice channel | #1 closed | #6 merged | done |
| M2 Knowledge / RAG-lite | #2 closed | #7 merged | done |
| M3 Sandbox scaffolding | #3 closed | #8 merged | done |
| M4 Closed loop (grounding + tools + completion detection) | #4 open | **#9 open, no reviews** | in flight |
| M5 Hardening + tuning | #5 open | — | not started |
| Kit adoption | — | #10 merged | done |

PR #9 now has `master` merged in (pushed as `cf1d9bd`), so it carries the kit.

## 2. Architecture as it really is

```mermaid
flowchart LR
  subgraph Browser["Sandbox page (served by server at /)"]
    direction LR
    subgraph Shadow["agent-client (shadow root, IIFE bundle)"]
      App[AgentApp.jsx] --> Hook[useLiveAgent.js<br/>React glue]
      Hook --> LS[liveSession.js<br/>connect, reconnect, resumption,<br/>tool dispatch, snapshot context]
      Hook --> AIO[audioIO.js<br/>ScriptProcessor capture + player]
      LS --> DSC[domSnapshotContext.js]
      LS --> LG[loopGuard.js]
      LS --> AT[actionTools.js]
      App --> KM[KnowledgeModal.jsx] --> KS[knowledgeStore.js<br/>localStorage]
    end
    Bridge[sandbox/bridge.js<br/>closure action library,<br/>origin + allowlist,<br/>snapshot + MutationObserver]
    IF[iframe: target-app<br/>2 static pages]
    LS <-->|window.postMessage<br/>ds-action / ds-action-result /<br/>ds-dom-snapshot / ds-ready| Bridge
    Bridge -->|direct DOM, same-origin| IF
  end
  Server["server/index.js (Express)<br/>/api/live-token: origin + rate limit + nonce<br/>static: /sandbox /target-app /agent-client<br/>/ = sandbox HTML with nonce templated"]
  Gemini[(Gemini Live<br/>gemini-3.8-live)]
  Server -- ephemeral token --> LS
  LS <-->|WebSocket: audio, transcripts, tool calls| Gemini
```

The M4 refactor split the old 294-line `useLiveAgent.js` into `liveSession.js` (305 lines,
now the riskiest file), `audioIO.js` and a 59-line hook. `CLAUDE.md` still points at the old
shape.

## 3. Conventions the code follows (versus `stack-conventions`)

| Area | This repo | Kit | Proposal? |
|---|---|---|---|
| Language | Plain JS/JSX, ESM | TypeScript strict | Yes: `checkJs` with JSDoc types, or a TS migration (user decides) |
| React | 19 + Compiler, no manual memo, `useSyncExternalStore` for the store | same | — |
| Primitives | Radix Dialog | Radix | — |
| Server data | none (no app API besides the token) | TanStack Query | N/A |
| Forms | one textarea | TanStack Form + Zod | N/A at this size |
| Structure | flat `src/` | `src/features/*` | No: 12 files, flat is fine |
| Tests | `src/__tests__/*.test.js` | next to the file | No: keep the repo's pattern |
| Server | one 127-line `index.js`, `console.log`, no Zod config, no helmet, `X-Powered-By` on | `node-api.md` shape, pino, helmet, Zod config, `/health` | Yes, scaled down (see §4) |
| Versions | caret ranges (`^2.22.0`) for a fast-moving SDK | exact stable | Yes (review item M8) |
| Comments | dense "why" comments that cite the review checklist | why-comments | — (matches) |

## 4. Quality baseline versus `quality-gates`

| Gate | Exists? | Result today | Risk of the gap |
|---|---|---|---|
| Unit tests (agent-client) | yes, vitest | **25/25 pass** (domSnapshotContext, knowledgeStore, loopGuard, pcm) | `liveSession.js`, `bridge.js`, `server` have **zero** tests |
| Build | yes | **clean**, `agent-client.js` 620 kB / **148.6 kB gzip** | — |
| Lint | no | — | hooks-rule and dead-code mistakes go unseen |
| Format | no | — | low |
| Types | no | — | arg-shape bugs across the postMessage seam |
| `npm run check` | no | — | there is no single gate command |
| e2e (Playwright) | no | — | the voice + action loop is verified only by hand |
| CI | no | — | nothing runs on a PR |
| `protect-master.sh` | not run | — | unknown whether `master` is protected |
| Server tests | no | — | the token gate (origin / nonce / rate limit) is untested |

The live loop can be tested in a real browser without a human voice. Chromium's
`--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<wav>` feeds a
recorded prompt to `getUserMedia` (macOS `say` can produce the WAV). That makes an opt-in,
key-gated live e2e possible, next to a deterministic bridge e2e that needs no Gemini.

## 5. Findings on PR #9 (read and run, not yet fixed)

| # | Sev | Finding |
|---|---|---|
| A1 | High | **`/sandbox/` is broken for the agent.** `express.static('/sandbox')` serves `index.html` with the literal `%%DS_NONCE%%`; only `/` templates the nonce. The README says to open `/sandbox/` (on port 8787; the server defaults to 3000), so the documented path 403s on the token. Verified with curl. |
| A2 | High | **B2 reintroduced one layer up.** When the session goes `failed`, the button shows "Connect". `useLiveAgent.connect()` then starts a new capture and player without stopping the previous ones (`disconnect()` was never called), which leaks a live mic stream and an `AudioContext`. There is also no unmount cleanup: the window listeners in `liveSession` are never removed and the hook doesn't close anything (M4). |
| A3 | High | **Status lies during retries.** A token or connect failure sets `failed` and then schedules a retry, so the UI says "failed" while it is still reconnecting. There is no `reconnecting` state and no retry affordance (spec goal #6). The handoff doc §5.2 describes a Radix Toast that does not exist in this rebuild. |
| A4 | High | **Session-token binding on the bridge (spec goal #1) is still not built.** `bridge.js` says "deferred to M4/M5". Neither PR #9 nor the checklist records the deferral, and `event.source` is not checked. Issue #4's "done when" needs it closed or explicitly deferred. |
| A5 | Med | A bridge action that throws never replies, so the client waits the 4 s timeout (M3, still open). |
| A6 | Med | `liveSession.js` has no tests (H2). PR #9 defers them to M5, but it is the riskiest file. |
| A7 | Low | The bridge posts the load snapshot *before* `ds-ready`, so `markNavigated()` forces a redundant keyframe on the next mutation. |
| A8 | Low | Transcript fragments are appended one entry per fragment, are unbounded, and have no `aria-live`. |
| A9 | Low | 500s echo `err.message` to the browser. |

## 6. Metrics

Measurable automatically:
- bundle size (gzip);
- Lighthouse and axe on `/` (the sandbox page plus the widget);
- console errors and 5xx during e2e;
- token-endpoint latency;
- bridge action round-trip;
- snapshot payload size.

Specific to this app, measured through the opt-in live e2e (fake-mic WAV, real key):
- **connect time** (click → `open`);
- **time to first agent audio**;
- **tool-call round-trip** (toolCall → bridge → sendToolResponse);
- **action success rate** across a scripted multi-step task;
- **reconnect recovery time** after a forced socket close;
- **snapshot tokens per turn** (keyframe vs delta).

Budgets: the kit defaults apply to `/`. The widget bundle is held to ≤ 150 kB gzip (148.6
today, no headroom).

## 7. Docs audit

| Doc | State | Action |
|---|---|---|
| `CLAUDE.md` | **stale** | Says `useLiveAgent.js` is the riskiest file with zero tests (it's 59 lines now; `liveSession.js` is the risk). Lists `renderIsolation` and the `VolumeMeter` / `TranscriptLog` / `Toast` files, none of which exist in the rebuild. Says "three npm roots" for 2 packages + 2 static dirs. No gate commands. Update. |
| `README.md` | **stale / wrong** | Gives port 8787 and URL `/sandbox/` (see A1); "greets once the iframe loads" (it greets on Connect); says "3 terminals"; test list names files that don't exist. Rewrite the run/test sections. |
| `docs/project-knowledge-handoff.md` §3–§5 | **stale** | Model is `gemini-3.1-flash-live-preview` (now legacy, shuts down 2026-11-17; code uses `gemini-3.8-live`); the bundle is "282 KB gzip" (148.6); test counts; Toast; `useLiveAgent.js` internals; "live loop never run" (PR #9 says it was). Update §3 and §5; §1–§2 are origin and stay. |
| `docs/demostack-ai-presenter-agent.md` | mostly current | Goals #8/#9 (volume meter in a ref, render-count test) are **not built in the rebuild**. Either build them or mark them dropped. |
| `docs/sandbox-simulation.md` | current | Fix typo L12 ("sandbard"). |
| `docs/code-review-notes.md` | **drifted** | B1/B2/H3/H4 and most of H1/H5 are fixed per its own editorial notes, but **every box is unchecked** and line refs point at deleted code. Tick and annotate in place. |
| `docs/agents/*.md` | current | — |
| `docs/adr/`, `CONTEXT.md` | missing | Create lazily. Worth an ADR each for the decisions §4 of the handoff already logs, only if the user wants them back-filled. A glossary is worth it: keyframe/delta, bridge, nonce, generation, loop guard. |

## 8. Closing status (M8 T4, 2026-11-06)

Every item above is done or filed as a GitHub issue. Where each one landed:

| Item | Status | Where |
|---|---|---|
| A1 `/sandbox/` not templated | done | M4 T1: one handler templates `/`, `/sandbox`, `/sandbox/`, `/sandbox/index.html`; `server/__tests__/app.test.js` |
| A2 a second mic / `AudioContext` on Retry, no unmount cleanup | done | M4 T4 (`useLiveAgent.js` teardown); M6 fix wave (capture releases once); `useLiveAgent.test.jsx`, `audioIO.test.js` |
| A3 status lies during retries | done | M4 T3 (`reconnecting`, `failed` only when the retries run out); M7 T4 (the card's states and the Radix Toast); `liveSession.test.js`, `e2e/widget.spec.js` |
| A4 session-token binding on the bridge | done | M4 T2: the private `MessageChannel` ([ADR 0001](../../adr/0001-private-bridge-channel.md)); `e2e/bridge.spec.js` (forged messages ignored) |
| A5 a throwing action never replies | done | M4 T2: `success: false` at once; `bridge.test.js` |
| A6 `liveSession.js` untested | done | M4 T3: `liveSession.test.js` |
| A7 load snapshot before `ds-ready` | done | M4 T2 (`navigated` posted before the snapshot) |
| A8 transcript one entry per fragment, unbounded, no `aria-live` | done | M7 T3 (`transcript.js`, `Transcript.jsx`) |
| A9 500s echo `err.message` | done | M4 T1, M5 T3 (the central error handler, `{ error: { code, message } }`) |
| §3 plain JS vs TypeScript | done | M5 T2: `checkJs` + `strict` ([ADR 0002](../../adr/0002-type-checking-with-checkjs.md)) |
| §3 server shape (pino, helmet, Zod config, `/health`) | done | M5 T3 (`app.js` / `index.js`, pino, helmet + CSP, `/health`); M8 T1 (`config.js`) |
| §3 caret ranges | done | M6 T4: `@google/genai` and every other dependency pinned exactly (review item M8) |
| §4 lint, format, types, `npm run check` | done | M5 T1, T2 |
| §4 e2e, server tests | done | M5 T3, T4 (and every milestone since: 33 e2e, 113 server tests) |
| §4 CI, `protect-master.sh` | done | M5 T6: `ci.yml` (`check`), `pr-demo-check.yml` (`demo`), `master` protected |
| §4 live loop testable without a voice | done | M5 T5: `npm run e2e:live` (fake-mic WAVs) |
| §6 metrics | done | `docs/metrics/m04.md`–`m07.md`, `history.csv`; app metrics from the live e2e; the bundle budget is 180 kB (raised by the user, spec Budgets) |
| §7 CLAUDE.md, README, handoff | done | every milestone; brought fully up to date in M8 T4 |
| §7 spec goals #8 / #9 | done | M7 T2 (`VolumeOrb.jsx`, `renderIsolation.test.jsx`) |
| §7 `sandbox-simulation.md` typo L12 | done | M4 T5 |
| §7 review checklist ticked | done | `docs/code-review-notes.md`: B1–B4, H1–H5, M1–M10, L1–L12 all done |
| §7 ADRs and `CONTEXT.md` | done | `docs/adr/0001`–`0004`; `CONTEXT.md` (M5) |

Follow-up work filed as issues at the close of the cycle:

| Issue | Follow-up | From |
|---|---|---|
| [#17](https://github.com/jovstern/ai-presenter-agent/issues/17) | Widget motion: dialog enter/exit and an orb pulse while reconnecting | M7 UI review ideas |
| [#18](https://github.com/jovstern/ai-presenter-agent/issues/18) | Card and dialog details: outline End button, counter colours near the limit, clamped file names | M7 UI review ideas |
| [#19](https://github.com/jovstern/ai-presenter-agent/issues/19) | Verify mic capture in Safari and Firefox | handoff §3.3 (Chromium-only verification) |
| [#20](https://github.com/jovstern/ai-presenter-agent/issues/20) | Bundle headroom: 0.76 kB under the 180 kB budget | spec Budgets, `docs/metrics/m06.md` options C / D |
| [#21](https://github.com/jovstern/ai-presenter-agent/issues/21) | Typecheck the agent-client unit tests | `jsconfig.json` excludes `src/__tests__/` |
| [#22](https://github.com/jovstern/ai-presenter-agent/issues/22) | Tune the snapshot cap and refresh ratio on a larger target page | R16, handoff §3.3 |

Not filed: the Render unknowns from M8 T1 (the proxy hop count, the key on PR previews), which
M8 T3 settles when the service goes live; the "real external site" path and the agent-creation
side, which are out of scope by design (spec Out of scope).
