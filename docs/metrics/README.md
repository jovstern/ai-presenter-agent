# Metrics

Two kinds of numbers are kept here:

- **Milestone reports** (`m<NN>.md`, `history.csv`) — the observer's per-milestone run against
  the spec's budgets: Lighthouse, Core Web Vitals, bundle size, axe, gate latency, console errors.
  How they are measured is in `.claude/skills/metrics/SKILL.md`.
- **App metrics** — how the voice agent itself performs against the real Gemini Live API,
  measured by the opt-in live e2e described below. The budgets are in
  `docs/superpowers/specs/design.md` § Budgets ("App metrics, from the live e2e").

## The live e2e (R12)

`e2e/live.spec.js` runs the real `/` page, the real server with its real key and the real Gemini
Live API. The user's voice is a WAV that Chromium's fake microphone plays once
(`--use-file-for-fake-audio-capture=<wav>%noloop`). The test reads the agent-client's own
timing marks and asserts on what happened in the target app's iframe.

It is **opt-in** and never runs in `npm run e2e` or CI: it needs a key, costs API usage, is
nondeterministic (an LLM drives it), and needs macOS for the prompts.

```bash
npm run e2e:live   # at the repo root
```

That script runs `e2e/make-prompts.sh` (macOS `say`, about 5 s) and then
`GEMINI_LIVE_E2E=1 playwright test`. Setting the variable inline is POSIX-shell syntax; it is
not made cross-platform because `say` is macOS-only anyway.

- **Key:** the server's own, never the test's. In live mode Playwright starts `node index.js`
  from `server/`, so `dotenv` loads `server/.env` (or an exported `GEMINI_API_KEY`) inside the
  server process. The config passes no key and the test never sees one. Without a key, every
  scenario fails at "Live", because the card shows the `not_configured` alert.
- **Port:** 3972 (the deterministic suite uses 3971, `npm run dev` 3000). A server already on
  the port fails the run instead of being reused.
- **One at a time:** `workers: 1`. The three scenarios share one key and one per-IP token rate
  limit, and the timings are cleaner on an unloaded machine.
- **No retries, no traces:** a failure is a data point for the pass rate. Traces are off in
  live mode because they would record the minted token (the token response and the Live socket
  URL).
- **Prompts:** `e2e/fixtures/prompts/*.wav`, 16 kHz 16-bit mono, about 2 MB each with their
  silence. They are gitignored, not committed: they are binary, they are regenerated on every
  run in a few seconds, and the suite needs macOS (and a key) anyway. Each prompt starts with
  some silence: liveSession.js buffers only the newest 20 mic frames until the socket is up,
  and the task's prompt waits for the greeting to finish. Each ends with 60 s of `say`
  `[[slnc 60000]]` silence (dither-level noise, peak 7/32767), so the voice activity
  detection sees a clean end of turn.

### Scenarios

Each WAV is its own Playwright project (`live-greeting`, `live-task`, `live-reconnect`), because
the fake-capture file is a browser launch flag.

| Scenario | Prompt (`make-prompts.sh`) | Passes when |
|---|---|---|
| `greeting` | "Hi!" at 4 s | Live within 15 s, then the first agent audio (`ds:first-audio`) and an agent transcript line |
| `task` | at 6 s: "Increment the counter twice, then go to Settings, turn on notifications and save." | within 150 s: the save confirmation is visible, the Settings heading is shown, the toggle is checked, and the counter went exactly `1`, `2` |
| `reconnect` | at 12 s: "Which page are we on right now?" | after the first audio, the test closes the page side of the real Gemini socket (a `routeWebSocket` pass-through); the card shows `Reconnecting…`, then Live, `ds:reconnected` is marked, and the agent answers the follow-up |

### Timing marks

`agent-client/src/liveSession.js` puts these on the page's performance timeline with
`performance.mark`. They are timestamps in a buffer nobody reads in production: no logging, no
network. A Disconnect clears them (`performance.clearMarks`), so the buffer stays bounded; read
them before disconnecting. Unit-tested in `liveSession.test.js` ("timing marks").

| Mark | When |
|---|---|
| `ds:connect-start` | a user-initiated connect (Connect or Retry) |
| `ds:open` | the server's first message on a session (each (re)connect) |
| `ds:first-audio` | the first audio chunk after a connect (once per connect) |
| `ds:tool-start:<id>` / `ds:tool-end:<id>` | around one tool call's bridge dispatch; `detail` holds `name` (and `success` on the end) |
| `ds:reconnected` | the first `open` after a drop that the session recovered from |

### `.metrics/live.json`

