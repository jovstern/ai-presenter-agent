# Plan — cycle 1 (M4 finish → M8)

Spec: `docs/superpowers/specs/design.md`. Assessment: `docs/superpowers/specs/assessment.md`.
ADRs: `docs/adr/0001–0003`.

## Global constraints

- Follow `.claude/skills/stack-conventions/SKILL.md` and the stack files the spec names,
  `.claude/skills/ui-craft/SKILL.md` for any UI, and `.claude/skills/quality-gates/SKILL.md`.
  Server data is never copied into client state; view state lives in the URL; data is read
  and written through the layer the spec names. Any `any`, unjustified dependency, missing
  state (loading, empty, error), missing keyboard or focus support, or leftover log or dead
  code is an Important finding.
- The repo's conventions win:
  - JS/JSX with checkJs (from M5);
  - tests in `src/__tests__/`;
  - dense *why* comments that cite `code-review-notes.md` items.
- **No new tracking surface:** `docs/code-review-notes.md` is ticked in place, in the same
  commit as the fix.
- Every task that changes behaviour updates the docs it makes untrue, in the same commit.
- No `useMemo` / `useCallback` / `memo`, no `useReducer`, no context, no state library. The
  only dependencies are the ones listed in the spec's table.
- `server/.env` is never read or printed. The live e2e reads the key from the environment of
  the server process only.
- Do not commit or push to `master`. One commit per task. `cd` into the package before npm.
- Every task touching `liveSession.js`, `useLiveAgent.js` or `bridge.js` is checked in a
  real browser at milestone end. Unit tests alone are not enough.
- **CSP rule (from M5 T3):** any task that adds a resource type (a worklet, a stylesheet, a
  font, a beacon, another origin) updates the CSP in `server/app.js` (`contentSecurityPolicy()`)
  and its test in `server/__tests__/app.test.js` in the same commit. No inline script on any
  served page.

---

## M4 — Finish the closed loop (issue #4, branch `m4-closed-loop`, PR #9)

The branch already has `master` merged in. These tasks are the fix wave on top of PR #9.

**Demo flow:**
1. Open `/sandbox/`.
2. Press Connect; the agent greets.
3. Ask: "increment the counter twice, then go to settings, turn on notifications and save."
4. Force-close the socket in DevTools: the status shows `reconnecting`, then `open`.
5. Press Disconnect, then Connect again: the mic indicator shows one stream.

**Acceptance tests:**
- `bridgeChannel.test.js`;
- `liveSession.test.js`;
- `useLiveAgent.test.jsx`;
- `npm test`, `npm run build`;
- curl on `/` and `/sandbox/` for the nonce;
- a manual real-browser run of the demo flow.

(`check` and `e2e` arrive in M5. M4's gate is test + build + the browser run, and the PR
says so.)

**T0 — Cycle docs + issues.**
- Commit `assessment.md`, `design.md`, this plan and ADRs 0001–0003.
- Create the GitHub issues "M5: Quality baseline", "M7: Presentable widget" and "M8: Deploy +
  close the cycle".
- Retitle #5 to "M6: Hardening + tuning".
- Update #4's body with the fix-wave scope.

*(small, 5 min)*

**T1 — The sandbox is served with a nonce at `/sandbox/` (A1, A9).**
- `server/index.js`: one `sendSandbox(req, res)` handler for `GET /` and `GET /sandbox/`
  (and `/sandbox/index.html`), registered before `express.static('/sandbox')`.
- The 500 body no longer echoes `err.message`; the error is logged server-side instead.
- Verify with curl that both URLs carry a UUID nonce. (No server test harness until M5 T3,
  which adds a regression test for this.)
- Docs: README run steps (port 3000, either URL); handoff §3.2 route list.
*(small, 5 min)*

**T2 — Private bridge channel + bridge robustness (A4, A5, A7, ADR 0001).**
- New `agent-client/src/bridgeChannel.js`, written test-first. `connectBridge()`:
  - creates a `MessageChannel` and posts `{type:'ds-bridge-connect'}` with the port;
  - exposes `dispatchAction(name, args) → Promise<result>`, with an id map and a 4 s
    timeout;
  - exposes `requestSnapshot()`, `onSnapshot(cb)`, `onNavigated(cb)` and `close()`.
