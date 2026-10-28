# 0001 — Agent ↔ bridge traffic on a private MessageChannel

Status: accepted (2026-10-28)

## Context

Spec goal #1 asks that every bridge message be validated by origin and source, and be bound
to the live session. Today `agent-client` and `sandbox/bridge.js` talk via `window.postMessage`.
Every message is broadcast to every `message` listener in the window, and that includes the
target app's own scripts in the real product, which run same-origin. A co-resident script can
therefore:
- read every DOM snapshot and action result;
- post a forged `ds-action-result` or `ds-dom-snapshot`.

An origin check cannot tell these apart, because they share the origin.

## Options

1. **Private `MessageChannel`.** `agent-client` creates a channel once, at mount, and posts
   `{ type: 'ds-bridge-connect' }` to `window` with one port transferred. The bridge accepts
   the first valid connect only, for the page's lifetime, and from then on all traffic is
   carried on the port:
   - `action` / `action-result`;
   - `snapshot` / `request-snapshot`;
   - `navigated`.
2. **A session token on window messages.** This is the spec's literal wording. Same-window
   scripts can read the token off the broadcast messages, so it adds little over the origin
   check.
3. **Record a deferral only.**

## Decision

Option 1, chosen by the user.

## Consequences

- What the channel protects against: **passive `message` listeners** (snapshots and results never
  reach `window`) and **forged `window` messages** (the bridge reads nothing off `window` after the
  handshake, and the agent-client never listens there).
- What it does **not** stop: a same-realm script can patch `MessagePort.prototype.postMessage`
  and read or alter everything sent on the port. Both ends capture
  `MessagePort.prototype.postMessage` when their script loads and send with
  `send.call(port, msg)`, which closes tampering *after* load.
- **Residual risks (documented, not closed):**
  - tampering *before* load: a script that patches `MessagePort.prototype.postMessage` before
    `bridge.js` / `agent-client.js` run still sees the traffic;
  - the pre-handshake hijack: a hostile script that runs *before* the agent-client's handshake
    could connect first and take the bridge.

  Closing both needs the clone isolated on another origin, which is out of scope
  (`code-review-notes.md` H1).
- The handshake is a one-time race: the agent-client connects at mount, not on "Connect"
  click, which keeps the window small.
- The message protocol changes shape. `docs/demostack-ai-presenter-agent.md` §4 and
  `docs/sandbox-simulation.md` §4 are updated to describe the channel.