Gitignored. Every `npm run e2e:live` appends one run (`e2e/live-reporter.js`, which collects
each test's `live-metrics` attachment):

```jsonc
{
  "runs": [
    {
      "timestamp": "2026-10-29T05:39:39.558Z", // run start
      "status": "passed",                      // the whole run
      "scenarios": [
        {
          "project": "live-reconnect",
          "status": "passed",                  // or failed / timedOut
          "durationMs": 15400,
          "error": null,                       // first line of the failure
          "metrics": {
            "connectToOpenMs": 1317,           // ds:connect-start → ds:open
            "connectToFirstAudioMs": 1843,     // ds:connect-start → ds:first-audio
            "openToFirstAudioMs": 506,         // ds:open → ds:first-audio (the greeting budget)
            "tools": [{ "name": "click", "roundTripMs": 2, "success": true }],
            "reconnectMs": 1065,               // socket closed by the test → ds:reconnected
            "reconnectAttempts": 1,            // reconnect scenario only: sockets after the drop
            "resumed": true,                   // reconnect scenario only: the last one resumed
            "transcript": ["agent: …", "user: …"] // failed tests only, one line per turn
          }
        }
      ]
    }
  ]
}
```

A tool's round trip is the bridge only: the dispatch through the private channel into the
iframe and back, not the model's thinking time. The observer summarises the file (median and
worst per metric, pass rate per scenario) in the milestone report.

## M5 T5 baseline (2026-10-29, 11 runs)

Measured on `m5-quality-baseline`, model `gemini-3.8-live`, after the three fixes the live
e2e found (below). `n` counts sessions across all three scenarios, so 33 connects.

| Metric | Median | Worst | Budget | |
|---|---|---|---|---|
| Connect, click → `open` (n=33) | 1.32 s | 1.89 s | ≤ 2.5 s | ✅ |
| First agent audio after `open` (n=33) | 0.51 s | 0.58 s | ≤ 2.0 s | ✅ |
| Connect → first audio (n=33) | 1.84 s | 2.46 s | — | |
| Tool round trip, click (n=38) | 1.5 ms | 8 ms | ≤ 300 ms | ✅ |
| Tool round trip, navigate (n=11) | 19 ms | 25 ms | ≤ 1.5 s | ✅ |
| Scripted task success | 8 of 11 | | ≥ 4 of 5 (80 %) | ❌ 73 % |
| Reconnect recovery, forced close → `open` (n=11) | 1.07 s | 3.37 s | ≤ 3 s | ❌ worst |
| Greeting scenario | 11 of 11 | | | ✅ |
| Reconnect recovered | 11 of 11 | | | ✅ |

- **Task misses:** all three failed runs stall the same way. The agent narrates the
  navigate to Settings, the navigate succeeds, and the model ends its turn without the next
  step. Before the fixes below it passed 0 of 4 exploratory runs, all stalled at or after the
  navigate. What is left belongs to M6 T5's tuning.
- **Reconnect worst case:** 4 of 11 recoveries needed two attempts. Gemini answered the
  immediate resume with `1008 "session is already connected to an existing client"` because
  it still held the dropped client, and the backoff's next attempt, 1 s later, resumed. One
  attempt took 1.01–1.35 s, two took 2.80–3.37 s. A shorter delay before retrying that
  particular refusal is a knob for M6 T5.
- Runs 4 and 6 of the 11 were marked failed by a test assertion that expected exactly one
  reconnect socket. Both recovered: Live again, with `ds:reconnected` marked. The assertion
  now allows the second attempt. The numbers above include both runs, but `resumed` wasn't
  recorded for them.

### Bugs the live e2e found (fixed in M5 T5, with unit tests)

1. **A resume refused as "already connected" dropped the handle.** `liveSession.js` treated
   any resumed attempt that closed before the server answered as a rejected handle, so every
   immediate reconnect started a fresh session and lost the conversation. It now keeps the
   handle when the close reason says the old client is still attached.
2. **A navigate's keyframe reached the model before the navigate's own result,** as a user
   turn between the function call and its response. With `turnComplete: false` it never
   prompted a turn, and the model stalled on "navigated". A snapshot that arrives while a tool
   batch runs is now held and sent inside the next tool response, as `page`. The system
   instruction says so, and says to carry out every step of a multi-step request.
3. **The snapshot named the notifications checkbox "on"** (its default `value`) and didn't
   say whether it was checked, so the model once reported it "already on" without clicking.
   `bridge.js` now names a form control by its `<label>`, adds `checked` for checkboxes and
   radios, and sends a snapshot on `input`/`change`, because toggling a checkbox changes no
   attribute and the `MutationObserver` alone never saw it.