- `connectBridge({ postConnect })`: `postConnect(port)` defaults to
  `window.postMessage({type:'ds-bridge-connect'}, origin, [port])`. Tests inject their own,
  because jsdom drops transfer lists.
- Ports use `port.onmessage` (which starts them implicitly); `close()` closes the port, so
  vitest doesn't hang.
- `onSnapshot(cb)` and `onNavigated(cb)` **return unsubscribe functions**.
- Tests (`src/__tests__/bridgeChannel.test.js`), using a real `MessageChannel` and a fake
  bridge end:
  - results are correlated by id;
  - timeout → `{success:false}`;
  - a result for an unknown id is ignored;
  - unsubscribe stops delivery;
  - forged `window` messages are ignored.
- **Channel ownership:** `main.jsx` connects once, at mount, and owns the channel for the
  page's lifetime. The bridge accepts only the first connect, so nothing else may close the
  channel: not session disposal, StrictMode or a remount.
- `sandbox/bridge.js`:
  - accepts the first `ds-bridge-connect` from the same origin with exactly one port, and
    ignores later ones;
  - snapshots or `navigated` produced before a port exists are dropped, because the iframe
    can load before DOMContentLoaded; the agent asks for a fresh snapshot on connect;
  - all replies go on the port;
  - each action is wrapped in try/catch, so a throw → `{success:false, error}` (M3);
  - on load, posts `navigated` *before* the snapshot (A7);
  - the "deferred to M4/M5" comment is replaced by the ADR reference.
- `liveSession.js` subscribes through the channel instead of `window` listeners.
- The real port transfer is proved in the M4 manual browser run, then in the M5 e2e.
- Docs:
  - spec doc §4 / §4.1 diagrams and messages, and goal #1 / §5.2 rewritten from "session
    token" to the channel;
  - `sandbox-simulation.md` §4;
  - checklist M3 ticked, H1 note on the channel (H1 itself is ticked in M5, after the CSP);
  - handoff §4 decision line → ADR 0001.

*(large, 22 min)*

**T3 — `liveSession` tests + honest status (A3, A6, H2).**
- New `src/__tests__/liveSession.test.js`. It mocks `@google/genai/web` (a fake
  `live.connect` capturing callbacks), `fetch` and the bridge channel. Write the tests first:
  1. `onerror`+`onclose` together → exactly one reconnect and one token fetch (B2);
  2. a `connect()` superseded during `await` closes the stale session;
  3. a tool batch of `navigate` then `click` is dispatched in order, and the second waits
     for the first (H4);
  4. a batch whose session is replaced mid-flight sends no stale tool response;
  5. a resumed reconnect passes the handle and sends no greeting;
  6. status sequence: `connecting` → `open` → (drop) `reconnecting` → `open`, and after 6
     failures `failed`;
  7. the loop guard blocks the 4th identical call;
  8. a manual `connect()` after `failed` resets the attempts and really retries;
  9. open-then-immediate-close repeatedly does not loop at delay 0, because `attempt` is
     reset only after the first server message (`setupComplete`) or 10 s open;
  10. a 4xx token response (expired nonce, missing key) → `failed` immediately, with the
      reason "reload the page", and no retries.
- Code:
  - add the `reconnecting` status (with the attempt number via `onStatusChange(status,
    {attempt, reason})`);
  - `failed` only when attempts are exhausted or the error is non-retryable;
  - `dispose()` only unsubscribes (knowledge listener, channel subscriptions) and closes
    the session. It **never** closes the bridge channel.
- Docs: checklist H2 ticked (point: tests); handoff §3.3 updated.

*(large, 25 min)*

**T4 — Hook cleanup + a minimal Retry (A2, M2, M4).**
- `useLiveAgent.js`:
  - `connect()` first stops any existing capture and player, so it is idempotent;
  - an effect (syncing with an external resource — allowed) disposes the session, capture
    and player on unmount, and sets `sessionRef` to null so a remount creates a new session;
  - capture and the player are stopped when the status becomes `failed`, so the mic is not
    left live;
  - `retry()` = `connect()`.
- `AgentApp.jsx`: the button shows Retry when `failed` and is disabled while `reconnecting`;
  the status text says "Reconnecting (n/6)…". The full UI is M7.
