# 0005 — Load the Gemini SDK on Talk

Status: accepted (2026-11-07, M9 T1, issue #20). The user delegated this choice for M9
("close every open issue in one PR without stopping for approval"); the PR flags it.

## Context

Until M9 the widget was one IIFE, `agent-client/dist/agent-client.js`, **179.62 kB gzip** against
the 180 kB budget (spec Budgets), which had already been raised twice (150 → 165 → 180). Any
feature that added code would break it. `@google/genai` (2.32.0, with `retry` / `p-retry`) is
~72–75 kB gzip of that (`docs/metrics/m06.md`, `m07.md`), and only a Live session uses it:
nothing on page load needs it. An IIFE can't code-split.

Issue #20's options:

- **C. Drop the SDK for a hand-written Live WebSocket client.** ~105 kB on page load and no SDK
  at all. About a day; the Live wire protocol (setup, `BidiGenerateContent` frames, resumption,
  tool calls, ephemeral-token auth) becomes ours to track as Gemini changes it, and the SDK's
  types (`LiveServerMessage`, ADR 0004's constraint behaviour) stop being a reference.
- **D. Load the SDK on Talk** as a chunk of its own.
- **Drop the Radix Toast** for a hand-rolled region: ~7 kB, and its swipe, F8 hotkey and
  announcer would be ours to rebuild.

## Decision

**D.** The widget is built as an **ES module** whose one dynamic `import()` is the SDK:

- `vite.config.js`: an app build with a JS entry (`rolldownOptions.input: 'src/main.jsx'`,
  `entryFileNames: 'agent-client.js'`), not lib mode — Vite's lib mode never minifies an ES
  build's whitespace (a lib build with Rolldown's own minifier came to the same size, plus a
  separate 0.4 kB gzip runtime chunk: a second request on the page-load path). The SDK chunk is `web-<hash>.js`, hashed so a page loaded before a deploy
  can't pair its entry with a newer chunk; the old one 404s, which is the `sdk` failure below.
  Vite wraps the `import()` in its preload helper (a few hundred bytes; it has nothing to
  preload here), not worth a plugin to remove.
- `sandbox/index.html` loads it with `<script type="module">`. Module scripts are deferred, and
  deferred and module scripts run in document order, so `bridge.js` still runs first.
- `main.jsx`: `document.currentScript` is null in a module, so the bundle's URL is
  `import.meta.url` and its tag (for `data-ds-nonce`) is the `document.scripts` entry with that
  `src`. The worklet URL and the client log's scope are the bundle's directory, so an error
  thrown from the SDK chunk is still reported.
- `liveSdk.js` owns the one `import('@google/genai/web')`: loaded once, a failed load forgotten
  so the next call imports again (Chromium does re-fetch a failed dynamic import; checked in
  `e2e/sdk.spec.js`). `liveSession.js` fetches the token and loads the SDK **in parallel**, so a
  first Talk waits for the slower of the two, not both. Pointing at or focusing Talk starts the
  load (`preloadLiveSdk`), so it is usually in before the press.
- A chunk that doesn't load fails the attempt at once as `fatal: 'sdk'` — "Can't connect", the
  reason "The voice client couldn't load. Check your connection, then retry." and **Retry**,
  which imports it again. The reconnect backoff is for the voice socket; a minute of retries on a
  missing file would only hide it. The client log accepts the `sdk` kind (`server/app.js`).
- The CSP is unchanged: a module script and its `import()` are same-origin scripts, covered by
  `script-src 'self'` (no inline, no `blob:`).

Not C: D gets the same page-load saving (C's ~105 kB vs D's 107.8 kB) without owning a wire
protocol, and its cost — the chunk's download on a first Talk — fits inside the connect budget
(measured below). C stays open if the SDK ever has to go for another reason. Not the toast: 7 kB
isn't headroom.

Not an idle-time prefetch after load: every page view would download the 75 kB again, the cost
this decision removes, for a gain only on a first Talk with no hover or focus before it.

## Consequences

- Page load: **107.79 kB gzip** (335.4 kB raw), from 179.62 (726.5 raw) — 72 kB under the 180 kB budget. The
  SDK chunk: **74.66 kB gzip** (399.3 kB raw), fetched once per page, on the first hover, focus or
  press of Talk. Both are checked by `e2e/sdk.spec.js` against the spec's budgets.
- A first Talk can wait for the chunk. With the fake Live (an instant token, so the chunk is the
  whole critical path): connect → `open` 16–26 ms before, 32–61 ms after with no network
  throttling; on a Slow 4G profile (150 ms RTT, 1.6 Mbps) ~20 ms before, ~500 ms after with a
  cold press, ~180 ms after a 300 ms hover. With the real token mint in parallel, part of that
  is hidden. One live e2e run after the change (run 50 in `.metrics/live.json`, local server, so
  the chunk is near-instant): connect → `open` 1.47 / 1.37 / 1.78 s (budget ≤ 2.5 s; the ten
  runs before it, 1.08–1.87 s), first audio after `open` 0.57 / 0.60 / 0.66 s (budget ≤ 2.0 s);
  all three scenarios passed, the reconnect in 1.07 s.
- Nothing else may import `@google/genai` as a value, or it is back in the page-load chunk.
  `liveSdk.test.js` fails on a static import, and `e2e/sdk.spec.js` checks the built entry.
- A page open across a deploy gets the `sdk` failure on its first Talk, since its chunk is gone.
  Retry fails the same way; a reload fixes it. Rare enough on a demo to leave the reason as is.
- `@google/genai`'s JSDoc `@import` types are unaffected (types only).
