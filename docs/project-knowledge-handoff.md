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
docs/            this doc + the spec + the sandbox-simulation doc
target-app/      2 static pages (Home, Settings), a handful of data-testid elements
sandbox/         iframe host page + bridge.js (action library, DOM snapshot, validation)
agent-client/    React app, built to a single script, mounted in a shadow root
server/          Hono server: mints a Gemini Live ephemeral token, serves the static bundles
```

### 3.2 What's built and actually verified (not just written)

- `npm install` succeeds in both `agent-client/` and `server/`.
- `agent-client`'s test suite passes (13 tests, 3 files): `loopGuard.test.js` (4 tests),
  `renderIsolation.test.jsx` (1 test, using `React.Profiler` to prove the transcript log does
  **not** re-render across 20 simulated volume updates, and **does** re-render on a real
  transcript change), and `knowledgeStore.test.js` (8 tests — see §5.1).
- `vite build` produces a single self-contained `dist/agent-client.js` (~837KB unminified-report,
  ~228KB gzip after adding Radix — was ~771KB/206KB before it) with no build errors.
- The server boots, and every static route (`/sandbox/`, `/target-app/index.html`,
  `/target-app/settings.html`, `/sandbox/bridge.js`, `/agent-client/agent-client.js`) returns 200.
- `/api/live-token` fails **cleanly** with a JSON 500 when `GEMINI_API_KEY` isn't set — confirmed
  by actually hitting it, not assumed.
- The exact Gemini Live SDK surface used (`ai.live.connect`, `client.authTokens.create`,
  `session.sendRealtimeInput`, `session.sendToolResponse`, the `toolCall.functionCalls` shape) was
  checked against Google's current docs (`ai.google.dev/gemini-api/docs/live-api/*`) via live web
  search/fetch during this build, not recalled from training data alone.

### 3.3 What's NOT verified — the honest gap list

- **The actual live voice/tool-call loop has never run end to end.** It needs a real
  `GEMINI_API_KEY`, which wasn't available while building this. Everything in `useLiveAgent.js`
  is correct-per-docs, not correct-per-observed-behavior. Run it for real before trusting it.
- **Model name and audio sample rates are best-current-knowledge, not pinned facts.**
  `LIVE_MODEL = "gemini-3.1-flash-live-preview"` (server/index.js) and
  `PLAYBACK_SAMPLE_RATE = 24000` (agent-client/src/useLiveAgent.js) — both called out in code
  comments as "verify against current docs if something's off." Google ships new Live models
  fairly often; check `ai.google.dev/gemini-api/docs/live-api` before assuming these are current.
- **Mic capture uses `ScriptProcessorNode`**, which is a deprecated Web Audio API. Chosen
  deliberately for simplicity (an `AudioWorklet` is the modern, non-deprecated replacement but is
  meaningfully more code — a separate worklet module, message-passing to the main thread). Fine
  for a local demo; worth swapping before anything resembling production use.
- **No test exists for `sandbox/bridge.js`'s validation logic itself** (origin check, token
  check, allowlist). The logic is simple to read but is tied directly to real DOM elements rather
  than extracted into pure, testable functions. Good next addition.
- **The "point this at a real external site" path was never built**, on purpose — see
  `sandbox-simulation.md` §5 for the (non-trivial) same-origin-proxy approach that would be needed.
- **DOM snapshot payload size in practice is untested** — the size cap (`MAX_SNAPSHOT_NODES = 30`
  in `bridge.js`) is a guess, not tuned against a real page or a real model's context behavior.
- **No production deployment story exists** (no Dockerfile, no hosting config, no HTTPS setup).
  Note for later: mic capture (`getUserMedia`) requires a secure context — fine on `localhost`,
  but will need real HTTPS the moment this is deployed anywhere else.

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
- **`navigate` tool uses a schema `enum` of known pages** — structurally prevents the exact
  hallucinated-navigation bug seen in the original system, instead of relying on prompting the
  model not to do it.
- **Ephemeral Gemini Live token, minted server-side, single job for the whole server** — mirrors
  the original system's own `token`/`sessionId` pattern almost exactly, just scoped to Gemini Live
  specifically instead of a bespoke backend.
- **Volume meter bypasses React state entirely** (ref + `requestAnimationFrame`) — the "go
  further" version of the original's isolate-and-memoize fix, and this time it's backed by a test
  proving the isolation actually holds, not just a flamegraph glanced at once.
- **`ScriptProcessorNode` over `AudioWorklet`** — simpler, deprecated-but-functional, a known
  tradeoff (see §3.3), not an oversight.

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
  `useLiveAgent.js`'s `sendKnowledgeContext` dumps the concatenated file text into a
  `session.sendClientContent(..., turnComplete:false)` turn — once right after connect, and again
  automatically whenever the store changes (a `ds-knowledge-changed` window event fired by every
  `knowledgeStore` write, listened for in both `KnowledgeModal.jsx` for its own file list and in
  `useLiveAgent.js` to re-send context mid-session). This is **not real RAG** — no chunking, no
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
  `Portal` (Toast, notably, does **not** need this — its `Viewport` renders in place, not via a
  portal, so `Toast.jsx` needed no such wiring).
- Tested: `knowledgeStore.test.js` (8 tests) covers accept/reject-by-extension, the size cap, add/
  remove/list, the concatenated context blob, byte totals, and that the change event fires exactly
  once per write. Not tested: the modal component itself (drag/drop interaction, Radix wiring) —
  reasonable next addition if this UI gets more complex.

### 5.2 Radix UI for generic components — IMPLEMENTED

`@radix-ui/react-dialog` powers the knowledge modal (§5.1); `@radix-ui/react-toast`
(`Toast.jsx`, a `ToastProvider` + `useToast()` hook) now also drives the connection-status
messaging — `AgentApp.jsx` fires a real toast ("Connection lost — tap Reconnect to try again.")
the moment `status` becomes `"failed"`, on top of the existing Reconnect button. That's v1 gap #6
closed for real, not just with a button: the silent-disconnect problem from the original system
now has actual user-visible feedback, not only a recovery affordance.

### 5.3 The `server/` scope question

Moving RAG files to `localStorage` removes the *reason* to add a files backend, but it does not
remove the server entirely: **the ephemeral-token endpoint must stay server-side** — that's the
one piece of information (the real API key) that can never reach the browser, regardless of any
other architecture change. What *can* legitimately shrink: `server/`'s job of serving
`target-app/`, `sandbox/`, and `agent-client/dist/` as static files is not special-purpose logic —
any static host (Vite's own preview server, a CDN, `npx serve`) could do it instead, leaving
`server/` to do exactly one thing: mint tokens. Worth doing for clarity of purpose, not framed as
"getting rid of the server," which isn't achievable while Gemini access needs to stay secured.