- `main.jsx`: keeps the React root so `unmount()` is reachable.
- Tests (`src/__tests__/useLiveAgent.test.jsx`, Testing Library, with `liveSession` and
  `audioIO` mocked):
  - pressing Connect twice → the first capture is stopped before the second starts;
  - unmount → capture stopped, player closed, session disposed;
  - render → unmount → render still dispatches actions over the same channel (StrictMode
    safety);
  - `failed` → capture stopped and the button shows Retry.
- Docs: checklist M2 and M4 ticked.

*(medium, 12 min)*

**T5 — Docs true again (R7).**
- `code-review-notes.md`:
  - tick B1, B2, B3, B4, H3, H4, H5 (all 3 points), and L9 (snapshot field already
    renamed to `tag`);
  - H1 gets the residual note but stays unticked until the CSP lands in M5;
  - a top note that the line references predate the rebuild.
- CLAUDE.md:
  - the real file layout (`liveSession.js` is the riskiest file);
  - the real test files;
  - "two npm packages + two static dirs";
  - drop the claims about VolumeMeter, TranscriptLog, Toast and renderIsolation (M7 brings
    them back).
- README: run and test sections, and the real behaviour (greets on Connect).
- Handoff:
  - §3.2 (test counts, bundle 148.6 kB gzip);
  - §3.3 (model `gemini-3.8-live`; 3.1-flash-live-preview shuts down 2026-11-17; the live
    loop was verified in PR #9);
  - §5.2 (Toast lands in M7).
- Spec doc: goals #8 and #9 marked "lost in the rebuild, restored in M7".
- `sandbox-simulation.md` and README: the L12 typo, fixed in both.

*(medium, 10 min)*

**Then:** the three reviews (code, UI on the card, observer on `/`), the fix wave, the demo
GIF, and the PR #9 body rewritten to the kit template. Wait for the merge.

---

## M5 — Quality baseline (issue #13, branch `m5-quality-baseline`)

**Demo flow:**
1. `npm run check` at the root is green.
2. `npm run e2e` runs the bridge suite headed.
3. The CI run is green on the PR.
4. `gh api …/branches/master/protection` shows the required check.

**Acceptance tests:**
- `server/__tests__/token.test.js`;
- `e2e/bridge.spec.js`;
- `e2e/a11y.spec.js`;
- `e2e/live.spec.js` (opt-in);
- the CI workflow run.

**T1 — Lint, format, root scripts (R8).**
- Flat `eslint.config.js` in each package:
  - `@eslint/js` recommended + `globals` (browser / node);
  - `react-hooks` recommended (which includes the compiler rules) for agent-client;
  - `no-restricted-imports` for `useMemo` / `useCallback` / `memo`;
  - agent-client's config also covers `../sandbox/*.js` and the target-app scripts, so
    `bridge.js` is linted.
- Verify v7's flat-config key and its ESLint 10 peer range with context7 before writing the
  config.
- Prettier is configured at the root to match the current style (single quotes, 2-space
  indent, width 100).
- A root `package.json` with `check`, `e2e` and `dev` scripts calling `npm --prefix`.
- Run Prettier once as its own commit inside the task.
- Fix any lint errors for real: no disables without a reason.
- Docs: CLAUDE.md commands section ("No lint" removed); README test section.

*(medium, 10 min)*

**T2 — checkJs (R9, ADR 0002).**
- A `jsconfig.json` per package (`checkJs`, `strict`, `noEmit`).
- `src/bridgeProtocol.js` holds the protocol `@typedef`s, and `bridge.js` gets a
  `// @ts-check` header with the same typedefs copied in. (It is unbundled; a test asserts
  both lists of message types match.)
- JSDoc on `actionTools`, `liveSession` callbacks, `bridgeChannel`, `knowledgeStore`.
- `jsconfig.json` settings:
  - `resolveJsonModule`, `jsx: react-jsx`, `types: ["vite/client"]`;
  - a `globals.d.ts` for `window.__DS_NONCE__`;
  - agent-client's config includes `../sandbox/bridge.js`.
- Type packages: `@types/node`, `@types/express`, `@types/supertest`.
- `tsc -p jsconfig.json` (plain `tsc` ignores `jsconfig.json`) is added to `check`.
- First verify that TS 7 supports the JSDoc constructs used (`@typedef`, `@import`,
  `@callback`); otherwise pin 6.x and record why in ADR 0002.
- Docs: CLAUDE.md.

*(medium, 12 min)*

**T3 — Server: testable app, logging, headers (R10).**
- Split into `server/app.js` (`createApp({ mintToken, now })`) and `server/index.js`.
- pino + pino-http with a request id; no `console.log`.
- helmet with a CSP:
  - `default-src 'self'`;
  - `script-src 'self'`, with the target app's inline scripts moved into `.js` files and
    the nonce passed as a `data-ds-nonce` attribute on the agent script tag;
  - `style-src 'self' 'unsafe-inline'`, stated explicitly because Radix's
    react-remove-scroll and the shadow-root `<style>` inject styles at runtime;
  - `connect-src 'self' wss://generativelanguage.googleapis.com
    https://generativelanguage.googleapis.com`;
  - `frame-src 'self'`;
  - `upgrade-insecure-requests` and HSTS only in production.
- **CSP rule from here on:** any later task that adds a resource type (the M6 worklet, M7
  styles, the M8 beacon) updates the CSP in the same commit. The e2e console fixture
  catches violations.
- `node-api.md` essentials:
  - one error shape, `{error:{code,message}}`;
  - a central error handler (logs with the request id, 500 without internals);
  - the `nonce` query parsed with Zod;
  - graceful SIGTERM shutdown, because Render sends it.

  The rest of `node-api.md` (a services/routes tree) is a recorded deviation, given a
  single-route server.
- `GET /health`; `x-powered-by` off.
- Moving the target-app inline scripts into `.js` files: add `target-app` to agent-client's
  `lint` script (its `eslint.config.js` already matches `target-app/**/*.js`; T1 left it out
  because ESLint errors on a path with no files).
- Supertest tests, written first:
  - 403 cross-origin, and 403 without Referer/Origin;
  - 403 bad nonce;
  - 429 past the limit;
  - 500 without the key (JSON, no internals);
  - 200 with a stubbed mint;
  - both sandbox URLs templated (regression for M4 T1);
  - the CSP header is present.
- `check` = lint + tsc + test.
- `zod` moves from M8 into this task.
- Docs: checklist H1 ticked (CSP point); handoff §5.3; target-app file list.

*Done notes (T3):*
- The services/routes tree from `node-api.md` is a recorded deviation (spec, Assumptions).
- The error shape changed the client contract: `retryable: false` became
  `code: 'not_configured'`, and `liveSession.js` reads `error.message`.
- The nonce is threaded `main.jsx` → `AgentApp` → `useLiveAgent` → `createLiveSession({ nonce })`
  rather than read from the DOM inside `liveSession.js`, so it is testable; `globals.d.ts` is gone.
- Beyond the listed directives the CSP also sets `object-src 'none'`, `base-uri 'self'`,
  `form-action 'self'` and `frame-ancestors 'self'`. `Referrer-Policy` is `same-origin`, not
  helmet's `no-referrer`, which the real-browser check showed breaks the Referer fallback of
  the same-origin gate.
- A malformed or missing nonce is a 400 (`invalid_request`, Zod); a well-formed unknown or
  expired one is a 403 (`invalid_nonce`). The client treats both as "reload".
- Map pruning is on access (no interval to clear on shutdown): `server/expiringMap.js`.
- `audioIO.js` still uses `ScriptProcessorNode` (no worklet, no `blob:`), so the CSP needs no
  `worker-src`; M6 T3's worklet is served from `'self'`.

*(medium, 20 min)*

**T4 — Deterministic Playwright e2e (R11).**
- Adds the root `e2e` script (T1 left it out rather than ship a placeholder).
- Root `playwright.config.js` starts the server on a free port with a dummy key.
- `e2e/fixtures.js` fails a test on any console error or page error.
- `e2e/bridge.spec.js` runs on a fixture sandbox page served through `page.route`. The page
  has `bridge.js` and the iframe but no agent-client, so the test's own script performs the
  real handshake and the real port transfer:
  - click / fill / scroll / navigate change the iframe DOM;
  - an unknown action is rejected;
  - a navigate to an unknown route is rejected;
  - a second `ds-bridge-connect` is ignored;
  - a forged result on `window` is ignored;
  - a snapshot arrives after a mutation, with `hidden` correct for `save-confirmation`.

  This is the spec §5.6 bridge validation test.
- `e2e/loop.spec.js` puts a **fake Gemini Live** on the real `/` page with
  `page.routeWebSocket`. The fake sends `setupComplete`, then a scripted `toolCall` batch
  (navigate → click), then a forced close. The test asserts:
  - the iframe DOM changes;
  - `toolResponse` frames are sent in order;
  - the status goes `reconnecting` → `open`;
  - only one token fetch is made per reconnect.

  This puts the M4 demo flow and B2 in CI with no key. The token endpoint is stubbed with
  `page.route`.
- `e2e/a11y.spec.js`: axe on `/` with the card idle and with the knowledge dialog open.
- Markup fixes so axe passes now rather than in M7:
  - an iframe `title`;
  - a viewport meta on the sandbox and the target-app pages;
  - the knowledge button's empty state signalled without `opacity:.5`.
- Docs: README test section; CLAUDE.md test layout.

*Done notes (T4):*
- The fake Gemini is `page.routeWebSocket` on `wss://generativelanguage.googleapis.com/…`: the
  SDK's own browser WebSocket is intercepted, so no init-script fake is needed.
- The e2e server runs `node server/index.js` with `DOTENV_CONFIG_PATH=/dev/null`, so dotenv
  never loads `server/.env`; port 3971, `reuseExistingServer: false`.
- The iframe title, viewport metas, the empty state's ring (not opacity) and the search
  input's id/name were already in place from M4. axe 4.14 found one new violation:
  `label-content-name-mismatch` on the knowledge button (its `aria-label` "Knowledge files (0)"
  left out the visible text). It is now named by its content, a visually hidden "Knowledge
  files:" before the visible count.
- The CSP fixture listens on `window`, not `document`: an iframe's first document reuses the
  Window of its initial about:blank, where the init script ran.
- The bridge fixture page is served with the real `/` response's headers, so it runs under the
  shipped CSP.
- `e2e/` is formatted by Prettier but not linted: no root ESLint config, and adding one is a
  lint-config change left for the user to decide.

*(large, 25 min)*

**T5 — Opt-in live e2e + app metrics (R12).**
- `e2e/fixtures/prompts/*.wav` are generated by a committed script, `e2e/make-prompts.sh`,
  so they are reproducible. It runs `say -o f.wav --data-format=LEI16@16000`, padded with
  `[[slnc 60000]]` trailing silence.
- `e2e/live.spec.js` runs only when `GEMINI_LIVE_E2E=1`. Chromium gets
  `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream
  --use-file-for-fake-audio-capture=<wav>%noloop`, because the file otherwise loops and
  trips the loop guard.
- Each WAV runs in its own project/worker, since the flags are per browser launch.
- In live mode, Playwright's `webServer` does **not** inject the dummy key: the key comes
  from the server's own env.
- The forced close is done with a `routeWebSocket` pass-through to the real Gemini socket,
  then `ws.close()`.
- The agent-client exposes timing marks through `performance.mark` (`ds:connect-start`,
  `ds:open`, `ds:first-audio`, `ds:tool-start:<id>`, `ds:tool-end:<id>`, `ds:reconnected`).
  These cost nothing in production and are read by the test.
- Scenarios:
  1. the greeting arrives;
  2. the scripted 5-step task, with DOM assertions on the iframe;
  3. a forced socket close → recovery.
- Results are written to `.metrics/live.json`; the observer summarises them.
- Docs: `docs/metrics/README.md` explaining the app metrics and how to run it.

*(large, 45 min — includes about 10 live runs)*

**T6 — CI + branch protection (R13).**
- `.github/workflows/ci.yml`: Node 24, a cached install of each package, the root
  `npm run check`, the Playwright install and `npm run e2e` (deterministic only), with the
  report uploaded on failure.
- After the workflow's first run on the PR (a check must have run once before it can be
  required), run `bash .claude/skills/pr-demo/protect-master.sh jovstern/ai-presenter-agent`
  with the CI job as a required check.
