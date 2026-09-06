# Code review notes — a senior FE pass over v2

> Reviewer's framing: this is a strong portfolio-grade rebuild with unusually honest docs. The
> notes below are what a senior FE would raise in review **on top of** the gaps
> `project-knowledge-handoff.md` §3.3 already owns (live loop never run, resumption field names
> inferred, no bridge-validation test, untuned snapshot cap, `ScriptProcessorNode`, no deploy
> story) — those aren't repeated here.
>
> Each item has a checkbox. Tick the ones worth doing; leave the rest. Nothing here has been
> changed in the code — this doc is the only thing added.
>
> Severity: **Blocker** = likely broken or conspicuously missing the first time it runs for real ·
> **High** = correctness / security / core UX · **Medium** = will bite eventually · **Low** = polish.

---

## Blocker

### [ ] B1 — The transcript log will always be empty

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

### [ ] B2 — Reconnect multiplies the audio pipeline and leaks the old one

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

### [ ] B3 — The agent re-greets on every navigation

`bridge.js:108-111` posts `{type:"ds-ready"}` on **every** iframe `load`, and the client's
`ds-ready` handler (`useLiveAgent.js:93-103`) unconditionally injects
`"[system] Greet the user briefly…"` with `turnComplete:true`. So when the agent navigates to
Settings mid-demo, the iframe reloads, `ds-ready` fires again, and the agent restarts with a fresh
"Hi, what would you like to see?" in the middle of the conversation.

Fix: latch the greeting on the client (`greetedRef`), or have the bridge send `ds-ready` only for
the first load and a plain `ds-navigated` afterward. Subsequent loads should send only the
page-context snapshot (which already happens via `diffAndSendSnapshot`).

### [ ] B4 — There is no `systemInstruction` / persona

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

### [ ] H1 — `/api/live-token` is an open token vending machine on the origin that hosts the "clone"

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

### [ ] H2 — The riskiest file has zero tests and three `exhaustive-deps` escape hatches

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

### [ ] H3 — Barge-in / interruption is not handled

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

### [ ] H4 — Tool calls run concurrently, not serialized

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

### [ ] H5 — The snapshot diff is computed but discarded, and grounding barely refreshes

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

### [ ] M1 — `KNOWN_ROUTES` is hand-duplicated across the security boundary

