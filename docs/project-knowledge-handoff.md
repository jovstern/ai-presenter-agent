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
docs/            this doc, the spec, sandbox-simulation, code-review-notes, adr/, superpowers/
target-app/      2 static pages (Home, Settings), a handful of data-testid elements
sandbox/         iframe host page + bridge.js (channel handshake, action library, DOM snapshot)
agent-client/    React 19 app (React Compiler on), built to a single script, mounted in a shadow root
server/          Express server: mints a Gemini Live ephemeral token, serves the static bundles
```

Two npm packages (`agent-client`, `server`) and two static directories (`sandbox`,
`target-app`). Inside `agent-client/src/`:

- `main.jsx` — mounts the shadow root on a plain host `<div>`, opens the bridge channel once for
  the page's lifetime, unmounts on a non-persisted `pagehide`.
- `bridgeChannel.js` — the agent's end of the private `MessageChannel` to `sandbox/bridge.js`
  ([ADR 0001](./adr/0001-private-bridge-channel.md)).
- `liveSession.js` — the Live socket: token fetch, connect, one-retry-per-drop backoff,
  resumption, serialized tool dispatch, knowledge and snapshot injection. The riskiest file.
- `useLiveAgent.js` — thin React glue over `liveSession.js` and `audioIO.js` (mic capture,
  playback, barge-in); owns teardown.
- `AgentApp.jsx` — the minimal card (one Connect / Cancel / Disconnect / Retry / Reload page button, status line, alert
  on `failed`, transcript, `📄` knowledge button); `KnowledgeModal.jsx` — the Radix dialog.
- Pure helpers: `actionTools.js`, `domSnapshotContext.js`, `loopGuard.js`, `pcm.js`,
  `knowledgeStore.js`.

### 3.2 What's built and actually verified (not just written)

- `npm install` succeeds in both `agent-client/` and `server/`.
- `agent-client`'s test suite passes (74 tests, 8 files, as of the M4 fix wave): `liveSession.test.js`
  (23 — the session state machine, see §3.3), `bridge.test.js` (3 — `sandbox/bridge.js`'s
  `navigate` against a stubbed iframe), `bridgeChannel.test.js` (9 — the private channel),
  `knowledgeStore.test.js` (10 — see §5.1), `useLiveAgent.test.jsx` (14 — the hook and card via
  Testing Library), `domSnapshotContext.test.js` (7 — the keyframe-vs-delta decision, see the
  decisions log below and `demostack-ai-presenter-agent.md` §5.3), `loopGuard.test.js` (5) and
  `pcm.test.js` (3). The first build's `renderIsolation.test.jsx` didn't survive the rebuild; it
  returns in M7 (#11).
- `npm run build` produces a single self-contained IIFE, `dist/agent-client.js`: 621.9 kB,
  149.5 kB gzip (React 19 + the React Compiler + `@google/genai/web` + Radix Dialog), with no
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
  by actually hitting it, not assumed.
- The exact Gemini Live SDK surface used (`ai.live.connect`, `client.authTokens.create`,
  `session.sendRealtimeInput`, `session.sendToolResponse`, the `toolCall.functionCalls` shape) was
  checked against Google's current docs (`ai.google.dev/gemini-api/docs/live-api/*`) via live web
  search/fetch during this build, not recalled from training data alone.
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
  in PR #9 (§3.2) — before the T2–T4 changes to the channel, status and teardown. An automated
  real-key run is M5's opt-in live e2e (#13).
- **Reconnect behaviour (`liveSession.js`).** A drop (`onerror` and/or `onclose`, a failed token
  fetch, or a rejected `live.connect()`) retires the session's generation and schedules a single
  retry on the backoff 0 s, 1 s, 3 s, 7 s, 15 s, 30 s. The status is `reconnecting` (with
  `{ attempt, maxAttempts: 6 }`) while a retry is pending, and becomes `failed` only once all six
  are used, or at once on a 4xx token response (other than 429), which means the page's nonce is
  no longer accepted: the reason tells the user to reload. A 500 the server marks
  `retryable: false` (no `GEMINI_API_KEY`) also fails at once, with a "contact the site owner"
  reason. Both of those carry `fatal: true`, and the card offers "Reload page" instead of Retry.
  The status turns `open` and the attempt count resets on the first server message of a session
  (normally `setupComplete`), not when the socket opens, so a socket that opens and closes
  without the server answering never shows "Live" and keeps climbing the backoff instead of
  retrying at 0 ms. A resumed attempt that closes before the server answers drops its handle, so
  the next attempt starts a fresh session instead of retrying a rejected handle. A manual
  Connect/Retry starts a fresh budget and resets the loop guard. Unit-tested; not yet exercised
  against a real network drop in this form.
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
  passed and that a resumed session isn't greeted again. **Not verified against a live session**:
  the exact field names (`sessionResumptionUpdate`,
  `.resumable`, `.newHandle`) are inferred from the SDK's consistent camelCase convention
  elsewhere (`serverContent`, `toolCall.functionCalls`), not confirmed from an actual received
  message. If resumption silently doesn't kick in, check these names first.
- **`sendKnowledgeContext` and the DOM-snapshot keyframe are both resent on every `connect()`,
  including a resumed reconnect — deliberately, not an oversight.** A (re)connect can't fully
  trust that a resumed session's turn history is intact, so both resend fresh grounding rather
  than assuming the model still remembers. The one acknowledged cost: on a *successfully* resumed
  session (where the model's context genuinely did survive), this adds a small amount of
  redundant context. Worth revisiting only if that turns out to matter in practice.
- **Mic capture uses `ScriptProcessorNode`**, which is a deprecated Web Audio API. Chosen
  deliberately for simplicity (an `AudioWorklet` is the modern, non-deprecated replacement but is
  meaningfully more code — a separate worklet module, message-passing to the main thread). Fine
  for a local demo; worth swapping before anything resembling production use.
- **No test exists yet for `sandbox/bridge.js`'s side of the channel** (the first-only
  `ds-bridge-connect` handshake with its origin/source checks, and the action allowlist). The
  agent's side is unit-tested (`bridgeChannel.test.js`, including forged `window` messages being
  ignored); the bridge's side needs a real page and iframe and arrives with the M5 Playwright e2e
  (#13, `e2e/bridge.spec.js`).
- **The "point this at a real external site" path was never built**, on purpose — see
  `sandbox-simulation.md` §5 for the (non-trivial) same-origin-proxy approach that would be needed.
- **DOM snapshot payload size in practice is untested** — the size cap (`MAX_SNAPSHOT_NODES = 30`
  in `bridge.js`) is a guess, not tuned against a real page or a real model's context behavior.
  (The keyframe-vs-delta *decision* logic itself, in `domSnapshotContext.js`, is unit-tested — it's
  specifically the real-world tuning of the cap and the 0.6 full-refresh ratio that's unverified.)
- **Not deployed yet.** The host is decided (Render, [ADR 0003](./adr/0003-hosting-on-render.md))
  and the deploy is M8; there is no `render.yaml` yet. `getUserMedia` and `crypto.randomUUID`
  need a secure context — fine on `localhost`, HTTPS anywhere else.

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
  first-only `ds-bridge-connect` handshake, then all traffic on the port, so other same-origin
  scripts can't read or forge it; chosen over a session token they could read off the broadcast.
  See [ADR 0001](./adr/0001-private-bridge-channel.md) (the residual first-connect risk is there).
- **`navigate` tool uses a schema `enum` of known pages** — structurally prevents the exact
  hallucinated-navigation bug seen in the original system, instead of relying on prompting the
  model not to do it.
- **Ephemeral Gemini Live token, minted server-side, single job for the whole server** — mirrors
  the original system's own `token`/`sessionId` pattern almost exactly, just scoped to Gemini Live
  specifically instead of a bespoke backend.
- **Volume meter bypasses React state entirely** (ref + `requestAnimationFrame`) — the "go
  further" version of the original's isolate-and-memoize fix, backed by a test proving the
  isolation actually holds. Built in the first v2 implementation, lost in the from-scratch
  rebuild; the volume orb and `renderIsolation.test.jsx` return in M7 (#11).
- **`ScriptProcessorNode` over `AudioWorklet`** — simpler, deprecated-but-functional, a known
  tradeoff (see §3.3), not an oversight.
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
  demonstrably can't cover the case. The current bundle is 149.5 kB gzip (§3.2).
- **Radix UI as the default for new interactive UI elements** (2026-09-15) — today that is
  `Dialog` for the knowledge modal. The first build's Radix `Toast` and hand-rolled
  `VolumeMeter` / `TranscriptLog` were lost in the rebuild; their successors return in M7 (#11).
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

## 5. Future planning (not yet built — read before starting on these)

### 5.1 RAG-lite knowledge modal (client-side, no backend) — IMPLEMENTED

Built: a button on the agent card (`📄 <count>`) opens a **Radix `Dialog`** (`KnowledgeModal.jsx`)
with a drag-and-drop zone plus a click-to-browse fallback. Dropped files are read via
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
  dialog would render, but unstyled (none of the injected `<style>` in the shadow root would
  reach it) and outside the isolation the shadow root exists to provide. Fix: `main.jsx` creates a
  second plain `<div>` inside the shadow root purely as a portal target, passes it down through
  `AgentApp` as `portalContainer`, and `KnowledgeModal` passes it to `Dialog.Portal container={...}`.
  Anything else built with Radix inside this shadow root needs the same treatment if it uses
  `Portal`. (Radix Toast's `Viewport` renders in place, not via a portal, so the M7 toast
  shouldn't need it.)
- Tested: `knowledgeStore.test.js` (10 tests) covers accept/reject-by-extension, the size cap, add/
  remove/list, the concatenated context blob, byte totals, and that the change event fires exactly
  once per write. Not tested: the modal component itself (drag/drop interaction, Radix wiring) —
  reasonable next addition if this UI gets more complex.

### 5.2 Radix UI for generic components — PARTLY IMPLEMENTED

`@radix-ui/react-dialog` powers the knowledge modal (§5.1); it is the only Radix package in
`agent-client/package.json`. There is no toast on this branch. Connection status (v1 gap #6) is
shown without one, since M4 T4: `AgentApp.jsx` has a status line (`role="status"`: Not connected
/ Connecting… / Live / Reconnecting (attempt n of 6)… / Connection lost), one primary button whose
job follows the status and is never disabled (Connect; Cancel while connecting; Disconnect while
live or reconnecting, so the viewer can hang up during the backoff; Retry on `failed`, or Reload
page when the failure is fatal), and, on `failed`, the reason in a `role="alert"` (e.g. "Reload
the page to reconnect" after a rejected token). A blocked microphone is a `role="alert"` too. The Radix toast for the failed state arrives with the designed card in M7
(#11).

### 5.3 The `server/` scope question

Moving RAG files to `localStorage` removes the *reason* to add a files backend, but it does not
remove the server entirely: **the ephemeral-token endpoint must stay server-side** — that's the
one piece of information (the real API key) that can never reach the browser, regardless of any
other architecture change. What *can* legitimately shrink: `server/`'s job of serving
`target-app/`, `sandbox/`, and `agent-client/dist/` as static files is not special-purpose logic —
any static host (Vite's own preview server, a CDN, `npx serve`) could do it instead, leaving
`server/` to do exactly one thing: mint tokens. Worth doing for clarity of purpose, not framed as
"getting rid of the server," which isn't achievable while Gemini access needs to stay secured.