- Add `.nvmrc` (24) and `engines` in each package (the rest of L11).
- `CONTEXT.md` glossary (bridge, channel, keyframe / delta, nonce, generation, loop guard,
  RAG-lite) per `docs/agents/domain.md`.
- Docs: CLAUDE.md "How work happens" mentions CI.

*(small, 6 min)*

---

## M6 — Hardening + tuning (issue #5, branch `m6-hardening`)

**Demo flow:** the live e2e passes 5 runs in a row. Then show, before and after tuning:
- the metrics table;
- the loop guard stopping an A-B-A-B cycle;
- `fill` working on a textarea and a select.

**Acceptance tests:**
- the extended `loopGuard.test.js` and `pcm.test.js`;
- `e2e/bridge.spec.js` (fill variants, the routes match);
- the live e2e numbers within budget.

**T1 — One route list + general `fill` (M1, M5).**
- `target-app/routes.json` (`{ "home": "/target-app/index.html", … }`) is the single
  source of the routes.
  - The server templates it into the sandbox page as `<script type="application/json"
    id="ds-routes">`, and `bridge.js` reads that.
  - `actionTools.js` imports it with a Vite JSON import, so the `navigate` enum is its keys.
  - An e2e asserts that the bridge accepts exactly the enum's routes.
- `fill` picks the native value setter per element type (`input` / `textarea` / `select`)
  and fires `input` + `change`. The target app gets a textarea and a select to prove it.
