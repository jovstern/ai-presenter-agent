// Explicit /web subpath, not the bare package: the bare entry's "browser"
// condition wasn't picked up by this build and pulled in the Node build
// instead, which references `process` and crashes in the browser.
import { GoogleGenAI, Modality } from '@google/genai/web';
import { CHANGE_EVENT, buildContextMessage } from './knowledgeStore.js';
import { TOOL_DECLARATIONS, toPositionalArgs } from './actionTools.js';
import { createDomSnapshotContext, formatSnapshotMessage } from './domSnapshotContext.js';
import { createLoopGuard, actionSignature, pageFingerprint, ACTION_BUDGET } from './loopGuard.js';
import { INPUT_SAMPLE_RATE } from './pcm.js';
// The one model name: server/geminiMint.js locks every token to it
// (liveConnectConstraints), so a second copy here could drift and every
// connect would be rejected (docs/code-review-notes.md M7).
import LIVE_MODEL from './liveModel.json' with { type: 'json' };

/** @import { FunctionCall, LiveServerMessage, Session } from '@google/genai/web' */
/** @import { ActionResult, Snapshot } from './bridgeProtocol.js' */
/** @import { BridgeChannel } from './bridgeChannel.js' */

/**
 * @typedef {'connecting' | 'open' | 'reconnecting' | 'failed' | 'closed'} SessionStatus
 */
/**
 * Why a `failed` can't be fixed by retrying on its own: `token` — this page's
 * token request is rejected (an expired nonce, a wrong origin), which a reload
 * fixes; `config` — the server has no key, or Google rejects it, which only
 * the site owner can fix, so a reload is no help.
 * @typedef {'config' | 'token'} FatalKind
 */
/**
 * Sent with `reconnecting` and `failed` only. `fatal` marks a `failed` the
 * backoff won't retry, and says which kind (the UI words its action by it).
 * @typedef {{ attempt: number, maxAttempts: number, reason?: string, fatal?: FatalKind }} StatusDetails
 */
/**
 * One transcription fragment as Live streams it: a few words of one speaker,
 * with its own leading space (transcript.js coalesces them into entries).
 * @typedef {{ role: 'agent' | 'user', text: string }} TranscriptFragment
 */
/**
 * @typedef {object} LiveSessionOptions
 * @property {Omit<BridgeChannel, 'close'>} bridge The page's channel; the
 *   session subscribes to it and never closes it.
 * @property {string} nonce The page nonce main.jsx read off its script tag;
 *   echoed on every token request (docs/code-review-notes.md H1).
 * @property {(status: SessionStatus, details?: StatusDetails) => void} [onStatusChange]
 * @property {(base64Pcm: string) => void} [onAudioChunk] 24 kHz 16-bit PCM from the model.
 * @property {(fragment: TranscriptFragment) => void} [onTranscript]
 * @property {() => void} [onTurnEnd] The model's turn ended (turnComplete) or was
 *   cut off (interrupted); after that message's fragment, if it had one.
 * @property {() => void} [onInterrupted] The user barged in: stop playback now.
 */
/**
 * @typedef {object} LiveSession
 * @property {() => Promise<void>} connect Starts a fresh backoff budget; never rejects.
 * @property {() => void} disconnect Closes the socket and cancels any retry.
 * @property {() => void} dispose Disconnects and unsubscribes from the bridge and the knowledge store.
 * @property {(base64Frame: string) => void} sendAudioFrame 16 kHz PCM; queued (bounded) until the socket is up.
 */

// Immediate, 1s, 3s, 7s, 15s, 30s — matches the backoff documented for the
// original build (docs/project-knowledge-handoff.md §3.3).
const RECONNECT_DELAYS = [0, 1000, 3000, 7000, 15000, 30000];
const MAX_ATTEMPTS = RECONNECT_DELAYS.length;
// live.connect resolves only once the server sends setupComplete, so a socket
// that opens and then hears nothing would sit at `connecting` forever. Past
// this, the attempt counts as failed and the backoff retries (M4 re-review).
const SETUP_TIMEOUT_MS = 10_000;
// The backoff resets only once a session has proved itself: it stayed open
// this long, or the server sent real content (not just setupComplete). A
// server that completes setup and then closes every session used to reset the
// backoff each time and retry at 0 ms, bounded only by the token rate limit
// (the M6 T3 deferral).
const STABLE_SESSION_MS = 5_000;

