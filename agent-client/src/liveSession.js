// Explicit /web subpath, not the bare package: the bare entry's "browser"
// condition wasn't picked up by this build and pulled in the Node build
// instead, which references `process` and crashes in the browser.
import { GoogleGenAI, Modality } from '@google/genai/web';
import { CHANGE_EVENT, buildContextMessage } from './knowledgeStore.js';
import { TOOL_DECLARATIONS, toPositionalArgs } from './actionTools.js';
import { createDomSnapshotContext, formatSnapshotMessage } from './domSnapshotContext.js';
import { createLoopGuard, actionSignature } from './loopGuard.js';

/** @import { FunctionCall, LiveServerMessage, Session } from '@google/genai/web' */
/** @import { ActionResult, Snapshot } from './bridgeProtocol.js' */
/** @import { BridgeChannel } from './bridgeChannel.js' */

/**
 * @typedef {'connecting' | 'open' | 'reconnecting' | 'failed' | 'closed'} SessionStatus
 */
/**
 * Sent with `reconnecting` and `failed` only. `fatal` marks a `failed` that
 * Retry can't fix (the page's token request is rejected, or the server is
 * misconfigured), so the UI offers a reload instead.
 * @typedef {{ attempt: number, maxAttempts: number, reason?: string, fatal?: boolean }} StatusDetails
 */
/**
 * @typedef {{ role: 'agent' | 'user', text: string }} TranscriptEntry
 */
/**
 * @typedef {object} LiveSessionOptions
 * @property {Omit<BridgeChannel, 'close'>} bridge The page's channel; the
 *   session subscribes to it and never closes it.
 * @property {string} nonce The page nonce main.jsx read off its script tag;
 *   echoed on every token request (docs/code-review-notes.md H1).
 * @property {(status: SessionStatus, details?: StatusDetails) => void} [onStatusChange]
 * @property {(base64Pcm: string) => void} [onAudioChunk] 24 kHz 16-bit PCM from the model.
 * @property {(entry: TranscriptEntry) => void} [onTranscript]
 * @property {() => void} [onInterrupted] The user barged in: stop playback now.
 */
/**
 * @typedef {object} LiveSession
 * @property {() => Promise<void>} connect Starts a fresh backoff budget; never rejects.
 * @property {() => void} disconnect Closes the socket and cancels any retry.
 * @property {() => void} dispose Disconnects and unsubscribes from the bridge and the knowledge store.
 * @property {(base64Frame: string) => void} sendAudioFrame 16 kHz PCM; queued (bounded) until the socket is up.
 */
/**
 * An Error that says whether retrying can help, and the reason to show if not.
 * @typedef {Error & { retryable: boolean, reason?: string }} TokenError
 */

const MODEL = 'gemini-3.8-live';

// Immediate, 1s, 3s, 7s, 15s, 30s — matches the backoff documented for the
// original build (docs/project-knowledge-handoff.md §3.3).
const RECONNECT_DELAYS = [0, 1000, 3000, 7000, 15000, 30000];
const MAX_ATTEMPTS = RECONNECT_DELAYS.length;

// A 4xx from /api/live-token means this page's own request is rejected
// (expired nonce, wrong origin), so the same request will be rejected again:
// burning the whole backoff on it would just delay the honest answer. 429 is
// the exception — the server's rate limit clears on its own.
const RELOAD_REASON =
  'This page can no longer get a connection token. Reload the page to reconnect.';
// The server marks a failure it can't recover from on its own (no
// GEMINI_API_KEY) with the code `not_configured`: a 500, but retrying won't
// help and neither will a reload, so the reason points at whoever runs the site.
// Every server error has one shape, { error: { code, message } } (server/app.js).
const MISCONFIGURED_REASON = "The server isn't configured to connect. Contact the site owner.";
const EXHAUSTED_REASON = `Could not reconnect after ${MAX_ATTEMPTS} attempts.`;

// What Gemini closes a resume with (code 1008) when the reconnect arrives
// before it has let go of the dropped client. The handle is fine, just early:
// the backoff's next attempt resumes with it (seen in the live e2e, M5 T5).
const SESSION_STILL_ATTACHED = /already connected/i;

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

/**
 * @param {string} message The server's own error text; empty for none.
 * @param {number} status
 * @param {boolean} retryable
 * @param {string} [reason]
 * @returns {TokenError}
 */
function tokenError(message, status, retryable, reason) {
  const error = new Error(message || `Token request failed: ${status}`);
  return Object.assign(error, reason === undefined ? { retryable } : { retryable, reason });
}

/**
 * @param {unknown} error
 * @returns {error is TokenError}
 */
function isTokenError(error) {
  return error instanceof Error && 'retryable' in error && typeof error.retryable === 'boolean';
}