- e2e cases are added.

*(medium, 10 min)*

**T2 — Loop guard detects cycles and utterances (M6).**
- Tests first: an A-B-A-B cycle is detected; a period-3 cycle is detected; normal varied
  use passes; repeated identical normalised transcript turns are detected.
- When an utterance loop is detected, `liveSession` injects one corrective context turn.

*(small, 8 min)*

**T3 — AudioWorklet capture + PCM fixes (handoff §3.3, L1, L6).**
- `agent-client/public/capture-worklet.js` is copied to `dist/` by Vite and served at
  `/agent-client/capture-worklet.js`. It is covered by `'self'`, so the CSP needs no `blob:`.
- The worklet sends 16 kHz Int16 frames to the main thread.
- A deterministic e2e uses the fake-device flags (no Gemini) to prove that the worklet loads
  under the CSP and emits frames.
- `ScriptProcessorNode` is removed.
- `pcm.js`: chunked base64; an aligned copy before the `Int16Array`.
- An explicit secure-context check gives a clear error message instead of failing silently.
- Tests: pcm round-trip on odd offsets; a large frame. Verify in the real browser.
- Docs: handoff §3.3 / §4 (the ScriptProcessor decision reversed).

*(large, 20 min)*

**T4 — SDK pin and config alignment (M7, M8, L10).**
- Upgrade `@google/genai` in both packages and pin it exactly.
- Re-verify the Live shapes against the pinned version's types and docs (context7):
  - `message.data`;
  - `sessionResumptionUpdate.newHandle` / `resumable`;
  - transcriptions;
  - `toolCall`.
