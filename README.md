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
[`docs/code-review-notes.md`](./docs/code-review-notes.md).

**Not included on purpose:** the agent-creation UI, the template/demo-agent data model, the flow
builder, RAG upload. This build is about the runtime — sandbox, grounding, security, resilience,
performance — see the docs for why.

## Layout

```
docs/            spec, handoff, review checklist, ADRs (docs/adr/), build cycle (docs/superpowers/)
target-app/      static mock "cloned app" (2 pages, a few data-testid elements)
sandbox/         the host page: iframe + the MessageChannel bridge (ADR 0001) + action library
agent-client/    npm package: the React app built into a single script, mounted in a shadow root
server/          npm package: mints a short-lived Gemini Live token, serves everything else
```

Two npm packages (`agent-client`, `server`), two static directories (`sandbox`, `target-app`);
there is no root `package.json`.

## Run it

You need a Gemini API key: https://aistudio.google.com/apikey

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
lost for good, or Reload page when retrying can't help (the reason shows under the status
line). Click the `📄` button on the card to drop in `.txt`/`.md` files it should know about
in advance; they stay in your browser's `localStorage`.

## Test

```bash
cd agent-client
npm test        # vitest: 8 files, 74 tests
npm run build   # single-file IIFE bundle in agent-client/dist/
```

The suite in `agent-client/src/__tests__/`:

- `liveSession.test.js` — the session state machine against a fake Live client: one reconnect
  per drop, superseded connects, in-order tool batches, resumption without re-greeting, the
  `reconnecting` → `failed` sequence, the loop guard, `dispose()`.
- `useLiveAgent.test.jsx` — the hook and card (Testing Library): no stacked mic on a double
  Connect, cleanup on unmount, the button per state (Cancel, Disconnect while reconnecting, Retry,
  Reload page on a fatal failure) with focus kept on it, the status line and alerts.
- `bridge.test.js` — `sandbox/bridge.js` run against a stubbed iframe: `navigate` waits for its
  own page and reports a page that never loads as a failure.
- `bridgeChannel.test.js` — the private channel: one port handed over, results correlated by id,
  the 4 s timeout, forged `window` messages ignored.
- `domSnapshotContext.test.js` — the keyframe-vs-delta decision.
- `knowledgeStore.test.js` — accept/reject by file type, the size cap, add/remove/list, the
  context blob it builds.
- `loopGuard.test.js`, `pcm.test.js` — the repeat cap and the audio encode/decode helpers.

## What's deliberately not here yet

- A test for the bridge's handshake/allowlist logic in `sandbox/bridge.js` itself — it is tied to
  a real page and iframe, so it arrives with the Playwright e2e in M5 (issue #13). The agent's
  side of the channel is unit-tested (`bridgeChannel.test.js`).
- A test for the `KnowledgeModal` component itself (drag/drop interaction, Radix wiring) — the
  underlying store is tested, the UI isn't yet (M7, issue #11).
- The designed widget — volume orb, coalesced transcript, connection toast, render-isolation
  test — is M7 (issue #11); today's card is deliberately minimal.
- The "point this at a real external site" path — see `docs/sandbox-simulation.md` §5 for what
  that would actually take.
- Anything from the agent-creation side of the real product (see the docs' scope note).
- Real RAG (chunking/embeddings/retrieval) — the knowledge feature is context-stuffing, see
  `docs/project-knowledge-handoff.md` §5.1.
