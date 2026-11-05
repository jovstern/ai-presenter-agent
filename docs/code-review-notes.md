# Code review notes — a senior FE pass over v2

> **Read this first (M4 T5):** the `file:line` references in the original items below
> (`useLiveAgent.js:248`, `bridge.js:108`, `main.jsx:129`, …) predate the from-scratch rebuild and
> point at deleted code. Each ticked item's "Fixed" note names where the fix lives on the current
> code instead. Status at a glance (M7 T2): B1–B4, H1–H5, M1–M9, L1, L3, L4, L6–L12 are done
> (H1 with the M5 T3 CSP; M1 and M5 in M6 T1; M6 in M6 T2; L1 and L6 in M6 T3; M7, M8 and L10
> in M6 T4; M9 in M6 T5; M6 and M9 refined in the M6 fix wave; L3, L4 and L7 in M7 T1; L8 in M7
> T2). **Three items are still open:** L2 and L5, card items marked "Deferred → M7 (issue #11,
> Tn)" (L2's orb half is done in M7 T2, its transcript half is T3), and M10, found in M7 T2:
> the React Compiler isn't running (fixing it changes the build config, the user's call). The M4 and M5 re-review items accepted for M6 are fixed in M6
> T6 (see B2, H1 and H5).

> Reviewer's framing: this is a strong portfolio-grade rebuild with unusually honest docs. The
> notes below are what a senior FE would raise in review **on top of** the gaps
> `project-knowledge-handoff.md` §3.3 already owns (live loop never run, resumption field names
> inferred, no bridge-validation test, untuned snapshot cap, `ScriptProcessorNode`, no deploy
> story) — those aren't repeated here.
>
> Each item has a checkbox. Tick the ones worth doing; leave the rest. *(Historical, the original
> reviewer's framing: "Nothing here has been changed in the code — this doc is the only thing
> added." The code has changed since; see the editorial notes and each item's "Fixed" note.)*
>
> **Editorial note (added afterward, not by the original reviewer):** H5 is now half-stale. Point
> 1 (diff computed but discarded, contradicting spec §5.3) was fixed by introducing
> `domSnapshotContext.js` — the client now sends a full keyframe or a compact delta, decided
> explicitly. Point 2 (no `MutationObserver`) was fixed the same way this review independently
> suggested — a debounced observer, reattached on every iframe load, replacing the fixed
> post-action `setTimeout`. Point 3 (no `hidden`/visibility flag) was closed in M4, and H5 is now
> ticked.
>
> **Editorial note (M1 rebuild, GitHub issue #1 / PR #6):** the file paths below (`bridge.js`,
> `actionTools.js`, a 294-line `useLiveAgent.js`) no longer exist — the whole implementation was
> deleted and rebuilt from scratch (`7c2965b`). The equivalent logic for a few items now lives in
> `agent-client/src/liveSession.js` and `agent-client/src/audioIO.js`:
> - **B1** (no transcription) — fixed. `outputAudioTranscription`/`inputAudioTranscription` are set
>   in the connect config from the start, not added after the fact.
> - **B2** (reconnect leaks the mic pipeline / races two sessions) — fixed structurally. Mic capture
>   (`audioIO.js`) and session/reconnect (`liveSession.js`) are separate modules; reconnect logic
>   never calls back into capture, and `liveSession.js` uses a generation counter plus a single
>   reconnect-timer guard so `onerror`+`onclose` firing together can't race two `connect()` calls.
> - **H3** (no barge-in) — fixed. `serverContent.interrupted` now stops every scheduled playback
>   source (`audioIO.js`'s `createPlayer().interrupt()`) instead of letting buffered audio play out.
> - **H1** (open token-vending endpoint) — closed in M5 T3 (see H1's "Fixed" note). `server/
>   app.js` (was `index.js`) gates `/api/live-token` on same-origin (`Origin`, falling back to
>   `Referer` since Chrome's `fetch()` omits `Origin` on same-origin requests), rate-limits per
>   IP, and since M4 also requires a nonce that `sandbox/index.html` carries at serve time (since
>   M5 T3 a `data-ds-nonce` attribute on the agent-client script tag, templated in by the server;
>   in M4 an inline `window.__DS_NONCE__` script) and `liveSession.js` echoes back as a query
>   param. This closes the
>   cross-origin-frame/other-window vector cleanly. It does **not** close the co-resident-script
>   vector H1 actually describes — a hostile script already running on this origin can read
>   the nonce off the page (now the `data-ds-nonce` attribute) exactly like `agent-client` does. What the nonce actually
>   buys against that script: a request must come from a script that loaded on this exact page, not
>   an arbitrary cross-origin/cross-frame caller. This residual gap is inherent to the "hostile
>   script running on the same origin" threat model, not a missing implementation step — closing it
>   fully would need isolating the clone from the agent (e.g. a separate origin/sandboxed iframe for
>   the clone), out of scope for this rebuild.
>
>   **Deviated from H1's original wording**: the nonce is reusable within a 1-hour TTL, not
>   single-use. A live Gemini token is itself single-use + 60s, so a real conversation fetches a
>   fresh one on every connect *and* every reconnect (network drop, session-cap resumption). A
>   single-use nonce made every reconnect after the first fail with a 403 — caught while testing
>   B2's reconnect path in a real browser, not a theoretical concern.
>
> At the time of M1, B3, B4 and everything else were still open; M4 closed B3, B4, H4 and H5 (see
> each item's "Fixed" note).
>
> Severity: **Blocker** = likely broken or conspicuously missing the first time it runs for real ·
> **High** = correctness / security / core UX · **Medium** = will bite eventually · **Low** = polish.

---

## Blocker

### [x] B1 — The transcript log will always be empty

> **Fixed (M1).** `liveSession.js`'s connect config sets `outputAudioTranscription: {}` and
> `inputAudioTranscription: {}`; `handleMessage` forwards both as `onTranscript({ role, text })`,
> and `AgentApp.jsx` renders them as agent/user lines. Fragments are not coalesced yet: each one
> is its own line until the M7 card (#11).

`useLiveAgent.js:248` connects with `responseModalities: [Modality.AUDIO]` and no transcription
config. The Live API emits **one** response modality at a time; with audio-only and no
`outputAudioTranscription`, the model turn carries no `text` part, so `handleServerMessage`
(`useLiveAgent.js:165-171`) never calls `appendTranscript`. `TranscriptLog` stays blank for the
whole session, and `.ds-line--user` (`main.jsx:129`) is dead code — user speech is never
transcribed at all. The only feedback the agent is alive is the audio itself plus the volume bars.

```js
// useLiveAgent.js — connect config
config: {
  responseModalities: [Modality.AUDIO],
  outputAudioTranscription: {},   // -> message.serverContent.outputTranscription.text
  inputAudioTranscription: {},    // -> message.serverContent.inputTranscription.text
  // ...
}
```

```js
// handleServerMessage
const out = message.serverContent?.outputTranscription?.text;
if (out) appendTranscript("agent", out);
const inp = message.serverContent?.inputTranscription?.text;
if (inp) appendTranscript("user", inp);
```

Note both transcriptions stream in fragments — you'll want to coalesce consecutive same-role
fragments into one bubble rather than pushing a new entry per fragment.

### [x] B2 — Reconnect multiplies the audio pipeline and leaks the old one

> **Fixed (M1 split, M4 T3/T4 tests).** Reconnect lives in `liveSession.js` and never touches the
> mic: a drop retires the session's `generation`, so `onerror`+`onclose` collapse into one retry,
> and the single `reconnectTimer` keeps at most one scheduled. Capture and playback (`audioIO.js`)
> are owned by `useLiveAgent.js`, whose `connect()` stops any previous pipeline before starting
> one. Covered by `liveSession.test.js` (one drop → exactly one reconnect; superseded connects)
> and `useLiveAgent.test.jsx` (no stacked mic). PR #9 force-closed the socket in a real browser:
> one token request, one reconnect.
>
> **M5 T5 (found by the live e2e).** The immediate resume after a drop is often refused with
> `1008 "… session is already connected to an existing client"`: Gemini still holds the dropped
> client. Treating that as a rejected handle started a fresh session on every such reconnect,
> which lost the conversation. `liveSession.js` now keeps the handle for that close reason
> (`SESSION_STILL_ATTACHED`), and the backoff's next attempt, 1 s later, resumes. Tested in
> `liveSession.test.js`. The live numbers are in `docs/metrics/README.md`.
>
> **M6 T6 (the M4 re-review and the M6 T3 deferral).** Four reconnect gaps, closed in
> `liveSession.js` and tested in `liveSession.test.js` with fake timers:
> - *Setup timeout.* `live.connect` resolves only on `setupComplete`, so a socket that opened and
>   then heard nothing sat at `connecting` forever. After `SETUP_TIMEOUT_MS` (10 s) the attempt
>   fails as a retryable failure on its own generation; the abandoned socket is closed if it
>   ever lands, and its callbacks are ignored.
> - *The resume handle survives the network.* It used to be dropped by any resumed attempt that
>   died before the server answered. Now only a server close (any code but 1006 — no close
>   frame — and the come-back-later 1001/1012–1014, `TRANSIENT_CLOSE_CODES`) drops it; a socket
>   error, a 1006, `live.connect` rejecting or the setup timeout keep it.
> - *The backoff reset waits for a stable session.* It used to reset on the first server
>   message, so setupComplete-then-close retried at 0 ms each cycle (bounded only by the token
>   rate limit). It now resets after `STABLE_SESSION_MS` (5 s) open, or on the first real content
>   (`serverContent` or a `toolCall`). `open` is still reported on the first message.
> - *Two kinds of fatal failure.* `StatusDetails.fatal` is `'token'` (a 4xx: the page's nonce is
>   rejected; the card offers Reload page) or `'config'` (`not_configured`: no key, or Google
>   rejects it; a reload can't help, so the card offers Try again, which asks the server again
>   and connects once the owner has fixed the key). Card: `useLiveAgent.test.jsx` (focus stays
>   on the button, no Reload page); browser: `e2e/loop.spec.js`, both paths from the keyboard.

`scheduleReconnect` → `connect()` (`useLiveAgent.js:227-277`) calls `startMicCapture` again on
every attempt. Each call:

- opens a **new** `getUserMedia` stream and overwrites `micStreamRef.current` — the previous
  stream's tracks are never `stop()`ped, so the mic indicator stays lit for every dead session;
- creates a **new** `ScriptProcessorNode`, `AnalyserNode`, and a **new** self-recursing
  `requestAnimationFrame` meter loop (`useLiveAgent.js:201-206`) with no cancellation handle — the
  old loops run forever;
- leaves the old `processor.onaudioprocess` closure pushing audio into a closed `session`.

On top of that, Live typically fires **both** `onerror` and `onclose` on a drop, so
`scheduleReconnect` runs twice — `attemptRef` double-increments and two `connect()` calls race,
producing two live sessions and two mic pipelines.

This is the most serious correctness problem in the repo. Suggested shape:

```js
const genRef = useRef(0);
const rafRef = useRef(0);

function teardown() {
  cancelAnimationFrame(rafRef.current);
  micStreamRef.current?.getTracks().forEach((t) => t.stop());
  micStreamRef.current = null;
  processorRef.current?.disconnect();
  sessionRef.current?.close();
  sessionRef.current = null;
}

const connect = useCallback(async () => {
  const gen = ++genRef.current;     // invalidates any in-flight older connect
  teardown();
  // ...await token, await ai.live.connect...
  if (gen !== genRef.current) { session.close(); return; }  // superseded while awaiting
  // ...
}, []);

const scheduleReconnect = useCallback(() => {
  if (reconnectTimerRef.current) return;   // collapse onerror+onclose into one
  // ...setTimeout, store handle in reconnectTimerRef...
}, []);
```

### [x] B3 — The agent re-greets on every navigation

> **Fixed (M4).** `sandbox/bridge.js` sends `navigated` on each new iframe document, and
> `liveSession.js` only marks the next snapshot as a keyframe for it. The greeting is sent once,
> from `openSession()`, for a fresh session only — not after navigation and not on a resumed
> reconnect (`liveSession.test.js` checks the latter).

`bridge.js:108-111` posts `{type:"ds-ready"}` on **every** iframe `load`, and the client's
`ds-ready` handler (`useLiveAgent.js:93-103`) unconditionally injects
`"[system] Greet the user briefly…"` with `turnComplete:true`. So when the agent navigates to
Settings mid-demo, the iframe reloads, `ds-ready` fires again, and the agent restarts with a fresh
"Hi, what would you like to see?" in the middle of the conversation.

Fix: latch the greeting on the client (`greetedRef`), or have the bridge send `ds-ready` only for
the first load and a plain `ds-navigated` afterward. Subsequent loads should send only the
page-context snapshot (which already happens via `diffAndSendSnapshot`).

### [x] B4 — There is no `systemInstruction` / persona

> **Fixed (M4).** `liveSession.js`'s `SYSTEM_INSTRUCTION` sets the role, "only use a selector given
> in a snapshot", and the say → act → confirm loop, and is passed as `systemInstruction` on every
> connect. The greeting itself is still a one-line `sendClientContent` turn, sent once per fresh
> session (see B3).

The connect config (`useLiveAgent.js:246-258`) has no `systemInstruction`. The "Presenter Agent"
has no standing guidance about: its role, that it must only use selectors it was explicitly handed,
that it should narrate *as* it acts, how terse to be, or how the act→observe→narrate loop works.
Every bit of steering is an ad-hoc `role:"user"` turn injected after connect.

This is the biggest functional-quality gap, and it undercuts the structural work for v1's
repetition/hallucination bug (spec goals #4–#5): the `navigate` enum stops *malformed* targets, but
nothing tells the model how to behave like a demo presenter, so the softer failure modes (rambling,
re-clicking, re-narrating) have nothing holding them back.

```js
config: {
  systemInstruction: {
    parts: [{ text:
`You are a live product-demo presenter embedded in the Acme Dashboard demo.
- Narrate briefly in the first person as you drive: say what you're about to do, then do it.
- Only ever use a selector that appeared in a "[page context]" message. Never invent one.
- To move between pages use the navigate tool; those are the only pages that exist.
- After each tool result, react to what actually happened before the next step.
- Keep spoken turns to 1–2 sentences. Never repeat a sentence or an action you just did.` }]
  },
  // ...
}
```

Also move the "[system] greet" turn (B3) into this instruction instead of a user turn.

---

## High

### [x] H1 — `/api/live-token` is an open token vending machine on the origin that hosts the "clone"

> **Fixed (M4 endpoint half + M5 T3 CSP).** `server/app.js`: same-origin check, per-IP rate
> limit, page nonce (validated with Zod), all in `GET /api/live-token`; and helmet now sends a
> CSP on every response (`contentSecurityPolicy()` in `server/app.js`): `default-src 'self'`,
> `script-src 'self'` (no inline script remains on any served page — the target app's scripts
> moved to `target-app/home.js` / `settings.js`, and the nonce moved from an inline script to a
> `data-ds-nonce` attribute that `main.jsx` reads), `connect-src` limited to `'self'` and the
> Gemini Live origins, `frame-src 'self'`, `object-src 'none'`, plus HSTS in production. This
> narrows what a compromised clone can load or reach, as suggested. Residual, documented and
> out of scope: a hostile script already on this origin can still read the nonce and call the
> endpoint (see the editorial note at the top and ADR 0001). The two in-memory gate maps are
> also TTL-pruned and size-capped now (`server/expiringMap.js`), so a flood can't grow them
> without limit, and serving the nonce-templated page is rate-limited per IP (M5 fix wave).
> Deliberate gap: `style-src` allows `'unsafe-inline'`. The agent-client's shadow root gets its
> stylesheet as a runtime `<style>` element (`main.jsx`), and Radix Dialog's react-remove-scroll
> injects a `<style>` and inline style attributes when the knowledge dialog opens; neither can
> carry a per-response nonce from a prebuilt bundle. Script injection is still blocked
> (`script-src 'self'`); style injection can restyle the page but not run code. Revisit if the
> styles move to a constructable stylesheet and Radix stops injecting. Tests:
> `server/__tests__/app.test.js`.
>
> **M6 T6 (the M5 re-review).** `server/app.js`'s `errorPage()` (the 404 and page-load 429
> pages) escapes all three arguments with `escapeHtml()`, so a later caller passing a path or
> a message can't inject markup; today's callers pass constants. Tested in `app.test.js`.

`server/index.js:35` returns an ephemeral Gemini token to any GET — no origin/referer check, no
rate limit, no per-page nonce. In the real product the iframe holds a crawled clone of a
third-party app, and (by the same-origin design this build depends on) that JS runs on the same
origin as this endpoint. So the clone's own scripts can:

- `fetch('/api/live-token')` and exfiltrate tokens (each is single-use / 30-min, but volume is
  unbounded — a cost and quota problem);
- read the "session token" straight out of the parent DOM — `bridge.js:30` writes it as a
  `data-session-token` attribute on a light-DOM element that any script can `getElementById`.

The v2 `postMessage` hardening (origin + token + allowlist) genuinely closes the
cross-origin-frame / other-window vector, but **not** the co-resident-script vector, which is the
threat the handoff doc §1.10 actually describes. There's also no CSP and no security headers on any
response.

Suggested, in rough order of value:
- Gate `/api/live-token` on `Origin`/`Referer` === the server's own origin, plus a short-TTL
  single-use nonce that the sandbox HTML embeds and the client echoes.
- Add a small fixed-window rate limit (per IP) around the endpoint.
- Send a CSP on the sandbox page. Even a permissive one that just constrains `connect-src` /
  `frame-src` narrows what a compromised clone can reach.
- Add a short section to the handoff doc: *what the token + allowlist protect against, and what
  they explicitly don't* (a hostile same-origin script).

> **Note (M4 T2):** the agent-client ↔ bridge traffic now runs on a private `MessageChannel`
> ([ADR 0001](./adr/0001-private-bridge-channel.md)): one `ds-bridge-connect` handshake on
> `window`, accepted first-only, then everything on the port, so passive `message` listeners no
> longer see snapshots/results and forged `window` messages are ignored. It does not stop a
> same-realm script that patches `MessagePort.prototype.postMessage`; since the M4 fix wave both
> ends capture that method at load, which closes tampering after load. Residual risks: tampering
> before load, and a hostile script that runs before the handshake and connects first.
>
> **Was open (M4 T5):** the endpoint half was done in M4; H1 stayed unticked until the CSP
> landed in M5 T3 (see the "Fixed" note above).

### [x] H2 — The riskiest file has zero tests and three `exhaustive-deps` escape hatches

> **Fixed (M1 split + M4 T3 tests).** The hook was split as directed: `audioIO.js` owns capture and
> playback (M1), `liveSession.js` owns the socket, reconnect, resumption, tool dispatch and
> context injection, and `useLiveAgent.js` is glue with no `useCallback`s or `exhaustive-deps`
> escape hatches. Since M4 T3, `agent-client/src/__tests__/liveSession.test.js` (23 tests, fake
> `@google/genai/web` + stubbed token `fetch` + fake bridge, fake timers) covers: `onerror`+`onclose`
> → exactly one reconnect (B2); a connect superseded during `live.connect()` or the token fetch;
> a `[navigate, click]` batch dispatched in order (H4); no stale tool response after a mid-batch
> reconnect; resumption with the handle and no re-greeting; the status sequence `connecting` →
> `open` → `reconnecting` → `open` → … → `failed`; `reconnecting` (not `failed`) while a retry is
> pending; the loop guard's 4th-call block; a manual connect after `failed` resetting the
> attempts; open-then-close cycles climbing the backoff (the attempt count resets on the first
> server message, not `onopen` — since M6 T6 only after 5 s open or the first content, see B2); a 4xx token response failing at once with a reload reason while
> 5xx and network errors retry; and `dispose()` unsubscribing without closing the bridge channel.
> The M4 fix wave added: `open` reported on the first server message; a `retryable: false` 500
> (missing key) failing at once, with `fatal` set for every non-retryable failure (since M6 T6
> its kind, `'config'` or `'token'`, see B2); a late
> `onclose` after a manual disconnect staying `closed`; every (re)connect requesting a snapshot
> and sending the next one as a keyframe; buffered connect-time audio flushed and capped at 20; the
> loop guard reset on a manual connect; a rejected resumption handle dropped; and a throwing
> `sendToolResponse` handled instead of becoming an unhandled rejection.
> Since M4 T4, the hook has its own Testing Library tests (`useLiveAgent.test.jsx`).


`useLiveAgent.js` (294 lines) owns the socket lifecycle, reconnect + resumption, mic capture,
playback scheduling, tool dispatch, and context injection — and has no test coverage. The three
tested modules (`loopGuard`, `knowledgeStore`, `VolumeMeter`) are the already-pure, low-risk
pieces. The `connect` / `scheduleReconnect` mutual recursion only works because every `useCallback`
happens to be referentially stable, and that invariant is held together by
`// eslint-disable-next-line react-hooks/exhaustive-deps` at lines 236, 276, and 290 — invisible to
the next person who touches it.

Direction: pull the machinery out of the hook.

- `audioIO.js` — `startCapture({ onFrame, onLevel })` / `stop()`; owns the `AudioContext`, mic
  stream, worklet-or-scriptprocessor, analyser, rAF loop. Pure enough to test with a fake
  `AudioContext`.
- `liveSession.js` — wraps `ai.live.connect`: `connect()`, `sendAudio()`, `sendContext()`,
  `sendToolResponse()`, `close()`, with reconnect + resumption inside it and an event emitter out.
  This is the "custom hook wrapped the live-model client" the handoff doc says v1 had; here it's
  inlined instead.
- `useLiveAgent` becomes glue: wire `liveSession` events to React state, own the loop guard.

Then a jsdom test with a mock `liveSession` can drive `toolCall → dispatchAction → postMessage →
(mock bridge) → result → sendToolResponse` and catch B2/H3/H4 regressions.

### [x] H3 — Barge-in / interruption is not handled

> **Fixed (M1).** `audioIO.js`'s `createPlayer()` keeps every scheduled source; `interrupt()` stops
> them all and resets the timeline. `liveSession.js` calls `onInterrupted` on
> `serverContent.interrupted`, which `useLiveAgent.js` wires to `player.interrupt()`.

`serverContent.interrupted` is never read, and `playAudioChunk` (`useLiveAgent.js:149-163`)
schedules `AudioBufferSourceNode`s without keeping references — nothing can stop them. When the
user talks over the agent, the agent keeps talking for the entire buffered duration. For a voice
agent this is a core UX defect (and it makes the demo feel broken in exactly the moment a viewer
tries to interject).

```js
const scheduledSourcesRef = useRef([]);

// in playAudioChunk, after src.start(startAt):
scheduledSourcesRef.current.push(src);
src.onended = () => {
  scheduledSourcesRef.current = scheduledSourcesRef.current.filter((s) => s !== src);
};

// in handleServerMessage:
if (message.serverContent?.interrupted) {
  scheduledSourcesRef.current.forEach((s) => { try { s.stop(); } catch {} });
  scheduledSourcesRef.current = [];
  playbackQueueTimeRef.current = 0;
}
```

### [x] H4 — Tool calls run concurrently, not serialized

> **Fixed (M4).** `liveSession.js`'s `handleToolCallBatch` awaits each `bridge.dispatchAction` in
> order and sends each `sendToolResponse` before the next call; a batch from a retired generation
> stops instead of answering into a new session. `liveSession.test.js` covers the in-order
> `[navigate, click]` batch and the mid-batch reconnect.

`handleServerMessage` does `for (const fc of message.toolCall.functionCalls) handleToolCall(fc)`
(`useLiveAgent.js:172-174`) with no `await` — `handleToolCall` is `async`. If the model emits
`navigate` + `click` in one batch, they race: the click resolves `querySelector` against whichever
document is current at that microtask. Response ordering back to the model is also not guaranteed.

```js
if (message.toolCall) {
  for (const fc of message.toolCall.functionCalls) {
    await handleToolCall(fc);   // handleServerMessage is already effectively a callback; make it async
  }
}
```

### [x] H5 — The snapshot diff is computed but discarded, and grounding barely refreshes

> **Fixed (M4), all three points.** (1) `domSnapshotContext.js` decides keyframe vs. delta and
> `liveSession.js` sends what it decides (`domSnapshotContext.test.js`). (2) `sandbox/bridge.js`
> runs a 250 ms-debounced `MutationObserver` on the iframe body, reattached on every new document,
> so user clicks and async DOM changes re-ground the model too. (3) Each snapshot node carries a
> `hidden` flag (`el.hidden`, `display: none` or `visibility: hidden`).
>
> **M5 T5 (found by the live e2e).** Two more grounding gaps:
> - A navigate's keyframe reached the model before the navigate's own result, as a user turn
>   between the function call and its response, and the multi-step task stalled there.
>   `liveSession.js` now holds a snapshot that arrives during a tool batch and sends it inside
>   the batch's next tool response as `page`; the system instruction mentions `page` and asks
>   for every step of a multi-step request.
> - `bridge.js` named the notifications checkbox "on" (its default `value`) and the model once
>   took that for its state. A form control is now named by its `<label>`, checkboxes and radios
>   carry `checked`, and `input`/`change` events schedule a snapshot, since a toggle changes no
>   attribute.
>
> Tested in `liveSession.test.js`, `bridge.test.js` and `e2e/loop.spec.js`.
>
> **M6 T6 (the M5 re-review).** `sandbox/bridge.js`'s `labelFor()` follows the accessible-name
> order: `aria-labelledby`'s text first, then `aria-label`, the `<label>`, the text, a
> button-like input's value, the placeholder and the title; and every source, the placeholder,
> title and `aria-label` included, is cut to 60 characters (`MAX_NAME_LENGTH`). Tested in
> `bridge.test.js`.

Two issues in one area:

1. `bridge.js:78-101` computes `changed` and `removed`, but the client only reads `data.full`
   (`useLiveAgent.js:74-90`) and re-sends the **entire** element list to the model on every
   snapshot. So you pay the diff's complexity *and* the token cost it was meant to remove. This
   directly contradicts spec §5.3 ("only changed nodes go out again"). Either send the diff and
   have the client apply it, or delete the diff code and own "we always send the full set, the
   pages are tiny" as the decision (the code comment leans this way — make it the whole story).

2. Snapshots fire only on iframe `load` and 150ms after an **agent** action (`bridge.js:195`).
   User-driven clicks, and any async DOM change (the widget counter, the "Saved." confirmation
   un-hiding), never re-ground the model. There's no `MutationObserver`.

3. The snapshot captures `disabled` (`bridge.js:72`) but not visibility — a `[data-testid]` element
   that is `hidden` still appears in the list with no flag, so the model is told about
   `save-confirmation: "Saved."` whether or not it's on screen.

```js
// bridge.js — debounced observer on the iframe document, reconnected on each load
let obs;
function watchIframeMutations() {
  obs?.disconnect();
  obs = new MutationObserver(debounce(diffAndSendSnapshot, 250));
  obs.observe(iframe.contentDocument.body, { subtree: true, childList: true, attributes: true });
}

// in buildSnapshot's node map:
const cs = iframe.contentWindow.getComputedStyle(el);
return { selector, tag: el.tagName.toLowerCase(), label: labelFor(el),
         disabled: !!el.disabled, hidden: el.hidden || cs.display === "none" || cs.visibility === "hidden" };
```

---

## Medium

### [x] M1 — `KNOWN_ROUTES` is hand-duplicated across the security boundary

> Fixed in M6 T1: `target-app/routes.json` (route name → page path) is the only route list.
> `server/app.js` validates it with Zod at startup and templates it into the sandbox page as a
> `<script type="application/json" id="ds-routes">` data block (`<` escaped, by
> `jsonForScriptBlock`; a data block never runs, so `script-src 'self'` holds);
> `sandbox/bridge.js`'s `readRoutes()` reads and validates that block and throws at load if it is
> missing or malformed; `agent-client/src/actionTools.js` imports the file (a JSON import), so
> `navigate`'s enum is its keys. Tests: `bridge.test.js` (each route, unknown routes, a bad
> block), `actionTools.test.js` (enum = file keys), `server/__tests__/app.test.js` (the block on
> every sandbox URL, the escaping), and `e2e/bridge.spec.js` (the bridge accepts exactly the
> enum's routes and rejects another).

`actionTools.js:9` (the enum that *is* the guardrail for v1 bug #4) and `bridge.js:17` each define
the list, with a code comment that says "Keep this list in sync." If they drift, the model gets an
enum value the bridge then rejects, or vice versa — a latent bug on the exact seam the design
leans on. Options: a shared JSON imported by both (the bridge can be a module, or the build can
inline it), or at minimum a test asserting `actionTools.KNOWN_ROUTES` deep-equals the bridge's
list.

### [x] M2 — Pending reconnect timers are never cleared

> Fixed in M4 T4 (timer half landed with M4 T3): `liveSession.js` keeps the one pending retry in
> `reconnectTimer`, and `teardown()` — run by every `openSession()`, `disconnect()` and `dispose()`
> — clears it, so at most one retry is ever scheduled. There is no separate "retry now" path: the
> hook's `retry` *is* `connect()`, which resets the attempts and supersedes any in-flight attempt
> by generation, and the UI shows Retry only once the backoff has given up (`failed`); while
> `reconnecting` the button is Disconnect, which cancels the pending retry.

`retryNow` (`useLiveAgent.js:279-282`) and `scheduleReconnect` both schedule `connect` via
`setTimeout` without storing the handle. Tapping "Reconnect" while a backoff retry is already
pending gives you two concurrent connects (compounds B2). Store the id, clear it at the top of
both functions.

### [x] M3 — Bridge action handlers aren't wrapped in try/catch

> Fixed in M4 T2: `sandbox/bridge.js` wraps every action in try/catch and replies `{success:false, error}` on a throw.
> The M4 fix wave closed the same class of gap for `navigate`: it used to report success when its
> page never loaded (its 5 s wait "failed open", past the agent's 4 s timeout). Now it waits 3.5 s
> for a load of the requested path only and replies `{success:false, error:'The page did not finish
> loading.'}` otherwise (`agent-client/src/__tests__/bridge.test.js`).

`bridge.js:188-191` calls `handler(data.args)` directly. A throw inside `fill` / `click` (e.g. the
`Object.getOwnPropertyDescriptor(...).set` lookup returning `undefined`) skips the
`post({type:"ds-action-result"})` entirely, so the client waits the full 4s timeout
(`useLiveAgent.js:44-49`) and then reports a misleading "bridge did not respond in time."

```js
let result;
try { result = handler(data.args || {}); }
catch (err) { result = { success: false, detail: String(err?.message || err) }; }
post({ type: "ds-action-result", id: data.id, ...result });
```

### [x] M4 — Leaks on unmount, not just on reconnect

> Fixed in M4 T4: `useLiveAgent.js` has one unmount effect that calls the session's `dispose()`,
> stops the capture (mic tracks + its `AudioContext`), closes the player's `AudioContext`, and nulls
> the session ref so a remount — including StrictMode's mount → cleanup → mount — builds a new
> session over the same page-lifetime bridge (whose channel is never closed). `connect()` stops any
> previous capture and player first, so a double press or Retry never stacks a second mic, and
> `failed` stops both too. `main.jsx` keeps the React root and unmounts it on a non-persisted
> `pagehide`; there is no custom element any more (the host is a plain div), so no
> `disconnectedCallback`. The rAF meter loop doesn't exist in this rebuild. Covered by
> `agent-client/src/__tests__/useLiveAgent.test.jsx`.

The unmount cleanup (`useLiveAgent.js:286-289`) stops mic tracks but never `close()`s the
`AudioContext` and never cancels the `tickMeter` rAF loop (self-recursing, no handle).
`DsAgentAvatar` (`main.jsx:143-167`) has no `disconnectedCallback`, never unmounts the React root,
and never stores it — so removing `<ds-agent-avatar>` from the DOM leaves the session open and the
mic live. Store the root, unmount it in `disconnectedCallback`, and have `teardown()` (B2) do the
rest.

### [x] M5 — `fill` only works for `<input>`

> Fixed in M6 T1: `sandbox/bridge.js` `fill` calls the native `value` setter of the element's own
> prototype (`HTMLInputElement` / `HTMLTextAreaElement` / `HTMLSelectElement`, taken from the
> iframe's realm, `nativeValueSetter()`), so a framework's controlled input sees the change, then
> fires bubbling `input` and `change`. A select is matched by its options' visible text (trimmed,
> case-insensitive), then by value (`matchOption()`); no match replies
> `{success:false, error:'… has no option "X"; options: A, B, C'}` and leaves the selection as it
> was. Its snapshot node carries `options` (≤ 20 texts, each ≤ 60 characters) and its `value` is
> the selected option's text. The target app's Settings page has a Notes textarea and a Plan
> select to prove it (`bridge.test.js`, `e2e/bridge.spec.js`). `contenteditable` stays out of
> scope: the target app has none.

> Partly addressed. The rebuilt `sandbox/bridge.js` `fill` sets `el.value` directly, which covers
> `<input>`, `<textarea>` and `<select>`. Since M5 T2 (checkJs) it replies `{success:false}` for an
> element with no `value` instead of reporting success while nothing changed
> (`agent-client/src/__tests__/bridge.test.js`). Still open: `contenteditable`, and the
> native-setter trick a framework's controlled input would need.

`bridge.js:136-138` hardcodes the `HTMLInputElement.prototype` value setter. Wrong for
`<textarea>` and `<select>`; `contenteditable` unsupported. Fine for the current mock — worth a
one-line note in the bridge that this is input-only for now. If generalised: pick the setter by
`el.tagName`, or use `el.value = v` for non-React targets and keep the descriptor trick only where
a framework's controlled input needs it.

### [x] M6 — The loop guard misses the common failure shape

> Fixed in M6 T2: `agent-client/src/loopGuard.js` keeps the last 6 action signatures (tool name
> + args with keys sorted and strings trimmed, `actionSignature()`) and trips on the call that
> makes the 4th identical one in a row, or completes an A-B-A-B or A-B-C-A-B-C cycle
> (`CYCLE_RULES`, a cycle needs two different calls). `liveSession.js` treats every trip as it
> did a repeat: the call isn't dispatched and is answered `{success:false, error:'…repeated too
> many times…'}`. Utterances: `liveSession` joins an agent turn's `outputTranscription`
> fragments until `turnComplete` (an interrupted turn is dropped) and `checkUtterance()` trips
> when the normalised sentence (lowercase, punctuation and whitespace collapsed, ≥ 4 words, so
> "Done." doesn't count) fills 3 of the last 5 turns. A trip sends one corrective turn ("You
> are repeating yourself…", `turnComplete: true`), held until a running tool batch ends and
> dropped with the session on a reconnect; it fires once per episode, which ends on a turn that
> isn't a repeat or on the user's own transcription. The thresholds are named constants that
> M6 T5 may tune. Tested in `loopGuard.test.js` and `liveSession.test.js`.
>
> Refined in the M6 fix wave: the action window spans one request — the user's own
> transcription clears it (`userSpoke()`), since a loop is the model acting with no new input,
> so four separately spoken "click increment" requests, or A, *user*, B, A, *user*, B, all run.
> A tool call ends an utterance episode (`agentActed()`): narration before each step of one
> request ("Clicking the increment button now." ×3) is no talk loop, and an action that really
> repeats is the action rules' to catch. Only turns with no tool call between them count.

`loopGuard.js` only flags **consecutive identical** signatures. The classic agent loop is a short
cycle — click A, click B, click A, click B — which sails straight through. Spec goal #5 also says
"actions **/utterances**", but only tool calls are checked; repeated narration isn't.

```js
// detect a short repeating cycle in recent history, not just a run of one value
check(sig) {
  history.push(sig);
  if (history.length > historyLimit) history.shift();
  for (const period of [1, 2, 3]) {
    if (history.length < period * repeatThreshold) continue;
    const window = history.slice(-period * repeatThreshold);
    const first = window.slice(0, period);
    if (window.every((s, i) => s === first[i % period])) return true;
  }
  return false;
}
```

Feed transcript text (normalised) through the same guard, or add a separate cap on spoken turns
per model turn.

### [x] M7 — `liveConnectConstraints.config` partly duplicates the client's connect config

> Fixed in M6 T4 ([ADR 0004](./adr/0004-live-token-constraints.md)): model only. `server/geminiMint.js`
> mints with `liveConnectConstraints: { model }` and `lockAdditionalFields: []`, the model read from
> `agent-client/src/liveModel.json`, which `liveSession.js` connects with too. The
> `lockAdditionalFields: []` is load-bearing: left out, Gemini locks every config field to the
> token's and ignores the client's tools, system instruction and resumption handle (seen in a
> real run: the agent said it couldn't click). Verified with real mints: three `npm run e2e:live`
> runs on 2026-11-02 (greeting 3/3, five-step task 2/3 — the miss is the known stall after
> `navigate` that M6 T5 tunes — reconnect 3/3), tools called every run and every reconnect
> resumed (`resumed: true`, 1.1–1.2 s, one attempt).

`server/index.js:46-53` locks the token to `{ responseModalities, sessionResumption }`, but the
client also sends `tools` and `thinkingConfig` (`useLiveAgent.js:248-257`). The in-code comment
admits it's unclear how strictly the config half is enforced — if it's strict, the client's extra
fields are a mismatch and the connect is rejected. Decide: constrain **model only** (simplest, and
the token being single-use + short-TTL already bounds abuse), or make the constraint an exact
mirror of what the client sends (and then generate both from one object).

### [x] M8 — Preview-SDK surface pinned loosely and partly guessed

> Fixed in M6 T4: `@google/genai` is pinned to exactly `2.32.0` in both packages (from `^2.22.0`;
> no breaking changes in the 2.23–2.32 release notes), and every other dependency in the three
> `package.json`s is pinned to the version its lockfile resolved. The Live fields
> `liveSession.js` reads were checked against 2.32.0's `dist/web/web.d.ts` and runtime, and all
> held: `message.data`, `serverContent.{interrupted, turnComplete, inputTranscription.text,
> outputTranscription.text}`, `sessionResumptionUpdate.{resumable, newHandle}`,
> `toolCall.functionCalls`, `setupComplete` (the first message: `live.connect` resolves only after
> it), and the `sendRealtimeInput({audio})` / `sendClientContent({turns, turnComplete})` /
> `sendToolResponse({functionResponses})` signatures. The client sends no `thinkingConfig`, so the
> `thinkingLevel` question is moot. `goAway` isn't read: the close that follows it takes the
> normal resume path.
>
> Fix wave: `live.connect` delivers `setupComplete`, and anything the server queued behind it,
> through `onmessage` *before* it resolves, while `liveSession.js` holds no session yet. A tool
> call in that queue now waits for the session and is answered (it was dropped), and the greeting
> is decided by whether the attempt resumed, not by whether a handle has arrived by then.
> `liveSession.test.js` drives both orders.

`@google/genai: ^1.0.0` (also `hono: ^4.6.0`, `react: ^18.3.0`) is a very wide range for a
preview-API integration whose message shapes the handoff doc already admits are inferred
(`sessionResumptionUpdate` / `.newHandle` / `.resumable`, `useLiveAgent.js:180-183`).
`thinkingConfig: { thinkingLevel: "minimal" }` (`useLiveAgent.js:253`) in particular should be
checked against the installed version — the SDK has shipped `thinkingBudget` / `includeThoughts`
shapes, and `thinkingLevel` may not be the field. Pin exact versions in all three
`package.json`s and commit to the lockfiles (they exist — good).

### [x] M9 — A resumed reconnect re-sends context it already has

`connect()` always calls `sendKnowledgeContext` (`useLiveAgent.js:270`), and the `ds-ready` path
re-greets (B3), even when `resumeHandleRef.current` is set and the session already carries all of
it. Handoff §3.3 flags the knowledge waste; combined with B3, a successful resume gets a greeting
dropped into the middle of the conversation. Guard both on `!resumeHandleRef.current`.

> Fixed in M6 T5: the greeting was already guarded (`openSession` greets only a fresh session).
> `agent-client/src/liveSession.js` now sends the knowledge context only to a fresh session, or
> to a resumed one when the store changed while no session was up (then `knowledgeChangedOffline`;
> since the fix wave, revisions, below).
> Measured in the live e2e (`docs/metrics/m06.md`): the reconnect scenario seeds a 386 B knowledge
> file and asks for its code name after the drop. With the resend, 5 of 5 resumed sessions named
> it, and without it 10 of 10, so the resend only stacked a copy of the knowledge (up to 4 MB)
> into the context per drop. The handoff's "deliberate" stance (§3.3) is reversed. The keyframe
> is still forced on every reconnect, because the page can change during a drop. Tests:
> `liveSession.test.js` "knowledge on a reconnect (M9)".
>
> **Assumption (M6 fix wave):** skipping the resend relies on a resume either really restoring
> the session the handle names, or Gemini closing the attempt (which drops the handle, so the
> next attempt is fresh and gets the knowledge). A resume that "succeeds" into an empty context
> would lose the knowledge silently; nothing seen in the live e2e does that. A handle restores
> the session as it was when the handle was issued, so knowledge sent after it isn't in the
> resumed session: `liveSession.js` counts store changes (`knowledgeRevision`), remembers which
> one the live session holds (`sentRevision`) and which one the newest handle captured
> (`handleRevision`), and a resume resends whenever the store moved past the handle's — a change
> while no session was up, or one sent into the session after its newest handle.

### [ ] M10 — The React Compiler isn't running

Found in M7 T2. `vite.config.js` passes the compiler as `react({ babel: { plugins:
['babel-plugin-react-compiler'] } })`, but `@vitejs/plugin-react` 6 (in use since before M5)
has no `babel` option and ignores it: the build and vitest compile JSX with oxc only, and
`dist/agent-client.js` has no `react/compiler-runtime` cache. So nothing is memoized, while
CLAUDE.md, the lint rule banning `useMemo`/`useCallback`/`memo` and the handoff's decisions log
all assume it is. Correctness is unaffected (the compiler only memoizes); every card render
re-renders the whole card. Two fixes, both a build-config change plus a dependency, so they
wait for the user: plugin-react 6's own `reactCompilerPreset` through `@rolldown/plugin-babel`
(+ `@babel/core`, the same Babel compiler as before), or its experimental native
`compiler: true` (`oxc-transform-react`). Once it runs, `renderIsolation.test.jsx` can also
assert the orb is skipped on a transcript line.

Also found: the compiler (run by hand on the source) skipped `useLiveAgent.js` entirely
because `connect()` called `disconnect()` before its declaration ("[PruneHoistedContexts]
Rewrite hoisted function references", a Todo bailout). M7 T2 moved `disconnect()` above
`connect()`; all five components and hooks now compile without a diagnostic.

The volume orb doesn't depend on either: it reads its level sources through `useEffectEvent`,
so a card render that hands it new getter functions never restarts its animation loop
(`renderIsolation.test.jsx`).

---

## Low / polish

- [x] **L1** — `pcm.js` base64 helpers build strings char-by-char ~20×/s (`int16ToBase64:23-25`,
  `base64ToInt16:30-32`). `new Int16Array(bytes.buffer)` throws on an odd byte length or a
  non-zero-offset view. Convert in chunks (`String.fromCharCode.apply(null, subarray)`), and copy
  into a fresh aligned buffer before the `Int16Array` view.
  *Fixed in M6 T3: `agent-client/src/pcm.js` encodes base64 by spreading 32 Ki-byte
  `subarray`s into `String.fromCharCode` (a 1 MB frame encodes; `pcm.test.js`), and encodes only
  the view's own bytes (`byteOffset`/`byteLength`, not the whole `buffer`). `bytesToInt16`
  copies a view at an odd byte offset into a fresh aligned buffer and drops a trailing half
  sample instead of throwing. The per-frame Float32 → Int16 and resampling moved off the main
  thread into `public/capture-worklet.js`.*
- [ ] **L2** — `VolumeMeter` calls `Math.random()` every frame for the side bars, with no
  `prefers-reduced-motion` branch. It's also `aria-hidden`, so a screen-reader user gets no signal
  the agent is speaking — pair with B1's transcript to give one (`aria-live` on the transcript).
  *Deferred → M7 (issue #11, T2, T3): `VolumeMeter` didn't survive the rebuild; its
  successor, the volume orb (rAF, a `prefers-reduced-motion` branch), and the `aria-live`
  transcript are the designed card's work, not hardening → M7 (issue #11, T2 and T3).*
  *Orb half fixed in M7 T2: `agent-client/src/VolumeOrb.jsx` draws real levels (the player's
  `AnalyserNode` and the mic's last frame, `audioIO.js` `getLevel()`), no randomness; under
  `prefers-reduced-motion` it runs no animation loop at all (followed live through
  `matchMedia`) and `styles.css` holds the rings at a static level. It stays `aria-hidden`: the
  card's `role="status"` line says "Live". The `aria-live` transcript is T3, which ticks this.*
- [x] **L3** — z-index escalation `999999 → 1000002` (`main.jsx`) inside a shadow root whose host
  has no `z-index` or positioning isn't robust against a target-app that creates its own stacking
  context. Set `z-index` (and `position`) on the host element, not just inside.
  *Deferred → M7 (issue #11, T1): today's card has no z-index at all; host positioning and
  `z-index` on the host element come with the card's styles, so they are set once, on the
  final layout → M7 (issue #11, T1).*
  *Fixed in M7 T1: `agent-client/src/styles.css`'s `:host` rule gives the host element itself
  `position: fixed`, the 16 px gutter, `z-index: 2147483000` and the card width; nothing inside
  the shadow root carries a z-index. Set through `:host` rather than an inline style because the
  width changes at the 400 px breakpoint; the target app is in an iframe, so only the sandbox
  page's own styles could outrank it. Checked in Chromium at 360, 768 and 1440 px (host computed
  `position: fixed`, `z-index: 2147483000`).*
- [x] **L4** — `:host { all: initial }` (`main.jsx:10`) resets the host to `display:inline`; the
  widget only survives because `.ds-card` is `position:fixed`. Add an explicit
  `:host { display: block; }` (or `contents`) so it doesn't depend on that coincidence.
  *Deferred → M7 (issue #11, T1): still true of `main.jsx`'s `:host { all: initial; }`; the
  card's styles move to `styles.css` with tokens on `:host`, where the explicit `display`
  belongs → M7 (issue #11, T1).*
  *Fixed in M7 T1: `agent-client/src/styles.css`'s `:host` keeps `all: initial` (the page's
  inherited styles stay out) and then sets `display: block` explicitly; the host, not the card,
  is the fixed box, so the card no longer survives by coincidence.*
- [ ] **L5** — Transcript is bounded twice and inconsistently: `appendTranscript` keeps 20
  (`useLiveAgent.js:35`), `TranscriptLog` renders 4 (`TranscriptLog.jsx:6`). Pick one bound.
  *Deferred → M7 (issue #11, T3): today's card keeps and renders every line (no bound at all,
  the M1 rebuild dropped both); the coalesced transcript bounds the list to 20 and renders the
  last 3 → M7 (issue #11, T3).*
- [x] **L6** — `crypto.randomUUID()` and `getUserMedia` both require a secure context — silent
  breakage the moment this is served over plain HTTP anywhere but localhost. Handoff doc notes the
  mic half; note the UUID half too, or add a fallback.
  *Fixed in M6 T3: `agent-client/src/audioIO.js` `voiceSupportError()` checks
  `window.isSecureContext`, then `AudioWorkletNode` and `getUserMedia`, and `useLiveAgent.js`
  runs it before Connect does anything: on plain http the card says "Voice needs a secure
  connection (https)…" and no session opens or token is minted (`useLiveAgent.test.jsx`, and
  checked in Chromium over a LAN-IP http URL). The UUID half: `knowledgeStore.js`'s file ids
  now come from `crypto.getRandomValues` (available everywhere), so adding a file on plain http
  no longer throws (`knowledgeStore.test.js`); `bridgeChannel.js`'s action ids keep
  `crypto.randomUUID()`, since actions only run in a session, which now can't start outside a
  secure context. Handoff §3.3 notes both halves.*
- [x] **L7** — ~130 lines of CSS in a JS template literal (`main.jsx:9-141`), no autoprefixer or
  linting. `import styles from './styles.css?inline'` keeps the single-file IIFE build and
  restores tooling / syntax highlighting.
  *Deferred → M7 (issue #11, T1): the CSS is still a template literal in `main.jsx`; it moves
  to `src/styles.css?inline` with the card's tokens → M7 (issue #11, T1).*
  *Fixed in M7 T1: the CSS is `agent-client/src/styles.css`, formatted by Prettier and minified
  by Vite's CSS pipeline; `main.jsx` imports it as `./styles.css?inline` (typed by
  `vite/client`, no config change) and puts it in the shadow root as one `<style>`. The bundle
  stays one IIFE file (163.1 kB gzip), and the CSP needs no change: `style-src 'unsafe-inline'`
  already covers a runtime `<style>` (0 violations across `npm run e2e`).*
- [x] **L8** — `barRefs = [useRef(null), useRef(null), useRef(null)]` (`VolumeMeter.jsx:11`) works
  only because the count is a literal constant. One `useRef([])` + callback refs is the idiom and
  won't trip the rules-of-hooks lint if the count ever becomes dynamic.
  *Deferred → M7 (issue #11, T2): `VolumeMeter` and its refs didn't survive the rebuild; the
  orb that replaces it holds its node in a ref and is checked by a Profiler render-count test → M7 (issue #11, T2).*
  *Fixed in M7 T2: `VolumeOrb.jsx` is one element in one `useRef`; its two rings are CSS
  pseudo-elements driven by `--level` and `--mic-level`, so there is no per-bar ref to keep in
  step with a count. `renderIsolation.test.jsx` checks that 50 frames commit nothing.*
- [x] **L9** — `snapshot.role` (`bridge.js:70`) is actually `el.tagName.toLowerCase()` — "a",
  "button", "input" — not an ARIA role. Misleading name for the model, which may reason about it as
  a role. Rename to `tag`, or compute a real role.
  *Fixed (M4): `sandbox/bridge.js`'s `buildSnapshotNodes` names the field `tag`.*
- [x] **L10** — `handleServerMessage` assumes `message.serverContent.modelTurn.parts` and
  `part.inlineData.data` for audio (`useLiveAgent.js:167-169`). Some `@google/genai` Live versions
  surface audio as `message.data`. Verify against the pinned version (ties to M8).
  *Verified in M6 T4: `liveSession.js` reads `message.data`, which in `@google/genai` 2.32.0 is a
  getter on the `LiveServerMessage` class the SDK builds for every message: it joins the
  `inlineData` of `serverContent.modelTurn.parts` and returns base64 (undefined when there is
  none). The real-key live e2e hears the greeting through it.*
- [x] **L11** — No root `package.json`, no single command to install/run the three parts, no
  `.nvmrc` / `engines`, no root `npm test`. A `dev` script (concurrently: agent-client watch +
  server) would cut the README's three-terminal dance.
  *Fixed (M5 T1, T6): a thin root `package.json` (no workspaces) runs every package's gate with
  `npm run check`, builds and starts with `npm run dev`, and runs the e2e; `.nvmrc` pins Node 24
  and each `package.json` has `engines: { node: ">=24" }`. Installs stay one `npm ci` per
  package (no workspaces, by design); CI (`.github/workflows/ci.yml`) runs all three.*
- [x] **L12** — Typo "sandbard" in `README.md` and `docs/sandbox-simulation.md` §2 ("sandbard
  operating on it").
  *Fixed (M4 T5): `docs/sandbox-simulation.md` §2 now reads "sandbox"; the rewritten README no
  longer had it.*

---

## What's genuinely good

Worth stating plainly so the review is balanced — these are decisions a senior would call out as
*right*, not just acceptable:

- **`navigate` as a schema `enum`.** The correct instinct: a structural guardrail the model
  cannot violate, instead of prompt-pleading. This is the single best design call in the repo.
- **`VolumeMeter` bypasses React state entirely**, and the `React.Profiler` test
  (`renderIsolation.test.jsx`) *proves* the isolation via a render count rather than asserting a
  proxy for it. That's the right way to lock in a perf fix.
- **The bridge action library lives in a closure, never on `window`**, with an explicit allowlist
  checked before any dispatch — exactly the v1 gap, closed properly.
- **The server does one job.** Token minting only, real key never in the browser, clean JSON 500
  when the key is missing. No accidental scope creep into a proxy.
- **`knowledgeStore` is honest about being context-stuffing, not RAG**, enforces a hard size cap
  with an explicit refusal (no silent truncation), and fans out changes via a `CustomEvent`. The
  Radix `Dialog.Portal` → shadow-root `container` fix (`main.jsx:157-159`, `KnowledgeModal.jsx:44`)
  is a real gotcha caught and documented correctly.
- **Documentation quality is high and unusually candid** about what's verified vs. inferred. That
  candor is why this review could focus on new ground instead of re-deriving the same caveats.