- `authTokens.create` gets `liveConnectConstraints` with the model only (M7 decision: model
  only; an ADR if it changes the security story).
- All other dependencies are pinned exactly.
- Docs: handoff §3.3 ("inferred" field names → verified).

*(medium, 12 min)*

**T5 — Measure, then tune the knobs (M9, R16).**
- Run the live e2e 5× at the current knobs and record the numbers.
- Baseline from M5 T5 (11 live runs): task success 8/11 (budget ≥ 80 %; the 3 misses end the
  turn right after navigate), and reconnect worst 3.37 s (budget ≤ 3 s; a resume refused with
  1008 "already connected" waits the full 1 s backoff). Candidate knobs: a short retry for
  that refusal, and the system instruction's multi-step wording.
- Then decide from the data:
  - `MAX_SNAPSHOT_NODES`;
  - `FULL_REFRESH_RATIO`;
  - the loop threshold;
  - whether a resumed reconnect should skip resending knowledge (M9 — the handoff's
    "deliberate" stance is kept or reversed with numbers).
- Write `docs/metrics/m06.md` with the before and after.
- Docs: handoff §3.3 / §4; checklist M9.

*(large, 45 min — includes about 10 live runs)*

**T6 — Close the checklist.**
- Every M and L item left is fixed or ticked "deferred: reason".
- L2, L3, L4, L5, L7 and L8 are marked "→ M7".
- L11 is done by the M5 root scripts, `.nvmrc` and `engines`.
- Accepted from the M4 re-review, fixed here:
  - a fatal **config** failure (missing server key) shows no Reload button, because a reload
    can't help (`fatal: 'config'` vs `'token'`);
  - a setup timeout (about 10 s) when the socket opens but the server never answers;
  - a resumed attempt that fails on the network keeps a valid resume handle; it is cleared
    only when the server rejects the handle;
  - the T3 deferral: setupComplete-then-close resets the backoff each cycle (bounded today
    by the 429 limit).
