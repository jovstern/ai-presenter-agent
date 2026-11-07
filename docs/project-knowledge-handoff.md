# Project knowledge handoff

> Read this first if you're picking up this repo cold — as a fresh agent, or as the author coming
> back after a break. It's the "everything we know" doc: where this project came from, what's
> actually built and verified vs. just written, every caveat and assumption baked into the current
> code, and what's planned next. [`demostack-ai-presenter-agent.md`](./demostack-ai-presenter-agent.md)
> is the build spec; [`sandbox-simulation.md`](./sandbox-simulation.md) is the deep-dive on the
> iframe/same-origin mechanics. This doc is the narrative and status layer around both.

## 1. Where this comes from

This is a from-scratch rebuild of the runtime half of a real system — a "Presenter Agent" built at
Demostack (2025-present), reconstructed here from memory in a prep session, not from its source.
Treat everything in this section as **origin knowledge**, not as ground truth about this repo's
own code — it's why decisions were made, not a description of what's implemented here.

### 1.1 The product

Demostack's core product clones a target web app — capturing its network traffic (APIs, JS
bundles, static assets) — into its own datastore and republishes it as an editable, endlessly
forkable **demo** on its own domain. One clone can become many differently-told demos without
standing up new infrastructure per story. Historically a human presenter narrated the demo live;
the **Presenter Agent** replaces that human with an AI embedded in the demo that both talks and
acts (navigate, click, scroll, fill forms) on the viewer's behalf.

### 1.2 The team and ownership (original project)

Sole FE (the author) on a 5-person team: 1 FE, 2 BE, 1 product, 1 designer. The FE owned, end to
end: the agent-creation config UI, the standalone agent-client React app, a small Hono server that
served it, tests, production deploys, and performance work. The idea was an internal bet from the
CTO and product — part AI strategy, part competitive gap.

### 1.3 Data model (original project — not implemented in this rebuild, see §3)

- **Template agents**: reusable across the whole system — avatar, voice/tone, RAG content
  (uploaded docx/pdf/txt; video was wanted but never shipped).
- **Demo agents**: children of a template, forked per demo, adding a **flow** — an ordered list of
  steps (`order`, `title`, `page`, `content`) authored in a separate Editor app (mainly used on
  desktop). `page` was picked from the app's already-crawled route list, not free text — this
  detail matters, see §1.6.
- Agent creation triggered an **async backend build** (RAG indexing / model config — backend-
  owned, never confirmed exactly what it did). The FE polled a status field on a **fixed 10s
  interval**, only while the agent list screen was mounted, and only for agents still building.
  No backoff was used, deliberately — the wait is short-lived and bounded by the user watching
  the screen, not an idle long-lived poller, so backoff wasn't solving a problem that existed.
- **Never verified**: whether editing a template after demo-agents already exist from it
  propagates to those children, or whether creation is a one-time snapshot. Left as an open
  question in the original story; irrelevant here since this rebuild has no template/demo-agent
  model at all.

### 1.4 Config UI (original project)

A 3-step wizard built as one large **TanStack Form**, chosen specifically because its own store
made cross-field projection cheap with no prop-drilling or a separate global store — e.g.
changing the agent's name/gender live-updated a voice "play" preview, and an uploaded avatar image
projected into several places across the wizard as you went.

### 1.5 Runtime embedding (original project — the part this rebuild does implement, see §3)

At play/share time, the demo page ("sandbox") fetched a **fresh**, agent-scoped `token` +
`sessionId` from the backend (Cusmo) — refetched every time, which is what kept the agent-to-demo
*binding* from ever going stale even though the agent's own *content* was baked in at build time.
The sandbox then loaded a `<script>` tag (the prebuilt agent-client bundle, served off the small
Hono server) plus a custom element carrying that token; the script mounted the React agent into a
**shadow root** on that element for full style isolation, authenticated with the token, and opened
a WebSocket session directly with Cusmo.

### 1.6 Conversation, grounding, and action execution (original project)

Mic audio streamed to Cusmo, relayed to **Gemini Live**; responses streamed back over the same
WebSocket as either narration (base64 audio, decoded client-side, driving a 3-bar volume
visualizer — center bar = true volume, two side bars = a randomized smaller fraction of it, all
animated together) or structured events like `{dsEvent:'click', xpath}`.

Screenshots were tried for grounding and dropped — too heavy/slow. What replaced them:

1. A **structural DOM snapshot** sent to the agent on load and on every page change (never
   precisely confirmed what shape it took — the "best practice" version this rebuild adopted is a
   flattened, labeled, diffed, size-capped list — see spec §5.3).
2. An **action-result loop** — every dispatched action reported success/failure back to the
   model, which is what actually let it keep reasoning and narrating without ever seeing pixels.

Action execution: the agent posted `{dsEvent, xpath}` via `postMessage` to the sandbox. The
sandbox — which pre-loaded an action library **on `window`** at startup (why it was global was
never established; flagged as a gap, not a deliberate choice) — executed directly against the
iframe's DOM, because **the clone was served same-origin with the sandbox**. (This was
double-checked mid-conversation — an earlier assumption that the clone was cross-origin was
wrong.) The result was posted back up to the agent.

### 1.7 Resilience and performance (original project)

A custom hook wrapped Google's live-model client (connect/on/off, mic-to-model audio encoding,
transcript-vs-event demuxing, volume tracking), with WebSocket reconnect on a real backoff
(immediate, 1s, 3s, ... giving up after 6 attempts). On final failure, the UX was **silent** — the
volume graph and mic just vanished, with no "reconnecting"/"failed" messaging. A known, un-fixed
gap.

The avatar subtree re-rendered on almost every audio tick (the mic picked up continuous ambient
noise, not just speech). Found via the **React Profiler flamegraph**; fixed by isolating the
volatile visualizer into its own memoized component so the rest of the avatar/chat tree stayed
still.

### 1.8 Testing (original project)

Standard unit/component coverage, plus a genuinely uncommon eval harness built in **Playwright**:
spin up an agent via API key, have a second agent converse with it, and a third agent score/rank
the conversation quality.

