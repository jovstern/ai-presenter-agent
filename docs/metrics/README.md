# Metrics

Two kinds of numbers are kept here:

- **Milestone reports** (`m<NN>.md`, `history.csv`) — the observer's per-milestone run against
  the spec's budgets: Lighthouse, Core Web Vitals, bundle size, axe, gate latency, console errors.
  Since M9 T1 the bundle is two files ([ADR 0005](../adr/0005-load-the-gemini-sdk-on-talk.md)):
  `agent-client.js`, the page-load bundle (the `js_kb` column and the 180 kB budget), and the
  Gemini SDK chunk `web-<hash>.js`, loaded on Talk (its own 80 kB budget). Vite's build output
  gives both gzip sizes; `e2e/sdk.spec.js` checks both budgets on every e2e run.
  How they are measured is in `.claude/skills/metrics/SKILL.md`.
- **App metrics** — how the voice agent itself performs against the real Gemini Live API,
  measured by the opt-in live e2e described below. The budgets are in
  `docs/superpowers/specs/design.md` § Budgets ("App metrics, from the live e2e").

A third source, from M8 on: **real-user vitals** — each viewer's LCP, INP and CLS, beaconed
by `agent-client/src/clientLog.js` and logged by the server as `client vital` lines (Render's
logs in production; README § Observability). They are field data, one line per viewer and
metric, not a lab run, so they complement the observer's Lighthouse numbers rather than
replace them. They under-count long sessions: a beacon rides on the page nonce, which dies
after 1 h or with a server restart (the free plan spins down after ~15 min idle), and a
rejected beacon's report is lost, most often INP and CLS, which are sent when the page is
hidden (README § Observability).

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
- **One at a time:** `workers: 1`. The four scenarios share one key and one per-IP token rate
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

Each WAV is its own Playwright project (`live-greeting`, `live-task`, `live-act`,
`live-reconnect`), because the fake-capture file is a browser launch flag.

