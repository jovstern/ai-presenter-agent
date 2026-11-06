# AI Presenter Agent (v2)

A rebuild of the runtime half of a Presenter Agent — an AI avatar embedded in a demo that talks
*and* acts (click/scroll/navigate/fill) on the app behind it, hardened against the gaps found in
the v1 build. It also has a small RAG-lite knowledge feature: drop `.txt`/`.md` files into a modal
and the agent gets them as context, stored only in your browser's `localStorage`.

Start with [`docs/project-knowledge-handoff.md`](./docs/project-knowledge-handoff.md) — the full
origin story, what's actually verified vs. just written, every caveat, and what's planned next.
[`docs/demostack-ai-presenter-agent.md`](./docs/demostack-ai-presenter-agent.md) is the build spec
and [`docs/sandbox-simulation.md`](./docs/sandbox-simulation.md) explains why this build fakes the
"cloned app" the way it does instead of embedding a real external site. Architecture decisions are
in [`docs/adr/`](./docs/adr/); the current build cycle's assessment, spec and milestone plan are in
[`docs/superpowers/`](./docs/superpowers/); open review items are tracked in
[`docs/code-review-notes.md`](./docs/code-review-notes.md). The words the code uses (bridge,
channel, keyframe, nonce, generation…) are defined in [`CONTEXT.md`](./CONTEXT.md).

**Not included on purpose:** the agent-creation UI, the template/demo-agent data model, the flow
builder, RAG upload. This build is about the runtime — sandbox, grounding, security, resilience,
performance — see the docs for why.

## Layout

```
docs/            spec, handoff, review checklist, ADRs (docs/adr/), build cycle (docs/superpowers/)
target-app/      static mock "cloned app" (2 pages + their scripts, a few data-testid elements,
                 routes.json: the one route list)
sandbox/         the host page: iframe + the MessageChannel bridge (ADR 0001) + action library
agent-client/    npm package: the React app built into a single script, mounted in a shadow root
server/          npm package: mints a short-lived Gemini Live token, serves everything else
                 with a CSP and security headers (helmet), JSON request logs (pino), /health
```

Two npm packages (`agent-client`, `server`), two static directories (`sandbox`, `target-app`),
and a thin root `package.json` (no workspaces) holding Prettier, Playwright and the
cross-package scripts. `e2e/` holds the Playwright suite.

## Run it

You need Node 24 (`.nvmrc`; `nvm use` picks it up) and a Gemini API key:
https://aistudio.google.com/apikey

```bash
# 1. build the agent-client once (or `npm run watch` in its own terminal to rebuild on save)
cd agent-client
npm install
npm run build

# 2. start the server
cd ../server
npm install
cp .env.example .env   # paste your key into GEMINI_API_KEY
npm start
```

Then open **http://localhost:3000/** (or `/sandbox/`, which serves the same page; the port is
`PORT` if you set one, 3000 otherwise). Press **Connect** on the agent card in the bottom-right
corner and allow microphone access: the agent greets you once the session is open (it does not
speak on page load). Try asking it to increment the counter, search for something, or go to
Settings, turn on notifications and save. The card's one button follows the connection: Connect,
Cancel while connecting, Disconnect while live or reconnecting, and Retry if the connection is
lost for good. When retrying can't help, it says what can: Reload page when the page's token
is rejected, or Try again (asks the server once more) when the server isn't configured, which a
reload can't fix (the reason shows under the status line). Click the `📄` button on the card to drop in `.txt`/`.md` files it should know about
in advance; they stay in your browser's `localStorage`.

After the first install and `.env` setup, `npm run dev` from the repo root builds agent-client
and starts the server in one step.

## Test

```bash
npm install     # at the repo root, once: Prettier, Playwright, axe
npx playwright install chromium   # once, for the e2e
npm run check   # Prettier check, then lint + typecheck + tests + build in agent-client,
                # lint + typecheck + tests in server
npm run e2e     # Playwright (Chromium): 4 specs, 23 tests, no Gemini key needed
npm run e2e:live  # opt-in, macOS: the live e2e against the real Gemini Live API (needs the key)
npm run format  # Prettier write

cd agent-client
npm test        # vitest: 16 files, 300 tests
npm run lint    # ESLint: agent-client plus sandbox/, target-app/ and the e2e/ suite
npm run typecheck  # tsc: checkJs + strict, sandbox/bridge.js included; the capture worklet
                   # in its own project (jsconfig.worklet.json, AudioWorklet globals only)
npm run build   # single-file IIFE bundle in agent-client/dist/, plus public/capture-worklet.js

cd ../server
npm test        # vitest + supertest: 3 files, 54 tests
```

The suite in `agent-client/src/__tests__/`:

- `liveSession.test.js` — the session state machine against a fake Live client: one reconnect
  per drop, superseded connects, in-order tool batches, the token and model it connects with,
  resumption without re-greeting, the
  `reconnecting` → `failed` sequence, a token response with no token retried, the loop guard (a cycle refused, one corrective turn
  per repeated-sentence episode, never sent to a replacement session; the user speaking clears
  the action window, and narration between tool calls is no loop), the SDK's real order
  (setupComplete and a queued tool call delivered before `connect()` resolves: still answered,
  the greeting by whether the attempt resumed),
  `dispose()`; a resume refused as "already connected" keeps its handle; a snapshot that arrives
  during a tool batch goes out inside the next tool response (`page`); a still-attached refusal
  retried after 400 ms × the attempt; knowledge not resent to a resumed session unless it changed after the handle (M9); the `ds:*`
  timing and size marks; the 10 s setup timeout; the handle kept on a network failure and dropped
  on a server close; the backoff reset only after 5 s open or the first content; the two fatal
  kinds (`config`, `token`).
- `useLiveAgent.test.jsx` — the hook and card (Testing Library): no stacked mic on a double
  Connect, plain http (or no AudioWorklet) explained with no session opened, cleanup on unmount, the button per state (Cancel, Disconnect while reconnecting, Retry,
  Reload page on a rejected token, Try again and no Reload page on a `config` failure) with focus kept on it, the status line ("Can't connect" when fatal) and alerts (a repeated one re-announced), any capture failure ending the session, the card a named landmark, the session's fragments coalesced into turns.
- `transcript.test.js` / `Transcript.test.jsx` — fragments merged per speaker (verbatim within a
  turn, one space across a turn boundary), bounded to 20; the last 3 rendered in a polite live
  region that announces additions only, a node per fragment, the speaker named for assistive tech.
- `bridge.test.js` — `sandbox/bridge.js` run against a stubbed iframe: `navigate` waits for its
  own page and reports a page that never loads as a failure; the routes come from the page's
  `#ds-routes` block (a missing or bad one throws at load); `fill` refuses an element that
  isn't a text input, a disabled or read-only field, a disabled option and a value over the
  field's `maxlength`, sets the value through the native setter and fires `input` + `change`, and
  picks a select's option by visible text, then value, selecting that option itself (no match
  fails and names the options); a test id with a quote in it is found (`CSS.escape`);
  a select's snapshot lists its option texts; replies survive a later patch of `MessagePort.prototype.postMessage`; a
  checkbox is named by its `<label>` and reports `checked`, and toggling it sends a snapshot;
  names follow the accessible-name order (`aria-labelledby` first) and are cut to 60 characters.
- `bridgeProtocol.test.js` — `sandbox/bridge.js`'s copy of the protocol typedefs matches
  `src/bridgeProtocol.js`, and both list the spec's six message types.
- `actionTools.test.js` — named tool args to the bridge's positional order; unknown and
  inherited names (`toString`) get none; `navigate`'s enum is `target-app/routes.json`'s keys.
- `bridgeChannel.test.js` — the private channel: one port handed over, results correlated by id,
  the 4 s timeout, forged `window` messages ignored.
- `domSnapshotContext.test.js` — the keyframe-vs-delta decision.
- `knowledgeStore.test.js` — accept/reject by file type, the size cap, add/remove/list, file
  ids without `crypto.randomUUID` (plain http), the context blob it builds.
- `loopGuard.test.js` — the loop guard: repeats, A-B-A-B and period-3 cycles, repeated agent
  sentences, realistic sequences that must pass, the window cleared by the user speaking and the
  utterance episode by a tool call.
- `pcm.test.js` — base64 encode/decode of PCM frames: a 1 MB frame encodes (chunked, no stack
  overflow), a subarray encodes only its own samples, Int16 from an odd byte offset or with a
  trailing half sample.
- `captureWorklet.test.js` — `public/capture-worklet.js` under a stubbed AudioWorklet scope:
  80 ms Int16 frames of 1280 at 16 kHz, posted with the buffer transferred; from 48 and 44.1 kHz,
  16000 samples a second, a 1 kHz tone kept and a 12 kHz tone filtered out (no aliasing).
- `audioIO.test.js` — the secure-context / AudioWorklet check, the context resumed after the
  worklet loads (Safari), and that capture releases the port, nodes, mic track and context once,
  including on a stop mid-setup, a worklet that fails to load (reported as a `WorkletLoadError`)
  or a context that won't resume.

`npm run e2e` builds agent-client and starts its own server on port 3971 (`playwright.config.js`)
with a dummy `GEMINI_API_KEY` and dotenv pointed at an empty file, so it never reads
`server/.env`; the token endpoint and the Gemini Live socket are stubbed inside the tests. It
is separate from `check`. A failure leaves a trace in `test-results/` (`npx playwright show-trace
<file>`). Every test fails on a console error, an uncaught page error or a CSP violation in any
frame (`e2e/fixtures.js`). The suite in `e2e/`:

- `bridge.spec.js` — `sandbox/bridge.js` in a real browser on a fixture page (the bridge and the
  iframe, no agent-client, served with the real CSP). The test does the real handshake and port
  transfer itself, then checks that click / fill / scroll / navigate change the iframe (the fill's
  value showing in the next snapshot), that the bridge accepts exactly `navigate`'s enum, that
  `fill` works on the Settings textarea and select (by text and by value, firing `input` and
  `change`; no matching option leaves the selection alone), that an unknown action, an unknown
  route and `fill` on a non-input are rejected, that a second
  `ds-bridge-connect` and forged `window` messages are ignored, and that a mutation brings a
  snapshot with `hidden` right for `save-confirmation`.
- `loop.spec.js` — the real `/` page against a fake Gemini Live (`page.routeWebSocket`, so the
  real `@google/genai` socket code runs) with Chromium's fake mic and a stubbed token endpoint: a
  tool batch (navigate → Settings, then click the toggle) changes the iframe and answers with
  `toolResponse`s in order, the navigate's carrying the Settings keyframe; a server-side close shows `Reconnecting…`, then Live, with exactly
  one token request (carrying the page nonce) per (re)connect; Disconnect returns to "Not
  connected". A `not_configured` 500 goes straight to "Can't connect" and "Try again" (no Reload page, no automatic
  retries; pressing it asks for one more token), and a 403 rejected nonce to "Reload page", both
  driven from the keyboard with focus kept on the button.
- `audio.spec.js` — the mic path in the real browser: Chromium's fake mic through the real
  capture worklet (loaded under the CSP, from `/agent-client/capture-worklet.js`) to the fake
  Live socket: `audio/pcm;rate=16000` frames of 2560 bytes at ~12.5 a second, not silence, and
  none after Disconnect.
- `a11y.spec.js` — axe (`@axe-core/playwright`, every default rule) on `/` with the card idle,
  with the knowledge dialog open, and connected (the fake-Live harness, `e2e/fakeLive.js`, shared
  with `loop.spec.js`) with a transcript line on screen, and on both target-app pages: zero
  violations. axe walks the
  card's open shadow root and the iframe; the test asserts it actually checked nodes in both.

`npm run e2e:live` is the opt-in live e2e (`e2e/live.spec.js`, R12): the real server key and the
real Gemini Live API, with spoken prompts (`e2e/make-prompts.sh`, macOS `say`) played by
Chromium's fake mic. Three scenarios: the greeting, the scripted six-step task checked in the
iframe, and a forced socket close that must recover. It records the app metrics (connect time,
first audio, tool round trips, reconnect time, pass rate) in `.metrics/live.json`. Never in CI.
How to run it, what each number means and the current baseline: `docs/metrics/README.md`.

The suite in `server/__tests__/`:

- `app.test.js` — supertest against `createApp` with a stubbed Gemini mint and clock: the token
  gate (403 cross-origin or with no Origin/Referer, 400 malformed nonce, 403 unknown or expired
  nonce, 429 past the limit, a JSON `not_configured` 500 with no key or when Google rejects
  the key with a 400/401/403, a 502 `upstream_error` for any other mint failure, both logged at
  error, 200), the error handler (a plain error is a 500 without internals; only an `expose`d
  client error keeps its 4xx), `/`, `/sandbox`, `/sandbox/` and `/sandbox/index.html` templated
  with a nonce and rate-limited per IP (an HTML 429 with `Retry-After` for a browser, JSON
  otherwise), no inline script on any page, `errorPage` escaping its arguments, the CSP and other headers
  (production adds HSTS), `/health`, an HTML 404 for a browser and a JSON one for `/api/*`, the
  nonce cap, and no nonce or token in the logs.
- `expiringMap.test.js` — the TTL'd, size-capped map behind the nonce and rate-limit state.
- `geminiMint.test.js` — the token config sent to `authTokens.create`: single use, the 60 s
  session window, locked to `liveModel.json`'s model only (`lockAdditionalFields: []`, ADR 0004).

CI (`.github/workflows/ci.yml`, job `check`) runs on every pull request and every push to
`master`: `npm ci` in the root, `agent-client/` and `server/`, then `npm run check` and
`npm run e2e`, with no secrets (the Playwright report is uploaded when it fails). A second
workflow, `pr-demo-check.yml` (job `demo`), fails a PR whose description has no demo image.

## What's deliberately not here yet

- A test for the `KnowledgeModal` component itself (drag/drop interaction, Radix wiring) — the
  underlying store is tested, the UI isn't yet (M7, issue #11).
- The rest of the designed widget — the connection toast — is M7 (issue #11); the volume orb
  and its render-isolation test landed in M7 T2, the coalesced transcript in M7 T3.
- The "point this at a real external site" path — see `docs/sandbox-simulation.md` §5 for what
  that would actually take.
- Anything from the agent-creation side of the real product (see the docs' scope note).
- Real RAG (chunking/embeddings/retrieval) — the knowledge feature is context-stuffing, see
  `docs/project-knowledge-handoff.md` §5.1.