// Expanded per docs/code-review-notes.md B4 now that tools exist: role,
// the selector constraint, and the act -> observe -> narrate loop.
const SYSTEM_INSTRUCTION =
  'You are a voice-controlled presenter agent embedded in a demo web app. You ' +
  'see the page through periodic snapshots of its interactive elements, and act ' +
  'on it using the click, scroll, fill, and navigate tools. Only ever use a ' +
  'selector that was given to you in a snapshot — never invent or guess one. ' +
  'Speak concisely: briefly say what you are about to do just before you do it, ' +
  'then act. A tool result may include the page as it is after the action, in ' +
  'its `page` field; use it to choose your next step. When the user asks for ' +
  'several steps, carry out every one of them in order without waiting to be ' +
  'asked again, then confirm what you did. ' +
  'If a tool call fails or a page does not change as expected, say so honestly ' +
  'and try a different approach rather than repeating the same action.';

// Wraps ai.live.connect: owns the WebSocket lifecycle, reconnect + session
// resumption. Deliberately knows nothing about the microphone — reconnects
// never touch audio capture, which is what caused the old build's reconnect
// bug (docs/code-review-notes.md B2: mic pipeline duplicated on every retry).
// Mic frames arrive continuously from the moment Connect is clicked, but
// ai.live.connect() takes a beat to resolve — bound how much audio queues up
// for that gap so "hears you" doesn't depend on speaking after a fixed delay.
const MAX_PENDING_FRAMES = 20; // ~5s of 4096-sample/16kHz frames

// Timing marks on the page's performance timeline, read by the opt-in live
// e2e (e2e/live.spec.js, docs/metrics/README.md): `ds:connect-start`,
// `ds:open`, `ds:first-audio`, `ds:tool-start:<id>` / `ds:tool-end:<id>` and
// `ds:reconnected`. A mark is a timestamp in a buffer nobody reads in
// production: no logging, no network.
/**
 * @param {string} name
 * @param {Record<string, unknown>} [detail]
 */
