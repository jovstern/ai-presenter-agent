// Explicit /web subpath, not the bare package: the bare entry's "browser"
// condition wasn't picked up by this build and pulled in the Node build
// instead, which references `process` and crashes in the browser.
import { GoogleGenAI, Modality } from '@google/genai/web';
import { CHANGE_EVENT, buildContextMessage } from './knowledgeStore.js';
import { TOOL_DECLARATIONS, toPositionalArgs } from './actionTools.js';
import { createDomSnapshotContext, formatSnapshotMessage } from './domSnapshotContext.js';
import { createLoopGuard, actionSignature } from './loopGuard.js';

const MODEL = 'gemini-3.8-live';

// Immediate, 1s, 3s, 7s, 15s, 30s — matches the backoff documented for the
// original build (docs/project-knowledge-handoff.md §3.3).
const RECONNECT_DELAYS = [0, 1000, 3000, 7000, 15000, 30000];
const MAX_ATTEMPTS = RECONNECT_DELAYS.length;

// A 4xx from /api/live-token means this page's own request is rejected
// (expired nonce, wrong origin), so the same request will be rejected again:
// burning the whole backoff on it would just delay the honest answer. 429 is
// the exception — the server's rate limit clears on its own.
const RELOAD_REASON = 'This page can no longer get a connection token. Reload the page to reconnect.';
// The server marks a failure it can't recover from on its own (no
// GEMINI_API_KEY) with `retryable: false`: a 500, but retrying won't help and
// neither will a reload, so the reason points at whoever runs the site.
const MISCONFIGURED_REASON = "The server isn't configured to connect. Contact the site owner.";
const EXHAUSTED_REASON = `Could not reconnect after ${MAX_ATTEMPTS} attempts.`;

function isRetryableStatus(status) {
  return status >= 500 || status === 429;
}

// Expanded per docs/code-review-notes.md B4 now that tools exist: role,
// the selector constraint, and the act -> observe -> narrate loop.
const SYSTEM_INSTRUCTION =
  'You are a voice-controlled presenter agent embedded in a demo web app. You ' +
  'see the page through periodic snapshots of its interactive elements, and act ' +
  'on it using the click, scroll, fill, and navigate tools. Only ever use a ' +
  'selector that was given to you in a snapshot — never invent or guess one. ' +
  'Speak concisely: briefly say what you are about to do just before you do it, ' +
  'act, then confirm the result once you see it reflected in the next snapshot. ' +
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

export function createLiveSession({ bridge, onStatusChange, onAudioChunk, onTranscript, onInterrupted }) {
  let session = null;
  let generation = 0;
  let resumeHandle = null;
  let reconnectTimer = null;
  let attempt = 0;
  let manuallyClosed = false;
  let pendingFrames = [];
  // Per attempt: whether the server has sent anything yet (what `open` and the
  // backoff reset hang on), and whether the attempt asked to resume a session.
  let serverAnswered = false;
  let attemptResumed = false;

  function sendFrame(base64Frame) {
    session.sendRealtimeInput({ audio: { data: base64Frame, mimeType: 'audio/pcm;rate=16000' } });
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

  const unsubscribeSnapshot = bridge.onSnapshot((snapshot) => {
    if (!session) return;
    const decision = snapshotContext.decide(snapshot);
    session.sendClientContent({ turns: formatSnapshotMessage(decision), turnComplete: false });
  });

  // Serialized on purpose (docs/code-review-notes.md H4): dispatching a batch
  // concurrently races a navigate against a click that expects the new page,
  // and doesn't guarantee sendToolResponse ordering back to the model.
  async function handleToolCallBatch(functionCalls, gen) {
    for (const fc of functionCalls) {
      const signature = actionSignature(fc.name, fc.args);
      const result = loopGuard.check(signature)
        ? { success: false, error: 'This action has repeated too many times in a row — try something different.' }
        : await bridge.dispatchAction(fc.name, toPositionalArgs(fc.name, fc.args ?? {}));

      // A drop retires the generation, so a batch from a dead session stops
      // here instead of answering into the dead socket or the replacement one.
      if (gen !== generation || !session) return;
      session.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: result } });
    }
  }

  // The batch runs detached from onmessage, so a throw inside it (typically
  // sendToolResponse on a socket that is already closing) would otherwise be an
  // unhandled rejection. A socket that can't be sent on has failed: route it
  // through handleFailure, whose generation guard makes it a no-op if the
  // matching onclose got there first.
  function runToolCallBatch(functionCalls, gen) {
    handleToolCallBatch(functionCalls, gen).catch((error) => handleFailure(gen, error));
  }

  // details ({ attempt, maxAttempts, reason, fatal }) only accompany
  // `reconnecting` and `failed`; the UI shows "attempt n of maxAttempts" and the
  // reason. `fatal` marks a `failed` that Retry can't fix (the page's token
  // request is rejected or the server is misconfigured), so the UI offers a
  // reload instead.
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

  async function fetchToken() {
    // Echoes the single-use nonce server/index.js embedded when it served
    // this page (docs/code-review-notes.md H1) — window.__DS_NONCE__ is set
    // by an inline script in sandbox/index.html, before this script runs.
    const nonce = window.__DS_NONCE__ ?? '';
    const res = await fetch(`/api/live-token?nonce=${encodeURIComponent(nonce)}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const error = new Error(body.error || `Token request failed: ${res.status}`);
      if (body.retryable === false) {
        error.retryable = false;
        error.reason = MISCONFIGURED_REASON;
      } else {
        error.retryable = isRetryableStatus(res.status);
        if (!error.retryable) error.reason = RELOAD_REASON;
      }
      throw error;
    }
    const { token } = await res.json();
    return token;
  }

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
      setStatus('open');
    }
    if (message.serverContent?.interrupted) {
      onInterrupted?.();
    }
    if (message.data) {
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
  function handleFailure(gen, error) {
    if (manuallyClosed || gen !== generation) return;
    generation += 1;
    teardown();
    // A resumed attempt that dies before the server says anything most likely
    // had its handle rejected (expired, or from a session the server dropped).
    // Retrying with it would fail the same way every time, so start fresh.
    if (attemptResumed && !serverAnswered) resumeHandle = null;
    if (error?.retryable === false) {
      setStatus('failed', { attempt, maxAttempts: MAX_ATTEMPTS, reason: error.reason ?? RELOAD_REASON, fatal: true });
      return;
    }
    if (attempt >= MAX_ATTEMPTS) {
      setStatus('failed', { attempt, maxAttempts: MAX_ATTEMPTS, reason: EXHAUSTED_REASON });
      return;
    }
    const delay = RECONNECT_DELAYS[attempt];
    attempt += 1;
    // `reconnecting`, not `failed`, while a retry is still coming — the old
    // build reported `failed` here and then silently recovered.
    setStatus('reconnecting', { attempt, maxAttempts: MAX_ATTEMPTS, reason: error?.message });
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
    setStatus('connecting');
    return openSession();
  }

  async function openSession() {
    const gen = ++generation; // invalidates any older in-flight attempt
    teardown();
    serverAnswered = false;
    attemptResumed = false;

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
          onerror: () => handleFailure(gen, new Error('The connection to the voice service failed.')),
          onclose: () => handleFailure(gen, new Error('The connection to the voice service closed.')),
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
        session.sendClientContent({ turns: 'Greet the user with a brief hello.', turnComplete: true });
      }
    } catch (error) {
      handleFailure(gen, error);
    }
  }

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