// A 4xx from /api/live-token means this page's own request is rejected
// (expired nonce, wrong origin), so the same request will be rejected again:
// burning the whole backoff on it would just delay the honest answer. 429 is
// the exception — the server's rate limit clears on its own.
// The server marks a failure it can't recover from on its own (no
// GEMINI_API_KEY) with the code `not_configured`: a 500, but neither the
// backoff nor a reload can help until the key is fixed, so the reason points
// at whoever runs the site, and the card's Try again asks the server again.
// server/app.js sends it for a missing key and for a key Google rejects (an
// upstream 400/401/403); a mint that merely failed is a retryable 502. Every
// server error has one shape, { error: { code, message } }.
/** @type {Record<FatalKind, string>} */
const FATAL_REASONS = {
  token: 'This page can no longer get a connection token. Reload the page to reconnect.',
  // Try again works once the key is fixed, unless the fix restarted the
  // server: that wipes its in-memory nonces, so the retry is rejected as a
  // stale page and the card turns Try again into Reload page.
  config:
    "The server isn't configured to connect. Contact the site owner, then try again (you may need to reload the page).",
};
const EXHAUSTED_REASON = `Could not reconnect after ${MAX_ATTEMPTS} attempts.`;

// What Gemini closes a resume with (code 1008) when the reconnect arrives
// before it has let go of the dropped client. The handle is fine, just early:
// the backoff's next attempt resumes with it (seen in the live e2e, M5 T5).
const SESSION_STILL_ATTACHED = /already connected/i;
// Such a refusal is retried after STILL_ATTACHED_RETRY_MS × the attempt
// (400 ms, 800 ms, …), never later than the usual backoff. With the generic
// 1 s, a recovery that needed a second attempt took 2.8–3.4 s against the 3 s
// budget (M5 T5 and the M6 T5 baseline, docs/metrics/m06.md); the linear
// ramp still gives Gemini ~6 s in all to let go before the budget runs out.
const STILL_ATTACHED_RETRY_MS = 400;
// Close codes that say nothing against a resume handle: no close frame at all
// (1006, the network), the server going away, failing internally or asking to
// come back later (1001, 1011, 1012–1014). Any other close of a resumed
// attempt before setup completes is the server rejecting the handle (M4
// re-review).
const TRANSIENT_CLOSE_CODES = new Set([1001, 1006, 1011, 1012, 1013, 1014]);

