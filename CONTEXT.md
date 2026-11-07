# Glossary

The words this codebase uses with a specific meaning. Each entry names the file that owns
the term; read that file for the details. Decisions behind them are in `docs/adr/`.

## Pages and the bridge

- **Target app** — the mock "cloned app" the agent acts on (`target-app/`): two static pages
  inside the sandbox's iframe. Stands in for a customer's real app
  (`docs/sandbox-simulation.md`).
- **Sandbox** — the host page served at `/` and `/sandbox/` (`sandbox/index.html`): the iframe
  with the target app, `bridge.js`, and the agent-client script. Not a security sandbox.
- **Agent** / **agent-client** — the React card in a shadow root on the sandbox page
  (`agent-client/`). It holds the Live session and asks the bridge to act.
- **Bridge** — `sandbox/bridge.js`: the only code that touches the target app's DOM. It runs
  actions, takes snapshots, and talks to the agent over the channel.
- **Channel** — the private `MessageChannel` between the agent and the bridge
  (`agent-client/src/bridgeChannel.js`, [ADR 0001](docs/adr/0001-private-bridge-channel.md)).
  Messages on `window` are ignored once it exists, so other scripts can't forge actions.
- **Handshake** — the one `ds-bridge-connect` message posted to `window` that hands the bridge
  its port. The bridge accepts the first one only (`sandbox/bridge.js`).
- **Bridge protocol** — the message types on the channel, as JSDoc typedefs
  (`agent-client/src/bridgeProtocol.js`, copied verbatim into `bridge.js`).
- **Action** — one thing the bridge does to the target app: click, fill, scroll, navigate. The
  bridge's **allowlist** is the authority on which actions exist; the model sees them as tools
  (`agent-client/src/actionTools.js`). `fill` types into a text field or picks a select's
  option by its visible text, and refuses what a user couldn't do: a disabled or read-only
  field, a disabled option, a value longer than the field's `maxlength`.
- **Routes** — the pages `navigate` can open, by name: `target-app/routes.json`, the one list.
  The server templates it into the sandbox page's `#ds-routes` block for the bridge, and
  `actionTools.js` imports it as `navigate`'s enum.

## Grounding

- **Snapshot** — the bridge's description of the interactive elements on the current page
  (each one's name, state, a text field's `value`, and a select's `options` by visible text):
  the full node list plus its diff
  against the previous snapshot (`changed`, `removed`). Sent
  after every load, after a debounced DOM mutation (250 ms), before each successful action's
  result once the page has **settled**, and on request (`sandbox/bridge.js`).
- **Settled** — the page after an action, as the bridge waits for it: no mutation, input or
  change for 100 ms, or 1 s of waiting, whichever comes first; when the action started a
  navigation (a link click), the new page once loaded. All of it ends within 3.7 s of the
  action's start. That snapshot goes out just before the action's result, so it rides in that
  successful action's tool response as `page` (#25). A change the viewer makes during the
  window is credited to the action. A navigation that starts but never commits (a 204, a
  download) makes the next successful action wait out its deadline once; the target app has
  none.
- **Keyframe** — a snapshot told to the model in full: on the first send, after a navigation,
  or when the diff covers most of the page (`agent-client/src/domSnapshotContext.js`).
- **Delta** — a snapshot told to the model as only what changed and what was removed. Cheaper
  than a keyframe; same idea as a video codec's delta frames.
- **Grounding** — keeping the model's picture of the page true by sending it snapshots.

## The Live session

- **Live session** — one Gemini Live socket and its state (`agent-client/src/liveSession.js`).
  Its **status** is `connecting`, `open`, `reconnecting`, `failed` or `closed`.
- **SDK chunk** — the Gemini SDK (`@google/genai/web`) as a file of its own,
  `agent-client/dist/web-<hash>.js`, imported on Talk (or when Talk is pointed at or focused),
  never on page load (`agent-client/src/liveSdk.js`,
  [ADR 0005](docs/adr/0005-load-the-gemini-sdk-on-talk.md)). The **page-load bundle** is
  `agent-client.js` alone.
- **Token** — a short-lived, single-use Gemini Live credential the server mints per connect
  and per reconnect (`server/geminiMint.js`, locked to the one model in
  `agent-client/src/liveModel.json`; `/api/live-token` in `server/app.js`). The real API key
  never reaches the browser.
- **Nonce** — a random id the server writes into the sandbox page at serve time; the agent
  sends it back with every token request (`server/app.js`). Proves the request came from a
  script on this page. Reusable until it expires, not single-use, because every reconnect needs
  a new token.
- **Attempt** — one try at opening the socket. After a drop the session reconnects with a
  backoff, up to a fixed number of attempts, then goes `failed` (`liveSession.js`). An attempt
  the server never answers with `setupComplete` fails after the **setup timeout** (10 s). The
  attempt count resets only once a session is **stable**: open for 5 s, or the server has sent
  real content.
- **Generation** — a counter in `liveSession.js` bumped by every connect, drop and disconnect.
  A callback from an older generation (a late socket event, a tool batch from a dead session)
  sees the mismatch and does nothing.
- **Resume handle** — the id Gemini sends so a reconnect can resume the same conversation
  instead of starting over (`liveSession.js`). A resumed session is not greeted again. It is
  dropped only when the server closes a resumed attempt before setup (a rejection), never on a
  network failure.
- **Fatal failure** — a `failed` status the backoff doesn't retry (`fatal` in
  `liveSession.js`'s `StatusDetails`), of one of three **kinds**: `token` — this page's token
  request is rejected (an expired nonce), so the card offers Reload page, which brings a fresh
  nonce; `config` — the server has no key or Google rejects it (`not_configured`), which a
  reload can't fix, so the card offers Try again, which asks the server again; `sdk` — the SDK
  chunk didn't load, so the card offers Retry, which imports it again. Each with the reason.
- **Tool batch** — the function calls of one model `toolCall` message. Run one at a time, in
  order, answered with one tool response each; a snapshot that arrives meanwhile rides inside
  the next response (`liveSession.js`), so each successful call carries its own settled page.
- **Client turn** — anything the agent-client tells the model as content rather than as a tool
  response: the knowledge context, the greeting, the loop's corrective turn. None is sent while
  a tool batch runs: each is **held** (one per kind) until the batch's last response, since the
  model takes a turn between a function call and its response as the user talking over it
  (`sendTurn` in `liveSession.js`).
- **Loop guard** — stops the model going in circles (`agent-client/src/loopGuard.js`). An
  **action signature** (tool name + normalised arguments + a **page fingerprint**, a hash of
  the latest full snapshot: the page the action was taken on) that is the 4th identical one in
  a row, or that completes an A-B-A-B or A-B-C-A-B-C **cycle** of page signatures or of the
  bare actions (a routine whose side effects last never meets the same pages twice), is
  refused and the model is told to try something else. The same click that moves the page on
  (the counter at 0, 1, 2, …) is progress, not a repeat: a constant run is no cycle; with no
  snapshot yet the signature is the bare action. A request
  also has an **action budget** of 50: past it each action is refused with "ask the user
  whether to go on". The window and the budget cover one request: the user speaking clears
  them. An **agent
  turn** (its transcription fragments up to `turnComplete`) whose normalised sentence fills 3
  of the last 5 turns is an **utterance loop**: `liveSession` sends one **corrective turn** per
  episode, which ends when the agent says something else, calls a tool (narrating each step of
  a task is no loop) or the user speaks. Reset on every manual connect.

- **Capture worklet** — the AudioWorklet that turns the mic into what the Live API takes:
  `agent-client/public/capture-worklet.js`, served as a same-origin file at
  `/agent-client/capture-worklet.js`. It low-passes, resamples to 16 kHz, converts to Int16 and
  posts one **frame** (80 ms, 1280 samples) at a time; `audioIO.js` base64-encodes each frame
  for the session (`pcm.js`).
- **Level** — how loud the agent's voice (the **output level**, from an `AnalyserNode` on
  playback) or the mic (the **mic level**, from the last frame) is right now, 0..1 on a 60 dB
  scale (`pcm.js` `levelOf`). Pulled with `getLevel()` (`audioIO.js`), never pushed as events.