- Issue #5's "done when" is met.

*(small, 6 min)*

---

## M7 — Presentable widget (issue #11, branch `m7-widget-ui`)

**Demo flow:**
1. The idle card in light and dark.
2. Talk → connecting → live, with the orb rings moving.
3. A coalesced transcript.
4. The socket is forced closed → reconnecting → the failed toast → Retry.
5. Knowledge dialog by keyboard: open, add a file, use the rules counter, Escape, and focus
   returns to the button.

**Acceptance tests:**
- `renderIsolation.test.jsx`;
- `transcript.test.js`;
- `KnowledgeModal.test.jsx`;
- `e2e/widget.spec.js` (states, keyboard, axe in both themes, 360 px and 1440 px).

**T1 — Tokens and styles out of JS (L3, L4, L7).**
- `src/styles.css` imported `?inline`, with tokens as custom properties on `:host`.
- `prefers-color-scheme` and `prefers-reduced-motion` respected.
- Host positioning and `z-index` set on the host element.
- Docs: spec doc tokens.

*(medium, 12 min)*

**T2 — Volume orb + render isolation (goals #8 and #9, L2, L8).**
- The player exposes an `AnalyserNode` level, and the capture exposes the mic level.
- `VolumeOrb.jsx` reads them in a rAF loop into refs and sets a CSS variable on the
  element: no React state. The loop stops on unmount, and under reduced motion the orb is
  static.
- Test first: `renderIsolation.test.jsx` fakes rAF with injected level sources and drives
  50 ticks. It uses `React.Profiler` to assert that:
  - `VolumeOrb` and its siblings render once;
  - the orb's `--level` CSS variable changed 50 times;
  - siblings do re-render on a transcript change.

  A test that only counted sibling renders would pass trivially, because levels never touch
  React state.
- Docs: spec goals #8 and #9 restored; handoff §4.

*(medium, 12 min)*

**T3 — Coalesced transcript (A8, L5).**
- A pure `transcript.js` written test-first: `appendFragment(list, {role, text})` merges
  consecutive same-role fragments and bounds the list to 20.
- `Transcript.jsx` renders the last 3 inside `aria-live="polite"`.

*(small, 8 min)*

**T4 — Connection states + toast (R20, goal #6).**
- `@radix-ui/react-toast` with its viewport inside the shadow root.
- The card renders every state in the spec table: the Talk / End / Retry button, the
  pending state, the reconnect attempt text, mic-denied guidance and the failed toast (once
  per failure).
- Docs: handoff §5.2 made true.

*(medium, 12 min)*

**T5 — Knowledge modal polish + test (R21, issue #5 "rules polish").**
- Read the file list via `useSyncExternalStore` (no mirrored state).
- Empty state copy; Remove buttons named "Remove <file>"; a rules counter with
  `aria-describedby`; errors with `role="alert"`; the drop zone is a real `<button>` for the
  keyboard.
- `KnowledgeModal.test.jsx`: add a file → listed; an oversize file → alert; remove; rules
  over the limit → the message; Escape closes.
- Fixed here explicitly (all pre-existing on `master`, found by the M4 UI review): the
  dialog's focus trap leaking out of it inside the shadow root; Escape not returning focus to
  the knowledge button that opened it; and the mouse-only drop zone (the real `<button>` above).
  `KnowledgeModal.test.jsx` covers the focus return and the keyboard path to the file picker.

*(medium, 10 min)*

**T6 — Widget e2e + bundle check.**
- `e2e/widget.spec.js` drives every state through the M5 fake-Gemini `routeWebSocket`
  harness and `/api/live-token` stubs (4xx → failed, a close → reconnecting). There is no
  test hook in the production bundle.
- Keyboard walk; axe in light and dark; 360, 768 and 1440 px.
- Check the bundle against the 165 kB budget. A miss is fixed (for example with Radix
  per-package imports) or brought to the user.

*(medium, 12 min)*

---

## M8 — Deploy and close the cycle (issue #12, branch `m8-deploy`)

**Demo flow:**
1. Open the Render URL on a phone and on a laptop.
2. Talk; the agent completes the task.
3. Render's logs show the request lines and a client-log beacon.

**Acceptance tests:**
- `server/__tests__/config.test.js`;
- `server/__tests__/clientLog.test.js`;
- the e2e against the preview URL (`BASE_URL`);
- the observer report against production.

**T1 — Config, proxy and blueprint (R22, ADR 0003).**
- `server/config.js` parses the env with Zod (PORT, GEMINI_API_KEY, NODE_ENV) and fails fast
  with a clear message.
- `trust proxy` in production. Without it the same-origin check compares an `https` Referer
  with `req.protocol` `http` behind Render's TLS proxy and rejects every token request, and
  every user shares the proxy's rate-limit bucket. A supertest case with
  `X-Forwarded-Proto: https` covers it.
- `render.yaml`:
  - build: `npm --prefix agent-client ci --include=dev && npm --prefix agent-client run
    build && npm --prefix server ci --omit=dev`;
  - `--include=dev` is needed because `NODE_ENV=production` would otherwise skip Vite;
  - start: `npm --prefix server start`;
  - health check `/health`;
  - PR previews on.
- Tests first for the config.

*(medium, 12 min)*

**T2 — Client error and vitals reporting (R23).**
- `POST /api/client-log`: same gates as the token endpoint, a Zod body, a 4 kB cap, logged
  through pino. Tests first.
- The client reporter uses `web-vitals` + `onerror` + connection failures. It sends with
  `sendBeacon(url?nonce=…, new Blob([json], {type:'application/json'}))`.
- `connect-src` already covers `'self'`.
- Docs: README observability.

*(medium, 10 min)*

**T3 — Go live (user + agent).**
- The user creates the Render service from the blueprint and sets `GEMINI_API_KEY`.
- The agent runs the e2e against the URL and the observer against production, and records
  `docs/metrics/m08.md`.

*(medium, 15 min)*

**T4 — Close the cycle.**
- README final: what it is, the live URL, run and test, architecture with the ADR links,
  metrics, GIFs, what's next.
- CLAUDE.md and the handoff are brought up to date.
- Every assessment item is done or filed as an issue.
- The requirements checklist ✅/❌ and the time log are completed.
- Propose kit calibration edits for `~/Mnt/portfolio/.claude`.

*(small, 6 min)*

---

## Time estimate

| Milestone | Tasks | Agent (build + reviews + fixes + demo) | User (answer, review, merge) | Wall-clock work |
|---|---|---|---|---|
| M4 finish closed loop | 6 | 79 + 30 = **~110 min** | ~25 min (incl. a voice check) | ~2.3 h |
| M5 quality baseline | 6 | 118 + 32 = **~150 min** | ~15 min | ~2.8 h |
| M6 hardening + tuning | 6 | 101 + 30 = **~130 min** | ~15 min | ~2.4 h |
| M7 presentable widget | 6 | 66 + 35 = **~100 min** | ~15 min | ~1.9 h |
| M8 deploy + close | 4 | 43 + 25 = **~70 min** | ~25 min (Render setup) | ~1.6 h |
| **Total** | 28 | **~9.3 h** | **~1.6 h** | **~10.9 h** |

Range of wall-clock work (excluding the waits for merges): best 8.5 h / likely 10.9 h / worst
15 h.

What pushes it to the worst case:
- the live e2e being flaky (VAD on fake-mic audio, model variance) and needing retries or
  prompt tuning;
- Live API shape changes in the SDK upgrade;
- TS 7 checkJs gaps;
- the bundle budget forcing a rework of the dependencies.

### Time log

| Milestone | Estimated | Actual | Why it differed |
|---|---|---|---|
| M4 | ~110 min | ~127 min (1.15×) | Real-browser checks in every task; a larger fix wave (6 Important, 2 Must fix, the LCP miss); two re-review rounds. Remaining milestones re-scaled by 1.15×: M5 ~175, M6 ~150, M7 ~115, M8 ~80 (~8.7 h). |
| M5 | ~150 min | | |
| M6 | ~130 min | | |
| M7 | ~100 min | | |
| M8 | ~70 min | | |
