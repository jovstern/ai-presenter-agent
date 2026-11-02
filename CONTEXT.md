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
  bridge's **allowlist** is the authority on which actions and routes exist; the model sees
  them as tools (`agent-client/src/actionTools.js`).

## Grounding

- **Snapshot** — the bridge's description of the interactive elements on the current page
  (each one's name, state, and a text field's `value`): the full node list plus its diff
  against the previous snapshot (`changed`, `removed`). Sent
  after every load, after a debounced DOM mutation, and on request (`sandbox/bridge.js`).
- **Keyframe** — a snapshot told to the model in full: on the first send, after a navigation,
  or when the diff covers most of the page (`agent-client/src/domSnapshotContext.js`).
- **Delta** — a snapshot told to the model as only what changed and what was removed. Cheaper
  than a keyframe; same idea as a video codec's delta frames.
- **Grounding** — keeping the model's picture of the page true by sending it snapshots.

## The Live session

- **Live session** — one Gemini Live socket and its state (`agent-client/src/liveSession.js`).
  Its **status** is `connecting`, `open`, `reconnecting`, `failed` or `closed`.
- **Token** — a short-lived, single-use Gemini Live credential the server mints per connect
  and per reconnect (`server/index.js`, `/api/live-token` in `server/app.js`). The real API key
  never reaches the browser.
- **Nonce** — a random id the server writes into the sandbox page at serve time; the agent
  sends it back with every token request (`server/app.js`). Proves the request came from a
  script on this page. Reusable until it expires, not single-use, because every reconnect needs
  a new token.
- **Attempt** — one try at opening the socket. After a drop the session reconnects with a
  backoff, up to a fixed number of attempts, then goes `failed` (`liveSession.js`).
- **Generation** — a counter in `liveSession.js` bumped by every connect, drop and disconnect.
  A callback from an older generation (a late socket event, a tool batch from a dead session)
  sees the mismatch and does nothing.
- **Resume handle** — the id Gemini sends so a reconnect can resume the same conversation
  instead of starting over (`liveSession.js`). A resumed session is not greeted again.
- **Fatal failure** — a `failed` status that Retry can't fix (the token request is rejected,
  or the server has no key or Google rejects it: `not_configured`), so the card offers Reload page instead, with the reason
  (`fatal` in `liveSession.js`'s `StatusDetails`).
- **Tool batch** — the function calls of one model `toolCall` message. Run one at a time, in
  order, answered with one tool response each; a snapshot that arrives meanwhile rides inside
  the next response (`liveSession.js`).
- **Loop guard** — stops the model repeating the same action: past three identical **action
  signatures** (tool name + arguments) in a row, the call is refused and the model is told to
  try something else (`agent-client/src/loopGuard.js`).

## Knowledge

- **RAG-lite** — the knowledge feature: `.txt`/`.md` files and free-text **rules** the user
  adds in the knowledge dialog, kept in `localStorage` and stuffed into the session as context.
  No chunking, embeddings or retrieval (`agent-client/src/knowledgeStore.js`,
  `agent-client/src/KnowledgeModal.jsx`).