| Scenario | Prompt (`make-prompts.sh`) | Passes when |
|---|---|---|
| `greeting` | "Hi!" at 4 s | Live within 15 s, then the first agent audio (`ds:first-audio`) and an agent transcript line |
| `task` | at 6 s: "Increment the counter twice, then go to Settings, choose the Pro plan, turn on notifications and save." | within 150 s: the save confirmation is visible, the Settings heading is shown, the toggle is checked, the Plan select is `pro` (a `fill`), and the counter went exactly `1`, `2` |
| `act` | at 6 s: "Please increment the counter to three." (issue #29: a spoken request that makes the agent act, then its answer) | the counter goes `1`, `2`, `3` within 60 s, the agent's answer completes, and it is listened to for 10 s more |
| `reconnect` | at 12 s: "Which page are we on right now, and what is the code name of this demo?" | a knowledge file naming the code name (Pelican) is seeded in `localStorage` first. After the first audio, the test closes the page side of the real Gemini socket (a `routeWebSocket` pass-through); the card shows `Reconnecting…`, then Live, `ds:reconnected` is marked, and the agent answers the follow-up. Whether the answer names Pelican is recorded (`recalledKnowledge`), not asserted |

Until M6 T5 the task had five steps (no Plan) and the follow-up asked only for the page, with
no knowledge seeded; runs 1–18 in `.metrics/live.json` used those prompts. The `act` scenario
and the socket tap below arrived in M9 T2 (issue #29), from run 51 on.

### The socket tap (M9 T2)

Every scenario routes the real Gemini socket through a pass-through (`tapLive` in
`e2e/live.spec.js`) that records each non-audio message both ways: the page's setup, client
turns (classified as `snapshot`, `knowledge`, `greeting`, `corrective` or `text`) and tool
responses; Gemini's transcriptions, `turnComplete`, `generationComplete`, `interrupted` and
tool calls (`e2e/liveTurns.js`). Audio is skipped, and the token, which is in the socket's URL,
is never recorded. From the events, the agent's speech is cut into **turns**: the text between
two boundaries (`turnComplete`, `interrupted`, a tool call, or a drop). A **doubled answer** is
a sentence of four words or more that the agent says again in the next turn, or twice in one
turn; two turns that each end in a tool call are narration of a repeated action ("Incrementing
the counter again."), not a double. The greeting, task and act scenarios end by waiting for the
agent's turn after its last tool response to complete, then listening 10 s more
(`SETTLE_MS`), so a repeat after the answer is caught.

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
| `ds:keyframe` | a full page snapshot sent to the model (on its own or inside a tool response); `detail` holds `bytes` (UTF-8, the whole message) and `nodes` |
| `ds:knowledge` | the knowledge context sent to the model; `detail.bytes` (UTF-8) |
| `ds:loop-trip` | the loop guard tripped; `detail.kind` is `action` (a call refused as a loop), `budget` (a call refused past the request's 50 actions) or `utterance` (a corrective turn sent) |

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
            "keyframeBytes": [777, 855],       // each ds:keyframe's size
            "knowledgeBytes": [386],           // each ds:knowledge's size
            "knowledgeResentBytes": 0,         // reconnect only: knowledge sent after the drop
            "loopTrips": [],                   // each ds:loop-trip's kind
            "reconnectAttempts": 1,            // reconnect scenario only: sockets after the drop
            "resumed": true,                   // reconnect scenario only: the last one resumed
            "recalledKnowledge": true,         // reconnect scenario only: the answer named Pelican
            "agentTurns": [                    // the agent's speech per turn (the socket tap)
              { "text": "I have incremented the counter to three.",
                "after": "toolResponse",       // what the page last sent (or `user`) before it
                "end": "turnComplete",         // or interrupted / toolCall / open (a drop)
                "userBefore": false }          // the user spoke since the agent's last turn
            ],
            "doubledTurns": 0,                 // how many doubled answers (issue #29)
            "doubles": [],                     // each: { "text", "userBetween" }
            "events": ["3294 0 in outputTranscription Hello! How can I "], // ms, socket, dir, kind, text or names
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

The latest numbers are in `m06.md` (M6 T5: six-step task 8 of 10, reconnect worst 2.89 s,
keyframe ≤ 855 B, fill ≤ 3 ms). The M5 baseline below is kept for history.

## M9 T2: doubled answers (issue #29, 2026-11-07)

Before: runs 51–55 and 63–64 (1-based; current code with the socket tap, 7 runs). After: runs
65–68 (`Behavior.BLOCKING` on every declaration and the voice pinned, 4 runs). Runs 56–62 are
left out: the host's audio service had stalled (an `AudioContext`'s clock moved 5 ms in 500 ms),
so the fake mic sent nothing and the agent never heard a prompt, on either code. Since then the
Playwright config passes `--disable-audio-output`, so Chromium renders to a fake output on its
own clock and the voice tests no longer depend on the host's audio device.

| Metric | Before | After |
|---|---|---|
| Doubled answers | 1 in 28 scenarios (greeting, after a barge-in) | 0 in 16 |
| Task (six steps) | 7 of 7 | 4 of 4 |
| Act ("increment the counter to three") | 6 of 7 (one stall: no answer after the third click) | 4 of 4 |
| Greeting, reconnect | 7 of 7, 7 of 7 | 4 of 4, 4 of 4 |
| Connect → `open`, median / worst | 1.53 s / 2.31 s | 1.47 s / 1.62 s |
| Connect → first audio, median / worst | 2.16 s / 3.06 s | 2.09 s / 2.46 s |
| Tool round trip, click, median (n) | 103 ms (49) | 102 ms (28) |
| Task duration, median | 37.3 s | 35.7 s |
| Reconnect, median / worst | 1.64 s / 2.46 s | 1.01 s / 2.34 s |

The click's round trip includes the bridge's settling since #25 (100 ms of quiet), hence ~100 ms
rather than M5's 1.5 ms. Analysis: handoff §4, "Doubled answers".

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