- **Volume orb** — the card's decorative orb (`agent-client/src/VolumeOrb.jsx`): while the
  session is open, a `requestAnimationFrame` loop writes the two levels to CSS variables
  (`--level`, `--mic-level`) on its node, and its rings follow them — with no React render per
  frame (**render isolation**, `renderIsolation.test.jsx`).
- **Transcript entry** — one speaker's consecutive speech on the card: the **transcription
  fragments** Live streams (a few words each, `onTranscript`) merged until the other speaker
  talks (`agent-client/src/transcript.js`). Within a turn fragments join verbatim; a turn end
  (`turnComplete` or `interrupted`, `onTurnEnd`) followed by the same speaker continues the entry
  after one space. The list keeps 20 entries, all in the card's scrolling transcript box (`Transcript.jsx`).
- **Primary button** — the card's one action, never disabled so focus stays on it: Talk to the
  presenter, a **pending** Cancel while connecting, End while live or reconnecting, then Retry,
  Try again or Reload page on `failed` (`AgentApp.jsx`).
- **Failure toast** — the Radix toast shown once per `failed` report (`failureCount` in
  `useLiveAgent.js`), above the card: the reason and Dismiss, no action of its own (the
  primary button is the one Retry; `agent-client/src/FailureToast.jsx`). It is the one live
  announcement of the reason; the card holds its own reason line while the toast is open (space
  kept, hidden) and shows it, as plain text, once the toast closes. Mic or voice-support problems get the card's
  alert instead of a toast.

## Knowledge

- **RAG-lite** — the knowledge feature: `.txt`/`.md` files and free-text **rules** the user
  adds in the knowledge dialog, kept in `localStorage` and stuffed into the session as context.
  No chunking, embeddings or retrieval (`agent-client/src/knowledgeStore.js`,
  `agent-client/src/KnowledgeModal.jsx`).

## Observability

- **Client log** — what the agent-client reports about itself in production: its own errors,
  the real-user vitals (LCP, INP, CLS) and each failed connection
  (`agent-client/src/clientLog.js`). The server validates each report and logs it as one pino
  line (`POST /api/client-log`, `server/app.js`).
- **Beacon** — one client-log report, sent with `navigator.sendBeacon` (it survives the page
  closing and needs no answer), the page nonce in its query. Best effort: one that can't be
  sent is dropped.

## Hosting

- **Blueprint** — `render.yaml`, the file Render creates and updates the service from
  ([ADR 0003](docs/adr/0003-hosting-on-render.md)).
- **Proxy hop** — a proxy between the viewer and the server; on Render, the load balancer that
  ends TLS. The server trusts that many hops (`trustProxyHops`, from `TRUST_PROXY_HOPS` or 1 in
  production, `server/config.js`), which makes `req.protocol` and `req.ip` the viewer's rather
  than the proxy's.
