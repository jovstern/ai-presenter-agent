# AI Presenter Agent (v2)

A rebuild of the runtime half of a Presenter Agent — an AI avatar embedded in a demo that talks
*and* acts (click/scroll/navigate/fill) on the app behind it, hardened against the gaps found in
the v1 build. It also has a small RAG-lite knowledge feature: drop `.txt`/`.md` files into a modal
and the agent gets them as context, stored only in your browser's `localStorage`.

Start with [`docs/project-knowledge-handoff.md`](./docs/project-knowledge-handoff.md) — the full
origin story, what's actually verified vs. just written, every caveat, and what's planned next.
[`docs/demostack-ai-presenter-agent.md`](./docs/demostack-ai-presenter-agent.md) is the build spec
and [`docs/sandbox-simulation.md`](./docs/sandbox-simulation.md) explains why this build fakes the
"cloned app" the way it does instead of embedding a real external site.

**Not included on purpose:** the agent-creation UI, the template/demo-agent data model, the flow
builder, RAG upload. This build is about the runtime — sandbox, grounding, security, resilience,
performance — see the docs for why.

## Layout

```
docs/            the two spec docs
target-app/      static mock "cloned app" (2 pages, a few data-testid elements)
sandbox/         the host page: iframe + the postMessage bridge + action library
agent-client/    the React app that gets built into a single script, mounted in a shadow root
server/          the entire backend: mints a short-lived Gemini Live token, serves everything else
```

## Run it

You need a Gemini API key: https://aistudio.google.com/apikey

```bash
# 1. server
cd server
npm install
cp .env.example .env   # paste your key into GEMINI_API_KEY

# 2. agent-client (separate terminal — leave this running, it rebuilds on save)
cd agent-client
npm install
npm run watch

# 3. back in server/
npm start
```

Then open **http://localhost:8787/sandbox/** and allow microphone access when prompted. The agent
should greet you once the target-app iframe finishes loading; try asking it to deploy a widget or
go to settings. Click the `📄` button on the agent card to drop in `.txt`/`.md` files it should
know about in advance.

## Test

```bash
cd agent-client
npm test
```

Covers the loop guard, the render-isolation claim for the volume meter (`React.Profiler`-based —
proves it, doesn't just assert it), and the knowledge store (accept/reject by file type, the size
cap, add/remove/list, the context blob it builds) — the things v1 either didn't verify or didn't
have.

## What's deliberately not here yet

- A test for the bridge's origin/token/allowlist validation itself (the logic is straightforward
  to read in `sandbox/bridge.js`, but it's tied directly to real DOM elements rather than
  extracted into a pure, easily-testable function — a good next step).
- A test for the `KnowledgeModal` component itself (drag/drop interaction, Radix wiring) — the
  underlying store is tested, the UI isn't.
- The "point this at a real external site" path — see `docs/sandbox-simulation.md` §5 for what
  that would actually take.
- Anything from the agent-creation side of the real product (see the docs' scope note).
- Real RAG (chunking/embeddings/retrieval) — the knowledge feature is context-stuffing, see
  `docs/project-knowledge-handoff.md` §5.1.