function mark(name, detail) {
  performance.mark(name, { detail });
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
  onInterrupted,
}) {
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
  // Per attempt: whether the server has sent anything yet (what `open` and the
  // backoff reset hang on), and whether the attempt asked to resume a session.
  let serverAnswered = false;
  let attemptResumed = false;
  // For the timing marks: whether this conversation has had its first audio
  // chunk yet, and whether a drop is being recovered from.
  let awaitingFirstAudio = false;
  let recovering = false;

  /** @param {string} base64Frame */
  function sendFrame(base64Frame) {
    session?.sendRealtimeInput({ audio: { data: base64Frame, mimeType: 'audio/pcm;rate=16000' } });
  }

  // Resent on every (re)connect (including a resumed one) and whenever
  // the knowledge store changes mid-session — a (re)connect can't fully
  // trust a resumed session's turn history is intact, so this resends fresh
  // grounding rather than assuming the model still remembers.
  function sendKnowledgeContext() {
    if (!session) return;
    const message = buildContextMessage();
    if (message) session.sendClientContent({ turns: message, turnComplete: false });
  }

  window.addEventListener(CHANGE_EVENT, sendKnowledgeContext);

  // --- DOM grounding + tool-calling ---
  const snapshotContext = createDomSnapshotContext();
  const loopGuard = createLoopGuard();

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
  // the batch's next tool response, as `page`.
  // A navigate's keyframe lands before its own result: sent on its own, it was
  // a user turn between a function call and its response, and with
  // turnComplete false it never prompted a turn, so the model ended its turn
  // on "navigated" with no selectors for the new page and the task stalled
  // (seen in the live e2e, M5 T5). In the function result, the model
  // continues from it.
  /** @type {Set<symbol>} */
  const runningBatches = new Set();
  /** @type {Snapshot | null} */
  let heldSnapshot = null;
  let heldCount = 0;

  /** @param {Snapshot} snapshot */
  function sendSnapshot(snapshot) {
    if (!session) return;
    const decision = snapshotContext.decide(snapshot);
    session.sendClientContent({ turns: formatSnapshotMessage(decision), turnComplete: false });
  }

  /** @returns {string | undefined} The held snapshot as a message, if any. */
  function takeHeldSnapshot() {
    if (!heldSnapshot) return undefined;
    // Each held snapshot is a diff against the one before it, so only the
    // last one, sent as a keyframe, carries everything the others changed.
    if (heldCount > 1) snapshotContext.markNavigated();
    const decision = snapshotContext.decide(heldSnapshot);
    heldSnapshot = null;
    heldCount = 0;
    return formatSnapshotMessage(decision);
  }

  const unsubscribeSnapshot = bridge.onSnapshot((snapshot) => {
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
      const signature = actionSignature(name, fc.args);
      mark(`ds:tool-start:${id}`, { name });
      /** @type {ActionResult} */
      const result = loopGuard.check(signature)
        ? {
            success: false,
            error: 'This action has repeated too many times in a row — try something different.',
          }
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
      .finally(() => runningBatches.delete(batch));
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

  function teardown() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
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
      const message = typeof apiError.message === 'string' ? apiError.message : '';
      /** @type {TokenError} */
      let error;
      if (apiError.code === 'not_configured') {
        error = tokenError(message, res.status, false, MISCONFIGURED_REASON);
      } else {
        const retryable = isRetryableStatus(res.status);
        error = tokenError(message, res.status, retryable, retryable ? undefined : RELOAD_REASON);
      }
      throw error;
    }
    /** @type {unknown} */
    const body = await res.json();
    // Checked rather than trusted: a missing token used to reach
    // `new GoogleGenAI` outside openSession's try, so the attempt rejected
    // unhandled and the status sat at `connecting` instead of retrying.
    if (!isRecord(body) || typeof body.token !== 'string') {
      throw tokenError('The token response had no token.', res.status, true);
    }
    return body.token;
  }

  /**
   * @param {LiveServerMessage} message
   * @param {number} gen
   */
  function handleMessage(message, gen) {
    // The server answering (setupComplete is its first message) is what
    // proves the session healthy — not onopen, which only proves the socket
    // opened. So both `open` and the backoff reset happen here, together:
    // resetting on onopen let open-then-immediate-close cycles retry at delay
    // 0 forever, and reporting `open` there showed "Live" for sockets the
    // server was about to reject.
    if (!serverAnswered) {
      serverAnswered = true;
      attempt = 0;
      mark('ds:open');
      if (recovering) {
        recovering = false;
        mark('ds:reconnected');
      }
      setStatus('open');
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

    const resumption = message.sessionResumptionUpdate;
    if (resumption?.resumable && resumption.newHandle) {
      resumeHandle = resumption.newHandle;
    }

    if (message.toolCall?.functionCalls?.length) {
      runToolCallBatch(message.toolCall.functionCalls, gen); // fire-and-forget; internally serialized
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
   * @param {boolean} [handleStillValid] The server refused a resume only because
   *   the dropped client is still attached; keep the handle for the next attempt.
   */
  function handleFailure(gen, error, handleStillValid = false) {
    if (manuallyClosed || gen !== generation) return;
    generation += 1;
    teardown();
    // A resumed attempt that dies before the server says anything most likely
    // had its handle rejected (expired, or from a session the server dropped).
    // Retrying with it would fail the same way every time, so start fresh.
    if (attemptResumed && !serverAnswered && !handleStillValid) resumeHandle = null;
    if (isTokenError(error) && !error.retryable) {
      setStatus('failed', {
        attempt,
        maxAttempts: MAX_ATTEMPTS,
        reason: error.reason ?? RELOAD_REASON,
        fatal: true,
      });
      return;
    }
    if (attempt >= MAX_ATTEMPTS) {
      setStatus('failed', { attempt, maxAttempts: MAX_ATTEMPTS, reason: EXHAUSTED_REASON });
      return;
    }
    const delay = RECONNECT_DELAYS[attempt];
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
    // A new conversation shouldn't inherit the last one's repeat streak.
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

    try {
      const newSession = await ai.live.connect({
        model: MODEL,
        callbacks: {
          // No onopen: a socket opening proves nothing about the session;
          // `open` waits for the first server message (handleMessage).
          onmessage: (message) => {
            if (gen !== generation) return;
            handleMessage(message, gen);
          },
          onerror: () =>
            handleFailure(gen, new Error('The connection to the voice service failed.')),
          onclose: (event) =>
            handleFailure(
              gen,
              new Error('The connection to the voice service closed.'),
              SESSION_STILL_ATTACHED.test(event.reason),
            ),
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
      session = newSession;
      pendingFrames.forEach(sendFrame);
      pendingFrames = [];
      sendKnowledgeContext();
      // A (re)connect can't fully trust a resumed session's turn history is
      // intact (same reasoning as sendKnowledgeContext above) — force a
      // fresh keyframe rather than assuming the model still remembers the
      // page, and ask bridge.js for one right away instead of waiting for
      // the next incidental DOM mutation.
      snapshotContext.markNavigated();
      bridge.requestSnapshot();
      // Greet once per fresh session, not on a resumed reconnect — otherwise
      // a mid-conversation resumption would restart the conversation with a
      // fresh "hello" (the same class of bug as docs/code-review-notes.md B3).
      if (!resumeHandle) {
        session.sendClientContent({
          turns: 'Greet the user with a brief hello.',
          turnComplete: true,
        });
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
    setStatus('closed');
  }

  // Detaches this session from the page; never closes the bridge channel,
  // which main.jsx owns for the page's lifetime (the bridge accepts only the
  // first connect, so a closed channel could never be replaced).
  function dispose() {
    unsubscribeNavigated();
    unsubscribeSnapshot();
    window.removeEventListener(CHANGE_EVENT, sendKnowledgeContext);
    disconnect();
  }

  return { connect, disconnect, dispose, sendAudioFrame };
}