`actionTools.js:9` (the enum that *is* the guardrail for v1 bug #4) and `bridge.js:17` each define
the list, with a code comment that says "Keep this list in sync." If they drift, the model gets an
enum value the bridge then rejects, or vice versa — a latent bug on the exact seam the design
leans on. Options: a shared JSON imported by both (the bridge can be a module, or the build can
inline it), or at minimum a test asserting `actionTools.KNOWN_ROUTES` deep-equals the bridge's
list.

### [ ] M2 — Pending reconnect timers are never cleared

`retryNow` (`useLiveAgent.js:279-282`) and `scheduleReconnect` both schedule `connect` via
`setTimeout` without storing the handle. Tapping "Reconnect" while a backoff retry is already
pending gives you two concurrent connects (compounds B2). Store the id, clear it at the top of
both functions.

### [ ] M3 — Bridge action handlers aren't wrapped in try/catch

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

### [ ] M4 — Leaks on unmount, not just on reconnect

The unmount cleanup (`useLiveAgent.js:286-289`) stops mic tracks but never `close()`s the
`AudioContext` and never cancels the `tickMeter` rAF loop (self-recursing, no handle).
`DsAgentAvatar` (`main.jsx:143-167`) has no `disconnectedCallback`, never unmounts the React root,
and never stores it — so removing `<ds-agent-avatar>` from the DOM leaves the session open and the
mic live. Store the root, unmount it in `disconnectedCallback`, and have `teardown()` (B2) do the
rest.

### [ ] M5 — `fill` only works for `<input>`

`bridge.js:136-138` hardcodes the `HTMLInputElement.prototype` value setter. Wrong for
`<textarea>` and `<select>`; `contenteditable` unsupported. Fine for the current mock — worth a
one-line note in the bridge that this is input-only for now. If generalised: pick the setter by
`el.tagName`, or use `el.value = v` for non-React targets and keep the descriptor trick only where
a framework's controlled input needs it.

### [ ] M6 — The loop guard misses the common failure shape

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

### [ ] M7 — `liveConnectConstraints.config` partly duplicates the client's connect config

`server/index.js:46-53` locks the token to `{ responseModalities, sessionResumption }`, but the
client also sends `tools` and `thinkingConfig` (`useLiveAgent.js:248-257`). The in-code comment
admits it's unclear how strictly the config half is enforced — if it's strict, the client's extra
fields are a mismatch and the connect is rejected. Decide: constrain **model only** (simplest, and
the token being single-use + short-TTL already bounds abuse), or make the constraint an exact
mirror of what the client sends (and then generate both from one object).

### [ ] M8 — Preview-SDK surface pinned loosely and partly guessed

`@google/genai: ^1.0.0` (also `hono: ^4.6.0`, `react: ^18.3.0`) is a very wide range for a
preview-API integration whose message shapes the handoff doc already admits are inferred
(`sessionResumptionUpdate` / `.newHandle` / `.resumable`, `useLiveAgent.js:180-183`).
`thinkingConfig: { thinkingLevel: "minimal" }` (`useLiveAgent.js:253`) in particular should be
checked against the installed version — the SDK has shipped `thinkingBudget` / `includeThoughts`
shapes, and `thinkingLevel` may not be the field. Pin exact versions in all three
`package.json`s and commit to the lockfiles (they exist — good).

### [ ] M9 — A resumed reconnect re-sends context it already has

`connect()` always calls `sendKnowledgeContext` (`useLiveAgent.js:270`), and the `ds-ready` path
re-greets (B3), even when `resumeHandleRef.current` is set and the session already carries all of
it. Handoff §3.3 flags the knowledge waste; combined with B3, a successful resume gets a greeting
dropped into the middle of the conversation. Guard both on `!resumeHandleRef.current`.

---

## Low / polish

- [ ] **L1** — `pcm.js` base64 helpers build strings char-by-char ~20×/s (`int16ToBase64:23-25`,
  `base64ToInt16:30-32`). `new Int16Array(bytes.buffer)` throws on an odd byte length or a
  non-zero-offset view. Convert in chunks (`String.fromCharCode.apply(null, subarray)`), and copy
  into a fresh aligned buffer before the `Int16Array` view.
- [ ] **L2** — `VolumeMeter` calls `Math.random()` every frame for the side bars, with no
  `prefers-reduced-motion` branch. It's also `aria-hidden`, so a screen-reader user gets no signal
  the agent is speaking — pair with B1's transcript to give one (`aria-live` on the transcript).
- [ ] **L3** — z-index escalation `999999 → 1000002` (`main.jsx`) inside a shadow root whose host
  has no `z-index` or positioning isn't robust against a target-app that creates its own stacking
  context. Set `z-index` (and `position`) on the host element, not just inside.
- [ ] **L4** — `:host { all: initial }` (`main.jsx:10`) resets the host to `display:inline`; the
  widget only survives because `.ds-card` is `position:fixed`. Add an explicit
  `:host { display: block; }` (or `contents`) so it doesn't depend on that coincidence.
- [ ] **L5** — Transcript is bounded twice and inconsistently: `appendTranscript` keeps 20
  (`useLiveAgent.js:35`), `TranscriptLog` renders 4 (`TranscriptLog.jsx:6`). Pick one bound.
- [ ] **L6** — `crypto.randomUUID()` and `getUserMedia` both require a secure context — silent
  breakage the moment this is served over plain HTTP anywhere but localhost. Handoff doc notes the
  mic half; note the UUID half too, or add a fallback.
- [ ] **L7** — ~130 lines of CSS in a JS template literal (`main.jsx:9-141`), no autoprefixer or
  linting. `import styles from './styles.css?inline'` keeps the single-file IIFE build and
  restores tooling / syntax highlighting.
- [ ] **L8** — `barRefs = [useRef(null), useRef(null), useRef(null)]` (`VolumeMeter.jsx:11`) works
  only because the count is a literal constant. One `useRef([])` + callback refs is the idiom and
  won't trip the rules-of-hooks lint if the count ever becomes dynamic.
- [ ] **L9** — `snapshot.role` (`bridge.js:70`) is actually `el.tagName.toLowerCase()` — "a",
  "button", "input" — not an ARIA role. Misleading name for the model, which may reason about it as
  a role. Rename to `tag`, or compute a real role.
- [ ] **L10** — `handleServerMessage` assumes `message.serverContent.modelTurn.parts` and
  `part.inlineData.data` for audio (`useLiveAgent.js:167-169`). Some `@google/genai` Live versions
  surface audio as `message.data`. Verify against the pinned version (ties to M8).
- [ ] **L11** — No root `package.json`, no single command to install/run the three parts, no
  `.nvmrc` / `engines`, no root `npm test`. A `dev` script (concurrently: agent-client watch +
  server) would cut the README's three-terminal dance.
- [ ] **L12** — Typo "sandbard" in `README.md` and `docs/sandbox-simulation.md` §2 ("sandbard
  operating on it").

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