### 1.9 Production bugs actually seen

1. The agent losing track of what it "saw" — mitigated by the DOM-snapshot + action-result
   grounding above, not by adding vision back.
2. Repetition loops (repeating a sentence/action) and hallucinated navigation targets (trying to
   go to a page that doesn't exist). Root cause: the model's action space wasn't narrowed enough —
   specifically, the flow's own `page` field *was* grounded (picked from a crawled-route list),
   but the agent's *live, freeform* navigation decisions mid-conversation weren't held to the same
   constraint.

### 1.10 Security gaps found in retrospect (not fixed in the original at the time)

- The `postMessage` bridge was never origin- or token-validated.
- The action library living on `window` would have let any page script bypass that validation
  entirely anyway, even if it existed.
- These two gaps, together, are the direct reason this rebuild's `sandbox/bridge.js` validates
  `event.origin`, a session token, and an explicit action allowlist, and keeps the action library
  in a closure instead of on `window` — see §3.2.

## 2. Why this rebuild is scoped the way it is

Deliberately excludes: the agent-creation config UI, the template/demo-agent data model, RAG
upload/indexing as a backend pipeline, the Editor flow builder, and async build+polling. None of
that is where the interesting engineering is. Also deliberately does not clone a real external
site — see `sandbox-simulation.md` for exactly why "any real site in an iframe" doesn't actually
work, and what this build does instead (a small, authored, same-origin mock target-app).

## 3. Current build status (this repo, as of this rebuild)

### 3.1 What exists

```
docs/            this doc, the spec, sandbox-simulation, code-review-notes, adr/, superpowers/,
                 metrics/ (the observer's report per milestone)
target-app/      2 static pages (Home, Settings) + their scripts (home.js, settings.js), data-testids,
                 routes.json (the one route list: the bridge and navigate's enum both read it)
sandbox/         iframe host page + bridge.js (channel handshake, action library, DOM snapshot)
agent-client/    React 19 app (React Compiler on), built to an ES module plus a lazy Gemini SDK
                 chunk (ADR 0005), mounted in a shadow root
server/          Express: app.js (token gate, /api/client-log, CSP, pino logs, /health),
                 config.js (the env parsed with Zod), index.js (listen, shutdown)
render.yaml      the Render Blueprint (ADR 0003)
```

Two npm packages (`agent-client`, `server`) and two static directories (`sandbox`,
`target-app`). Inside `agent-client/src/`:

- `main.jsx` — mounts the shadow root on a plain host `<div>`, opens the bridge channel once for
  the page's lifetime, unmounts on a non-persisted `pagehide`. It is a module script: its URL is
  `import.meta.url`, and the page nonce comes off the tag with that `src`.
- `liveSdk.js` — the one `import()` of `@google/genai/web`, on Talk (or when Talk is pointed at
  or focused), never on page load ([ADR 0005](./adr/0005-load-the-gemini-sdk-on-talk.md)).
- `bridgeChannel.js` — the agent's end of the private `MessageChannel` to `sandbox/bridge.js`
  ([ADR 0001](./adr/0001-private-bridge-channel.md)).
- `liveSession.js` — the Live socket: token fetch, connect, one-retry-per-drop backoff,
  resumption, serialized tool dispatch, knowledge and snapshot injection. The riskiest file.
- `useLiveAgent.js` — thin React glue over `liveSession.js` and `audioIO.js` (mic capture,
  playback, barge-in); owns teardown. Mic capture runs in an AudioWorklet,
  `agent-client/public/capture-worklet.js` (§4).
- `AgentApp.jsx` — the card (the volume orb, one Talk to the AI Presenter / Cancel / End / Retry / Try again / Reload page button, status line, the
  failure's reason, mic alerts, transcript, the knowledge button with its document icon); `FailureToast.jsx` — the Radix
  toast on `failed`, once per failure (§5.2); `VolumeOrb.jsx` — the orb's rAF loop (§4);
  `Transcript.jsx` — the coalesced turns (up to 20) in a fixed-height box that follows the newest line, `aria-live="polite"` (additions only);
  `KnowledgeModal.jsx` — the knowledge button and its Radix dialog (§5.1).
- `clientLog.js` — the production client log (M8 T2): the bundle's own uncaught errors, the
  real user's LCP / INP / CLS (`web-vitals`) and each connection failure, sent as
  `navigator.sendBeacon` reports to the server's `/api/client-log`, which logs them with pino.
- Pure helpers: `actionTools.js`, `domSnapshotContext.js`, `loopGuard.js`, `pcm.js`,
  `knowledgeStore.js`, `transcript.js` (fragments → bounded turns).

### 3.2 What's built and actually verified (not just written)

- `npm install` succeeds in both `agent-client/` and `server/`.
- `agent-client`'s test suite passes (76 tests, 8 files, as of the M4 fix wave): `liveSession.test.js`
  (23 — the session state machine, see §3.3), `bridge.test.js` (4 — `sandbox/bridge.js`'s
  `navigate` against a stubbed iframe, and its replies surviving a later `postMessage` patch), `bridgeChannel.test.js` (10 — the private channel),
  `knowledgeStore.test.js` (10 — see §5.1), `useLiveAgent.test.jsx` (14 — the hook and card via
  Testing Library), `domSnapshotContext.test.js` (7 — the keyframe-vs-delta decision, see the
  decisions log below and `demostack-ai-presenter-agent.md` §5.3), `loopGuard.test.js` (5) and
  `pcm.test.js` (3). The first build's `renderIsolation.test.jsx` didn't survive the rebuild; it
  returned in M7 T2, with `VolumeOrb.test.jsx`. At the end of cycle 1 (M8 T4) the counts are
  20 files and 381 tests in agent-client, 5 files and 117 tests in `server/` (`config` and
  `clientLog` added in M8), and 33 deterministic Playwright tests in 5 specs, plus the 3 opt-in
  live ones; CLAUDE.md lists what each file covers.
- `npm run build` produces an ES module, `dist/agent-client.js`, 107.79 kB gzip on page load
  since M9 T1, plus the Gemini SDK chunk `dist/web-<hash>.js` (74.66 kB gzip) imported on Talk
  ([ADR 0005](./adr/0005-load-the-gemini-sdk-on-talk.md)). Until then it was a single
  self-contained IIFE: 725.7 kB, 179.24 kB gzip at M8 T4 (179.22 after M8 T2's `web-vitals`, 176.7 after the M7 fix wave, 175.4 after M7 T5, 174.3 after T4's toast, 166.2 after T3) (budget ≤ 180 kB gzip, spec Budgets), served gzipped by the server since the M4 fix wave (React 19 + the React Compiler + `@google/genai/web` + Radix Dialog and Toast), with no
  build errors.
- Migrated from Hono to Express (2026-09-15) — the server boots on Express, and every static
  route (`/sandbox/`, `/target-app/index.html`, `/target-app/settings.html`, `/sandbox/bridge.js`,
  `/agent-client/agent-client.js`) still returns 200, confirmed by actually hitting each one after
  the migration, not assumed from the route table alone.
- The sandbox page is served nonce-templated at both `/` and `/sandbox/` (also `/sandbox` and
  `/sandbox/index.html`) by one handler registered ahead of the `/sandbox` static mount, so no
  URL ships the literal `%%DS_NONCE%%`; each was curled and returned a UUID nonce (M4 T1,
  assessment A1).
- `/api/live-token` fails **cleanly** with a JSON 500 when `GEMINI_API_KEY` isn't set — confirmed
  by actually hitting it, not assumed. Since M5 T3 every server error has one shape,
  `{ error: { code, message } }` (this one is `not_configured`), and the token gate, the
  templating and the CSP are covered by `server/__tests__/app.test.js` (supertest).
- **The M5 T3 CSP was checked in a real browser** (Playwright/Chromium against `npm start`): `/`
  and `/sandbox/` load with zero CSP violations and zero console errors, the knowledge dialog
  opens styled, the target app's counter and Save still work from their moved script files, the
  page's own `/api/live-token` call returns 200, and a real Connect opened the Gemini Live socket
  (`wss://generativelanguage.googleapis.com`) to `Live`. That check caught helmet's default
  `Referrer-Policy: no-referrer` stripping the Referer the same-origin gate needs (Chrome's
  `fetch()` sends no Origin on same-origin GETs); the policy is `same-origin` now.
- **`sandbox/bridge.js`'s side of the channel is tested in a real browser** (M5 T4,
  `e2e/bridge.spec.js`, Chromium): the first-only `ds-bridge-connect` handshake with a real port
  transfer, a second connect and forged `window` messages ignored, the action allowlist, unknown
  routes, `fill` on a non-input refused, and snapshots after a mutation. axe
  (`e2e/a11y.spec.js`) finds zero violations on `/` (card idle and knowledge dialog open, inside
  the shadow root) and on both target-app pages.
- The exact Gemini Live SDK surface used (`ai.live.connect`, `client.authTokens.create`,
  `session.sendRealtimeInput`, `session.sendToolResponse`, the `toolCall.functionCalls` shape) was
  checked against Google's current docs (`ai.google.dev/gemini-api/docs/live-api/*`) via live web
  search/fetch during this build, not recalled from training data alone.
  M6 T4 re-checked it against the pinned `@google/genai` 2.32.0 (exact in both packages): the
  `.d.ts` types, the runtime, and Google's ephemeral-token docs. The token is locked to the
  model only (`liveConnectConstraints: { model }` plus `lockAdditionalFields: []`, ADR 0004);
  without the empty `lockAdditionalFields`, a real run showed Gemini dropping the client's tools
  and system instruction.
- **The live loop was run by hand in a real browser with a real key (PR #9, M4).** A multi-step
  task across a navigation (increment the counter → go to Settings → toggle notifications → save)
  completed, with the agent reporting DOM state it could only have learned from a live snapshot.
  Force-closing the WebSocket mid-session fired exactly one reconnect (one token request), the
  status recovered and tool calls worked again, and neither reconnect nor navigation produced a
  second greeting.

### 3.3 What's NOT verified — the honest gap list

- **The session logic is unit-tested; the real Live service is only checked by hand.** Since M4
  T3, `agent-client/src/__tests__/liveSession.test.js` drives `liveSession.js` against a fake
  `@google/genai/web` client, a stubbed token `fetch` and a fake bridge: the B2 drop collapse
  (`onerror`+`onclose` → one reconnect), a superseded connect, H4's in-order tool batches, a batch
  orphaned by a reconnect, resumption, the loop guard, the status sequence and `dispose()`. That
  proves the state machine, not the wire protocol. The wire protocol was exercised once, by hand,
  in PR #9 (§3.2) — before the T2–T4 changes to the channel, status and teardown. Since M5 T4,
  `e2e/loop.spec.js` runs the real page and the real SDK socket code against a scripted fake
  Live server (`page.routeWebSocket`): a tool batch, a dropped socket and one token per
  reconnect, in CI with no key. That still isn't Google's server; the real-key run is the
  opt-in live e2e (`npm run e2e:live`, M5 T5), last run 5 times after the M7 fix wave (runs
  44–48: the six-step task 4 of 5, every reconnect resumed; `docs/metrics/m07.md`).
- **Reconnect behaviour (`liveSession.js`).** A drop (`onerror` and/or `onclose`, a failed token
  fetch, or a rejected `live.connect()`) retires the session's generation and schedules a single
  retry on the backoff 0 s, 1 s, 3 s, 7 s, 15 s, 30 s. The status is `reconnecting` (with
  `{ attempt, maxAttempts: 6 }`) while a retry is pending, and becomes `failed` only once all six
  are used, or at once on a 4xx token response (other than 429), which means the page's nonce is
  no longer accepted: the reason tells the user to reload. Every server error has one shape,
  `{ error: { code, message } }`, and a 500 with the code `not_configured` also fails at once,
  with a "contact the site owner, then try again (you may need to reload the page)" reason —
  fixing the key often restarts the server, which wipes its in-memory nonces, and then Try again
  comes back a rejected token and turns into Reload page. The server sends it when it has no
  `GEMINI_API_KEY` and when Google rejects the key it has (an upstream 400/401/403 from the
  mint). Any other mint failure is a 502 `upstream_error`, which is retried like any 5xx. The
  fatal cases carry their kind (M6 T6): `fatal: 'token'` (a rejected nonce) makes the card offer
  "Reload page", which brings a fresh nonce; `fatal: 'config'` makes it offer "Try again", which
  asks the server again, since a reload can't fix a missing key.
  The status turns `open` on the first server message of a session (normally `setupComplete`),
  not when the socket opens, so a socket that opens and closes without the server answering
  never shows "Live". The attempt count resets later still (M6 T6): once the session has stayed
  open 5 s (`STABLE_SESSION_MS`) or the server has sent real content (`serverContent` or a
  `toolCall`), so a server that completes setup and then closes every session keeps climbing the
  backoff instead of retrying at 0 ms. `live.connect` resolves only on `setupComplete`, so an
  attempt the server never answers fails after 10 s (`SETUP_TIMEOUT_MS`) and is retried; the
  abandoned socket is closed if it ever lands. A resumed attempt that the server closes before
  setup completes drops its handle, so the next attempt starts a fresh session instead of
  retrying a rejected handle; a network failure (a socket error, a 1006 close with no close frame,
  1001/1012–1014, `live.connect` rejecting, the setup timeout) keeps it. So does a close of code
  1008 with "already connected": Gemini still holds the dropped client, the handle is fine, and
  the next attempt resumes with it (seen in the live e2e, M5 T5). A manual
  Talk/Retry starts a fresh budget and resets the loop guard. No client turn (the knowledge, the
  greeting, the loop corrective) is sent while a tool batch runs: each waits for the batch's last
  response, and a tool call the server queued before `live.connect()` resolved is answered
  before the session's knowledge and greeting (M7 T4, from the M6 re-review). Unit-tested; not
  yet exercised against a real network drop in this form.
- **Model: `gemini-3.8-live`** (`MODEL` in `liveSession.js`), the GA Live model since
  2026-09-15. The earlier `gemini-3.1-flash-live-preview` is now legacy and shuts down on
  2026-11-17; nothing in the code uses it. Input is 16 kHz PCM mono, output 24 kHz PCM mono
  (`pcm.js`). Worth re-checking `ai.google.dev/gemini-api/docs/models` before assuming this stays
  current; Google ships new Live models often, and this is a point-in-time check.
- **Audio-only Live sessions hard-cap at 15 minutes**, full stop, independent of network
  reliability — a fact discovered *after* the initial build, not designed around from the start.
  Fixed by wiring up **session resumption**: `sessionResumption: {}` in the connect config starts
  a resumable session, `sessionResumptionUpdate` messages carry a handle
  (`liveSession.js` stores it in `resumeHandle`), and every reconnect passes that stored handle
  back if one exists, so a 15-minute cutoff is handled by the same reconnect path as a real
  network drop rather than being a separate failure mode. The unit tests check that the handle is
  passed and that a resumed session isn't greeted again. The field names
  (`sessionResumptionUpdate`, `.resumable`, `.newHandle`), once inferred, were **verified against
  `@google/genai` v2.32.0** (M6 T4): its `LiveServerMessage` types and runtime, plus real runs in
  which the reconnect resumed (`resumed: true` in `.metrics/live.json`) under the model-locked
  token (ADR 0004). The same check covered every other field `liveSession.js` reads
  (`message.data`, transcriptions, `interrupted`, `turnComplete`, `toolCall.functionCalls`,
  `setupComplete`) and the three send signatures (code-review-notes M8, L10).
- **Tool `behavior` and the voice (M9 T2, issue #29), checked against `@google/genai` 2.32.0's
  types and Google's Live API guide (aistudio.google.com/docs/live-api/tools and
  /capabilities, 2026-11-07).** The guide says function calling on `gemini-3.8-live` is
  sequential by default and supports both synchronous and asynchronous calls
  (`behavior: NON_BLOCKING` opts in; `gemini-3.8-live-extended-thinking` is async only,
  `gemini-3.1-flash-live-preview` sync only). The SDK's `FunctionDeclaration.behavior` doc
  says an unset one "keeps the current function call behavior", so `liveSession.js` now sends
  `Behavior.BLOCKING` on every declaration rather than rely on the default. The issue's lead
  (non-blocking by default on 3.8) is not what the guide says. `FunctionResponse.scheduling`
  (`SILENT` / `WHEN_IDLE` / `INTERRUPT`) is "only applicable to NON_BLOCKING function calls, is
  ignored otherwise", so tool responses carry none. The voice is pinned with
  `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName` (`VOICE_NAME`, `Kore`, the voice in
  the guide's own example; native audio models take any of the 30 TTS voices). Both were
  accepted by the real API in four live e2e runs (16 scenarios) under the model-locked token.
- **A resumed reconnect resends the DOM keyframe but not the knowledge context — reversed in
  M6 T5 (code-review-notes M9).** Until then both were resent on every (re)connect, "deliberately":
  a reconnect couldn't trust that a resumed session's history was intact. The live e2e now
  measures it: the reconnect scenario seeds a 386 B knowledge file naming a code name, drops the
  socket and asks for the code name afterwards. With the resend (5 runs) and without it (10 runs)
  the resumed session named it every time, so resumption does carry the knowledge, and the resend
  only stacked another copy of it (up to `MAX_TOTAL_BYTES`, 4 MB) into the context on every drop.
  A fresh session (no handle, or a handle the server rejected) still gets it, and so does a
  resumed one when the store changed while no session was up. The keyframe (777–855 B on the
  target app) is still forced on every reconnect: the page can change during a drop.
- **Reconnect timing.** A resume refused with 1008 "already connected" is retried after 400 ms ×
  the attempt (capped by the usual backoff) instead of the generic 1 s, since M6 T5
  (`STILL_ATTACHED_RETRY_MS`); numbers in `docs/metrics/m06.md`.
- **Mic capture runs in an AudioWorklet** (M6 T3; it replaced the deprecated
  `ScriptProcessorNode`, see §4). `agent-client/public/capture-worklet.js` is copied into `dist/`
  by Vite and loaded with `audioWorklet.addModule('/agent-client/capture-worklet.js')` — the URL
  is resolved by `main.jsx` against its own script tag — so the CSP's `script-src 'self'` covers
  it with no `blob:`. The AudioContext runs at the device rate; the worklet low-passes (63-tap
  Blackman windowed sinc at 7 kHz) and resamples to 16 kHz by linear interpolation, converts
  to Int16 and posts 80 ms frames (1280 samples) with the buffer transferred. Verified:
  `captureWorklet.test.js` (frame size, 16000 samples/s from 48 and 44.1 kHz, a 12 kHz tone
  suppressed below −40 dB), `e2e/audio.spec.js` (Chromium's fake mic at 48 kHz through the real
  worklet under the real CSP: 2560-byte `audio/pcm;rate=16000` frames at ~12.5/s), and one
  `npm run e2e:live` run on 2026-11-02 in which all three live scenarios passed, the spoken
  five-step task included — so Gemini heard the worklet's audio. `startCapture` resumes the
  context after `addModule` (M6 fix wave): it is created after awaits, outside the click's user
  activation, and Safari starts such a context suspended. Not verified: Firefox and Safari (the
  e2e is Chromium only). Manual checks for them, with a real mic:
  - **Safari / WebKit:** the capture node has **0 outputs** (a sink), and WebKit has been known
    not to pull a node that isn't connected toward the destination, so `process()` might never
    run. Check that a user transcript line appears after speaking; if not, give the node one
    output and connect it through a muted `GainNode` to the destination.
  - **Firefox:** the AudioContext runs at the device rate on purpose (Firefox refuses to connect
    a mic to a context at another rate). Check on a 44.1 kHz device (many USB headsets) and a
    48 kHz one that the agent hears you and the frames are 2560 bytes at ~12.5/s (DevTools →
    Network → WS).
- **The "point this at a real external site" path was never built**, on purpose — see
  `sandbox-simulation.md` §5 for the (non-trivial) same-origin-proxy approach that would be needed.
- **DOM snapshot payload size is measured on the mock target app only** (M6 T5, the `ds:keyframe`
  mark): 8 nodes per page, keyframes 777–855 B, about 100 B a node, so the 30-node cap
  (`MAX_SNAPSHOT_NODES` in `bridge.js`) comes to roughly 3–3.5 kB, inside the 4 kB budget. The cap
  and the 0.6 full-refresh ratio were kept, but these pages never reach the cap or a large delta,
  so neither is stressed. A real, larger page is the test that's still missing.
- **Not deployed yet.** The host is decided (Render, [ADR 0003](./adr/0003-hosting-on-render.md));
  `render.yaml`, the env parsed at startup (`server/config.js`) and `trust proxy` landed in M8
  T1, the client log (`/api/client-log`, `clientLog.js`) in M8 T2, checked locally only; the
  service itself is not live yet: M8 shipped without it (2026-11-06) and #23 deploys it and
  records `docs/metrics/m08.md`. Two Render facts are
  unverified until then: the proxy hop count (`TRUST_PROXY_HOPS` overrides it) and whether a
  PR preview copies the key. `getUserMedia` and AudioWorklet need a
  secure context — fine on `localhost`, HTTPS anywhere else. On plain http, Talk now stops
  before opening a session and the card says "Voice needs a secure connection (https)…"
  (`voiceSupportError()` in `audioIO.js`; code-review-notes L6). Of the two `crypto.randomUUID`
  callers, the knowledge store's file ids no longer use it (they use `getRandomValues`), and the
  bridge channel's action ids only run inside a session, which can't start without a secure
  context.

## 4. Decisions log (fast "why did we do X" reference)

- **Gemini Live over Claude** — native bidirectional audio + function calling; closest fidelity to
  what the original system actually used. Claude would need bolted-on browser STT/TTS instead.
- **Authored same-origin mock target-app instead of a real external site** — arbitrary real sites
  refuse iframing (`X-Frame-Options`) and/or are cross-origin, which breaks the direct-DOM-action
  model the original system relied on. See `sandbox-simulation.md` §1.
- **One `postMessage` hop (agent-client ↔ sandbox bridge), not two** — the sandbox is same-origin
  with its own iframe, so it manipulates that DOM directly rather than relaying a second message
  across the iframe boundary. The one hop that exists is a deliberate decoupling between two
  independently-built bundles, not a same-origin-policy requirement. See `sandbox-simulation.md` §4.
- **That hop runs on a private `MessageChannel`, not `window.postMessage`** (2026-10-28) — one
  first-only `ds-bridge-connect` handshake, then all traffic on the port, so passive `message`
  listeners never see it and forged `window` messages are ignored; chosen over a session token
  they could read off the broadcast. It does not stop a same-realm script that patches
  `MessagePort.prototype.postMessage`: both ends capture that method at load, which closes
  tampering after load but not before it. See [ADR 0001](./adr/0001-private-bridge-channel.md)
  (the residual pre-load and first-connect risks are there).
- **`navigate` tool uses a schema `enum` of known pages** — structurally prevents the exact
  hallucinated-navigation bug seen in the original system, instead of relying on prompting the
  model not to do it.
- **Ephemeral Gemini Live token, minted server-side, single job for the whole server** — mirrors
  the original system's own `token`/`sessionId` pattern almost exactly, just scoped to Gemini Live
  specifically instead of a bespoke backend. Since M6 T4 the token is locked to the model only
  ([ADR 0004](./adr/0004-live-token-constraints.md)).
- **Volume meter bypasses React state entirely** (ref + `requestAnimationFrame`) — the "go
  further" version of the original's isolate-and-memoize fix, backed by a test proving the
  isolation actually holds. Built in the first v2 implementation, lost in the from-scratch
  rebuild, back in M7 T2 as the volume orb. **Levels are pulled, not pushed:** the player and
  the capture each expose `getLevel()` (0..1, `audioIO.js`), and `VolumeOrb.jsx` calls both once
  per animation frame and writes `--level` / `--mic-level` on its own node; `styles.css` turns
  them into ring scale and opacity. No event per audio frame reaches React, so there is no
  state to throttle. The output level comes from an `AnalyserNode` between the scheduled chunks
  and the speakers; the mic level is computed on the Int16 frame the worklet already posts
  (cheaper than a second node on the mic, and the orb's fall-off hides the 80 ms steps). The loop
  runs only while the session is open, never under `prefers-reduced-motion` (followed live with
  `matchMedia`), and reads its sources through `useEffectEvent`, so a card render never restarts
  it. `renderIsolation.test.jsx` proves it: 50 frames, no commit, `--level` changed 50 times.
- **`AudioWorklet` over `ScriptProcessorNode` — reversed in M6 T3** (2026-11-02). The first
  build chose `ScriptProcessorNode` for simplicity: deprecated but functional, one file, no
  module to serve. Reversed because the deprecated node runs its callback on the main thread
  (capture glitches whenever React or the snapshot work is busy, and its resampling there was
  linear interpolation with no low-pass, so everything above 8 kHz aliased into the voice band),
  and because the "more code" cost turned out small once the CSP existed to say where the
  worklet must come from: a same-origin file under `script-src 'self'`, not a `blob:` URL. The
  AudioContext deliberately runs at the device rate rather than 16 kHz: Firefox has long
  refused to connect a mic stream to a context at a different rate ("Connecting AudioNodes from
  AudioContexts with different sample-rate is currently not supported"; not re-checked against
  the current release), so the worklet resamples itself, one path for every browser. See §3.3 for what is verified.
- **Session resumption wired up proactively, before ever hitting the 15-minute session cap in
  practice** — discovered the limit by reading the docs, not by observing a real session die at
  minute 15. Chose to fix it structurally (reuse the existing reconnect path) rather than wait and
  see, since a demo running past 15 minutes was a predictable, not edge-case, scenario.
- **DOM snapshot updates were originally always sent as "full" to the model** — bridge.js computed
  a diff but nothing downstream used it. Corrected after being asked directly "when should we send
  a full snapshot" surfaced the gap: `domSnapshotContext.js` now makes that call explicitly (full
  keyframe on navigation / first snapshot / large delta; compact delta otherwise), modeled on a
  video codec's keyframe/delta-frame split. `bridge.js` itself didn't need to change — the
  token-cost decision belongs entirely on the client side that actually talks to the model.
- **React 18 → 19, with the React Compiler on** (2026-09-15) — a direct stack preference, not a
  bug fix; `createRoot` was already in use so the upgrade itself was a no-op for `main.jsx`. The
  compiler is now the default answer to "does this need `useMemo`/`useCallback`" — let it infer
  memoization rather than hand-adding it, only reach for a manual hook where the compiler
  demonstrably can't cover the case. The current bundle is 176.7 kB gzip (§3.2). **Found in M7
  T2: the compiler wasn't running** — `@vitejs/plugin-react` 6 ignored the `babel` option
  `vite.config.js` passed it. Fixed in M7 T2b (the user chose the plugin's Babel preset over the
  experimental native `oxc-transform-react`): `@rolldown/plugin-babel` + `reactCompilerPreset()`,
  +1.65 kB gzip for the memo caches; see `code-review-notes.md` M10.
- **Radix UI as the default for new interactive UI elements** (2026-09-15) — today that is
  `Dialog` for the knowledge modal and `Toast` for the failure notice (M7 T4). The first build's
  Radix `Toast` and hand-rolled `VolumeMeter` / `TranscriptLog` were lost in the rebuild; their
  successors returned in M7 (#11): the orb (T2), the coalesced transcript (T3), the toast (T4).
- **Hono → Express for `server/`** (2026-09-15) — a direct stack preference. Same responsibilities
  kept (token endpoint + static file serving for all three other packages, not split apart) — see
  §5.3 for the deferred option of shrinking it to token-only. All routes re-verified by hand after
  the migration, not just carried over on faith.
- **Type checking via `checkJs` + JSDoc, not a TypeScript migration** (2026-10-28) — `tsc
  --noEmit` over the plain JS, typed first at the seams (bridge protocol, tool args, session
  callbacks), widening from there; lands in M5. See
  [ADR 0002](./adr/0002-type-checking-with-checkjs.md).
- **Host on Render** (2026-10-28) — a web service from a `render.yaml` blueprint: automatic HTTPS
  (the mic needs a secure context), the key as a dashboard secret, PR previews; free-tier cold
  starts accepted. Deploy is M8. See [ADR 0003](./adr/0003-hosting-on-render.md).

- **Config parsed once, a missing key fatal only in production (M8 T1).** `server/config.js`
  reads the env with Zod and names a bad variable, never its value. A production start without
  `GEMINI_API_KEY` fails, so Render keeps the previous deploy instead of going live with a card
  that can only say Try again; locally and in the e2e the `not_configured` path stays.
  `trust proxy` is 1 hop in production: without it the same-origin check sees `http` behind
  Render's TLS proxy and every viewer shares the proxy's IP in both rate limiters.
- **Client reports by beacon, `web-vitals` 5.3.0 (M8 T2).** Errors, vitals and connection
  failures go to `POST /api/client-log` with `sendBeacon` (the nonce in the query, since a
  beacon can't set headers), behind the token route's gates plus its own rate limit. No fetch
  fallback: its failures would hit the console. `web-vitals` is pinned to 5.3.0 and only
  `onLCP` / `onINP` / `onCLS` are imported: 6.x took the bundle to 180.11 kB, past the 180 kB
  budget.
- **The Gemini SDK loads on Talk (M9 T1, issue #20, [ADR 0005](./adr/0005-load-the-gemini-sdk-on-talk.md)).**
  The bundle was 0.4 kB under its 180 kB budget, 72–75 kB of it the SDK, which only a Live
  session uses. The widget is now an ES module (an app build with a JS entry; a
  `<script type="module">`) whose one `import()` is the SDK, started when Talk is pointed at or
  focused and awaited alongside the token. Page load 179.62 → 107.79 kB gzip; the chunk
  74.66 kB. Not a hand-written Live client (option C): about the same saving, with the wire
  protocol ours to track. A chunk that doesn't load is `fatal: 'sdk'` with Retry, not the
  backoff. The CSP didn't change (`script-src 'self'` covers both).

- **Doubled answers (M9 T2, issue #29): blocking declarations and a pinned voice; the live e2e
  now counts doubles.** The live e2e taps the Live socket (`e2e/liveTurns.js`), records the
  agent's speech per turn and counts a doubled answer (a sentence of 4+ words said again in the
  next turn, or twice in one turn), with a new `act` scenario close to the report ("Please
  increment the counter to three") and a 10 s listen after each answer. Before (7 runs, 28
  scenarios): one double, in the greeting scenario, after the user's "Hi!" barged into the
  greeting: the interrupted greeting's sentence ("I am your voice-controlled presenter agent")
  was said again in the reply. No double followed a tool response: every turn after one either
  ended in the next call or was the final answer, once. After (4 runs, 16 scenarios): no double;
  every scenario passed; connect, first audio and tool round trips unchanged (medians 1.47 s,
  2.09 s, click 102 ms). So the change pins what the guide documents rather than fixing a
  reproduced cause. The best evidence for the report is a barge-in: the user's speech (or the
  agent's own voice reaching the mic from the speakers) interrupts an answer, and the next
  generation says it again, in a fresh take that can sound different. The client cannot play
  two streams at once (one player, one queue; `interrupted` stops it) or show a fragment twice.
  Not verified: echo on real speakers (the e2e's fake mic has none). One after-run greeting
  reply ran on into a spoken Python listing (run 67 in `.metrics/live.json`): a model glitch,
  once in 16, not a double; worth watching.
- **Live knobs tuned from the live e2e (M6 T5, 2026-11-02; numbers in `docs/metrics/m06.md`).**
  Kept: `MAX_SNAPSHOT_NODES` 30 (about 100 B a node, so about 3–3.5 kB at the cap, under the
  4 kB budget), `FULL_REFRESH_RATIO` 0.6, and the loop-guard thresholds (no trip in 14 runs).
  Changed: a 1008 "already connected" refusal is retried after 400 ms × the attempt instead of
  the generic 1 s. The worst recovery went from 3.14 s to 2.89 s, and two attempts now take
  2.5–2.9 s instead of 2.8–3.4 s. A resumed session no longer gets the knowledge again (M9, §3.3).
  **Tried and reverted:** a `next` line in a successful navigate's tool result ("the page has
  loaded … carry on with the next step"), meant for the stall after navigate. The task passed
  0 of 3 with it, against 6 of 6 for the code just before it. The model still ended its turn
  after the navigate, so the change was reverted. The task path is now the baseline's, and it
  passed 8 of 10 after the other changes. Its misses were a stall after `fill` and a prompt that
  the voice activity detection split in two.

## 5. Future planning (not yet built — read before starting on these)

### 5.1 RAG-lite knowledge modal (client-side, no backend) — IMPLEMENTED

Built: a button on the agent card (a document icon and the count, the dialog's `Dialog.Trigger`) opens a **Radix
`Dialog`** (`KnowledgeModal.jsx`) with an Add files button — a real `<button>`, so the keyboard
reaches the file picker — that is also the drop target for dragged files (M7 T5; it was a
mouse-only `<div>` before). Dropped files are read via
`FileReader` and stored, as `{id, name, size, addedAt, text}`, in `localStorage` under
`ds-agent-knowledge-files` (`knowledgeStore.js`) — no server-side storage, no backend indexing
pipeline, unlike the original system's Cusmo-owned RAG pipeline.

Decisions actually made (the open questions from the plan, resolved):

- **File types: `.txt`/`.md` only**, deliberately, to avoid pulling in `pdf.js`/`mammoth.js` and
  the bundle-size/complexity that comes with them. Revisit if PDF/DOCX support is ever requested —
  it's an additive change (`ACCEPTED_EXTENSIONS` + a parsing step in `addFile`), not a rework.
- **Size limit: 4MB total** across all stored files (`MAX_TOTAL_BYTES` in `knowledgeStore.js`),
  comfortably under `localStorage`'s ~5–10MB per-origin ceiling. `addFile` refuses outright with a
  reason string when a new file would exceed it — no silent failure, no truncation.
- **Injection mechanism: context-stuffing, confirmed as the actual approach, not just proposed.**
  `liveSession.js`'s `sendKnowledgeContext` dumps the concatenated file text into a
  `session.sendClientContent(..., turnComplete:false)` turn — once right after connect, and again
  automatically whenever the store changes (a `ds-knowledge-changed` window event fired by every
  `knowledgeStore` write, read through `knowledgeStore.subscribe` by `AgentApp.jsx` for the
  button's count, and listened for in `liveSession.js` to re-send context mid-session). This is **not real RAG** — no chunking, no
  embeddings, no retrieval — call it "context-stuffing" or "RAG-lite" explicitly if asked, rather
  than letting "RAG" imply more sophistication than it has. A real pipeline (chunk → embed →
  retrieve top-k per turn) is a legitimate future step and a materially bigger project than this.
- **The gotcha that cost the most time to get right: Radix's `Dialog.Portal` defaults to
  rendering into `document.body`**, which would silently escape this widget's shadow root — the
  dialog would render, but unstyled (none of the shadow root's `<style>`, `styles.css`, would
  reach it) and outside the isolation the shadow root exists to provide. Fix: `main.jsx` creates a
  second plain `<div>` inside the shadow root purely as a portal target, passes it down through
  `AgentApp` as `portalContainer`, and `KnowledgeModal` passes it to `Dialog.Portal container={...}`.
  Anything else built with Radix inside this shadow root needs the same treatment if it uses
  `Portal`. Radix Toast's `Viewport` renders in place, but its screen-reader announcer is a
  portal: `FailureToast.jsx` passes the same container as the provider's `announcerContainer`
  (M7 T4). Radix also tracks focus with `document.activeElement`, which inside a shadow root is
  the host; see §5.2 for what that broke in the toast. In the dialog it broke the focus trap
  (found by the M4 UI review, fixed in M7 T5): FocusScope's Tab wrap compares
  `document.activeElement` to the first and last controls, so it never matched and Tab from
  Close walked out of the dialog (to Radix's focus guards on the page, then the browser), and
  Shift+Tab from the first control onto the card; its trapping `focusin` listener on `document`
  sees the host as every event's target, so it never pulled focus back; and its open autofocus
  never saw focus move and fell back to focusing the dialog itself. `KnowledgeModal`'s Content
  `onKeyDown` now wraps Tab at the two edges using the shadow root's own `activeElement`
  (`shadowFocus.js`, shared with the toast), and `onOpenAutoFocus` focuses Add files. Escape
  left focus nowhere for another reason: the knowledge button wasn't a `Dialog.Trigger`, so
  Radix's modal close (which focuses the trigger) had none; it is one now.
- **The dialog's states (M7 T5, R21):** it reads the store through `useSyncExternalStore`
  (`listFiles()` returns the same array until the files change), with no mirrored state. An
  empty state says what files are for; each file has a "Remove <file name>" button, and removing
  one moves focus to the next file's Remove, else the previous, else Add files; an add the store
  refuses is a `role="alert"` naming the file and the reason. The rules field (GitHub issue #5's
  "rules polish") has a used / limit counter it is described by, a polite note once within 200
  characters and again at the limit (not per keystroke), and over the limit keeps the text on
  screen, unsaved, with `aria-invalid` and a `role="alert"` saying by how much — the store's
  "no silent truncation" carried into the UI (the old `maxLength` cut a paste silently).
- Tested: `knowledgeStore.test.js` covers accept/reject-by-extension, the size cap, add/
  remove/list, the stable list snapshot, the concatenated context blob, byte totals, and that
  the change event fires exactly once per write. `KnowledgeModal.test.jsx` (M7 T5) renders the
  dialog in a real shadow root and covers every state above, the picker from a button, a drop,
  open focus, the Tab wrap both ways and Escape returning focus; `e2e/a11y.spec.js` walks it from
  the keyboard only in Chromium (Enter → the real file chooser, Tab wraps, Escape), axe 0 in
  both themes.

### 5.2 Radix UI for generic components — IMPLEMENTED

Two Radix packages, both `1.3.1` so each shared primitive (`primitive`, `react-portal`,
`react-presence`, `react-dismissable-layer`, …) is installed and bundled once:
`@radix-ui/react-dialog` for the knowledge modal (§5.1) and `@radix-ui/react-toast` for the
failure notice (M7 T4, R20).

Connection status (v1 gap #6) lives in the card (`AgentApp.jsx`): a status line
(`role="status"`: Not connected / Connecting… / Live / Reconnecting (attempt n of 6)… /
Connection lost, or Can't connect for a fatal failure) and one primary button whose job follows
the status and is never disabled, so focus stays on it (Talk to the AI Presenter; a pending Cancel
while connecting; End while live or reconnecting, so the viewer can hang up during the backoff;
Retry on `failed`, Reload page when the page's token is rejected, or Try again when the server
isn't configured — a reload can't fix that, M6 T6). On `failed` the reason shows under the status
line as plain text once the toast has closed (while it is open, the toast says it).

The toast (`FailureToast.jsx`) appears once per failure: above the card (never over its
button), with the reason and Dismiss — no action of its own since the M7 fix wave, so the screen
holds one Retry, the card's — and the card holds its reason line (space kept, hidden) until the toast closes; it
closes on its 8 s timer (paused on hover and focus), Escape, a swipe or Dismiss, and a re-render
never reopens it — the next failure (`useLiveAgent`'s `failureCount`) gets a new one. Who
announces what: the toast is the one live announcement of the reason (Radix's announcer,
assertive, with a visually hidden line "Use the Retry button on the presenter card."), so the
card's copy of it is not an alert, and a screen reader hears it once; a blocked mic and the
other capture or voice-support problems are not connection failures and get no toast, only the
card's `role="alert"` with what to do. F8 (Radix's hotkey) takes focus into the toast. Radix
moves Tab inside the toast, and from its focus proxies, by comparing `document.activeElement`,
which inside the shadow root is the host, so Tab skipped straight out of the toast;
`FailureToast.jsx` handles those moves itself in capture phase (the toast, Dismiss, then back to
the card's button) and returns focus to the button when a focused toast closes.
`e2e/loop.spec.js` walks it in the real shadow root.

### 5.3 The `server/` scope question

Moving RAG files to `localStorage` removes the *reason* to add a files backend, but it does not
remove the server entirely: **the ephemeral-token endpoint must stay server-side** — that's the
one piece of information (the real API key) that can never reach the browser, regardless of any
other architecture change. What *can* legitimately shrink: `server/`'s job of serving
`target-app/`, `sandbox/`, and `agent-client/dist/` as static files is not special-purpose logic —
any static host (Vite's own preview server, a CDN, `npx serve`) could do it instead, leaving
`server/` to do exactly one thing: mint tokens. Worth doing for clarity of purpose, not framed as
"getting rid of the server," which isn't achievable while Gemini access needs to stay secured.

Since M5 T3 the split costs more than moving files: the server also templates the page nonce
into `sandbox/index.html` (a `data-ds-nonce` attribute on the agent script tag) and sends the
CSP and security headers on every page (helmet, `server/app.js`). A static host would need to
send the same CSP (`script-src 'self'`, the Gemini origins in `connect-src`, …) and still get
the nonce from the token server, e.g. by a first fetch, which reopens the question H1's nonce
answers. Until there is a reason to split, the one Express app stays, now as `app.js` (testable,
supertest) + `index.js` (env, listen, SIGTERM shutdown), with pino request logs and `/health`.