/** @param {number} status */
function isRetryableStatus(status) {
  return status >= 500 || status === 429;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

// A token request the backoff mustn't retry; any other Error is retryable.
class FatalTokenError extends Error {
  /**
   * @param {string} message
   * @param {FatalKind} kind
   */
  constructor(message, kind) {
    super(message);
    this.kind = kind;
  }
}

// Expanded per docs/code-review-notes.md B4 now that tools exist: role,
// the selector constraint, and the act -> observe -> narrate loop.
const SYSTEM_INSTRUCTION =
  'You are a voice-controlled presenter agent embedded in a demo web app. You ' +
  'see the page through periodic snapshots of its interactive elements, and act ' +
  'on it using the click, scroll, fill, and navigate tools. Only ever use a ' +
  'selector that was given to you in a snapshot — never invent or guess one. ' +
  'Speak concisely: briefly say what you are about to do just before you do it, ' +
  'then act. A successful tool result includes the page as it is after the ' +
  'action, in its `page` field (a delta lists only what changed; an empty one ' +
  'means nothing on the page changed); use it to check the action worked and ' +
  'to choose your next step. When the user asks for ' +
  'several steps, carry out every one of them in order without waiting to be ' +
  'asked again, then confirm what you did. ' +
  'If a tool call fails or a page does not change as expected, say so honestly ' +
  'and try a different approach rather than repeating the same action.';

// The error a refused action answers with. A loop is the same action on the
// same page (loopGuard.check), so progress, which changes the page, never
// gets it; past the request's budget (loopGuard.spendAction) the model is
// told to check in, not that it repeated.
const LOOP_REFUSAL =
  'This action has repeated too many times, alone or in a cycle with your last few — try something different.';
const BUDGET_REFUSAL = `That is ${ACTION_BUDGET} actions since the user last spoke. Stop here, tell the user what you have done so far, and ask the user whether to go on.`;

// Sent once per utterance-loop episode (loopGuard.checkUtterance).
const CORRECTIVE_TURN =
  'You are repeating yourself. Stop, say one short sentence to the user and wait for them.';

// Wraps ai.live.connect: owns the WebSocket lifecycle, reconnect + session
// resumption. Deliberately knows nothing about the microphone — reconnects
// never touch audio capture, which is what caused the old build's reconnect
// bug (docs/code-review-notes.md B2: mic pipeline duplicated on every retry).
// Mic frames arrive continuously from the moment Connect is clicked, but
// ai.live.connect() takes a beat to resolve — bound how much audio queues up
// for that gap so "hears you" doesn't depend on speaking after a fixed delay.
const MAX_PENDING_FRAMES = 20; // ~1.6 s of the capture worklet's 80 ms frames

// Timing marks on the page's performance timeline, read by the opt-in live
// e2e (e2e/live.spec.js, docs/metrics/README.md): `ds:connect-start`,
// `ds:open`, `ds:first-audio`, `ds:tool-start:<id>` / `ds:tool-end:<id>` and
// `ds:reconnected`, plus `ds:keyframe` and `ds:knowledge` with the `bytes` (UTF-8)
// each sent message cost and `ds:loop-trip` with its `kind` (`action`,
// `utterance` or `budget`; M6 T5 tunes from
// them). A mark is a timestamp in a buffer nobody reads in
// production: no logging, no network. The buffer lasts as long as the page and
// gets two marks per tool call, so the names are kept and cleared on
// disconnect() (never mid-session: the live e2e reads them after its scenario,
// with the session still open). Each session keeps its own names (mark() in
// createLiveSession), so one session's disconnect clears only its own marks.

const encoder = new TextEncoder();

/** @param {string} text */
function byteLength(text) {
  return encoder.encode(text).length;
}

/**
 * @param {LiveSessionOptions} options
 * @returns {LiveSession}
 */
export function createLiveSession({
  bridge,
  nonce,
  onStatusChange,
  onAudioChunk,
  onTranscript,
  onTurnEnd,
  onInterrupted,
}) {
  /** @type {Set<string>} */
  const markNames = new Set();

  /**
   * @param {string} name
   * @param {Record<string, unknown>} [detail]
   */
  function mark(name, detail) {
    markNames.add(name);
    performance.mark(name, { detail });
  }

  function clearMarks() {
    markNames.forEach((name) => performance.clearMarks(name));
    markNames.clear();
  }

  /** @type {Session | null} */
  let session = null;
  let generation = 0;
  /** @type {string | null} */
  let resumeHandle = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let reconnectTimer = null;
  let attempt = 0;
  let manuallyClosed = false;
  /** @type {string[]} */
  let pendingFrames = [];
  // Per attempt: whether the server has sent anything yet (what `open` hangs
  // on), whether the attempt asked to resume a session, the setup timeout,
  // and the timer that resets the backoff once the session is stable.
  let serverAnswered = false;
  let attemptResumed = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let setupTimer = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let stableTimer = null;
  // For the timing marks: whether this conversation has had its first audio
  // chunk yet, and whether a drop is being recovered from.
  let awaitingFirstAudio = false;
  let recovering = false;

  /** @param {string} base64Frame */
  function sendFrame(base64Frame) {
    session?.sendRealtimeInput({
      audio: { data: base64Frame, mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}` },
    });
  }

  // Sent on every fresh session and whenever the knowledge store changes
  // mid-session, but not on a resumed reconnect: resumption restores the
  // session's context, knowledge included, so a resend only stacked another
  // copy (up to MAX_TOTAL_BYTES, 4 MB) into it on every drop. The live e2e
  // showed the resumed session still naming the seeded knowledge without it
  // (docs/code-review-notes.md M9, docs/metrics/m06.md).
  // A handle restores the session as it was when the handle was issued, so a
  // resume resends whenever the store has changed since the knowledge that
  // handle's session held: a change made while no session was up, or one sent
  // into the session after its newest handle. Revisions count store changes;
  // `sentRevision` is what the live session holds, `handleRevision` what the
  // handle in use restores.
  let knowledgeRevision = 0;
  let sentRevision = 0;
  let handleRevision = 0;

  function onKnowledgeChange() {
    knowledgeRevision += 1;
    sendKnowledgeContext();
  }

  // A client turn, so it waits for a running tool batch (sendTurn). The
  // revision is taken when it is really sent: a handle issued while it was
  // held doesn't hold it.
  function sendKnowledgeContext() {
    if (!session) return;
    sendTurn('knowledge', () => {
      if (!session) return;
      sentRevision = knowledgeRevision;
      const message = buildContextMessage();
      if (!message) return;
      mark('ds:knowledge', { bytes: byteLength(message) });
      session.sendClientContent({ turns: message, turnComplete: false });
    });
  }

  window.addEventListener(CHANGE_EVENT, onKnowledgeChange);

  // --- DOM grounding + tool-calling ---
  const snapshotContext = createDomSnapshotContext();
  const loopGuard = createLoopGuard();

  // The utterance half of the loop guard (docs/code-review-notes.md M6). Live
  // streams the agent's speech as outputTranscription fragments and ends each
  // turn with turnComplete, so a turn is the fragments in between, checked
  // once complete; an interrupted turn is dropped unchecked, and the user's
  // own transcription or a tool call ends any loop episode (the user speaking
  // also clears the action window: a new request). A loop gets one corrective turn,
  // which prompts a reply (turnComplete true), sent through sendTurn like
  // every client turn. A drop discards the partial turn: it belongs to the
  // dead session.
  let agentTurn = '';

  /** @param {LiveServerMessage['serverContent']} content */
  function trackUtterances(content) {
    if (!content) return;
    if (content.inputTranscription?.text) {
      loopGuard.userSpoke();
      // A new request ends the loop episode, so a corrective still held
      // behind a tool batch is no longer due.
      heldTurns.delete('corrective');
    }
    if (content.interrupted) agentTurn = '';
    agentTurn += content.outputTranscription?.text ?? '';
    if (!content.turnComplete) return;
    const turn = agentTurn;
    agentTurn = '';
    if (!loopGuard.checkUtterance(turn)) return;
    mark('ds:loop-trip', { kind: 'utterance' });
    sendTurn('corrective', () =>
      session?.sendClientContent({ turns: CORRECTIVE_TURN, turnComplete: true }),
    );
  }

  // Traffic with sandbox/bridge.js goes over the private channel main.jsx owns
  // (docs/adr/0001-private-bridge-channel.md). These unsubscribe functions are
  // kept so the session can detach without closing the channel itself.
  const unsubscribeNavigated = bridge.onNavigated(() => {
    // A fresh page has nothing in common with whatever delta state the
    // last one left behind — force the next snapshot to be a keyframe.
    // Deliberately does NOT send anything else (no greeting) — that's
    // the exact class of bug docs/code-review-notes.md B3 describes.
    snapshotContext.markNavigated();
  });

  // A snapshot that arrives while a tool batch runs is held, then sent inside
  // the batch's next tool response, as `page`. bridge.js posts each successful
  // action's snapshot, taken once the page has settled, just before that
  // action's result (#25), so every successful call answers with the page it
  // left: one held snapshot, a delta against the one the previous response
  // carried.
  // A navigate's keyframe lands before its own result: sent on its own, it was
  // a user turn between a function call and its response, and with
  // turnComplete false it never prompted a turn, so the model ended its turn
  // on "navigated" with no selectors for the new page and the task stalled
  // (seen in the live e2e, M5 T5). In the function result, the model
  // continues from it.
  /** @type {Set<symbol>} */
  const runningBatches = new Set();
  // Calls that arrived before live.connect() resolved (handleMessage).
  /** @type {FunctionCall[]} */
  let earlyToolCalls = [];
  /** @type {Snapshot | null} */
  let heldSnapshot = null;
  let heldCount = 0;
  // The loop guard's view of the page: the fingerprint of the latest full
  // snapshot, whether it was sent, held or arrived with no session. Snapshots
  // come in order, and a successful action's settled one before its result,
  // so when a call is checked this is the page the previous call left.
  /** @type {string | undefined} */
  let currentPage;

  // Client turns (the knowledge context, the greeting, the loop corrective)
  // can't land between a function call and its response either: the model
  // takes one as the user talking over its call, as the M5 navigate stall
  // showed. While a batch runs they are held, at most one of each kind (a
  // later one replaces it, keeping its place), and sent in the order first
  // held once the last batch is answered. A drop discards them with the dead
  // session's batches (openSession); the new session sends its own.
  /** @type {Map<'knowledge' | 'greeting' | 'corrective', () => void>} */
  const heldTurns = new Map();

  /**
   * @param {'knowledge' | 'greeting' | 'corrective'} kind
   * @param {() => void} send
   */
  function sendTurn(kind, send) {
    if (runningBatches.size > 0) heldTurns.set(kind, send);
    else send();
  }

  /** @param {Snapshot} snapshot */
  function snapshotMessage(snapshot) {
    const decision = snapshotContext.decide(snapshot);
    const message = formatSnapshotMessage(decision);
    if (decision.type === 'keyframe') {
      mark('ds:keyframe', { bytes: byteLength(message), nodes: decision.nodes.length });
    }
    return message;
  }

  /** @param {Snapshot} snapshot */
  function sendSnapshot(snapshot) {
    if (!session) return;
    session.sendClientContent({ turns: snapshotMessage(snapshot), turnComplete: false });
  }

  /** @returns {string | undefined} The held snapshot as a message, if any. */
  function takeHeldSnapshot() {
    if (!heldSnapshot) return undefined;
    // Each held snapshot is a diff against the one before it, so when more
    // than one arrived (a debounced one besides the action's own, or a
    // navigate's load and settle) only the last one, sent as a keyframe,
    // carries everything the others changed.
    if (heldCount > 1) snapshotContext.markNavigated();
    const message = snapshotMessage(heldSnapshot);
    heldSnapshot = null;
    heldCount = 0;
    return message;
  }

  const unsubscribeSnapshot = bridge.onSnapshot((snapshot) => {
    currentPage = pageFingerprint(snapshot.full);
    if (!session) return;
    if (runningBatches.size > 0) {
      heldSnapshot = snapshot;
      heldCount += 1;
      return;
    }
    sendSnapshot(snapshot);
  });

  // Serialized on purpose (docs/code-review-notes.md H4): dispatching a batch
  // concurrently races a navigate against a click that expects the new page,
  // and doesn't guarantee sendToolResponse ordering back to the model.
  /**
   * @param {FunctionCall[]} functionCalls
   * @param {number} gen
   */
  async function handleToolCallBatch(functionCalls, gen) {
    for (const fc of functionCalls) {
      // The SDK types `name` as optional; Live always sends it with a call.
      const name = fc.name ?? '';
      const id = fc.id ?? name;
      const signature = actionSignature(name, fc.args, currentPage);
      mark(`ds:tool-start:${id}`, { name });
      const overBudget = loopGuard.spendAction();
      const looping = loopGuard.check(signature);
      const refusal = overBudget ? BUDGET_REFUSAL : looping ? LOOP_REFUSAL : undefined;
      if (refusal) mark('ds:loop-trip', { kind: overBudget ? 'budget' : 'action' });
      /** @type {ActionResult} */
      const result = refusal
        ? { success: false, error: refusal }
        : await bridge.dispatchAction(name, toPositionalArgs(name, fc.args ?? {}));
      mark(`ds:tool-end:${id}`, { name, success: result.success });

      // A drop retires the generation, so a batch from a dead session stops
      // here instead of answering into the dead socket or the replacement one.
      if (gen !== generation || !session) return;
      const page = takeHeldSnapshot();
      session.sendToolResponse({
        functionResponses: {
          id: fc.id,
          name: fc.name,
          response: page ? { ...result, page } : result,
        },
      });
    }
  }

  // The batch runs detached from onmessage, so a throw inside it (typically
  // sendToolResponse on a socket that is already closing) would otherwise be an
  // unhandled rejection. A socket that can't be sent on has failed: route it
  // through handleFailure, whose generation guard makes it a no-op if the
  // matching onclose got there first.
  /**
   * @param {FunctionCall[]} functionCalls
   * @param {number} gen
   */
  function runToolCallBatch(functionCalls, gen) {
    const batch = Symbol('tool batch');
    runningBatches.add(batch);
    // A snapshot is a port message, so it can't land between a batch's last
    // response and this cleanup: whatever the batch held, it has sent.
    handleToolCallBatch(functionCalls, gen)
      .catch((error) => handleFailure(gen, error))
      .finally(() => {
        runningBatches.delete(batch);
        // openSession clears the held turns on a drop, so any still held
        // here are the live session's.
        if (runningBatches.size > 0 || gen !== generation) return;
        const sends = [...heldTurns.values()];
        heldTurns.clear();
        sends.forEach((send) => send());
      });
  }

  // details (StatusDetails) only accompany `reconnecting` and `failed`; the UI
  // shows "attempt n of maxAttempts" and the reason.
  /**
   * @param {SessionStatus} status
   * @param {StatusDetails} [details]
   */
  function setStatus(status, details) {
    onStatusChange?.(status, details);
  }

  function clearTimer(/** @type {ReturnType<typeof setTimeout> | null} */ timer) {
    if (timer) clearTimeout(timer);
    return null;
  }

  function teardown() {
    reconnectTimer = clearTimer(reconnectTimer);
    setupTimer = clearTimer(setupTimer);
    stableTimer = clearTimer(stableTimer);
    session?.close();
    session = null;
  }

  /** @returns {Promise<string>} */
  async function fetchToken() {
    // Echoes the nonce server/app.js templated into this page's script tag
    // (docs/code-review-notes.md H1); main.jsx reads it and passes it down.
    const res = await fetch(`/api/live-token?nonce=${encodeURIComponent(nonce)}`);
    if (!res.ok) {
      /** @type {unknown} */
      const body = await res.json().catch(() => ({}));
      const apiError = isRecord(body) && isRecord(body.error) ? body.error : {};
      const message =
        typeof apiError.message === 'string' && apiError.message
          ? apiError.message
          : `Token request failed: ${res.status}`;
      if (apiError.code === 'not_configured') throw new FatalTokenError(message, 'config');
      if (!isRetryableStatus(res.status)) throw new FatalTokenError(message, 'token');
      throw new Error(message);
    }
    /** @type {unknown} */
    const body = await res.json();
    // Checked rather than trusted: a missing token used to reach
    // `new GoogleGenAI` outside openSession's try, so the attempt rejected
    // unhandled and the status sat at `connecting` instead of retrying.
    if (!isRecord(body) || typeof body.token !== 'string') {
      throw new Error('The token response had no token.');
    }
    return body.token;
  }

  /**
   * @param {LiveServerMessage} message
   * @param {number} gen
   */
  function handleMessage(message, gen) {
    // The server answering (setupComplete is its first message) is what
    // makes the session `open` — not onopen, which only proves the socket
    // opened and showed "Live" for sockets the server was about to reject.
    // The backoff reset waits longer (STABLE_SESSION_MS): setupComplete
    // followed by a close, every time, must keep climbing the backoff.
    if (!serverAnswered) {
      serverAnswered = true;
      stableTimer = setTimeout(() => {
        stableTimer = null;
        if (gen === generation) attempt = 0;
      }, STABLE_SESSION_MS);
      mark('ds:open');
      if (recovering) {
        recovering = false;
        mark('ds:reconnected');
      }
      setStatus('open');
    }
    if (stableTimer && (message.serverContent || message.toolCall)) {
      stableTimer = clearTimer(stableTimer);
      attempt = 0;
    }
    if (message.serverContent?.interrupted) {
      onInterrupted?.();
    }
    if (message.data) {
      if (awaitingFirstAudio) {
        awaitingFirstAudio = false;
        mark('ds:first-audio');
      }
      onAudioChunk?.(message.data);
    }
    const outText = message.serverContent?.outputTranscription?.text;
    if (outText) onTranscript?.({ role: 'agent', text: outText });
    const inText = message.serverContent?.inputTranscription?.text;
    if (inText) onTranscript?.({ role: 'user', text: inText });
    if (message.serverContent?.turnComplete || message.serverContent?.interrupted) onTurnEnd?.();
    trackUtterances(message.serverContent);

    const resumption = message.sessionResumptionUpdate;
    if (resumption?.resumable && resumption.newHandle) {
      resumeHandle = resumption.newHandle;
      handleRevision = sentRevision;
    }

    const functionCalls = message.toolCall?.functionCalls;
    if (functionCalls?.length) {
      // Narration between the steps of one request is no talk loop.
      loopGuard.agentActed();
      // The SDK delivers what the server queued behind setupComplete before
      // live.connect() resolves, so a call can arrive before `session` is
      // ours: it waits for openSession to start it rather than being answered
      // into nothing.
      if (session)
        runToolCallBatch(functionCalls, gen); // fire-and-forget; internally serialized
      else earlyToolCalls.push(...functionCalls);
    }
  }

  // Live typically fires both onerror and onclose on the same drop. The
  // first one retires the generation, so the second (and any late callback,
  // a still-pending live.connect() or an in-flight tool batch from it) is
  // ignored; the reconnectTimer guard additionally keeps at most one retry
  // scheduled (the other half of B2, and M2's never-cleared timers).
  /**
   * @param {number} gen
   * @param {unknown} error Anything a failed attempt threw, or the socket's Error.
   * @param {{ handleRejected?: boolean, stillAttached?: boolean }} [close] Set by
   *   onclose only. `handleRejected`: the server closed the attempt for a reason
   *   that isn't the network's. `stillAttached`: it refused a resume only because
   *   the dropped client is still attached (the handle is fine, just early).
   */
  function handleFailure(gen, error, { handleRejected = false, stillAttached = false } = {}) {
    if (manuallyClosed || gen !== generation) return;
    generation += 1;
    teardown();
    // A resumed attempt the server closes before setup completes had its
    // handle rejected (expired, or from a session it dropped); retrying with it
    // would fail the same way every time, so start fresh. A network failure
    // (an error, a close with no close frame, the setup timeout) says nothing
    // against the handle, and keeps it (M4 re-review).
    if (attemptResumed && !serverAnswered && handleRejected) resumeHandle = null;
    if (error instanceof FatalTokenError) {
      setStatus('failed', {
        attempt,
        maxAttempts: MAX_ATTEMPTS,
        reason: FATAL_REASONS[error.kind],
        fatal: error.kind,
      });
      return;
    }
    if (attempt >= MAX_ATTEMPTS) {
      setStatus('failed', { attempt, maxAttempts: MAX_ATTEMPTS, reason: EXHAUSTED_REASON });
      return;
    }
    const delay = stillAttached
      ? Math.min(RECONNECT_DELAYS[attempt], STILL_ATTACHED_RETRY_MS * attempt)
      : RECONNECT_DELAYS[attempt];
    attempt += 1;
    recovering = true;
    // `reconnecting`, not `failed`, while a retry is still coming — the old
    // build reported `failed` here and then silently recovered.
    setStatus('reconnecting', {
      attempt,
      maxAttempts: MAX_ATTEMPTS,
      reason: error instanceof Error ? error.message : undefined,
    });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      openSession();
    }, delay);
  }

  // A user-initiated connect (first Connect, or Retry after `failed`) starts
  // a fresh backoff budget; automatic retries go straight to openSession() and
  // keep showing `reconnecting` until the session is open again.
  function connect() {
    attempt = 0;
    manuallyClosed = false;
    // A new conversation shouldn't inherit the last one's repeats or cycles.
    loopGuard.reset();
    recovering = false;
    awaitingFirstAudio = true;
    mark('ds:connect-start');
    setStatus('connecting');
    return openSession();
  }

  async function openSession() {
    const gen = ++generation; // invalidates any older in-flight attempt
    teardown();
    // A dead session's batches and the page state they held go with it; the
    // new session asks for a fresh keyframe below.
    runningBatches.clear();
    heldSnapshot = null;
    heldCount = 0;
    earlyToolCalls = [];
    agentTurn = '';
    heldTurns.clear();
    serverAnswered = false;
    attemptResumed = false;

    /** @type {string} */
    let token;
    try {
      token = await fetchToken();
    } catch (error) {
      handleFailure(gen, error);
      return;
    }
    if (gen !== generation) return;

    const ai = new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } });
    attemptResumed = Boolean(resumeHandle);
    // The abandoned socket can't be closed from here (live.connect hasn't
    // returned it); the generation check below closes it if it ever lands,
    // and ignores its callbacks until then. The same holds for a disconnect()
    // during a pending live.connect: if the server never completes setup,
    // the SDK never hands the socket over, and it stays open, ignored, until
    // the server or the network closes it (an orphan socket, no traffic sent).
    setupTimer = setTimeout(() => {
      setupTimer = null;
      handleFailure(gen, new Error('The voice service did not answer in time.'));
    }, SETUP_TIMEOUT_MS);

    try {
      const newSession = await ai.live.connect({
        model: LIVE_MODEL.model,
        callbacks: {
          // No onopen: a socket opening proves nothing about the session;
          // `open` waits for the first server message (handleMessage).
          onmessage: (message) => {
            if (gen !== generation) return;
            handleMessage(message, gen);
          },
          onerror: () =>
            handleFailure(gen, new Error('The connection to the voice service failed.')),
          onclose: (event) => {
            // Only a resume can be refused for a still-attached client.
            const stillAttached =
              attemptResumed &&
              event?.code === 1008 &&
              SESSION_STILL_ATTACHED.test(event.reason ?? '');
            const transient = event?.code === undefined || TRANSIENT_CLOSE_CODES.has(event.code);
            handleFailure(gen, new Error('The connection to the voice service closed.'), {
              stillAttached,
              handleRejected: !stillAttached && !transient,
            });
          },
        },
        config: {
          responseModalities: [Modality.AUDIO],
          outputAudioTranscription: {},
          inputAudioTranscription: {},
          systemInstruction: SYSTEM_INSTRUCTION,
          sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
          tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
        },
      });

      if (gen !== generation) {
        newSession.close();
        return;
      }
      setupTimer = clearTimer(setupTimer);
      session = newSession;
      pendingFrames.forEach(sendFrame);
      pendingFrames = [];
      // Calls the server sent before live.connect() resolved are answered
      // first: started before any client turn, so the knowledge and the
      // greeting below wait for their responses (sendTurn, M6 re-review).
      if (earlyToolCalls.length > 0) {
        const calls = earlyToolCalls;
        earlyToolCalls = [];
        runToolCallBatch(calls, gen);
      }
      if (!attemptResumed || knowledgeRevision !== handleRevision) sendKnowledgeContext();
      // The page, unlike the knowledge, may have changed during the drop, and
      // a keyframe is small (≤ 855 B in the live e2e) — force a fresh one
      // rather than assuming the model still has the page right, and ask
      // bridge.js for one now instead of waiting for the next DOM mutation.
      snapshotContext.markNavigated();
      bridge.requestSnapshot();
      // Greet once per fresh session, not on a resumed reconnect — otherwise
      // a mid-conversation resumption would restart the conversation with a
      // fresh "hello" (the same class of bug as docs/code-review-notes.md B3).
      // By this attempt, not by resumeHandle: a handle can arrive before
      // live.connect() resolves (the SDK's queue), on a fresh session too.
      if (!attemptResumed) {
        sendTurn('greeting', () =>
          session?.sendClientContent({
            turns: 'Greet the user with a brief hello.',
            turnComplete: true,
          }),
        );
      }
    } catch (error) {
      handleFailure(gen, error);
    }
  }

  /** @param {string} base64Frame */
  function sendAudioFrame(base64Frame) {
    if (session) {
      sendFrame(base64Frame);
      return;
    }
    pendingFrames.push(base64Frame);
    if (pendingFrames.length > MAX_PENDING_FRAMES) pendingFrames.shift();
  }

  function disconnect() {
    generation += 1; // invalidate any in-flight attempt too (teardown clears a scheduled retry)
    manuallyClosed = true;
    attempt = 0;
    recovering = false;
    resumeHandle = null;
    pendingFrames = [];
    teardown();
    clearMarks();
    setStatus('closed');
  }

  // Detaches this session from the page; never closes the bridge channel,
  // which main.jsx owns for the page's lifetime (the bridge accepts only the
  // first connect, so a closed channel could never be replaced).
  function dispose() {
    unsubscribeNavigated();
    unsubscribeSnapshot();
    window.removeEventListener(CHANGE_EVENT, onKnowledgeChange);
    disconnect();
  }

  return { connect, disconnect, dispose, sendAudioFrame };
}
